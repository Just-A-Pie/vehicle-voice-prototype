import sys,json,socket,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
import agent_service as svc
from server_omni25_opt.native_backend import NativeBackend
from small_model_eval.backend import IDENTITY
import uvicorn,soundfile as sf
import os
svc.backend=NativeBackend(os.environ['VEHICLE_MODEL_PATH'])
svc.CABIN_PROMPT=(ROOT/'small_model_eval/compact_prompt.txt').read_text()
svc.BUILD='native3b-single-decision-v1-20261014'
out=ROOT/'evidence/optimized-3b-20261008';out.mkdir(parents=True,exist_ok=True)
warm_audio=Path(os.environ.get('VEHICLE_WARMUP_AUDIO',str(ROOT/'small_model_eval/fixtures/c010.wav')))
for i in range(3):
 user=[{'type':'audio','audio':str(warm_audio)}] if i==2 and warm_audio.exists() else '请说你好。'
 t=time.monotonic();text,wav=svc.backend.generate([{'role':'system','content':IDENTITY},{'role':'user','content':user}],audio=True,force_text='你好。')
 sf.write(out/f'warm-{i}.wav',wav,24000)
 print('WARM',text,time.monotonic()-t,svc.backend.parts,flush=True)
endpoint=ROOT/'runtime/endpoint.json';endpoint.parent.mkdir(exist_ok=True)
endpoint.write_text(json.dumps({'host':socket.gethostbyname(socket.gethostname()),'port':18825,'token':svc.TOKEN}));endpoint.chmod(0o600)
print('OPT_READY',flush=True)
uvicorn.run(svc.app,host='0.0.0.0',port=18825)
