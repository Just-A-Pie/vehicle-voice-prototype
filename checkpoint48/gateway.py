"""Local simulator gateway; models remain on the remote GPU service."""
import json,os,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
import agent_service as svc
from checkpoint48.backend import CheckpointBackend
import uvicorn
svc.RUN=ROOT/'runtime/checkpoint48';svc.RUN.mkdir(exist_ok=True)
svc.BUILD='vehicle-checkpoint48-no-history-tools-v1'
connection=ROOT/'runtime/connection-checkpoint48-rpc.json'
svc.backend=CheckpointBackend(json.loads(connection.read_text()),connection)
port=int(os.environ.get('VEHICLE_CHECKPOINT_PORT','18748'))
path=ROOT/'runtime/connection-checkpoint48.json'
fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as f:json.dump({'local_port':port,'token':svc.TOKEN},f)
uvicorn.run(svc.app,host='127.0.0.1',port=port)
