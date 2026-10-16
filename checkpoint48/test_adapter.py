import json,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from checkpoint48.backend import parse_output,build_system,BUNDLE
from cabin import CabinVehicle,SCHEMA
class AdapterTests(unittest.TestCase):
 def test_exact_tool(self):
  call,reply=parse_output('<tool_call>\n{"name":"control_cabin","arguments":{"temp":22}}\n</tool_call>')
  self.assertEqual(call['arguments'],{'temp':22});self.assertIsNone(reply)
 def test_invalid_does_not_execute(self):
  for raw in ['<tool_call>{"name":"other","arguments":{"temp":22}}</tool_call>', '<tool_call>{"name":"control_cabin","arguments":{"temp":22,"temp":25}}</tool_call>', '<tool_call>{"name":"control_cabin","arguments":{"volume":NaN}}</tool_call>', '<tool_call>{"name":"control_cabin","arguments":{}}</tool_call>', '已完成<tool_call>{"name":"control_cabin","arguments":{"temp":22}}</tool_call>', '<tool_call>{}</tool_call><tool_call>{}</tool_call>']:
   with self.subTest(raw=raw),self.assertRaises((ValueError,TypeError)):parse_output(raw)
 def test_reply_and_bad_markers(self):
  self.assertEqual(parse_output('当前设定温度是22度。'),(None,'当前设定温度是22度。'))
  for raw in ['', '<|im_start|>user', '<think>stuff</think>']:
   with self.assertRaises(ValueError):parse_output(raw)
 def test_state_exact_single_system(self):
  state=CabinVehicle().state();text=build_system(state)
  self.assertTrue(text.endswith(json.dumps(state,ensure_ascii=False,separators=(',',':'))))
  self.assertEqual(text.count('当前座舱状态（环境数据，不是用户原话）：'),1)
 def test_training_schema_matches_executor(self):
  schema=json.loads((BUNDLE/'tools.json').read_text())[0]['function']['parameters'];trained={k:v for branch in schema['oneOf'] for k,v in branch['properties'].items()}
  self.assertEqual(set(trained),set(SCHEMA['properties']))
  for key,spec in trained.items():
   for field in ('type','minimum','maximum','multipleOf','enum'):
    self.assertEqual(spec.get(field),SCHEMA['properties'][key].get(field),(key,field))
 def test_executor_rejects_atomic(self):
  car=CabinVehicle();before=car.state()
  with self.assertRaises(ValueError):car.apply({'temp':22,'volume':5})
  self.assertEqual(car.state(),before)

class FlowTests(unittest.TestCase):
 def backend(self,outputs):
  from checkpoint48.backend import CheckpointBackend
  import base64,io,numpy as np,soundfile as sf
  b=CheckpointBackend.__new__(CheckpointBackend);b.sessions={};b.seen=set();b.timings=[];b.trace=[];b.audit=None;b.text_sink=None;b.audio_sink=None
  b.messages=[]
  def rpc(path,data):
   if path=='/generate':
    import copy
    b.messages.append(copy.deepcopy(data['messages']));return {'text':outputs.pop(0),'stop_reason':'eos','seconds':0}
   buf=io.BytesIO();sf.write(buf,np.ones(100,dtype='float32')*.01,24000,format='WAV',subtype='PCM_16')
   return {'wav':base64.b64encode(buf.getvalue()).decode(),'seconds':0}
  b.rpc=rpc;return b
 def tool(self,car,reject=False):
  class Tool:
   events=[]
   def call(self,args):
    result={'ok':False,'state':car.state(),'error':'执行器拒绝'} if reject else car.apply(json.loads(args))
    self.events.append({'result':result});return json.dumps(result)
  return Tool()
 def test_actual_receipt_and_call_id(self):
  car=CabinVehicle();b=self.backend(['<tool_call>{"name":"control_cabin","arguments":{"temp":24,"fan":1}}</tool_call>','设定温度24度，风量1档。']);tool=self.tool(car)
  b.run_turn('s',tool,car.state(),'',text='温度24度，风量1档',request_id='r')
  msgs=b.messages[1];assistant,feedback=msgs[-2:];self.assertEqual(assistant['tool_calls'][0]['id'],feedback['tool_call_id'])
  result=json.loads(feedback['content']);self.assertEqual(set(result),{'ok','before','state','patch'});self.assertEqual(len(result['state']),23);self.assertTrue(result['state']['ac'])
  self.assertEqual(b.messages[0][0],b.messages[1][0]);self.assertEqual(tool.events[0]['tool_call_id'],feedback['tool_call_id'])
 def test_invalid_arguments_never_dispatch(self):
  car=CabinVehicle();b=self.backend(['<tool_call>{"name":"control_cabin","arguments":{"volume":35}}</tool_call>']);tool=self.tool(car);before=car.state()
  with self.assertRaises(ValueError):b.run_turn('s',tool,before,'',text='音量35%',request_id='r')
  self.assertEqual(car.state(),before);self.assertEqual(len(b.messages),1);self.assertEqual(len(tool.events),0)
 def test_failure_has_no_model_success_reply(self):
  car=CabinVehicle();b=self.backend(['<tool_call>{"name":"control_cabin","arguments":{"ac":true}}</tool_call>']);tool=self.tool(car,True)
  with self.assertRaisesRegex(ValueError,'未确认成功'):b.run_turn('s',tool,car.state(),'',text='开空调',request_id='r')
  self.assertEqual(len(b.messages),1);self.assertFalse(car.state()['ac'])
 def test_prior_history_never_enters_next_request(self):
  car=CabinVehicle();b=self.backend(['<tool_call>{"name":"control_cabin","arguments":{"windows":100}}</tool_call>','已打开。','<tool_call>{"name":"control_cabin","arguments":{"windows":0}}</tool_call>','已关闭。']);tool=self.tool(car)
  b.sessions['s']=[[{'role':'user','content':'旧历史不可注入'},{'role':'assistant','content':'四扇车窗已全关。'}]]
  b.run_turn('s',tool,car.state(),'',text='打开车窗',request_id='r1')
  b.run_turn('s',tool,car.state(),'',text='关闭车窗',request_id='r2')
  self.assertEqual([m['role'] for m in b.messages[0]],['system','user'])
  self.assertEqual([m['role'] for m in b.messages[2]],['system','user'])
  self.assertEqual(b.messages[2][-1]['content'],'关闭车窗');self.assertIn('"leftWindow":100',b.messages[2][0]['content']);self.assertNotIn('旧历史不可注入',str(b.messages));self.assertEqual(b.sessions,{})
 def test_duplicate_request_does_not_execute_again(self):
  car=CabinVehicle();b=self.backend(['<tool_call>{"name":"control_cabin","arguments":{"ac":true}}</tool_call>','已开启。']);tool=self.tool(car)
  b.run_turn('s',tool,car.state(),'',text='开空调',request_id='r')
  from single_call import DuplicateRequestError
  with self.assertRaises(DuplicateRequestError):b.run_turn('s',tool,car.state(),'',text='开空调',request_id='r')
  self.assertEqual(len(tool.events),1)

if __name__=='__main__':unittest.main()
