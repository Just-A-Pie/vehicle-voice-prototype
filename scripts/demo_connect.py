"""Reconnect a configured checkpoint RPC tunnel; never submit or replay a turn."""
import json,os,shlex,signal,subprocess,threading,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];stop=threading.Event();child=None
config=json.loads((ROOT/'runtime/demo-settings.json').read_text())['checkpoint48']
target=config['ssh_target'];remote=config['remote_endpoint'];port=int(config['tunnel_port'])
if not target or target.startswith('-') or not remote.startswith('/'):raise ValueError('Invalid SSH target/endpoint configuration')
ssh=['ssh','-o','BatchMode=yes','-o','ConnectTimeout=8']
if config.get('ssh_port'):ssh+=['-p',str(config['ssh_port'])]
if config.get('ssh_key'):ssh+=['-i',str(Path(config['ssh_key']).expanduser())]
client=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def finish(*_):
 stop.set()
 if child is not None:child.terminate()
signal.signal(signal.SIGTERM,finish);signal.signal(signal.SIGINT,finish)
while not stop.is_set():
 try:
  endpoint=json.loads(subprocess.check_output(ssh+['-o','ClearAllForwardings=yes',target,'cat '+shlex.quote(remote)],timeout=15,stderr=subprocess.DEVNULL))
  host=endpoint['host'];remote_port=int(endpoint['port'])
  if not isinstance(host,str) or any(c in host for c in '\r\n /') or not 1<=remote_port<=65535:raise ValueError('Invalid endpoint')
  child=subprocess.Popen(ssh+['-N','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2','-L',f'127.0.0.1:{port}:{host}:{remote_port}',target])
  failed=0
  while child.poll() is None and not stop.wait(2):
   try:
    req=urllib.request.Request(f'http://127.0.0.1:{port}/health',headers={'Authorization':'Bearer '+endpoint['token']})
    with client.open(req,timeout=3) as response:h=json.load(response)
    if not h.get('ready') or h.get('step')!=48 or h.get('prompt_version')!='vehicle_tool_messages_v3':raise ValueError('Checkpoint service not ready or incompatible')
    p=ROOT/'runtime/connection-checkpoint48-rpc.json';tmp=p.with_suffix('.tmp')
    with os.fdopen(os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600),'w') as f:json.dump({'local_port':port,'token':endpoint['token']},f)
    os.replace(tmp,p);failed=0
   except Exception:
    failed+=1
    if failed>=2:child.terminate();break
  child.wait()
 except Exception as e:print('SSH/RPC not ready: '+type(e).__name__,flush=True)
 stop.wait(5)
