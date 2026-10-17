import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"research"))
from benchmark_fast_690_current_day_v1 import compare_published_race,canonical_digest

class Fast690ValueEqualityTests(unittest.TestCase):
 def test_value_equality_ignores_object_insertion_order(self):
  first={"rows":[{"a":1.0,"b":None,"c":2.0}],"race_id":"202604040101"}
  second={"race_id":"202604040101","rows":[{"c":2.0,"a":1.0,"b":None}]}
  self.assertIsNone(compare_published_race(first,second))
  self.assertEqual(canonical_digest(first),canonical_digest(second))
 def test_value_drift_is_rejected_with_exact_path(self):
  first={"rows":[{"a":1.0,"b":None}],"race_id":"202604040101"}
  second={"rows":[{"b":None,"a":1.1}],"race_id":"202604040101"}
  self.assertEqual(compare_published_race(first,second)["path"],"$.rows[0].a")
  self.assertNotEqual(canonical_digest(first),canonical_digest(second))
 def test_missing_feature_is_not_just_different_order(self):
  first={"rows":[{"a":1.0,"b":None}],"race_id":"202604040101"}
  second={"rows":[{"a":1.0}],"race_id":"202604040101"}
  self.assertEqual(compare_published_race(first,second)["reason"],"keys")

if __name__=="__main__":unittest.main()
