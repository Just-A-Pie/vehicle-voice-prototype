"""Write a same-machine UI proxy config without printing the service token."""
import argparse
import json
import os
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser()
p.add_argument('--endpoint',type=Path,default=ROOT/'runtime/endpoint.json')
p.add_argument('--output',type=Path,default=ROOT/'runtime/connection.json')
args=p.parse_args();endpoint=json.loads(args.endpoint.read_text())
args.output.parent.mkdir(parents=True,exist_ok=True)
tmp=args.output.with_suffix('.tmp')
with os.fdopen(os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600),'w') as f:
    json.dump({'local_port':int(endpoint['port']),'token':endpoint['token']},f)
os.replace(tmp,args.output)
print('Local proxy connection configured; token not displayed.')
