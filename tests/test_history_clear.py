import sys,unittest
from pathlib import Path
from unittest.mock import Mock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import agent_service as svc
class ClearTests(unittest.TestCase):
 def setUp(self):
  self.old=svc.backend;svc.backend=Mock();self.sid,self.s=svc.get_session('', 'slai');self.s['vehicle'].apply({'windows':100,'temp':24});self.s['history']=[{'role':'user','content':'旧对话'}]
 def tearDown(self):
  svc.SESSIONS.pop(self.sid,None);svc.backend=self.old
 def test_clear_preserves_all_state_and_drops_backend_history(self):
  before=self.s['vehicle'].state();result=svc.clear_history(svc.Payload(session_id=self.sid,profile='slai'),'Bearer '+svc.TOKEN)
  self.assertEqual(result['state'],before);self.assertEqual(result['session_id'],self.sid);self.assertEqual(self.s['history'],[]);svc.backend.drop_session.assert_called_once_with(self.sid)
 def test_clear_during_turn_rejected(self):
  svc.LOCK.acquire()
  try:
   with self.assertRaises(svc.HTTPException) as e:svc.clear_history(svc.Payload(session_id=self.sid,profile='slai'),'Bearer '+svc.TOKEN)
   self.assertEqual(e.exception.status_code,409);self.assertTrue(self.s['history']);svc.backend.drop_session.assert_not_called()
  finally:svc.LOCK.release()
if __name__=='__main__':unittest.main()
