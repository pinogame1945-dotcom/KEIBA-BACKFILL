"""Contract-only unit tests; numerical test requires original state snapshots."""
import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"research"))
from build_live_690_batch_36_v1 import RACES,DAY
class TestLive690Batch(unittest.TestCase):
    def test_ids(self):
        self.assertEqual(len(RACES),36)
        self.assertEqual(sum(x.startswith("202604") for x in RACES),12)
        self.assertEqual(sum(x.startswith("202605") for x in RACES),12)
        self.assertEqual(sum(x.startswith("202608") for x in RACES),12)
        self.assertEqual(DAY,"2026-10-17")
if __name__=="__main__":unittest.main()
