import sys,json,base64,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from optimized.realtime_agent import RealtimeAgent
from cabin import CabinVehicle
from agent_service import CabinTool
class Socket:
 def __init__(self,events):self.events=iter(events);self.sent=[];self.closed=False
 def recv(self):return json.dumps(next(self.events))
 def send(self,x):self.sent.append(json.loads(x))
 def close(self,**kw):self.closed=True
DONE={'type':'response.done','response':{'status':'completed'}}
AUDIO={'type':'response.audio.delta','delta':base64.b64encode(b'\1\0\2\0').decode()}
UPDATED={'type':'session.updated'}
class Test(unittest.TestCase):
 def setUp(self):
  self.b=RealtimeAgent({'url':'https://test.aliyuncs.com/compatible-mode/v1','token':'secret-test','speech_model':'qwen3.8-omni-flash-realtime'});self.v=CabinVehicle();self.events=[];self.tool=CabinTool(self.v,self.events)
 def test_tools_once_and_connection_reuse(self):
  event={'type':'response.function_call_arguments.done','name':'control_cabin','call_id':'one','arguments':'{"windows":50}'}
  s=Socket([{'type':'session.created'},UPDATED,event,event,DONE,AUDIO,DONE,UPDATED,AUDIO,DONE]);chunks=[];self.b.audio_sink=chunks.append
  with patch('websocket.create_connection',return_value=s) as create:
   self.b.run_turn('one',self.tool,self.v.state(),'',text='一半')
   self.b.run_turn('one',self.tool,self.v.state(),'',text='你好')
  self.assertEqual(len(self.events),1);self.assertEqual(self.v.state()['leftWindow'],50);self.assertEqual(create.call_count,1);self.assertTrue(self.b.trace[0]['connection_reused'])
  self.assertEqual([e['sequence'] for e in chunks],[0,0])
 def test_rejected_tool_does_not_modify(self):
  event={'type':'response.function_call_arguments.done','name':'control_cabin','call_id':'one','arguments':'{"temp":100}'}
  before=self.v.state();s=Socket([{'type':'session.created'},UPDATED,event,DONE,AUDIO,DONE])
  with patch('websocket.create_connection',return_value=s):self.b.run_turn('one',self.tool,before,'',text='100度')
  self.assertEqual(before,self.v.state());self.assertFalse(self.events[0]['result']['ok'])
 def test_free_quota_rejection_is_clear_and_drops_session(self):
  s=Socket([{'type':'session.created'},{'code':'AllocationQuota.FreeTierOnly','message':'free quota exhausted'}])
  with patch('websocket.create_connection',return_value=s):
   with self.assertRaisesRegex(RuntimeError,'免费额度已用完'):
    self.b.run_turn('one',self.tool,self.v.state(),'',text='你好')
  self.assertEqual(self.events,[]);self.assertTrue(s.closed);self.assertEqual(self.b.sessions,{})
 def test_failure_drops_connection_and_never_replays_tool(self):
  event={'type':'response.function_call_arguments.done','name':'control_cabin','call_id':'one','arguments':'{"windows":50}'}
  s=Socket([{'type':'session.created'},UPDATED,event,{'type':'error','error':'secret-test disconnected'}])
  with patch('websocket.create_connection',return_value=s) as create:
   with self.assertRaises(RuntimeError) as e:self.b.run_turn('one',self.tool,self.v.state(),'',text='一半')
  self.assertEqual(len(self.events),1);self.assertEqual(create.call_count,1);self.assertTrue(s.closed);self.assertNotIn('secret-test',str(e.exception));self.assertEqual(self.b.sessions,{})
if __name__=='__main__':unittest.main()
