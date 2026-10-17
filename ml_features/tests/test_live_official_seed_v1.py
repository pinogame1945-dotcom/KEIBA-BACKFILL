import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"research"))
class TestSeed(unittest.TestCase):
    def test_dates_and_no_invention(self):
        sys.path.insert(0,str(Path(__file__).resolve().parents[2]/"scripts"))
        from discover_jra_official_seed_v1 import extract
        raw='<a href="/JRADB/accessD.html?CNAME=pw01dde0105202604070120261018%2F00">race</a>'
        self.assertEqual(extract(raw,"2026-10-18"),[
            "https://www.jra.go.jp/JRADB/accessD.html?CNAME=pw01dde0105202604070120261018%2F00"])
        self.assertEqual(extract(raw,"2026-10-17"),[])
if __name__=="__main__":unittest.main()
