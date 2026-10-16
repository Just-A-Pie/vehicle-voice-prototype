import copy,json,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from scripts import demo
class ConfigTests(unittest.TestCase):
 def setUp(self):
  self.cfg=json.loads((demo.ROOT/'config/demo.example.json').read_text());self.cfg['checkpoint48'].update(ssh_target='example',remote_endpoint='/service/endpoint.json')
 def test_client_config_has_unique_local_ports(self):self.assertEqual(len(demo.check(self.cfg)),3)
 def test_missing_ssh_target_fails_early(self):
  self.cfg['checkpoint48']['ssh_target']=''
  with self.assertRaises(ValueError):demo.check(self.cfg)
 def test_duplicate_ports_fail(self):
  self.cfg['checkpoint48']['gateway_port']=self.cfg['web_port']
  with self.assertRaises(ValueError):demo.check(self.cfg)
 def test_default_profile_must_be_enabled(self):
  self.cfg['default_profile']='api'
  with self.assertRaises(ValueError):demo.check(self.cfg)
 def test_api_requires_explicit_usage_authorization(self):
  self.cfg['api'].update(enabled=True,base_url='https://example.aliyuncs.com')
  with self.assertRaisesRegex(ValueError,'authorization'):demo.check(self.cfg)
 def test_no_credential_in_templates(self):
  self.assertEqual(self.cfg['api']['base_url'],'');self.assertNotIn('token',json.dumps(self.cfg));self.assertNotIn('api_key',json.dumps(self.cfg))
if __name__=='__main__':unittest.main()
