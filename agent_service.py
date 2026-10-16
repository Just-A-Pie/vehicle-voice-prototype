import logging
import base64,io,json,os,secrets,socket,tempfile,threading,time,uuid,traceback,hashlib,queue
from pathlib import Path
import numpy as np
import soundfile as sf
from fastapi import FastAPI,HTTPException,Header
from pydantic import BaseModel,Field
from qwen_agent.agents import Assistant
from qwen_agent.tools import BaseTool
from vehicle import Vehicle
from cabin import CabinVehicle, SCHEMA as CABIN_SCHEMA, PROMPT as CABIN_PROMPT, confirmation as cabin_confirmation, rejection as cabin_rejection
from typing import Literal

ROOT=Path(__file__).parent
RUN=ROOT/'runtime';RUN.mkdir(exist_ok=True)
TOKEN=os.environ.get('VEHICLE_TOKEN') or secrets.token_urlsafe(32)
LOCK=threading.Lock();SESSIONS={};backend=None
app=FastAPI()
BUILD='2026-09-24-slai-v3'
STREAM_CONTEXT=threading.local()
def audit(request_id,kind,data):
    record={'timestamp':time.time(),'request_id':request_id,'build':BUILD,'kind':kind,**data}
    path=RUN/'audit.jsonl'
    try:
        with path.open('a') as f:f.write(json.dumps(record,ensure_ascii=False)+'\n')
        path.chmod(0o600)
    except OSError as exc:
        logging.getLogger(__name__).error('Audit write failed for %s (%s): %s',request_id,kind,type(exc).__name__)

class Payload(BaseModel):
    session_id:str=''
    request_id:str=Field(default='',max_length=80)
    profile:Literal['legacy','slai']='legacy'
    patch:dict=Field(default_factory=dict)
    audio:str=Field(default='',max_length=1500000)
    text:str=Field(default='',max_length=300)
class CarTool(BaseTool):
    name='vehicle_control'
    description='控制模拟车辆。设置空调开关/温度、媒体音量、车窗开度，或恢复初始状态。只修改用户明确要求的字段；温度16–30度，百分比0–100。'
    parameters={'type':'object','properties':{'ac_on':{'type':'boolean'},'temperature':{'type':'number'},'temperature_delta':{'type':'number','description':'相对当前温度的变化，例如再低两度用-2'},'media_volume':{'type':'integer'},'window_open':{'type':'integer'},'reset':{'type':'boolean'}},'required':[]}
    def __init__(self,vehicle,events):
        super().__init__();self.vehicle=vehicle;self.events=events
    def call(self,params,**kwargs):
        try:
            args=json.loads(params) if isinstance(params,str) else params
            result=self.vehicle.apply(args)
        except (ValueError,TypeError) as e:result={'ok':False,'error':str(e),'state':self.vehicle.state()}
        self.events.append({'tool':self.name,'arguments':params,'result':result,'time':time.time()})
        return json.dumps(result,ensure_ascii=False)

class CabinTool(CarTool):
    name='control_cabin'
    description='设置 SLAI 模拟座舱参数。只修改明确要求的字段；独立门窗开度、空调、送风、音乐和灯光。'
    parameters={'type':'object','properties':CABIN_SCHEMA['properties'],'required':[]}

def auth(value):
    if not secrets.compare_digest(value or '', 'Bearer '+TOKEN):raise HTTPException(401,'认证失败')

def get_session(sid,profile="legacy"):
    if not sid or sid not in SESSIONS:
        if len(SESSIONS)>=32:raise HTTPException(503,'会话数量已满，请重启服务清理')
        sid=str(uuid.uuid4());SESSIONS[sid]={'vehicle':CabinVehicle() if profile=='slai' else Vehicle(),'history':[],'profile':profile}
    if SESSIONS[sid].get('profile','legacy')!=profile:raise HTTPException(409,'会话版本不匹配，请重新连接')
    return sid,SESSIONS[sid]

def run_agent(bot,messages,events):
    """Finish all tool calls in the current plan; avoid an unused confirmation pass."""
    stream=bot.run(messages)
    result=[]
    try:
        for result in stream:
            planned=sum(bool(m.get('function_call')) for m in result)
            completed=sum(m.get('role')=='function' for m in result)
            if events and planned and completed==planned:break
    finally:
        stream.close()
    return result

