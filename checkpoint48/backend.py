"""Native v3 tool-message adapter. Model output is never repaired or replaced."""
import base64,copy,io,json,re,time,urllib.request,uuid
from pathlib import Path
import numpy as np
import soundfile as sf
from assistant_identity import PROMPT as IDENTITY_PROMPT, VERSION as IDENTITY_VERSION
from cabin import CabinVehicle

BUNDLE=Path(__file__).parent/'prompt_assets/vehicle_tool_messages_v3'
MODEL='AudioTrain-Qwen3-ASR-0.6B-vehicle-checkpoint-48'

def strict_object(pairs):
 out={}
 for key,value in pairs:
  if key in out:raise ValueError('模型JSON含重复字段')
  out[key]=value
 return out

def parse_output(text):
 text=text.strip()
 if '<tool_call>' in text or '</tool_call>' in text:
  match=re.fullmatch(r'<tool_call>\s*(.*?)\s*</tool_call>',text,re.S)
  if not match:raise ValueError('模型工具调用格式异常，本轮未执行新的操作')
  call=json.loads(match[1],object_pairs_hook=strict_object,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('非法数值')))
  if not isinstance(call,dict) or set(call)!={'name','arguments'} or call['name']!='control_cabin' or not isinstance(call['arguments'],dict) or not call['arguments']:
   raise ValueError('模型返回未知工具或无效参数，本轮未执行新的操作')
  return call,None
 if not text or re.search(r'<\|[^>]+\|>|</?(?:think|tool_response)',text):raise ValueError('模型回复为空或包含异常协议标记')
 return None,text

def build_system(state):
 fixed='\n\n'.join((BUNDLE/name).read_text().strip() for name in ('system.txt','task.txt'))
 return fixed+'\n\n'+IDENTITY_PROMPT+'\n\n当前座舱状态（环境数据，不是用户原话）：\n'+json.dumps(state,ensure_ascii=False,separators=(',',':'),allow_nan=False)

