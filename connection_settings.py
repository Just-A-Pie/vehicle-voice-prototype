"""Local profile selection; secrets never leave the server."""
import json,os,urllib.request
from pathlib import Path
ROOT=Path(__file__).parent
PROFILES={'local':'mnn-connection.json','api':'connection-api.json','server':'connection.json','server3b':'connection-native3b.json'}
def selection_path(connection):return connection.with_name(connection.stem+'-selection.json')
def resolved(connection):
    p=selection_path(connection)
    if p.exists():return ROOT/'runtime'/PROFILES[json.loads(p.read_text())['profile']]
    return connection
def read(connection):
    cfg=ROOT/'runtime/api-settings.json'
    settings=json.loads(cfg.read_text()) if cfg.exists() else {}
    active=next((k for k,v in PROFILES.items() if resolved(connection).name==v),'server')
    return {'profile':active,'settings':{k:settings.get(k,'') for k in ('base_url','model','speech_model','voice')},'key_configured':(ROOT/'runtime/dashscope.key').exists()}
def write_json(path,data):
    tmp=path.with_suffix('.tmp');fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'w') as f:json.dump(data,f)
    os.replace(tmp,path)
def save(connection,data):
    profile=data.get('profile')
    if profile not in PROFILES:raise ValueError('请选择有效连接')
    if profile=='api':
        from urllib.parse import urlparse
        values=data.get('settings',{});url=urlparse(values.get('base_url',''))
        if url.scheme!='https' or not (url.hostname or '').endswith('.aliyuncs.com') or url.username or url.password or url.query or url.fragment:raise ValueError('仅支持现有百炼适配器的官方 HTTPS 地址')
        for k in ('model','speech_model','voice'):
            if not isinstance(values.get(k),str) or not values[k].strip() or len(values[k])>160:raise ValueError('请填写模型和音色')
        p=ROOT/'runtime/api-settings.json';old=json.loads(p.read_text()) if p.exists() else {}
        old.update({k:values[k].strip() for k in ('base_url','model','speech_model','voice')});write_json(p,old)
    path=ROOT/'runtime'/PROFILES[profile]
    if not path.exists():raise ValueError('连接配置不存在，请先启动对应服务。API 参数已保存（如有）。')
    cfg=json.loads(path.read_text());req=urllib.request.Request(f"http://127.0.0.1:{int(cfg['local_port'])}/health",headers={'Authorization':'Bearer '+cfg['token']})
    try:
        with urllib.request.urlopen(req,timeout=5) as response:health=json.load(response)
    except Exception:raise ValueError('目标服务未启动或不可达，未切换连接。API 参数已保存（如有）。') from None
    if not health.get('ready') or health.get('busy'):raise ValueError('目标服务未就绪或正在处理请求，请稍后再试')
    write_json(selection_path(connection),{'profile':profile})
    return {'ok':True,'message':'连接已切换。请刷新座舱页面开始新会话。API 健康检查不代表额度可用。'}