@app.get('/health')
def health(authorization:str=Header(default='')):
    auth(authorization);upstream=backend.health_status() if hasattr(backend,'health_status') else {};return {'ready':backend is not None and upstream.get('ready',True),'model':getattr(backend,'model_name','Qwen3-Omni-30B-A3B-Instruct'),'speech':(getattr(backend,'engine_info',None) or {}).get('speech_model','Qwen3-Omni native'),'busy':LOCK.locked() or upstream.get('busy',False),'build':BUILD,'profiles':getattr(backend,'supported_profiles',['legacy','slai']),'streaming_audio':hasattr(backend,'audio_sink'),'engine_info':getattr(backend,'engine_info',None)}
@app.post('/session')
def session(p:Payload,authorization:str=Header(default='')):
    auth(authorization);sid,s=get_session(p.session_id,p.profile);return {'session_id':sid,'state':s['vehicle'].state()}
@app.post('/reset')
def reset(p:Payload,authorization:str=Header(default='')):
    auth(authorization)
    if not LOCK.acquire(False):raise HTTPException(409,'本轮处理尚未结束')
    try:
        sid,s=get_session(p.session_id,p.profile);s['vehicle']=CabinVehicle() if p.profile=='slai' else Vehicle();s['history']=[];
        if hasattr(backend,'drop_session'):backend.drop_session(sid)
        return {'session_id':sid,'state':s['vehicle'].state()}
    finally:LOCK.release()

@app.post('/clear-history')
def clear_history(p:Payload,authorization:str=Header(default='')):
    auth(authorization)
    if not LOCK.acquire(False):raise HTTPException(409,'本轮处理尚未结束')
    try:
        sid,s=get_session(p.session_id,p.profile)
        if hasattr(backend,'drop_session'):backend.drop_session(sid)
        s['history']=[]
        audit(p.request_id or str(uuid.uuid4()),'history_cleared',{'session_id':sid,'state':s['vehicle'].state()})
        return {'session_id':sid,'state':s['vehicle'].state(),'history_cleared':True}
    finally:LOCK.release()

@app.post('/control')
def control(p:Payload,authorization:str=Header(default='')):
    auth(authorization)
    if p.profile!='slai':raise HTTPException(400,'此接口仅用于 SLAI 座舱')
    if not LOCK.acquire(False):raise HTTPException(409,'本轮处理尚未结束')
    try:
        sid,s=get_session(p.session_id,p.profile)
        try:result=s['vehicle'].apply(p.patch)
        except (ValueError,TypeError) as e:raise HTTPException(400,str(e))
        # Touch changes invalidate conversational state references.
        s['history']=[]
        if hasattr(backend,'drop_session'):backend.drop_session(sid)
        audit(str(uuid.uuid4()),'touch_control',{'session_id':sid,'patch':p.patch,'result':result})
        return {'session_id':sid,**result}
    finally:LOCK.release()

