import base64
import copy
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from cabin import CabinVehicle
from agent_service import CabinTool
from single_call import (SingleDecisionMixin, DuplicateRequestError, PROTOCOL,
                         build_decision_messages, validate_decision)


def output(args=None, reply='好的。', when=None):
    return json.dumps({'tool_calls': [] if args is None else [{'name': 'control_cabin', 'arguments': args}],
                       'reply': {'text': reply, 'when': when or ('after_success' if args is not None else 'immediate')}}, ensure_ascii=False)


class ScriptedBackend(SingleDecisionMixin):
    """Scripted gold outputs: tests execution/transport, not model accuracy."""
    def __init__(self, raw):
        self.raw = raw
        self.sessions = {}
        self.captured = []
        self.trace = []
        self.timings = []
        self.audit = None
        self.audio_sink = None
        self.text_sink = None
        self.stage = 'agent'
        self.model_name = 'scripted-test-only'
        self.engine_info = {'protocol': PROTOCOL}
        self.before_return = None
        self.speech_error = False
        self.wrong_speech = False
    def generate(self, messages, audio=False, force_text=None, max_new_tokens=None):
        self.captured.append({'messages': copy.deepcopy(messages), 'audio': audio,
                              'force_text': force_text, 'max_new_tokens': max_new_tokens})
        if audio:
            if self.speech_error:
                raise RuntimeError('test speech failure')
            return ('错误的播报' if self.wrong_speech else force_text), np.ones(48, dtype=np.float32) * .01
        if self.before_return:
            self.before_return()
        return self.raw, None


class SingleCallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = patch.dict(os.environ, {'VEHICLE_SINGLE_CALL_EVIDENCE_DIR': self.tmp.name})
        self.env.start(); self.addCleanup(self.env.stop)
        self.v = CabinVehicle(); self.events = []
        self.tool = CabinTool(self.v, self.events)
    def run_turn(self, backend, text='把右后窗开一半', **kwargs):
        return backend.run_turn('session', self.tool, self.v.state(), '', text=text, **kwargs)
    def assert_one_decision(self, backend):
        self.assertEqual(sum(not c['audio'] for c in backend.captured), 1)
        self.assertEqual(backend.captured[0]['max_new_tokens'], 512)
    def test_action_releases_model_authored_reply_without_template_rewrite(self):
        self.v.apply({'rightWindow':80})
        b = ScriptedBackend(output({'rearRightWindow':50}, '好的，右后车窗已经开到一半啦。'))
        sequence = []
        b.text_sink = lambda e: sequence.append(('text', e['text'], self.v.state()))
        b.audio_sink = lambda e: sequence.append(('audio', e['sequence'], self.v.state()))
        r = self.run_turn(b, on_state=lambda t, reply_text=None: sequence.append(('state', reply_text, self.v.state())))
        self.assert_one_decision(b)
        self.assertEqual(r['speech_model_calls'],1)
        self.assertEqual(r['reply'],'好的，右后车窗已经开到一半啦。')
        self.assertEqual([s[0] for s in sequence],['state','text','audio'])
        self.assertTrue(all(s[2]['rearRightWindow']==50 for s in sequence))
        self.assertEqual(self.v.state()['rightWindow'],80)
        self.assertEqual(len(self.events),1)
        self.assertNotIn('tool_calls',str(b.captured[1]['messages']))
    def test_chat_query_and_negation_use_same_entry_without_tools(self):
        for text,reply in [('你好','你好呀。'),('现在设定几度','当前设定22度。'),('不要打开窗户','好的，保持现状。')]:
            b=ScriptedBackend(output(reply=reply));before=self.v.state()
            r=self.run_turn(b,text=text)
            self.assert_one_decision(b)
            self.assertEqual(r['decision_status'],'no_action')
            self.assertEqual(self.v.state(),before)
            self.assertEqual(self.events,[])
            self.assertEqual(b.captured[1]['force_text'],reply)
    def test_invalid_envelopes_never_execute_or_retry(self):
        bad=[output({'ac':True,'temp':100}),output({'reset':True,'temp':22}),
             output({'temp':True}),output({'temp':float('nan')}),output({'unknown':1}),
             output({'ac':True},when='immediate'),output(reply='x',when='after_success'),
             output({'ac':True})[:-1],output({'ac':True}).replace('control_cabin','other'),
             output({'locked':True,'doors':50}),
             '{"tool_calls":[],"tool_calls":[],"reply":{"text":"x","when":"immediate"}}',
             '{"tool_calls":[{},{}],"reply":{"text":"x","when":"after_success"}}',
             '```json\n'+output()+'\n```']
        for raw in bad:
            with self.subTest(raw=raw):
                before=self.v.state();b=ScriptedBackend(raw);r=self.run_turn(b)
                self.assert_one_decision(b)
                self.assertEqual(r['decision_status'],'protocol_error')
                self.assertEqual(self.v.state(),before);self.assertEqual(self.events,[])
                self.assertEqual(r['reply'],'这次没有执行，请重新说明要调整什么。')
    def test_execution_failure_suppresses_success_draft(self):
        b=ScriptedBackend(output({'ac':True},'空调打开啦。'))
        with patch.object(self.tool,'call',return_value=json.dumps({'ok':False,'state':self.v.state()})) as call:
            r=self.run_turn(b)
        self.assert_one_decision(b);self.assertEqual(call.call_count,1)
        self.assertEqual(r['decision_status'],'execution_error')
        self.assertNotEqual(r['reply'],'空调打开啦。')
        self.assertEqual(b.captured[-1]['force_text'],r['reply'])
    def test_changed_state_does_not_execute_old_plan(self):
        b=ScriptedBackend(output({'temp':20},'温度20度。'))
        b.before_return=lambda:self.v.apply({'temp':25})
        r=self.run_turn(b)
        self.assertEqual(r['decision_status'],'stale_state')
        self.assertEqual(self.v.state()['temp'],25);self.assertEqual(self.events,[])
    def test_audio_goes_directly_to_decision_and_not_to_readback(self):
        b=ScriptedBackend(output({'rearRightWindow':50},'右后窗开一半了。'))
        pcm=(np.ones(3200)*500).astype('<i2').tobytes()
        self.run_turn(b,text='',pcm=pcm)
        self.assert_one_decision(b)
        items=b.captured[0]['messages'][-1]['content']
        audio=next(x['audio'] for x in items if x['type']=='audio')
        self.assertTrue(Path(audio).exists())
        self.assertNotIn('user_text',json.loads(items[0]['text']))
        self.assertNotIn(audio,str(b.captured[1]['messages']))
    def test_history_contains_actual_user_and_reply_for_clarification_followup(self):
        b=ScriptedBackend(output(reply='你想调整哪个车窗？'))
        self.run_turn(b,text='帮我开一下窗户')
        b.raw=output({'rearRightWindow':50},'右后车窗已开到一半。')
        self.run_turn(b,text='右后，开一半')
        msgs=b.captured[2]['messages']
        self.assertEqual(msgs[1],{'role':'user','content':'帮我开一下窗户'})
        self.assertEqual(msgs[2],{'role':'assistant','content':'你想调整哪个车窗？'})
        self.assertEqual(json.loads(msgs[-1]['content'])['state_before']['rearRightWindow'],0)
        b.drop_session('session');self.assertEqual(b.sessions,{})
    def test_audio_history_is_retained_as_audio_not_a_transcript_guess(self):
        b=ScriptedBackend(output(reply='你想调到几度？'))
        self.run_turn(b,text='',pcm=(np.ones(3200)*500).astype('<i2').tobytes())
        b.raw=output({'temp':21.5},'已设置21.5度。')
        self.run_turn(b,text='二十一点五')
        self.assertEqual(b.captured[2]['messages'][1]['content'][0]['type'],'audio')
    def test_duplicate_request_is_not_reexecuted_even_after_history_reset(self):
        b=ScriptedBackend(output({'ac':True},'空调开了。'))
        self.run_turn(b,request_id='r1');b.drop_session('session')
        with self.assertRaises(DuplicateRequestError):self.run_turn(b,request_id='r1')
        self.assertEqual(len(b.captured),2);self.assertEqual(len(self.events),1)
        self.run_turn(b,request_id='r2');self.assertEqual(len(self.events),2)
    def test_speech_failure_keeps_action_and_blocks_same_request_retry(self):
        b=ScriptedBackend(output({'ac':True},'空调已打开。'));b.speech_error=True
        with self.assertRaisesRegex(RuntimeError,'speech failure'):self.run_turn(b,request_id='r1')
        self.assertTrue(self.v.state()['ac']);self.assertEqual(len(self.events),1)
        self.assertEqual(b.sessions['session'][0]['tool_calls'][0]['arguments'],{'ac':True})
        with self.assertRaises(DuplicateRequestError):self.run_turn(b,request_id='r1')
        self.assertEqual(len(self.events),1)
    def test_incorrect_speech_is_never_emitted(self):
        b=ScriptedBackend(output(reply='你好。'));b.wrong_speech=True;chunks=[];b.audio_sink=chunks.append
        with self.assertRaisesRegex(RuntimeError,'播报生成失败'):self.run_turn(b)
        self.assertEqual(chunks,[])
    def test_partial_support_explanation_is_preserved(self):
        reply='空调已打开，座椅按摩目前还不支持。'
        b=ScriptedBackend(output({'ac':True},reply));r=self.run_turn(b,text='开空调和按摩')
        self.assertEqual(r['reply'],reply);self.assertEqual(len(self.events),1)
    def test_all_existing_216_gold_samples_use_one_decision_and_preserve_state(self):
        path=ROOT/'tests/fixtures/gold_cases.jsonl'
        rows=[json.loads(l) for l in path.read_text().splitlines()]
        self.assertEqual(len(rows),216)
        for row in rows:
            with self.subTest(sample=row['sample_id']):
                self.v.values=copy.deepcopy(row['input']['state_before']);self.events.clear()
                b=ScriptedBackend(json.dumps(row['output'],ensure_ascii=False))
                r=self.run_turn(b,text=row['input']['user_text'])
                self.assert_one_decision(b)
                self.assertEqual(self.v.state(),row['verification']['expected_state_after'])
                self.assertEqual(r['reply'],row['output']['reply']['text'])


