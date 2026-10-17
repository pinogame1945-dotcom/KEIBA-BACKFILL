import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"research"))
from export_odds_delivery_v1 import BET_TYPES,make_historical,make_live

class TestOddsHandoff(unittest.TestCase):
    def test_type_mapping(self):
        self.assertEqual(len(BET_TYPES),8)
        self.assertEqual(BET_TYPES["8"],"TRIFECTA")
        self.assertEqual(BET_TYPES["2"],"PLACE")
    def test_final_not_pretend_live(self):
        odds={k:{"01" if k in ("1","2") else "0102":
                  ["1.1","2.3","0"]} for k in BET_TYPES}
        a=make_historical("202605040301",{
            "race_id":"202605040301","source_status":"result",
            "odds_kind":"FINAL","source":"NETKEIBA_FINAL",
            "odds":odds,"group_summary":{},
            "fetched_at":"2026-10-12T01:00:00Z"})
        self.assertEqual(a["snapshot_type"],"POST_RACE_FINAL")
        self.assertEqual(a["readiness"],"FINAL_ODDS_NOT_PRE_RACE_ASOF")
        with self.assertRaises(ValueError):
            make_historical("202605040301",{
                "race_id":"202605040301","source_status":"middle",
                "odds_kind":"MIDDLE","source":"NETKEIBA_FINAL","odds":odds})
    def test_live_8_groups_and_no_votes(self):
        rid="202604040101"
        a={"race_id":rid,"includes_results":False,
           "includes_final_odds":False,"status":"SOURCE_AND_ODDS_VERIFIED",
           "errors":[],"captured_at_utc":"2026-10-16T13:00:00+00:00",
           "jra_odds":{"source":"JRA_OFFICIAL_POST",
               "snapshot_type":"PRE_RACE_LIVE_ODDS",
               "combination_coverage_complete":True,
               "by_bet_type":{v:{} for v in BET_TYPES.values()},
               "expected_combination_count":2,
               "quoted_combination_count":1,
               "no_votes_combination_count":1,
               "scratched_combination_count":0,
               "quotes":[{"bet_type":"WIN","combination":[1],"odds":1.5}],
               "no_votes":[{"bet_type":"TRIFECTA",
                             "combination":[1,2,3],"odds":None}],
               "scratched_combinations":[]}}
        b=make_live(rid,a)
        self.assertEqual(b["snapshot_type"],"PRE_RACE_LIVE_ODDS")
        self.assertEqual(b["no_votes_combination_count"],1)
        with self.assertRaises(ValueError):
            a["jra_odds"]["expected_combination_count"]=3
            make_live(rid,a)
if __name__=="__main__":unittest.main()