@app.post('/turn')
def turn(p:Payload,authorization:str=Header(default='')):
    auth(authorization)
    if backend is None:raise HTTPException(503,'模型尚未就绪')
    if not LOCK.acquire(False):raise HTTPException(409,'模型正忙，请稍后重试')
    t=time.monotonic();file=None;request_id=p.request_id or str(uuid.uuid4());events=[]
    emit=getattr(STREAM_CONTEXT,'emit',None)
    first_audio=[]
    def receive_audio(data):
        if not first_audio:
            first_audio.append(round(time.monotonic()-t,4))
            audit(request_id,'first_audio',{'seconds':first_audio[0],'sample_rate':data['sample_rate']})
        if emit:emit('audio',data)
    if hasattr(backend,'audio_sink'):backend.audio_sink=receive_audio
    backend.calls=0;backend.timings=[];backend.trace=[]
    backend.audit=lambda kind,data:audit(request_id,kind,data)
    try:
        if p.profile not in getattr(backend,'supported_profiles',['legacy','slai']):
            raise HTTPException(400,'当前后端不支持这个座舱版本')
        audit(request_id,'request',{'session_id':p.session_id,'input_type':'audio' if p.audio else 'text','text':p.text})
        sid,s=get_session(p.session_id,p.profile)
        if bool(p.audio)==bool(p.text):raise HTTPException(400,'须提供音频或文字，二选一')
        if hasattr(backend,'run_turn'):
            import sys,realtime_turn
            return realtime_turn.run(sys.modules[__name__],p,sid,s,events,request_id,t,emit)
        if p.audio:
            try:
                raw=base64.b64decode(p.audio,validate=True);samples,sr=sf.read(io.BytesIO(raw),dtype='float32')
                if samples.ndim!=1 or sr!=16000 or not .2<=len(samples)/sr<=20 or not np.isfinite(samples).all():raise ValueError('需要0.2–20秒的16kHz单声道WAV')
                if float(np.max(np.abs(samples)))<.0005:raise ValueError('录音为空或音量过低')
            except Exception as e:raise HTTPException(400,str(e))
            f=tempfile.NamedTemporaryFile(suffix='.wav',delete=False);f.write(raw);f.close();file=f.name
            audit(request_id,'audio_metadata',{'sha256':hashlib.sha256(raw).hexdigest(),'sample_rate':sr,'duration':len(samples)/sr,'rms':float(np.sqrt(np.mean(samples*samples)))})
            content=backend.transcribe(file)
        else:content=p.text
        audit(request_id,'interpreted_input',{'text':content,'state_before':s['vehicle'].state()})
        if p.profile=="slai":
            bot=Assistant(llm=backend,function_list=[CabinTool(s['vehicle'],events)],system_message=CABIN_PROMPT+json.dumps(s['vehicle'].state(),ensure_ascii=False))
        else:
            bot=Assistant(llm=backend,function_list=[CarTool(s['vehicle'],events)],system_message='你是深圳河套学院车载语音助手，可以自然聊天、查询状态或执行明确车控。先判断用户最新一句的意图。问候、致谢、闲聊、状态查询、否定命令和含糊表达均不调用工具。只有用户明确要求改变空调、温度、媒体音量、车窗或复位，才调用vehicle_control；只传用户要求修改的字段，不要复制整份当前状态。例：你好→你好，有什么可以帮你？（无工具）；现在几度→根据当前状态回答（无工具）；不要开窗→好的，保持车窗不变（无工具）；调一下→询问调什么（无工具）；我有点冷→询问想调到几度（无工具）。明确操作必须实际调用工具，不可只口头说已完成。工具拒绝时不能声称成功。未知功能说明暂不支持。澄清问题时只列出空调、温度、媒体音量、车窗，不推荐座椅、按摩、天窗等未实现的功能。答复用一两句中文，不要分析过程。用户提到的目标、否定或假设不能当作当前事实。否定或取消操作禁止改变现状，也不代表设备当前处于相反状态。例如当前空调开启时，“先别开空调”仍须保留开启，不能说“保持空调关闭”；当前车窗打开时，“不要打开车窗”仍须保留当前开度。对这类表达只回复“好的，保持现状。”，不附加任何开关或数值判断。查询状态时以以下状态数据为唯一事实，不能由用户的措辞推测状态：'+json.dumps(s['vehicle'].state(),ensure_ascii=False))
        messages=s['history']+[{'role':'user','content':content}]
        result=run_agent(bot,messages,events)
        audit(request_id,'agent_result',{'messages':result,'events':events})
        successes=[e for e in events if e['result'].get('ok')]
        if successes and p.profile=="slai":
            reply=cabin_confirmation(successes,s['vehicle'].state())
            if len(successes)!=len(events):reply+='另外，'+cabin_rejection(events)
        elif successes:
            first=successes[0]['result']['before'];after=s['vehicle'].state();parts=[]
            names={'ac_on':'空调','temperature':'温度','media_volume':'媒体音量','window_open':'车窗开度'}
            touched=set()
            for e in successes:
                args=e['arguments'];args=json.loads(args) if isinstance(args,str) else args
                if args.get('reset'):touched.update(names)
                touched.update('temperature' if k=='temperature_delta' else k for k in args)
            for k in names:
                if k not in touched:continue
                v=after[k]
                if k=='ac_on':parts.append('空调已'+('开启' if v else '关闭'))
                elif k=='temperature':parts.append(f'温度已设为{v:g}度')
                else:parts.append(f'{names[k]}已设为百分之{v:g}')
            reply='，'.join(parts)+'。'
            if len(successes)==1:
                args=successes[0]['arguments'];args=json.loads(args) if isinstance(args,str) else args
                if args=={'reset':True}:reply='已恢复初始设置。'
        else:
            reply=next((m.get('content','') for m in reversed(result) if m.get('role')=='assistant' and isinstance(m.get('content'),str) and m.get('content').strip()),'抱歉，我没听清，请再说一次。')
            if events:reply=cabin_rejection(events) if p.profile=='slai' else '本轮设置未执行，参数超出范围或格式无效。请重新说明。'
        if events:result.append({'role':'assistant','content':reply})
        state_seconds=time.monotonic()-t
        if emit:emit('state',{'request_id':request_id,'session_id':sid,'state':s['vehicle'].state(),'input_text':content,'agent_reply':reply,'state_seconds':round(state_seconds,3)})
        speech_text,wav=backend.speak(reply)
        if wav is None or not len(wav):raise RuntimeError('Omni未生成语音')
        audio=io.BytesIO();sf.write(audio,wav,24000,format='WAV',subtype='PCM_16')
        history_user={'role':'user','content':content}
        s['history'].extend([history_user]+result)
        # Retain whole turns so a tool response is never orphaned by truncation.
        users=[i for i,m in enumerate(s['history']) if m.get('role')=='user']
        if len(users)>3:s['history']=s['history'][users[-3]:]
        out={'request_id':request_id,'session_id':sid,'state':s['vehicle'].state(),'reply':speech_text,'agent_reply':reply,'events':events,'audio':base64.b64encode(audio.getvalue()).decode(),'timings':backend.timings,'state_seconds':round(state_seconds,3),'total_seconds':round(time.monotonic()-t,3),'model':getattr(backend,'model_name','Qwen3-Omni-30B-A3B-Instruct'),'build':BUILD,'input_text':content,'trace':backend.trace}
        out['first_audio_seconds']=first_audio[0] if first_audio else None
        out['engine_info']=getattr(backend,'engine_info',None)
        audit(request_id,'completed',{'state_after':out['state'],'events':events,'reply':speech_text,'expected_reply':reply,'total_seconds':out['total_seconds']})
        log={k:v for k,v in out.items() if k!='audio'};log['timestamp']=time.time()
        with (RUN/'turns.jsonl').open('a') as f:f.write(json.dumps(log,ensure_ascii=False)+'\n')
        return out
    except HTTPException as e:
        audit(request_id,'rejected',{'status':e.status_code,'detail':e.detail})
        raise
    except Exception as e:
        audit(request_id,'error',{'error':str(e),'events':events})
        traceback.print_exc()
        with (RUN/'errors.jsonl').open('a') as f:f.write(json.dumps({'request_id':request_id,'error':str(e),'events':events},ensure_ascii=False)+'\n')
        # A failed speech stage must not hide already-executed state changes.
        raise HTTPException(500,{'error':str(e),'state':s['vehicle'].state(),'events':events,'request_id':request_id})
    finally:
        if file:Path(file).unlink(missing_ok=True)
        backend.audit=None
        if hasattr(backend,'audio_sink'):backend.audio_sink=None
        if hasattr(backend,'text_sink'):backend.text_sink=None
        LOCK.release()

