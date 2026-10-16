"""Server-authoritative SLAI simulator; contract exported from controls.mjs."""
import json
import math
from pathlib import Path

CONTRACT = json.loads(Path(__file__).with_name('cabin_contract.json').read_text())
PARAMETERS = CONTRACT['parameters']
WINDOWS = ['leftWindow', 'rightWindow', 'rearLeftWindow', 'rearRightWindow']
DOORS = ['leftDoor', 'rightDoor', 'rearLeftDoor', 'rearRightDoor']
SCHEMA = {**CONTRACT['controlSchema'], 'properties': {
    **CONTRACT['controlSchema']['properties'],
    'reset': {'type': 'boolean', 'description': '仅在明确要求复位时单独传 true'},
}}
PROMPT = '''你是深圳河套学院 SLAI 模拟座舱语音助手。可以自然聊天、查询当前状态，并用 control_cabin 执行明确要求的操作。
只传需要改变的字段，不复制整份状态。问候、闲聊、查询、纯否定、取消、假设，以及不能按下述默认规则确定的含糊表达不调用工具。
“不要打开车窗”“先别开空调”只回复“好的，保持现状。”，不改变或猜测现状；项目或位置仍不明确时先澄清。
climateMode支持auto自动、cool制冷、heat制热、fan通风；选择模式会开启系统。ac是系统总开关，不是压缩机开关。温度调节不自动切换冷暖模式。自动模式无实测舱温，不能声称已自动决定制冷制热或达到实际温度；通风只送风，温度仅为保留的目标值。
支持空调、16–28度温度（步长0.5）、1–5档风量、前后排送风、四扇独立车窗/车门（0–100开度）、锁车、迎宾灯、氛围灯开关/颜色/亮度、音乐播放/暂停/曲目/音量/静音。
主驾=left，副驾=right，左后=rearLeft，右后=rearRight。“车窗”未指定位置时用 windows 设置四扇；车门同理。
音量 volume 使用0–1，例如30%为0.3；车窗、车门及灯光亮度使用0–100。颜色仅blue冰川蓝、violet暮光紫、amber暖琥珀。
曲目0=Nightfall、1=Blue Horizon、2=Weightless（氛围声）、3=晨光（轻钢琴）、4=河畔（柔和拨弦）、5=星夜（空灵琴音）。要求轻音乐时优先选3。下一首按当前曲目加一并对6取余，上一首减一并对6取余。这是本地合成曲库，没有网络音乐库，不可承诺播放其他歌曲。
相对调节依据当前状态计算绝对目标。锁车会关闭所有车门，打开车门会解锁。
小幅调节默认策略 cabin-small-adjust-v1：只有项目、方向和作用位置已明确、且用户没有给出具体数值/幅度时，才应用下列默认。温度“高/低一点”每次±1℃；风量“大/小一点”每次±1档；媒体音量“大/小一点”每次±5个百分点（volume±0.05）；氛围灯亮度“亮/暗一点”每次±10个百分点；车窗“再开大/关小一点”按开度每次±10个百分点，玻璃升高对应开度减小、玻璃下降对应开度增大。带“再/更/继续”等比较关系时按相对调整；没有比较关系的车窗“开一点/留条缝”是绝对目标开度10%，不是在当前开度上加10%。
仅隐式默认步幅允许到边界：按当前状态逐目标计算，若跨过合法上下限就只调到该边界；已在该方向边界时，不为该目标调用工具，直接说明已经到边界。不能为了这种无变化默认操作触发开空调、开灯、解除静音等联动。组合请求中其他明确合法目标仍按各自规则处理，无变化目标不产生额外参数。
用户明确给出的数字、增量、百分比或极值优先于小幅默认。明确数字/增量导致超范围或非法步长时，本轮不执行工具，也不夹紧、舍入或改成默认值；明确最高/最低按该参数的合法极值处理。显式数字的单位或比例基准不明仍须澄清，例如“音量设50”“音量减少10%”，不能猜成百分比/百分点或套默认5个百分点。
车门“开一点/留条缝”没有默认开度，必须询问。项目不明如“空调大一点”、位置指代不明如“那边窗”，仍先澄清；未限定位置的泛称车窗仍按四窗，不等于指代不明。默认策略不能覆盖用户的否定、保持状态或作用范围限制。
这是模拟装置，没有实体车控。温度是设定值，门窗数值是模拟目标，并非已经到位的传感器数据。
可执行的明确动作必须实际调用工具；默认操作已到边界时不调用。失败不可声称成功。复位只传reset:true。答复一两句中文，不解释内部过程。
查询以当前状态为唯一事实：'''


