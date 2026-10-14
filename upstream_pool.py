"""Short-lived HTTP keepalive pool. Never retries a possibly delivered operation."""
import http.client,select,threading,time
from contextlib import contextmanager

class UpstreamPool:
    def __init__(self,max_idle=4,idle_seconds=3):
        self.max_idle=max_idle;self.idle_seconds=idle_seconds;self.idle=[];self.lock=threading.Lock()
    def acquire(self,key):
        now=time.monotonic();selected=None;keep=[]
        with self.lock:
            for stamp,k,conn in self.idle:
                stale=now-stamp>self.idle_seconds or conn.sock is None
                if not stale:
                    try:stale=bool(select.select([conn.sock],[],[],0)[0])
                    except (OSError,ValueError):stale=True
                if stale or k!=key:conn.close()
                elif selected is None:selected=conn
                else:keep.append((stamp,k,conn))
            self.idle=keep
        return selected or http.client.HTTPConnection('127.0.0.1',key[0],timeout=240)
    @contextmanager
    def response(self,config,path,data=None,method='GET'):
        key=(int(config.get('local_port',18765)),config['token']);conn=self.acquire(key);response=None;completed=False
        try:
            conn.request(method,path,body=data,headers={'Authorization':'Bearer '+config['token'],'Content-Type':'application/json'})
            response=conn.getresponse()
            yield response
            completed=True
        finally:
            reusable=completed and response is not None and response.isclosed() and not response.will_close and conn.sock is not None
            if reusable:
                with self.lock:
                    if len(self.idle)<self.max_idle:self.idle.append((time.monotonic(),key,conn))
                    else:conn.close()
            else:conn.close()
    def close(self):
        with self.lock:
            for _,_,conn in self.idle:conn.close()
            self.idle=[]