@app.post('/turn-stream')
def turn_stream(p:Payload,authorization:str=Header(default='')):
    from fastapi.responses import StreamingResponse
    auth(authorization)
    if not hasattr(backend,'audio_sink'):raise HTTPException(503,'当前推理后端不支持分块语音')
    q=queue.Queue()
    def emit(kind,data):q.put({'type':kind,'data':data})
    def work():
        STREAM_CONTEXT.emit=emit
        try:
            result=turn(p,authorization)
            result.pop('audio',None)
            emit('done',result)
        except HTTPException as e:emit('error',{'status':e.status_code,'detail':e.detail})
        except Exception as e:emit('error',{'status':500,'detail':str(e)})
        finally:STREAM_CONTEXT.emit=None;q.put(None)
    threading.Thread(target=work,daemon=True).start()
    def chunks():
        while True:
            try:item=q.get(timeout=10)
            except queue.Empty:
                yield b'\n';continue
            if item is None:break
            yield (json.dumps(item,ensure_ascii=False)+'\n').encode()
    return StreamingResponse(chunks(),media_type='application/x-ndjson',headers={'Cache-Control':'no-store','X-Accel-Buffering':'no'})

if __name__=='__main__':
    from omni_backend import OmniBackend
    import uvicorn
    backend=OmniBackend('/mnt/afs/models/Qwen3-Omni-30B-A3B-Instruct')
    port=int(os.environ.get('VEHICLE_PORT','18765'))
    endpoint={'host':socket.gethostbyname(socket.gethostname()),'port':port,'token':TOKEN,'pid':os.getpid(),'started':time.time()}
    path=RUN/'endpoint.json';path.write_text(json.dumps(endpoint));path.chmod(0o600)
    print('VEHICLE_MODEL_READY',endpoint['host'],port,flush=True)
    uvicorn.run(app,host='0.0.0.0',port=port,log_level='info')