class CabinVehicle:
    def __init__(self):
        self.values = {k: d['default'] for k, d in PARAMETERS.items()}

    def state(self):
        return self.values.copy()

    def apply(self, args):
        if not isinstance(args, dict) or not args:
            raise ValueError('请提供有效车控参数')
        before = self.state()
        if 'reset' in args:
            if args != {'reset': True} or type(args['reset']) is not bool:
                raise ValueError('复位必须单独传 true')
            self.__init__()
            return {'ok': True, 'before': before, 'state': self.state(), 'patch': self.state()}
        patch = args.copy()
        for alias, keys in [('windows', WINDOWS), ('doors', DOORS)]:
            if alias in patch:
                value = patch.pop(alias)
                if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 100 or value != int(value):
                    raise ValueError('门窗开度须为 0–100 的整数')
                for key in keys:
                    patch.setdefault(key, value)
        for key, value in patch.items():
            d = PARAMETERS.get(key)
            if not d:
                raise ValueError('未知车控参数：' + key)
            if d['type'] == 'boolean':
                valid = type(value) is bool
            elif d['type'] == 'string':
                valid = isinstance(value, str) and value in d['enum']
            else:
                valid = (type(value) in (int, float) and math.isfinite(value)
                         and d['min'] <= value <= d['max']
                         and abs(value / d['step'] - round(value / d['step'])) < 1e-7)
            if not valid:
                raise ValueError('参数类型、范围或步长无效：' + d['label'])
        if patch.get('locked') is True:
            patch.update({key: 0 for key in DOORS})
        after = {**before, **patch}
        if any(patch.get(k, 0) > 0 for k in DOORS):
            after['locked'] = False
        if (any(k in patch for k in ('climateMode', 'temp', 'fan')) or any(patch.get(k) is True for k in ('frontAir', 'rearAir'))) and patch.get('ac') is not False:
            after['ac'] = True
        if ('ambientColor' in patch or patch.get('ambientBrightness', 0) > 0) and patch.get('ambient') is not False:
            after['ambient'] = True
        if 'track' in patch and patch.get('playing') is not False:
            after['playing'] = True
        if 'volume' in patch and patch.get('muted') is not True:
            after['muted'] = False
        self.values = after
        effective = {k: v for k, v in after.items() if k in patch or before[k] != v}
        return {'ok': True, 'before': before, 'state': self.state(), 'patch': effective}


def arguments(event):
    value = event['arguments']
    return json.loads(value) if isinstance(value, str) else value


def confirmation(events, state):
    requested = set()
    for event in events:
        args = arguments(event)
        if args.get('reset'):
            requested = set(PARAMETERS)
        else:
            for key in args:
                requested.update(WINDOWS if key == 'windows' else DOORS if key == 'doors' else [key])
    if len(events) == 1 and arguments(events[0]) == {'reset': True}:
        return '已恢复初始设置。'
    parts = []
    for keys, label in [(WINDOWS, '车窗'), (DOORS, '车门')]:
        selected = [k for k in keys if k in requested]
        groups = [(selected, state[selected[0]])] if selected and all(state[k] == state[selected[0]] for k in selected) else [([k], state[k]) for k in selected]
        for group, value in groups:
            names = {tuple(keys): '全部' + label, tuple(keys[:2]): '前排' + label, tuple(keys[2:]): '后排' + label}
            name = names.get(tuple(group), '、'.join(PARAMETERS[k]['label'].replace('开度', '') for k in group))
            action = '关闭' if value == 0 else '打开' if value == 100 else '开到一半' if value == 50 else f'开到{value:g}%'
            parts.append(name + action)
    for key, d in PARAMETERS.items():
        if key not in requested or key in WINDOWS + DOORS:
            continue
        v = state[key]
        if key == 'climateMode': parts.append('已切换到'+{'auto':'自动','cool':'制冷','heat':'制热','fan':'通风'}[v]+'模式')
        elif key == 'temp': parts.append(f'温度调到{v:g}度')
        elif key == 'fan': parts.append(f'风量{v:g}档')
        elif key == 'volume': parts.append(f'音量{round(v * 100)}%')
        elif key == 'track': parts.append('切换到' + CONTRACT['trackNames'][int(v)])
        elif key == 'ambientBrightness': parts.append(('亮度' if 'ambientColor' in requested else '氛围灯亮度') + f'{v:g}%')
        elif key == 'ambientColor': parts.append({'blue': '冰川蓝', 'violet': '暮光紫', 'amber': '暖琥珀'}[v])
        elif key == 'locked': parts.append('已锁车' if v else '已解锁')
        elif key == 'playing': parts.append('开始播放' if v else '音乐已暂停')
        elif key == 'muted': parts.append('已静音' if v else '已取消静音')
        else: parts.append(d['label'] + ('已开启' if v else '已关闭'))
    return '，'.join(parts) + '。'


def rejection(events):
    # Explain actual rejected tool arguments; never change a value to its limit.
    reasons = []
    for event in events:
        if event['result'].get('ok'):
            continue
        try: args = arguments(event)
        except (ValueError, TypeError): args = {}
        if isinstance(args, dict):
            for key, value in args.items():
                d = PARAMETERS.get(key)
                if not d or d['type'] != 'number' or type(value) not in (int, float) or not math.isfinite(value):
                    continue
                if key == 'temp' and value > d['max']:
                    reasons.append('最高支持28度，要调到28度吗？')
                elif key == 'temp' and value < d['min']:
                    reasons.append('最低支持16度，要调到16度吗？')
                elif not d['min'] <= value <= d['max'] or abs(value / d['step'] - round(value / d['step'])) >= 1e-7:
                    if key == 'volume': reasons.append('音量支持0到100%的整数。')
                    else: reasons.append(f'{d["label"]}支持{d["min"]:g}到{d["max"]:g}{d.get("unit", "")}，每次{d["step"]:g}{d.get("unit", "")}。')
        if not reasons:
            reasons.append('这项设置没有执行，请重新说明要调整的内容。')
    return ''.join(dict.fromkeys(reasons))
