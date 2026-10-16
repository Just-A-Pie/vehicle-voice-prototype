"""Optional local DashScope gateway. Does not purchase or enable cloud services."""
import json,os
from pathlib import Path
from urllib.parse import urlparse
ROOT=Path(__file__).resolve().parent

def settings():
    p=ROOT/'runtime/api-settings.json'
    cfg=json.loads(p.read_text()) if p.exists() else {}
    key=os.environ.get('DASHSCOPE_API_KEY','')
    key_file=ROOT/'runtime/dashscope.key'
    if not key and key_file.exists():
        if key_file.stat().st_mode&0o077:raise RuntimeError('密钥文件权限须为600')
        key=key_file.read_text().strip()
    url=os.environ.get('DASHSCOPE_BASE_URL',cfg.get('base_url','')).rstrip('/')
    host=urlparse(url)
    if not key:raise RuntimeError('尚未配置 DASHSCOPE_API_KEY 或 runtime/dashscope.key')
    if host.scheme!='https' or not host.hostname or host.username or host.password or host.query or host.fragment:
        raise RuntimeError('请提供百炼控制台确认的 HTTPS base_url')
    if not host.hostname.endswith('.aliyuncs.com'):raise RuntimeError('只接受百炼官方 aliyuncs.com 服务地址')
    if not cfg.get('usage_authorized',False):raise RuntimeError('尚未核验免费额度或获得计费调用授权；不会发起模型请求')
    return {'provider':'dashscope','url':url,'token':key,'model':cfg.get('model','qwen3-omni-flash'),'voice':cfg.get('voice','longanlingxin'),'speech_model':cfg.get('speech_model','qwen3.8-omni-flash-realtime')}

def main():
    endpoint=settings()
    import agent_service as service
    from optimized.realtime_agent import RealtimeAgent
    import uvicorn
    service.backend=RealtimeAgent(endpoint)
    active=[endpoint]
    @service.app.middleware('http')
    async def refresh_settings(request,call_next):
        if not service.LOCK.locked():
            updated=settings()
            if updated!=active[0]:
                for sid in list(service.backend.sessions):service.backend.drop_session(sid)
                service.backend=RealtimeAgent(updated)
                active[0]=updated
        return await call_next(request)
    port=int(os.environ.get('VEHICLE_API_PORT','18766'))
    path=ROOT/'runtime/connection-api.json'
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'w') as f:json.dump({'local_port':port,'token':service.TOKEN},f)
    print('Local API gateway: 127.0.0.1:'+str(port)+'; model='+endpoint['model'],flush=True)
    uvicorn.run(service.app,host='127.0.0.1',port=port,log_level='warning')
if __name__=='__main__':main()
