"""Bounded real-3B comparison; development smoke cases, not a blind benchmark."""
import argparse
import importlib.util
import json
import os
import sys
import time
from pathlib import Path
import numpy as np
import soundfile as sf

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from cabin import CabinVehicle
from agent_service import CabinTool
from server_omni25_opt.native_backend import NativeBackend

CASES=[
    ('rear','右后车窗打开一半',{}, {'rearRightWindow':50},None),
    ('scope','打开所有车门和前排车窗',{}, {'doors':100,'leftWindow':100,'rightWindow':100},None),
    ('decimal','把温度设为21.5度',{}, {'temp':21.5},None),
    ('negative','不要打开车窗',{'windows':50},None,None),
    ('unmute','取消静音',{'muted':True},{'muted':False},None),
    ('query','现在设定温度是多少',{'temp':23.5},None,None),
    ('greeting','你好',{},None,None),
    ('out_of_range','把温度设为100度',{},None,None),
    ('audio_rear','',{}, {'rearRightWindow':50},'c035'),
    ('audio_decimal','',{}, {'temp':21.5},'c010'),
    ('audio_negative','',{'doors':50},None,'c096'),
]

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--model',required=True)
    p.add_argument('--baseline',type=Path)
    p.add_argument('--output',type=Path,required=True)
    args=p.parse_args();args.output.mkdir(parents=True,exist_ok=True)
    os.environ['VEHICLE_SINGLE_CALL_EVIDENCE_DIR']=str(args.output/'audio')
    baseline=None
    if args.baseline:
        spec=importlib.util.spec_from_file_location('single_call_baseline',args.baseline)
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        baseline=module.NativeBackend.run_turn
    start=time.monotonic();backend=NativeBackend(args.model)
    print('LOADED',round(time.monotonic()-start,3),flush=True)
    # Warm speech and decoder before timing either path.
    backend.generate([{'role':'system','content':'你是语音助手。'},{'role':'user','content':'请说你好。'}],audio=True,force_text='你好。')
    collected=[]
    prompt=(ROOT/'small_model_eval/compact_prompt.txt').read_text()
    for index,(name,text,setup,expected_patch,fixture) in enumerate(CASES):
        modes=['new','old'] if index%2==0 else ['old','new']
        if baseline is None:modes=['new']
        for mode in modes:
            vehicle=CabinVehicle()
            if setup:vehicle.apply(setup)
            before=vehicle.state();oracle=CabinVehicle();oracle.values=before.copy()
            if expected_patch:oracle.apply(expected_patch)
            pcm=None
            if fixture:
                x,sr=sf.read(ROOT/'small_model_eval/fixtures'/f'{fixture}.wav',dtype='float32')
                assert sr==16000 and x.ndim==1
                pcm=np.clip(np.rint(x*32768),-32768,32767).astype('<i2').tobytes()
            events=[];audit=[];state_at=[];backend.sessions={};backend.calls=0;backend.trace=[];backend.timings=[]
            backend.audit=lambda kind,data:audit.append({'kind':kind,**data})
            backend.audio_sink=None;backend.text_sink=None
            began=time.monotonic();error=None;result={}
            try:
                callback=lambda *a,**k:state_at.append(time.monotonic()-began)
                if mode=='new':result=backend.run_turn(name,CabinTool(vehicle,events),before,prompt,text=text,pcm=pcm,on_state=callback,request_id=f'{mode}-{name}')
                else:result=baseline(backend,name,CabinTool(vehicle,events),before,prompt,text=text,pcm=pcm,on_state=callback)
            except Exception as exc:error=f'{type(exc).__name__}: {exc}'
            duration=time.monotonic()-began
            correct=vehicle.state()==oracle.state() and bool(events)==bool(expected_patch) and all(e['result'].get('ok') for e in events)
            # Check explicitly supplied fields, not just final state. Extra
            # idempotent writes must not disappear from the evaluation.
            expected_keys=set(expected_patch or {})
            def expanded(keys):
                out=set()
                for key in keys:
                    out.update(['leftWindow','rightWindow','rearLeftWindow','rearRightWindow'] if key=='windows' else ['leftDoor','rightDoor','rearLeftDoor','rearRightDoor'] if key=='doors' else [key])
                return out
            actual_keys=set()
            for e in events:
                data=json.loads(e['arguments']) if isinstance(e['arguments'],str) else e['arguments']
                actual_keys.update(data)
            fields_ok=expanded(actual_keys)==expanded(expected_keys)
            protocol_ok=mode=='old' or result.get('decision_status') in {'success','no_action'}
            reply_ok=bool(result.get('reply'))
            if name=='query':reply_ok=reply_ok and any(x in result['reply'] for x in ['23.5','二十三点五','二十三度半'])
            basic_pass=error is None and correct and fields_ok and protocol_ok and reply_ok
            row={'case':name,'mode':mode,'input_type':'synthetic_audio' if fixture else 'text',
                 'text':text,'fixture':fixture,'before':before,'expected_state':oracle.state(),
                 'state':vehicle.state(),'events':events,'reply':result.get('reply'),
                 'decision_status':result.get('decision_status'),'semantic_model_calls':result.get('semantic_model_calls'),
                 'speech_model_calls':result.get('speech_model_calls'),'error':error,
                 'state_correct':correct,'explicit_fields_correct':fields_ok,'protocol_ok':protocol_ok,
                 'reply_basic_check':reply_ok,'basic_case_pass':basic_pass,
                 'state_seconds':state_at[-1] if state_at else None,'complete_seconds':duration,
                 'trace':backend.trace,'audit':audit}
            collected.append(row)
            with (args.output/'results.jsonl').open('a') as f:f.write(json.dumps(row,ensure_ascii=False)+'\n')
            if result.get('pcm'):
                sf.write(args.output/f'{mode}-{name}-reply.wav',np.frombuffer(result['pcm'],dtype='<i2'),24000,subtype='PCM_16')
            print(json.dumps({k:row[k] for k in ['case','mode','error','state_correct','explicit_fields_correct','basic_case_pass','decision_status','state_seconds','complete_seconds']},ensure_ascii=False),flush=True)
    summary={'model':args.model,'scope':'11 development inputs; same loaded BF16 model; alternating order; synthetic input audio; one run per case; no browser/acoustic latency test','modes':{}}
    for mode in ['old','new']:
        group=[r for r in collected if r['mode']==mode]
        if not group:continue
        summary['modes'][mode]={'requests':len(group),'completed':sum(r['error'] is None for r in group),
            'basic_case_pass':sum(r['basic_case_pass'] for r in group),
            'state_and_fields_correct':sum(r['state_correct'] and r['explicit_fields_correct'] for r in group),
            'median_state_seconds':float(np.median([r['state_seconds'] for r in group if r['state_seconds'] is not None])),
            'median_complete_seconds':float(np.median([r['complete_seconds'] for r in group]))}
    (args.output/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
    print('COMPLETE',json.dumps(summary,ensure_ascii=False),flush=True)

if __name__=='__main__':main()