class CheckpointBackend:
 audio_sink=None;text_sink=None;audit=None
 supported_profiles=['slai'];supports_request_id=True
 def __init__(self,connection,connection_file=None):
  self.connection=connection;self.connection_file=connection_file;self.client=urllib.request.build_opener(urllib.request.ProxyHandler({}));self.sessions={};self.seen=set()
  self.model_name=MODEL;self.timings=[];self.trace=[]
  health=self.rpc('/health')
  if health.get('step')!=48 or health.get('prompt_version')!='vehicle_tool_messages_v3':raise ValueError('加载的不是指定checkpoint或协议')
  self.engine_info={'provider':'local-checkpoint','mode':'native-tool-messages','model':MODEL,'speech_model':'Kokoro-82M-v1.1-zh','prompt_version':'vehicle_tool_messages_v3','checkpoint':health['checkpoint'],'native_precision':health['native_precision'],'identity_prompt_version':IDENTITY_VERSION,'history_mode':'disabled','state_context':'current-full-state'}
 def rpc(self,path,data=None,timeout=180):
  connection=json.loads(Path(self.connection_file).read_text()) if self.connection_file else self.connection
  req=urllib.request.Request('http://127.0.0.1:'+str(connection['local_port'])+path,data=None if data is None else json.dumps(data,ensure_ascii=False,allow_nan=False).encode(),headers={'Authorization':'Bearer '+connection['token'],'Content-Type':'application/json'})
  with self.client.open(req,timeout=timeout) as response:return json.load(response)
 def health_status(self):
  try:return self.rpc('/health',timeout=3)
  except Exception:return {'ready':False,'error':'GPU推理服务未连接'}
 def drop_session(self,sid):self.sessions.pop(sid,None)
 def generate(self,messages,stage):
  result=self.rpc('/generate',{'messages':messages})
  self.timings.append({'stage':stage,'seconds':result['seconds']});self.trace.append({'stage':stage,**result})
  if result.get('stop_reason')!='eos':raise ValueError('模型达到输出长度限制，本轮未执行新的操作')
  return parse_output(result['text'])
 def run_turn(self,sid,tool,state,prompt,text='',pcm=None,on_state=None,request_id=''):
  from single_call import DuplicateRequestError
  if request_id in self.seen:raise DuplicateRequestError('该请求已处理，不重复执行；请核对车况')
  if len(self.seen)>=10000:raise RuntimeError('测试服务请求额度已满，请重启服务')
  self.seen.add(request_id);self.timings=[];self.trace=[]
  if pcm is not None:
   asr=self.rpc('/transcribe',{'pcm':base64.b64encode(pcm).decode()});text=asr['text'].strip();self.timings.append({'stage':'checkpoint_asr','seconds':asr['seconds']})
  if not text:raise ValueError('没有识别到有效内容')
  # No prior user/assistant/tool messages: only this request and live cabin state.
  self.sessions.pop(sid,None)
  current=[{'role':'user','content':text}]
  messages=[{'role':'system','content':build_system(state)}]+current
  call,reply=self.generate(messages,'decision');calls=1
  if call:
   # Validate with the same simulator before dispatching; do not clamp or repair.
   validation=CabinVehicle();validation.values=state.copy();validation.apply(call['arguments'])
   cid='call_'+uuid.uuid4().hex[:12]
   assistant={'role':'assistant','content':'','tool_calls':[{'id':cid,'type':'function','function':call}]}
   # CabinTool delegates validation + atomic state transitions to the existing CabinVehicle.
   self.trace.append({'stage':'tool_request','request_id':request_id,'message':copy.deepcopy(assistant)})
   result=tool.call(json.dumps(call['arguments'],ensure_ascii=False,allow_nan=False))
   if getattr(tool,'events',None):tool.events[-1].update(tool_call_id=cid,request_id=request_id)
   feedback={'role':'tool','tool_call_id':cid,'name':'control_cabin','content':result}
   self.trace.append({'stage':'tool_result','request_id':request_id,'message':copy.deepcopy(feedback)})
   current.extend([assistant,feedback]);messages.extend([assistant,feedback])
   if self.audit:self.audit('checkpoint_tool',{'call':call,'result':json.loads(result)})
   if on_state:on_state(text)
   confirmed=json.loads(result)
   if confirmed.get('ok') is not True:
    # Failure trajectories were not trained: report the executor's refusal directly.
    raise ValueError('执行器未确认成功，未生成成功回复：'+str(confirmed.get('error','请核对当前车况')))
   if set(confirmed)!={'ok','before','state','patch'} or set(confirmed['state'])!=set(state) or set(confirmed['before'])!=set(state):
    raise ValueError('执行回执不符合完整车况合同，请核对当前车况')
   another,reply=self.generate(messages,'post_tool_reply');calls+=1
   if another:raise ValueError('模型在反馈后再次调用工具，已阻止重复执行；请核对已确认车况')
  # The current tool receipt remains available for this request's final reply only.
  current.append({'role':'assistant','content':reply})
  if self.text_sink:self.text_sink({'text':reply,'input_text':text})
  if on_state:on_state(text,reply_text=reply)
  speech=self.rpc('/synthesize',{'text':reply});self.timings.append({'stage':'kokoro_tts','seconds':speech['seconds']})
  audio,sr=sf.read(io.BytesIO(base64.b64decode(speech['wav'],validate=True)),dtype='float32')
  if sr!=24000 or audio.ndim!=1 or not len(audio) or not np.isfinite(audio).all():raise ValueError('播报音频格式异常')
  raw=np.clip(np.rint(audio*32768),-32768,32767).astype('<i2').tobytes()
  for seq,start in enumerate(range(0,len(raw),9600)):
   if self.audio_sink:self.audio_sink({'pcm':base64.b64encode(raw[start:start+9600]).decode(),'sample_rate':24000,'channels':1,'sequence':seq})
  return {'reply':reply,'input_text':text,'pcm':raw,'protocol':'vehicle_tool_messages_v3','semantic_model_calls':calls,'speech_model_calls':1}
