"""One semantic generation -> validated local control -> release model reply.

Native speech is a separate, text-constrained generation. This module deliberately
has no Qwen-Agent loop, JSON repair, semantic retry, or success-reply template.
"""
import copy
import hashlib
import json
import os
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf

from cabin import CabinVehicle, SCHEMA

ROOT = Path(__file__).resolve().parent
PROTOCOL = 'cabin-single-decision-v1'
IDENTITY = 'You are Qwen, a virtual human developed by the Qwen Team, Alibaba Group, capable of perceiving auditory and visual inputs, as well as generating text and speech.'
MAX_REPLY_CHARS = 240
MAX_DECISION_TOKENS = 512
HISTORY_TURNS = 2

PATCH_SCHEMA = {'oneOf': [
    {'type': 'object', 'properties': {'reset': {'type': 'boolean', 'const': True}},
     'required': ['reset'], 'additionalProperties': False},
    {'type': 'object', 'properties': {k: v for k, v in SCHEMA['properties'].items() if k != 'reset'},
     'minProperties': 1, 'additionalProperties': False},
]}
OUTPUT_SCHEMA = {
    'type': 'object', 'required': ['tool_calls', 'reply'], 'additionalProperties': False,
    'properties': {
        'tool_calls': {'type': 'array', 'maxItems': 1, 'items': {
            'type': 'object', 'required': ['name', 'arguments'], 'additionalProperties': False,
            'properties': {'name': {'const': 'control_cabin'}, 'arguments': PATCH_SCHEMA}}},
        'reply': {'type': 'object', 'required': ['text', 'when'], 'additionalProperties': False,
                  'properties': {'text': {'type': 'string', 'minLength': 1, 'maxLength': MAX_REPLY_CHARS},
                                 'when': {'enum': ['immediate', 'after_success']}}},
    },
    'allOf': [{'if': {'properties': {'tool_calls': {'maxItems': 0}}},
               'then': {'properties': {'reply': {'properties': {'when': {'const': 'immediate'}}}}},
               'else': {'properties': {'reply': {'properties': {'when': {'const': 'after_success'}}}}}}],
}


class ProtocolError(ValueError):
    pass


class DuplicateRequestError(ValueError):
    pass


def _unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ProtocolError('duplicate JSON key')
        result[key] = value
    return result


def _invalid_constant(value):
    raise ProtocolError('non-finite JSON value')


def parse_decision(raw):
    if not isinstance(raw, str) or not raw or len(raw) > 12000:
        raise ProtocolError('invalid output size/type')
    try:
        obj = json.loads(raw, object_pairs_hook=_unique_pairs, parse_constant=_invalid_constant)
    except (ValueError, RecursionError) as exc:
        raise ProtocolError('invalid JSON') from exc
    if not isinstance(obj, dict) or set(obj) != {'tool_calls', 'reply'}:
        raise ProtocolError('expected tool_calls and reply')
    calls, reply = obj['tool_calls'], obj['reply']
    if not isinstance(calls, list) or len(calls) > 1:
        raise ProtocolError('expected zero or one cabin patch')
    if not isinstance(reply, dict) or set(reply) != {'text', 'when'}:
        raise ProtocolError('invalid reply object')
    text = reply['text']
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_REPLY_CHARS:
        raise ProtocolError('invalid reply text')
    if reply['when'] != ('after_success' if calls else 'immediate'):
        raise ProtocolError('reply timing does not match calls')
    if calls:
        call = calls[0]
        if not isinstance(call, dict) or set(call) != {'name', 'arguments'}:
            raise ProtocolError('invalid call object')
        if call['name'] != 'control_cabin' or not isinstance(call['arguments'], dict) or not call['arguments']:
            raise ProtocolError('invalid tool/arguments')
    return obj


