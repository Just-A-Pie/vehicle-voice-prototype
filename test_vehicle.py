import unittest
from vehicle import Vehicle
class VehicleTests(unittest.TestCase):
 def test_partial_changes_and_relative(self):
  v=Vehicle();v.apply({'temperature':22});v.apply({'temperature_delta':-2});self.assertEqual(v.temperature,20);self.assertEqual(v.media_volume,40)
 def test_invalid_atomic(self):
  v=Vehicle();before=v.state()
  for x in [{'temperature':25,'window_open':101},{'ac_on':1},{'reset':True,'temperature':20},{'temperature':float('nan')},{'media_volume':False},{'unknown':1}]:
   with self.assertRaises(ValueError):v.apply(x)
   self.assertEqual(v.state(),before)
 def test_reset(self):
  v=Vehicle();v.apply({'ac_on':False,'window_open':50});v.apply({'reset':True});self.assertEqual(v.state(),Vehicle().state())
if __name__=='__main__':unittest.main()

class BoundaryTests(unittest.TestCase):
 def test_each_boundary(self):
  for key,values in [('temperature',[16,30]),('media_volume',[0,100]),('window_open',[0,100])]:
   for value in values:
    with self.subTest(key=key,value=value):
     v=Vehicle();v.apply({key:value});self.assertEqual(v.state()[key],value)
 def test_rejections_do_not_partially_change_state(self):
  bad=[{},[],None,{'reset':False},{'temperature':15.9},{'temperature':30.1},{'window_open':-1},{'media_volume':100.1},{'window_open':1.5},{'temperature_delta':True},{'temperature_delta':float('inf')},{'temperature_delta':-20},{'temperature':22,'temperature_delta':1}]
  for value in bad:
   with self.subTest(value=value):
    v=Vehicle(temperature=23,media_volume=35,window_open=50);before=v.state()
    with self.assertRaises(ValueError):v.apply(value)
    self.assertEqual(v.state(),before)
 def test_sessions_are_independent(self):
  first,second=Vehicle(),Vehicle();first.apply({'temperature':20});self.assertEqual(second.temperature,24)
