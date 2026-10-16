"""UI and authenticated upstream proxy; loopback by default, explicit LAN opt-in."""
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from pathlib import Path
import json,os
from upstream_pool import UpstreamPool
import connection_settings
UPSTREAM=UpstreamPool()
ROOT=Path(__file__).parent
PORT=int(os.environ.get('VEHICLE_LOCAL_PORT','8765'))
BIND=os.environ.get('VEHICLE_LOCAL_BIND','127.0.0.1')
ALLOWED_ORIGINS={f'http://127.0.0.1:{PORT}',f'http://localhost:{PORT}'}
ALLOWED_ORIGINS.update(json.loads(os.environ.get('VEHICLE_ALLOWED_ORIGINS','[]')))
CONNECTION=Path(os.environ.get('VEHICLE_CONNECTION_FILE',str(ROOT/'runtime/connection.json')))
class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(ROOT/'web'),**kwargs)
    def log_message(self,fmt,*args):pass
    def reply(self,status,data):
        self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(data)
    def proxy(self):
        origin=self.headers.get('Origin')
        if origin and origin not in ALLOWED_ORIGINS:
            return self.reply(403,b'{"detail":"Origin rejected"}')
        if self.path=='/api/connection-settings':
            try:
                if self.command=='GET':result=connection_settings.read(CONNECTION)
                else:
                    if origin not in ALLOWED_ORIGINS:return self.reply(403,b'{}')
                    n=int(self.headers.get('Content-Length','0'))
                    if not 0<n<8192:return self.reply(413,b'{}')
                    data=json.loads(self.rfile.read(n))
                    if 'settings' in data and self.client_address[0] not in ('127.0.0.1','::1'):
                        return self.reply(403,json.dumps({'detail':'API参数请在主机本地设置；局域网可直接切换已配置模型。'},ensure_ascii=False).encode())
                    result=connection_settings.save(CONNECTION,data)
                return self.reply(200,json.dumps(result,ensure_ascii=False).encode())
            except ValueError as exc:return self.reply(400,json.dumps({'detail':str(exc)},ensure_ascii=False).encode())
            except Exception:return self.reply(503,b'{"detail":"Configuration unavailable"}')
        if self.path not in ['/api/health','/api/session','/api/reset','/api/clear-history','/api/turn','/api/turn-stream','/api/control']:return self.reply(404,b'{}')
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0<=length<=1600000:return self.reply(413,b'{"detail":"Recording too large"}')
            config=json.loads(connection_settings.resolved(CONNECTION).read_text())
            data=self.rfile.read(length) if self.command=='POST' else None
            with UPSTREAM.response(config,self.path[4:],data,self.command) as r:
                if r.status>=400:return self.reply(r.status,r.read())
                if self.path=='/api/turn-stream':
                    self.send_response(r.status);self.send_header('Content-Type','application/x-ndjson');self.send_header('Cache-Control','no-store');self.send_header('Connection','close');self.end_headers()
                    self.close_connection=True
                    try:
                        for line in r:
                            self.wfile.write(line);self.wfile.flush()
                    except (BrokenPipeError,ConnectionResetError):pass
                    except Exception:
                        event={'type':'error','data':{'status':502,'detail':'语音流连接中断，请检查连接后重试。'}}
                        try:self.wfile.write((json.dumps(event,ensure_ascii=False)+'\n').encode());self.wfile.flush()
                        except (BrokenPipeError,ConnectionResetError):pass
                else:self.reply(r.status,r.read())
        except Exception:self.reply(503,json.dumps({'detail':'服务器尚未连接或模型未就绪。请运行 connect.py 并检查任务状态。'},ensure_ascii=False).encode())
    def do_GET(self):
        if self.path.startswith('/api/'):return self.proxy()
        return super().do_GET()
    def do_POST(self):return self.proxy()
if __name__=='__main__':
    print(f'Open http://{BIND}:{PORT}/slai/',flush=True)
    ThreadingHTTPServer((BIND,PORT),Handler).serve_forever()