def validate_decision(raw, state):
    """Validate the entire envelope/patch before any real tool invocation."""
    decision = parse_decision(raw)
    after = copy.deepcopy(state)
    if decision['tool_calls']:
        args = decision['tool_calls'][0]['arguments']
        try:
            simulation = CabinVehicle()
            simulation.values = copy.deepcopy(state)
            after = simulation.apply(args)['state']
            if args.get('locked') is True and any(args.get(k, 0) > 0 for k in (
                    'doors', 'leftDoor', 'rightDoor', 'rearLeftDoor', 'rearRightDoor')):
                raise ValueError('conflicting lock/open-door requests')
        except (ValueError, TypeError) as exc:
            raise ProtocolError(str(exc)) from exc
    return decision, after


def build_decision_messages(user_text, state, history=(), audio_path=None):
    """Shared by inference and text-data export; future results are not inputs.

    History contains real user messages and confirmed results, not unused drafts.
    Previous audio is included as audio content, never reduced to a path in prose.
    """
    policy = (ROOT / 'single_call_prompt.txt').read_text()
    system = policy + '\n输出Schema：\n' + json.dumps(OUTPUT_SCHEMA, ensure_ascii=False, separators=(',', ':'))
    messages = [{'role': 'system', 'content': system}]
    known_history = []
    for turn in list(history)[-HISTORY_TURNS:]:
        messages.append(copy.deepcopy(turn['user_message']))
        messages.append({'role': 'assistant', 'content': turn['reply']})
        known_history.append({k: copy.deepcopy(turn[k]) for k in ('tool_calls', 'tool_results', 'reply', 'status')})
    context = {'state_before': state, 'history': known_history}
    if audio_path is None:
        context['user_text'] = user_text
        user_message = {'role': 'user', 'content': json.dumps(context, ensure_ascii=False)}
    else:
        user_message = {'role': 'user', 'content': [
            {'type': 'text', 'text': json.dumps(context, ensure_ascii=False)},
            {'type': 'audio', 'audio': str(audio_path)},
        ]}
    messages.append(user_message)
    # Store only the actual utterance as the historical user message.
    original_user = {'role': 'user', 'content': user_text if audio_path is None else [
        {'type': 'audio', 'audio': str(audio_path)}]}
    return messages, original_user


def execute_decision(tool, raw, state_snapshot):
    """Caller holds the service request lock. No model call occurs here."""
    before = tool.vehicle.state()
    if before != state_snapshot:
        return {'status': 'stale_state', 'reply': '设置刚刚发生了变化，这次没有执行，请重新说一次。', 'decision': None}
    try:
        decision, expected = validate_decision(raw, before)
    except ProtocolError as exc:
        return {'status': 'protocol_error', 'reply': '这次没有执行，请重新说明要调整什么。',
                'decision': None, 'diagnostic': str(exc)}
    if not decision['tool_calls']:
        return {'status': 'no_action', 'reply': decision['reply']['text'], 'decision': decision}
    try:
        raw_result = tool.call(json.dumps(decision['tool_calls'][0]['arguments'], ensure_ascii=False))
        result = json.loads(raw_result) if isinstance(raw_result, str) else raw_result
        ok = isinstance(result, dict) and result.get('ok') is True
        if not ok or result.get('state') != expected or tool.vehicle.state() != expected:
            raise ValueError('execution result does not match the validated patch')
    except Exception as exc:
        unchanged = tool.vehicle.state() == before
        return {'status': 'execution_error', 'reply': '这次没有执行成功，设置保持原状。' if unchanged else '执行出现异常，请核对当前设置。',
                'decision': decision, 'diagnostic': type(exc).__name__}
    # The LLM authors the reply. Successful execution gates its release; it does
    # not prove arbitrary prose semantically correct. Evaluate that separately.
    return {'status': 'success', 'reply': decision['reply']['text'], 'decision': decision}


