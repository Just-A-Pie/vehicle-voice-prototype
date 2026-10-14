"""Native Realtime function calling, with per-cockpit connections and local tools."""
import base64,json,time
from urllib.parse import urlparse,urlencode
import websocket

STYLE='''你是车内的语音助手，用自然、轻松的普通话交流，不是播音员。回复简短，不自我介绍，不列举功能，不念参数名或“开度”。
问候只简短打招呼，例如“你好呀。”，不主动发起闲聊。禁止编造天气、行程、环境或用户心情。执行成功后立即结束回复，只说本次执行结果。禁止主动建议或询问其他操作，禁止追加“还需要什么”“要不要打开空调”等服务推销式问题；只有当前指令缺少必要参数或存在歧义才能追问。开窗只确认车窗，不联想空调；调整温度只确认温度，不推荐音乐或其他功能。执行成功只说本次结果，不追加“通风效果不错”等评价。明确车控先调用工具，收到成功结果后再简短确认，不能提前声称已完成。
每一轮新的操作都必须重新调用工具，上一轮工具结果不能代表本轮已执行。切到制冷必须调用control_cabin(climateMode="cool")，切到制热用heat，只吹风用fan，自动模式用auto；不得仅口头答应。只改用户要求的项目。纯否定、取消、问候、查询不调用修改工具；“只吹风，不要制冷制热”包含明确通风要求，必须设置fan。查询以当前车辆状态为准。
结合对话理解省略句，例如刚讨论车窗后“一半”就是把刚讨论的车窗开到一半。
“开太多了”这类没有明确程度的要求自然确认，例如“那开一半，可以吗？”，不擅自修改；随后“一半”或同意即执行。
不支持的功能如实说明。工具拒绝时说明未执行，不谎称成功。用一句话回复，只有必要时才追问。
'''
class RealtimeAgent:
    audio_sink=None
    text_sink=None
    def __init__(self,endpoint):
        self.endpoint=endpoint;self.model_name=endpoint['speech_model'];self.sessions={}
        self.engine_info={'provider':'dashscope','mode':'native-realtime','model':self.model_name,'speech_model':self.model_name}
        self.audit=None;self.trace=[];self.timings=[]
    def drop_session(self,sid):
        old=self.sessions.pop(sid,None)
        if old:
            try:old['ws'].close(timeout=.1)
            except Exception:pass
    def run_turn(self,sid,tool,state,prompt,text='',pcm=None,on_state=None):
        start=time.monotonic();deadline=start+90;blocks=[];reply='';input_text=text;calls=set();round_calls=0;tool_count=0;usage=[];arrivals=[]
        old=self.sessions.get(sid)
        if old and (start-old['used']>90 or old['turns']>=16):self.drop_session(sid);old=None
        reused=old is not None;ws=old['ws'] if old else None
        def recv():
            if time.monotonic()>deadline:raise TimeoutError('Realtime 响应超时')
            raw=ws.recv()
            if not raw:raise RuntimeError('Realtime 连接中断')
            e=json.loads(raw)
            if e.get('code')=='AllocationQuota.FreeTierOnly':
                raise RuntimeError('免费额度已用完，服务已按免费额度限制停止；未开启付费调用。')
            if e.get('type')=='error':raise RuntimeError(str(e.get('error')))
            if not e.get('type'):
                raise RuntimeError('Realtime 服务拒绝请求：'+str(e.get('code','unknown')))
            return e
        def send(e):ws.send(json.dumps(e,ensure_ascii=False))
        try:
            if not ws:
                host=urlparse(self.endpoint['url']).netloc
                ws=websocket.create_connection('wss://'+host+'/api-ws/v1/realtime?'+urlencode({'model':self.model_name}),header=['Authorization: Bearer '+self.endpoint['token']],timeout=20)
                self.sessions[sid]={'ws':ws,'used':start,'turns':0}
                while recv()['type']!='session.created':pass
            config={'modalities':['text','audio'],'turn_detection':None,
                    'instructions':prompt+'\n'+STYLE+'\n当前车辆状态：'+json.dumps(state,ensure_ascii=False),
                    'tools':[{'type':'function','function':{'name':tool.name,'description':tool.description,'parameters':tool.parameters}}],
                    'audio':{'input':{'format':{'type':'pcm','sample_rate':16000,'sample_format':'s16le','channels':1,'packing':'interleaved','channel_layout':'mono'}},'output':{'voice':self.endpoint.get('voice','longanlingxin'),'format':{'type':'pcm','sample_rate':24000}}}}
            send({'type':'session.update','session':config})
            while recv()['type']!='session.updated':pass
            setup=time.monotonic()-start
            if pcm is not None:
                for offset in range(0,len(pcm),32000):send({'type':'input_audio_buffer.append','audio':base64.b64encode(pcm[offset:offset+32000]).decode()})
                send({'type':'input_audio_buffer.commit'})
                while True:
                    e=recv()
                    if e['type']=='input_audio_buffer.committed':break
            else:send({'type':'conversation.item.create','item':{'type':'message','role':'user','content':[{'type':'input_text','text':text}]}})
            send({'type':'response.create'})
            while True:
                e=recv();kind=e.get('type')
                if kind=='conversation.item.input_audio_transcription.completed':input_text=e.get('transcript','')
                elif kind=='response.function_call_arguments.done':
                    cid=e.get('call_id');name=e.get('name');args=e.get('arguments','')
                    if not cid:raise RuntimeError('工具调用缺少 ID')
                    if cid in calls:continue
                    calls.add(cid);tool_count+=1;round_calls+=1
                    if tool_count>4:raise RuntimeError('本轮工具调用过多')
                    if name!=tool.name:result=json.dumps({'ok':False,'error':'未知工具'},ensure_ascii=False)
                    else:result=tool.call(args)
                    if self.audit:self.audit('realtime_tool',{'call_id':cid,'name':name,'arguments':args,'result':result})
                    if on_state:on_state(input_text)
                    send({'type':'conversation.item.create','item':{'type':'function_call_output','call_id':cid,'output':result}})
                elif kind in ('response.audio_transcript.delta','response.text.delta'):
                    reply+=e.get('delta','')
                    if self.text_sink:self.text_sink({'text':reply,'input_text':input_text})
                elif kind=='response.audio.delta':
                    block=base64.b64decode(e['delta'],validate=True)
                    if len(block)%2:raise RuntimeError('不完整的PCM音频块')
                    if not block:continue
                    blocks.append(block);arrivals.append({'seconds':round(time.monotonic()-start,4),'samples':len(block)//2})
                    if self.audio_sink:self.audio_sink({'pcm':e['delta'],'sample_rate':24000,'channels':1,'sequence':len(blocks)-1})
                elif kind=='response.done':
                    r=e.get('response',{});usage.append(r.get('usage'))
                    if r.get('status')!='completed':raise RuntimeError('Realtime 未完成：'+str(r.get('status_details',r.get('status'))))
                    if round_calls:
                        round_calls=0;send({'type':'response.create'});continue
                    break
            if not blocks:raise RuntimeError('Realtime 未返回语音')
            self.sessions[sid]['used']=time.monotonic();self.sessions[sid]['turns']+=1
            self.timings=[{'stage':'realtime_setup','seconds':round(setup,3)},{'stage':'realtime_total','seconds':round(time.monotonic()-start,3)}]
            self.trace=[{'stage':'realtime','connection_reused':reused,'input_text':input_text,'output':reply,'audio_chunks':arrivals,'usage':usage}]
            if self.audit:self.audit('realtime_completed',self.trace[0])
            return {'reply':reply,'input_text':input_text,'pcm':b''.join(blocks)}
        except Exception as exc:
            self.drop_session(sid)
            raise RuntimeError(str(exc).replace(self.endpoint['token'],'[redacted]')) from None
