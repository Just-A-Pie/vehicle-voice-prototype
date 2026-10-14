"""Configurable SSH proxy; never submits jobs or replays user requests."""
import json
import os
import shlex
import signal
import subprocess
import threading
import urllib.request
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
target=os.environ['VEHICLE_SSH_TARGET']
remote=os.environ['VEHICLE_REMOTE_ENDPOINT']
port=int(os.environ.get('VEHICLE_TUNNEL_PORT','18841'))
config=Path(os.environ.get('VEHICLE_CONNECTION_FILE',str(ROOT/'runtime/connection.json')))
expected=os.environ.get('VEHICLE_EXPECT_BUILD','native3b-single-decision-v1-20261014')
ssh=['ssh','-o','BatchMode=yes','-o','ConnectTimeout=8','-p',os.environ.get('VEHICLE_SSH_PORT','22')]
if os.environ.get('VEHICLE_SSH_KEY'):ssh+=['-i',os.environ['VEHICLE_SSH_KEY']]
stop=threading.Event();child=None
def end(*args):
    stop.set()
    if child is not None:child.terminate()
signal.signal(signal.SIGINT,end);signal.signal(signal.SIGTERM,end)
config.parent.mkdir(parents=True,exist_ok=True)
while not stop.is_set():
    try:
        endpoint=json.loads(subprocess.check_output(ssh+[target,'cat '+shlex.quote(remote)],timeout=15,stderr=subprocess.DEVNULL))
        child=subprocess.Popen(ssh+['-N','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2','-L',f'127.0.0.1:{port}:{endpoint["host"]}:{int(endpoint["port"])}',target])
        failed=0
        while child.poll() is None and not stop.wait(5):
            try:
                req=urllib.request.Request(f'http://127.0.0.1:{port}/health',headers={'Authorization':'Bearer '+endpoint['token']})
                with urllib.request.urlopen(req,timeout=3) as r:health=json.load(r)
                if not health.get('ready') or health.get('build')!=expected:raise ValueError('Backend not ready or build mismatch')
                tmp=config.with_suffix('.tmp')
                with os.fdopen(os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600),'w') as f:json.dump({'local_port':port,'token':endpoint['token']},f)
                os.replace(tmp,config);failed=0
            except Exception:
                failed+=1
                if failed>=2:child.terminate();break
        child.wait()
    except Exception as exc:print(type(exc).__name__,flush=True)
    stop.wait(5)
