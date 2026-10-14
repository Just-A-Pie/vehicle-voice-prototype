"""Service bridge for native Realtime; no separate ASR or speech-generation pass."""
import base64,io,json,time,hashlib
import numpy as np
import soundfile as sf

def run(service,p,sid,s,events,request_id,started,emit):
    backend=service.backend;pcm=None;first=[];state_at=[]
    if p.audio:
        try:
            raw=base64.b64decode(p.audio,validate=True);samples,sr=sf.read(io.BytesIO(raw),dtype='float32')
            if samples.ndim!=1 or sr!=16000 or not .2<=len(samples)/sr<=20 or not np.isfinite(samples).all():raise ValueError('需要0.2–20秒的16kHz单声道WAV')
            if np.max(np.abs(samples))<.0005:raise ValueError('录音为空或音量过低')
            pcm=np.clip(np.rint(samples*32768),-32768,32767).astype('<i2').tobytes()
        except Exception as e:raise service.HTTPException(400,str(e))
        service.audit(request_id,'audio_metadata',{'sha256':hashlib.sha256(raw).hexdigest(),'sample_rate':sr,'duration':len(samples)/sr})
    def state(input_text='',initial=False,reply_text=None):
        elapsed=round(time.monotonic()-started,3)
        if not initial:state_at.append(elapsed)
        reply=''
        if not initial and events:
            event=events[-1]
            if event['result'].get('ok'):
                reply=service.cabin_confirmation([event],s['vehicle'].state()) if p.profile=='slai' else '车辆设置已确认。'
                patch=event['result'].get('patch',{})
                if any(k.endswith('Window') or k.endswith('Door') for k in patch):
                    reply='门窗目标已确认。'
            else:
                reply='这项设置未执行。'
        if reply_text is not None:reply=reply_text
        if emit:emit('state',{'request_id':request_id,'session_id':sid,'state':s['vehicle'].state(),'input_text':input_text,'agent_reply':reply,'state_seconds':elapsed})
    def audio(chunk):
        if not first:
            first.append(round(time.monotonic()-started,4));service.audit(request_id,'first_audio',{'seconds':first[0]})
        if emit:emit('audio',chunk)
    backend.text_sink=lambda data: emit('transcript',data) if emit else None
    backend.audio_sink=audio
    state(p.text,initial=True)
    tool=service.CabinTool(s['vehicle'],events) if p.profile=='slai' else service.CarTool(s['vehicle'],events)
    prompt=service.CABIN_PROMPT if p.profile=='slai' else '控制模拟车辆，只修改明确要求的空调、温度、音量、车窗。'
    kwargs={'request_id':request_id} if getattr(backend,'supports_request_id',False) else {}
    try:
        result=backend.run_turn(sid,tool,s['vehicle'].state(),prompt,text=p.text,pcm=pcm,on_state=state,**kwargs)
    except Exception as exc:
        from single_call import DuplicateRequestError
        if isinstance(exc,DuplicateRequestError):
            raise service.HTTPException(409,{'error':str(exc),'state':s['vehicle'].state(),'session_id':sid,'request_id':request_id}) from exc
        raise
    buf=io.BytesIO();sf.write(buf,np.frombuffer(result['pcm'],dtype='<i2'),24000,format='WAV',subtype='PCM_16')
    out={'request_id':request_id,'session_id':sid,'state':s['vehicle'].state(),'reply':result['reply'],'agent_reply':result['reply'],'events':events,'audio':base64.b64encode(buf.getvalue()).decode(),'timings':backend.timings,'state_seconds':state_at[-1] if state_at else first[0],'first_audio_seconds':first[0],'total_seconds':round(time.monotonic()-started,3),'model':backend.model_name,'build':service.BUILD,'input_text':result['input_text'],'trace':backend.trace,'engine_info':backend.engine_info}
    out.update({k:result[k] for k in ('protocol','decision_status','semantic_model_calls','speech_model_calls') if k in result})
    service.audit(request_id,'completed',{'state_after':out['state'],'events':events,'reply':out['reply'],'total_seconds':out['total_seconds']})
    with (service.RUN/'turns.jsonl').open('a') as f:f.write(json.dumps({k:v for k,v in out.items() if k!='audio'},ensure_ascii=False)+'\n')
    return out