class SingleDecisionMixin:
    supports_request_id = True
    supported_profiles = ['slai']

    def drop_session(self, sid):
        self.sessions.pop(sid, None)
        # Keep recent request IDs across manual controls/reset to prevent an old
        # HTTP retry from executing again after history has been cleared.

    def run_turn(self, sid, tool, state, prompt, text='', pcm=None, on_state=None, request_id=''):
        if tool.name != 'control_cabin':
            raise ValueError('单次决策后端仅支持SLAI座舱')
        if bool(text) == (pcm is not None):
            raise ValueError('请提供文字或录音，二选一')
        self.semantic_model_calls = 0
        self.speech_model_calls = 0
        if not hasattr(self, '_single_request_ids'):
            self._single_request_ids = {}
        request_ids = self._single_request_ids.setdefault(sid, {})
        if request_id:
            fingerprint = hashlib.sha256(text.encode() if pcm is None else pcm).hexdigest()
            if request_id in request_ids:
                raise DuplicateRequestError('这个请求已经处理过，请核对当前状态；不会重复执行。')
            request_ids[request_id] = fingerprint
            if len(request_ids) > 64:
                del request_ids[next(iter(request_ids))]
        folder = Path(os.environ.get('VEHICLE_SINGLE_CALL_EVIDENCE_DIR', str(ROOT / 'evidence/single-call-runtime')))
        folder.mkdir(parents=True, exist_ok=True)
        rid = uuid.uuid4().hex
        audio_path = None
        if pcm is not None:
            audio_path = folder / (rid + '-input.wav')
            sf.write(audio_path, np.frombuffer(pcm, dtype='<i2'), 16000, subtype='PCM_16')
        messages, original_user = build_decision_messages(text, state, self.sessions.get(sid, []), audio_path)
        if self.audit:
            self.audit('single_decision_input', {'protocol': PROTOCOL, 'text': text, 'audio_path': str(audio_path) if audio_path else None,
                                               'state_before': state, 'history_turns': len(self.sessions.get(sid, []))})
        previous_stage = getattr(self, 'stage', 'agent')
        self.stage = 'decision'
        try:
            self.semantic_model_calls += 1
            raw, _ = self.generate(messages, audio=False, max_new_tokens=MAX_DECISION_TOKENS)
        finally:
            self.stage = previous_stage
        result = execute_decision(tool, raw, state)
        reply = result['reply']
        if self.audit:
            self.audit('single_decision_result', {'raw': raw, **result, 'state_after': tool.vehicle.state(), 'events': tool.events})

        # Persist actual execution facts before speech: an audio failure must not
        # erase a successful action or cause an automatic second execution.
        successful = [e for e in tool.events if e['result'].get('ok')]
        turn = {'user_message': original_user,
                'tool_calls': [{'name': e['tool'], 'arguments': json.loads(e['arguments']) if isinstance(e['arguments'], str) else e['arguments']} for e in successful],
                'tool_results': [copy.deepcopy(e['result']) for e in tool.events],
                'reply': reply, 'status': result['status']}
        self.sessions[sid] = (self.sessions.get(sid, []) + [turn])[-HISTORY_TURNS:]
        if on_state:
            on_state(text, reply_text=reply)
        if self.text_sink:
            self.text_sink({'text': reply, 'input_text': text})

        # Read only the released reply, not the original command/JSON. This is
        # one separately counted speech generation, with no semantic replanning.
        speech_messages = [{'role': 'system', 'content': IDENTITY},
                           {'role': 'user', 'content': '请严格原样说出下面的文字，不要添加内容：' + reply}]
        sink = self.audio_sink
        self.audio_sink = None
        try:
            self.speech_model_calls += 1
            spoken, wav = self.generate(speech_messages, audio=True, force_text=reply)
        finally:
            self.audio_sink = sink
        if spoken != reply or wav is None or not len(wav) or not np.isfinite(wav).all():
            raise RuntimeError('播报生成失败，请查看文字和当前设置；操作不会自动重试。')
        data = np.clip(np.rint(wav * 32768), -32768, 32767).astype('<i2').tobytes()
        sf.write(folder / (rid + '-reply.wav'), wav, 24000)
        if sink:
            import base64
            sink({'pcm': base64.b64encode(data).decode(), 'sample_rate': 24000, 'channels': 1, 'sequence': 0})
        return {'reply': reply, 'input_text': text, 'pcm': data, 'decision_status': result['status'],
                'protocol': PROTOCOL, 'semantic_model_calls': self.semantic_model_calls,
                'speech_model_calls': self.speech_model_calls}
