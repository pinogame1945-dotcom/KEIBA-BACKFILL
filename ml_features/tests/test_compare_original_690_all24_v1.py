"""Non-IO consistency checks for full 690 exact/approx/null parity."""
import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"research"))
from compare_original_690_all24_v1 import diff, IDS, N_CELLS
class TestCellComparison(unittest.TestCase):
    def test_population(self):
        self.assertEqual(len(IDS),24)
        self.assertEqual(N_CELLS,217350)
    def test_null_and_zero_different(self):
        self.assertEqual(diff(None,0)[0],"missingness_mismatch")
        self.assertEqual(diff(None,None)[0],"identical")
    def test_approx_does_not_claim_exact(self):
        self.assertEqual(diff(1.0,1.000002)[0],"approx_only")
        self.assertEqual(diff(1.0,1.1)[0],"value_mismatch")
    def test_non_numeric_and_type(self):
        self.assertEqual(diff("TURF","TURF")[0],"identical")
        self.assertEqual(diff("1",1)[0],"value_mismatch")
        self.assertEqual(diff(True,1)[0],"value_mismatch")
    def test_numeric_exact_and_nonfinite(self):
        self.assertEqual(diff(1,1.0)[0],"identical")
        self.assertEqual(diff(float('nan'),2)[0],"nonfinite_invalid")
if __name__=="__main__":unittest.main()
