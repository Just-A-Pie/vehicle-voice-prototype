import sys, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from cabin import CabinVehicle, confirmation
class Modes(unittest.TestCase):
 def test_modes_and_setpoint_are_independent(self):
  v=CabinVehicle()
  for mode in ['auto','cool','heat','fan']:
   v.apply({'climateMode':mode})
   self.assertTrue(v.state()['ac'])
   for temp in [16,28]:
    v.apply({'temp':temp})
    self.assertEqual(v.state()['climateMode'],mode)
  v.apply({'ac':False})
  self.assertFalse(v.state()['ac'])
  self.assertEqual(v.state()['climateMode'],'fan')
 def test_invalid_mode_is_atomic(self):
  v=CabinVehicle(); before=v.state()
  with self.assertRaises(ValueError):v.apply({'temp':26,'climateMode':'invalid'})
  self.assertEqual(v.state(),before)
 def test_confirmation_and_reset(self):
  v=CabinVehicle();v.apply({'climateMode':'heat'})
  self.assertIn('制热',confirmation([{'arguments':{'climateMode':'heat'}}],v.state()))
  v.apply({'reset':True})
  self.assertEqual(v.state()['climateMode'],'auto')
  self.assertFalse(v.state()['ac'])
if __name__=='__main__':unittest.main()
