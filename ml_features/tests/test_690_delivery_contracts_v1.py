import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"research"))
from export_690_delivery_v1 import RACES,POPULATION
from fetch_690_handoff_for_ml_v1 import ROOT,BASE
class TestDeliveryContracts(unittest.TestCase):
    def test_scope(self):
        self.assertEqual(len(RACES["2026-10-10"]),24)
        self.assertEqual(len(RACES["2026-10-17"]),36)
        self.assertEqual(POPULATION,{"2026-10-10":315,"2026-10-17":471})
        self.assertEqual(len(set.union(*RACES.values())),60)
    def test_lookup_is_stable(self):
        self.assertTrue(ROOT.startswith("https://raw.githubusercontent.com/"))
        self.assertTrue(ROOT.endswith("handoff/690-feature-data-v1/"))
        self.assertEqual(BASE,"ml_features/delivery/690/")
if __name__=="__main__":unittest.main()
