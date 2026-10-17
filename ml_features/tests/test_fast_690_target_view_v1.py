import gzip
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

DIR = Path(__file__).resolve().parents[1] / "research"
sys.path.insert(0, str(DIR))
import audit_2026_generated_core4_v1 as audit
from export_690_delivery_dynamic_v1 import verify_current_day_view


DAY = "2026-10-17"
OLD = "2026-10-16"
RID = "202605040601"


def row(rid, day, horse, *, results=False, features=None):
    return {
        "race_id": rid,
        "horse_id": horse,
        "features": {"race_date": day, **(features or {"a": 1, "b": None, "c": 3})},
        "target": {"finish_position": 1} if results else None,
        "market_outcome": None,
    }


def write(path, rows):
    with gzip.open(path, "wt", encoding="utf-8") as out:
        for r in rows:
            out.write(json.dumps(r, ensure_ascii=False) + "\n")


class Fast690TargetViewTests(unittest.TestCase):
    def invoke(self, all_rows, day_rows):
        with tempfile.TemporaryDirectory() as root:
            src = Path(root) / "full.jsonl.gz"
            current = Path(root) / "today.jsonl.gz"
            write(src, all_rows)
            write(current, day_rows)
            fake_sha = audit.digest(["a", "b", "c"])
            with patch.object(audit, "selected_columns",
                              side_effect=lambda f: sorted(set(f)-{"race_date"})), \
                 patch.object(audit, "EXPECTED", 3), \
                 patch.object(audit, "CORE4_SHA", fake_sha):
                return verify_current_day_view(src, current, DAY)

    def test_pass_if_exact_target_records_preserved_in_original_order(self):
        prev = row("202605040501", OLD, "111", results=True)
        same = [row(RID, DAY, "222"), row(RID, DAY, "333")]
        self.assertIsNone(self.invoke([prev, *same], same))

    def test_reject_changed_value_even_if_race_ids_equal(self):
        orig = row(RID, DAY, "222")
        corrupted = row(RID, DAY, "222", features={"a": 2, "b": None, "c": 3})
        with self.assertRaisesRegex(ValueError,
                                   "CURRENT_DAY_VIEW_NOT_BYTE_EQUIVALENT"):
            self.invoke([orig], [corrupted])

    def test_reject_missing_or_reordered_runners(self):
        r1, r2 = row(RID, DAY, "222"), row(RID, DAY, "333")
        with self.assertRaisesRegex(ValueError,
                                   "CURRENT_DAY_VIEW_NOT_BYTE_EQUIVALENT"):
            self.invoke([r1, r2], [r2, r1])

    def test_reject_current_day_target_results(self):
        target = row(RID, DAY, "222", results=True)
        with self.assertRaisesRegex(ValueError, "TARGET_DAY_RESULTS_OR_MARKET"):
            self.invoke([target], [target])

    def test_reject_target_view_containing_prior_rows(self):
        previous = row(RID, OLD, "111")
        current = row(RID, DAY, "222")
        with self.assertRaisesRegex(ValueError,
                                   "TARGET_VIEW_CONTAINS_OTHER_DATE"):
            self.invoke([previous, current], [previous, current])

    def test_reject_missing_feature_schema_even_if_daily_rows_identical(self):
        prior = row(RID, OLD, "111")
        prior["features"]["d"] = 4
        daily = row(RID, DAY, "222")
        with self.assertRaisesRegex(ValueError, "FULL_SOURCE_CORE4_SCHEMA_DRIFT"):
            self.invoke([prior, daily], [daily])


if __name__ == "__main__":
    unittest.main()
