"""macOS demo supervisor. Owns only this checkout's processes; no GPU jobs."""
import argparse,fcntl,json,os,signal,socket,subprocess,sys,threading,time,urllib.request,webbrowser
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];RUN=ROOT/'runtime';CONFIG=RUN/'demo-settings.json'
sys.path.insert(0,str(ROOT))
import connection_settings
CLIENT=urllib.request.build_opener(urllib.request.ProxyHandler({}))
STOP=threading.Event();children={};logs=[]

def write(path,data):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
 with os.fdopen(fd,'w') as stream:json.dump(data,stream,ensure_ascii=False,indent=2)

def settings():
 if not CONFIG.exists():raise ValueError('Run install.command first, then fill runtime/demo-settings.json.')
 return json.loads(CONFIG.read_text())

def check(cfg):
 import importlib.metadata
 for package in ('numpy','soundfile','fastapi','pydantic','uvicorn','qwen-agent','websocket-client'):importlib.metadata.version(package)
 import agent_service,checkpoint48.backend,optimized.realtime_agent  # Verify transitive imports too.
 if cfg.get('default_profile') not in ('api','checkpoint48'):raise ValueError('default_profile must be api or checkpoint48')
 ports=[cfg['web_port']]
 enabled=[]
 for profile in ('api','checkpoint48'):
  values=cfg[profile]
  if not values['enabled']:continue
  enabled.append(profile);ports.append(values['gateway_port'])
  if profile=='checkpoint48':
   ports.append(values['tunnel_port'])
   if not values['ssh_target'] or values['ssh_target'].startswith('-') or not values['remote_endpoint'].startswith('/'):
    raise ValueError('Fill checkpoint48.ssh_target and its absolute remote_endpoint path.')
   if values.get('ssh_key') and not Path(values['ssh_key']).expanduser().is_file():raise ValueError('SSH key file does not exist on this Mac.')
  else:
   from urllib.parse import urlsplit
   u=urlsplit(values['base_url'])
   if u.scheme!='https' or not (u.hostname or '').endswith('.aliyuncs.com') or u.username or u.password or u.query or u.fragment:raise ValueError('API base_url must be an official aliyuncs.com HTTPS URL.')
   if not values.get('usage_authorized'):raise ValueError('Confirm API usage authorization in api.usage_authorized.')
   key=RUN/'dashscope.key'
   if not os.environ.get('DASHSCOPE_API_KEY'):
    if not key.is_file() or not key.read_text().strip():raise ValueError('Set DASHSCOPE_API_KEY or create runtime/dashscope.key.')
    if key.stat().st_mode&0o077:raise ValueError('Run chmod 600 runtime/dashscope.key.')
 if cfg['default_profile'] not in enabled:raise ValueError('The default model must be enabled.')
 if any(type(p)!=int or not 1024<=p<=65535 for p in ports) or len(ports)!=len(set(ports)):raise ValueError('Ports must be distinct integers from 1024 to 65535.')
 return ports

def health(profile):
 try:
  c=json.loads((RUN/connection_settings.PROFILES[profile]).read_text())
  req=urllib.request.Request(f"http://127.0.0.1:{c['local_port']}/health",headers={'Authorization':'Bearer '+c['token']})
  with CLIENT.open(req,timeout=5) as response:h=json.load(response)
  return {'profile':profile,'ready':bool(h.get('ready')),'model':h.get('model'),'busy':h.get('busy'),'history':h.get('engine_info',{}).get('history_mode','backend default')}
 except Exception:return {'profile':profile,'ready':False}

def rpc_ready():
 try:
  c=json.loads((RUN/'connection-checkpoint48-rpc.json').read_text())
  req=urllib.request.Request(f"http://127.0.0.1:{c['local_port']}/health",headers={'Authorization':'Bearer '+c['token']})
  with CLIENT.open(req,timeout=2) as response:h=json.load(response)
  return h.get('ready') and h.get('step')==48
 except Exception:return False

def spawn(name,script,env):
 stream=(RUN/(name+'.log')).open('a');logs.append(stream)
 children[name]=subprocess.Popen([sys.executable,'-u',str(ROOT/script)],cwd=ROOT,env=env,stdout=stream,stderr=stream,start_new_session=True)

