import json,sys,tempfile,unittest
from pathlib import Path

P=Path(__file__).resolve().parents[1]/"research"
sys.path.insert(0,str(P))
from export_690_delivery_dynamic_v1 import build_index
from export_odds_delivery_v1 import export_date,index_odds,BET_TYPES
from fetch_features_and_odds_for_ml_v1 import fetch

class NewDateIndexTests(unittest.TestCase):
    def test_new_day_race_id_690_and_eight_odds_without_faking_prices(self):
        day="2026-10-18"
        with tempfile.TemporaryDirectory() as root:
            root=Path(root)
            dest=root/"published"
            source=root/"source"/"data"/"live"/day
            source.mkdir(parents=True)
            features=dest/"ml_features"/"delivery"/"690"/day
            features.mkdir(parents=True)
            for n in range(1,13):
                rid=f"2026050407{n:02d}"
                rows=[
                    {"_race_id":rid,"_horse_id":f"000000000{i}",
                     "_race_date":day,
                     **{f"f_{j:03d}":None for j in range(690)}}
                    for i in range(1,4)
                ]
                features.joinpath(rid+".json").write_text(
                    json.dumps({
                        "contract":"KEIBA_BACKFILL_TO_ML_690_UNSCORED_V1",
                        "race_id":rid,"race_date":day,
                        "feature_count":690,"starters":3,
                        "readiness":"ASOF_UNVERIFIED_DO_NOT_BET",
                        "rows":rows})+"\n",encoding="utf-8")
                source.joinpath(rid+".json").write_text(json.dumps({
                    "race_id":rid,"includes_results":False,
                    "includes_final_odds":False,
                    "status":"SOURCE_AND_ODDS_VERIFIED","errors":[],
                    "captured_at_utc":"2026-10-17T10:00:00+00:00",
                    "jra_odds":{
                        "source":"JRA_OFFICIAL_POST",
                        "snapshot_type":"PRE_RACE_LIVE_ODDS",
                        "combination_coverage_complete":True,
                        "by_bet_type":{v:{} for v in BET_TYPES.values()},
                        "expected_combination_count":1,
                        "quoted_combination_count":1,
                        "no_votes_combination_count":0,
                        "scratched_combination_count":0,
                        "quotes":[{"bet_type":"WIN",
                                   "combination":[1],"odds":7.3}],
                        "no_votes":[],"scratched_combinations":[]
                    }}),encoding="utf-8")
            build_index(dest)
            export_date(day,root/"source",dest)
            index_odds(dest)
            sample=fetch("202605040701",dest.as_uri()+"/")
            self.assertEqual(sample["race_id"],"202605040701")
            self.assertEqual(sample["features"]["feature_count"],690)
            self.assertEqual(sample["odds"]["odds"]["snapshot_type"],
                             "PRE_RACE_LIVE_ODDS")
            self.assertEqual(sample["readiness"],"ASOF_UNVERIFIED_DO_NOT_BET")
            self.assertEqual(len(json.loads((dest/"ml_features"/"delivery"/"odds"/"index.json").read_text())["races"]),12)

if __name__=="__main__":unittest.main()
