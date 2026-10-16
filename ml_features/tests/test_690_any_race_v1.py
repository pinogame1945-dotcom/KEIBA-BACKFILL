"""CPU-only tests for BACKFILL's generic original 690 feature adapter."""
from __future__ import annotations
import gzip
import json
import sys
import tempfile
import unittest
from pathlib import Path
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "research"))
from build_690_any_race_v1 import bias19, speed22
from verify_2026_original_690_extra_values_v1 import HIST_FIELDS
from run_l1_sameday_track_bias_v1 import STYLE_FIELDS

RID = "202605040302"
PRIOR = "202605040301"
DAY = "2026-10-10"

def fixture():
    rows = []
    for idx in range(1, 4):
        rows.append({
            "_race_id": RID, "_race_date": DAY,
            "_horse_id": f"202410000{idx}", "horse_number": idx,
            "field_size": 3, "venue_code": "05", "surface": "TURF",
            "race_no": 2, "distance_m": 1600,
        })
    return {"race_id": RID, "race_date": DAY, "rows": rows}

def emit_snapshot(dest, doc, previous_completed):
    with gzip.open(dest, "wt", encoding="utf-8") as out:
        for i in range(1, 4):
            f = {"race_date": DAY, "venue_code": "05", "surface": "TURF",
                 "race_no": 1, "field_size": 3, "horse_number": i}
            obj = {"race_id": PRIOR, "horse_id": f"202310000{i}",
                   "features": f, "target": {
                    "finish_position": i, "finish_time_ms": 100000 + 1200*i,
                    "last_3f": 35.1 + i} if previous_completed else None}
            out.write(json.dumps(obj) + "\n")
        for row in doc["rows"]:
            features = {"race_date": DAY, "venue_code": "05", "surface": "TURF",
                        "race_no": 2, "field_size": 3,
                        "horse_number": row["horse_number"],
                        **{key: 0.1 for key in STYLE_FIELDS}}
            out.write(json.dumps({"race_id": RID, "horse_id": row["_horse_id"],
                                  "features": features, "target": None}) + "\n")

class OriginalFeatureCalculatorTests(unittest.TestCase):
    def test_19_bias_handles_earlier_unfinished_race_without_leak(self):
        doc = fixture()
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "year.jsonl.gz"
            emit_snapshot(p, doc, False)
            rows = bias19(p, doc)
            self.assertEqual(len(rows), 3)
            for vals in rows.values():
                self.assertEqual(len(vals), 19)
                self.assertEqual(vals["daybias_prior_races"], 0.0)

    def test_19_bias_uses_only_completed_prior_race(self):
        doc = fixture()
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "year.jsonl.gz"
            emit_snapshot(p, doc, True)
            rows = bias19(p, doc)
            self.assertEqual(len(rows), 3)
            for vals in rows.values():
                self.assertEqual(len(vals), 19)
                self.assertEqual(vals["daybias_prior_races"], 1.0)

    def test_22_speed_features_are_defined_for_cold_starters(self):
        doc = fixture()
        history = pd.DataFrame(columns=HIST_FIELDS)
        result = speed22(history, doc)
        self.assertEqual(len(result), 3)
        for vals in result.values():
            self.assertEqual(len(vals), 22)
            self.assertTrue(all(name.startswith("regime_speed_resid_")
                                for name in vals))

if __name__ == "__main__":
    unittest.main()
