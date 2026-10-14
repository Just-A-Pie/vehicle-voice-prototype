"""Deterministic simulated vehicle. No real vehicle interfaces."""
from dataclasses import dataclass, asdict
import math

@dataclass
class Vehicle:
    ac_on: bool = True
    temperature: float = 24
    media_volume: int = 40
    window_open: int = 0

    def state(self):
        return asdict(self)

    def apply(self, args):
        allowed = {'ac_on','temperature','temperature_delta','media_volume','window_open','reset'}
        if not isinstance(args,dict) or not args or set(args)-allowed:
            raise ValueError('无效或未知车控参数')
        before = self.state()
        nxt = before.copy()
        if 'reset' in args:
            if args != {'reset':True}: raise ValueError('复位不能与其他动作同时执行')
            nxt = Vehicle().state()
        else:
            if 'temperature' in args and 'temperature_delta' in args: raise ValueError('温度绝对值和相对值不能同时使用')
            if 'ac_on' in args:
                if type(args['ac_on']) is not bool: raise ValueError('空调开关必须为布尔值')
                nxt['ac_on'] = args['ac_on']
            for key,lo,hi in [('temperature',16,30),('media_volume',0,100),('window_open',0,100)]:
                if key in args:
                    v=args[key]
                    if type(v) not in (int,float) or not math.isfinite(v) or not lo<=v<=hi: raise ValueError(f'{key} 必须在 {lo}–{hi} 范围内')
                    if key != 'temperature' and v != int(v): raise ValueError('百分比必须是整数')
                    nxt[key]=v
            if 'temperature_delta' in args:
                delta=args['temperature_delta']
                if type(delta) not in (int,float) or not math.isfinite(delta): raise ValueError('温度变化量无效')
                nxt['temperature']=self.temperature+delta
                if not 16<=nxt['temperature']<=30: raise ValueError('调整后的温度必须在16–30℃')
        for key,value in nxt.items():setattr(self,key,value)
        return {'ok':True,'before':before,'state':self.state()}