class BridgeTests(unittest.TestCase):
    def test_http_stream_exposes_released_reply_counts_and_duplicate_conflict(self):
        import agent_service as svc
        from fastapi.testclient import TestClient
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ,{'VEHICLE_SINGLE_CALL_EVIDENCE_DIR':folder}):
            b=ScriptedBackend(output({'rearRightWindow':50},'右后窗开好啦。'))
            with patch.object(svc,'backend',b),patch.object(svc,'SESSIONS',{}),patch.object(svc,'RUN',Path(folder)),patch.object(svc,'audit'):
                client=TestClient(svc.app);headers={'Authorization':'Bearer '+svc.TOKEN}
                s=client.post('/session',headers=headers,json={'profile':'slai'}).json()
                payload={'profile':'slai','session_id':s['session_id'],'request_id':'test-id','text':'右后窗开一半'}
                r=client.post('/turn-stream',headers=headers,json=payload)
                events=[json.loads(l) for l in r.text.splitlines() if l]
                final=next(e['data'] for e in events if e['type']=='done')
                self.assertEqual(final['semantic_model_calls'],1)
                self.assertEqual(final['speech_model_calls'],1)
                self.assertEqual(final['reply'],'右后窗开好啦。')
                confirmed=[e for e in events if e['type']=='state' and e['data']['agent_reply']]
                self.assertEqual(confirmed[0]['data']['agent_reply'],'右后窗开好啦。')
                self.assertEqual(client.post('/turn',headers=headers,json=payload).status_code,409)
                self.assertEqual(len(b.captured),2)
                client.post('/control',headers=headers,json={'profile':'slai','session_id':s['session_id'],'patch':{'temp':24}})
                self.assertNotIn(s['session_id'],b.sessions)
                self.assertEqual(client.post('/turn',headers=headers,json=payload).status_code,409)

if __name__=='__main__':unittest.main()