def start(cfg):
 ports=check(cfg);RUN.mkdir(exist_ok=True)
 lock=(RUN/'demo.lock').open('a')
 try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 except BlockingIOError:raise ValueError('This demo is already running; use stop.command first.')
 for port in ports:
  with socket.socket() as sock:
   try:sock.bind(('127.0.0.1',port))
   except OSError:raise ValueError(f'Port {port} is already in use; change demo-settings.json or stop its owner.')
 stopfile=RUN/'demo.stop';stopfile.unlink(missing_ok=True)
 selection=connection_settings.selection_path(RUN/'connection-demo.json')
 if not selection.exists() or json.loads(selection.read_text()).get('profile') not in [k for k in ('api','checkpoint48') if cfg[k]['enabled']]:write(selection,{'profile':cfg['default_profile']})
 env=dict(os.environ,VEHICLE_LOCAL_PORT=str(cfg['web_port']),VEHICLE_CONNECTION_FILE=str(RUN/'connection-demo.json'),VEHICLE_API_PORT=str(cfg['api']['gateway_port']),VEHICLE_CHECKPOINT_PORT=str(cfg['checkpoint48']['gateway_port']))
 for signum in (signal.SIGINT,signal.SIGTERM):signal.signal(signum,lambda *_:STOP.set())
 try:
  if cfg['api']['enabled']:
   write(RUN/'api-settings.json',{k:v for k,v in cfg['api'].items() if k not in ('enabled','gateway_port')})
   spawn('demo-api','api_gateway.py',env)
  if cfg['checkpoint48']['enabled']:spawn('demo-tunnel','scripts/demo_connect.py',env)
  spawn('demo-web','local_server.py',env)
  write(RUN/'demo-process.json',{'pid':os.getpid(),'root':str(ROOT),'web_port':cfg['web_port']})
  url=f"http://127.0.0.1:{cfg['web_port']}/slai/";print('页面：'+url+'\n请保持这个终端窗口打开。Ctrl+C 或 stop.command 停止本项目。',flush=True)
  opened=False;last=None;attempts=0
  while not STOP.wait(2) and not stopfile.exists():
   if children['demo-web'].poll() is not None:raise RuntimeError('Web proxy exited; see runtime/demo-web.log')
   gateway=children.get('demo-checkpoint')
   if cfg['checkpoint48']['enabled'] and (gateway is None or gateway.poll() is not None) and attempts<3 and rpc_ready():
    spawn('demo-checkpoint','checkpoint48/gateway.py',env);attempts+=1
   status=[health(p) for p in ('api','checkpoint48') if cfg[p]['enabled']]
   state=json.dumps(status,ensure_ascii=False)
   if state!=last:print(state,flush=True);last=state
   if not opened:
    try:
     with CLIENT.open(url,timeout=2) as r:opened=r.status==200
     if opened and cfg.get('open_browser',True):webbrowser.open(url)
    except OSError:pass
 finally:
  for process in children.values():
   if process.poll() is None:process.terminate()
  for process in children.values():
   try:process.wait(timeout=10)
   except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL)
  for stream in logs:stream.close()
  (RUN/'demo-process.json').unlink(missing_ok=True);stopfile.unlink(missing_ok=True)
  lock.close()

def main():
 parser=argparse.ArgumentParser();parser.add_argument('action',choices=['init','check','start','stop','status']);args=parser.parse_args();RUN.mkdir(exist_ok=True)
 if args.action=='init':
  if not CONFIG.exists():write(CONFIG,json.loads((ROOT/'config/demo.example.json').read_text()))
  print('配置文件：'+str(CONFIG));return
 if args.action=='stop':
  lock=(RUN/'demo.lock').open('a')
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);print('本项目没有运行中的展示服务。')
  except BlockingIOError:(RUN/'demo.stop').touch();print('已请求停止本项目展示服务。')
  finally:lock.close()
  return
 cfg=settings()
 if args.action=='status':
  print(json.dumps([health(p) for p in ('api','checkpoint48') if cfg[p]['enabled']],ensure_ascii=False,indent=2));return
 if args.action=='check':check(cfg);print('客户端依赖和配置检查通过；服务器权限、模型就绪和麦克风还需实测。');return
 start(cfg)
if __name__=='__main__':
 try:main()
 except Exception as error:print('启动失败：'+str(error),file=sys.stderr);sys.exit(1)
