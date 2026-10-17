import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "research"))
from detect_live_day_delta_v1 import classify
from live_json_to_daily_pack_dynamic_v1 import official_race_cutoff, observed_before_race, CUT_OFF, DAY


class LiveDayDeltaTests(unittest.TestCase):
    date = "2026-10-18"

    def build(self, folder, *, market="2.3", horse="A", stale=False,
              blocked=False, publisher="18時30分現在"):
        folder.mkdir(parents=True, exist_ok=True)
        records = []
        for no in range(1, 13):
            rid = f"2026050407{no:02d}"
            records.append({"race_id": rid, "status":
                            "BLOCKED_SOURCE_OR_INTEGRITY" if blocked and no == 1
                            else "SOURCE_AND_ODDS_VERIFIED"})
            snapshot = {
                "race_id": rid, "race_date": self.date,
                "status": records[-1]["status"],
                "errors": ["NO_ODDS"] if blocked and no == 1 else [],
                "includes_results": False, "includes_final_odds": False,
                "captured_at_utc": "2026-10-17T10:00:00+00:00" if not stale
                else "2026-10-17T11:00:00+00:00",
                "source_discovery": {
                    "race_id": rid, "race_date": self.date, "venue_code": "05",
                    "race_no": no, "scheduled_start_time_jst": "09:45",
                    "jra_odds_cname": "different-observed-link" if stale else "original",
                },
                "netkeiba": {
                    "runners": [{"horse_name": horse if no == 1 else "B"}],
                    "meta": {"fetched_at_utc": "another-time" if stale else "initial"},
                },
                "jra_card": {
                    "official_horse_set": [{"horse_name": "A" if no == 1 else "B"}],
                    "meta": {"sha256": "another-hash" if stale else "original-hash"},
                },
                "jra_odds": {
                    "quotes": [{"bet_type": "WIN", "combination": [1],
                                "odds": market if no == 1 else "2.3"}],
                    "no_votes": [], "scratched_combinations": [],
                    "page_observations": {
                        "WIN_PLACE": {"official_update_display": publisher if no == 1 else "18時30分現在",
                                      "sha256": "different" if stale else "same",
                                      "fetched_at_utc": "different" if stale else "same"},
                    },
                },
            }
            (folder / (rid + ".json")).write_text(
                json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")
        (folder / "manifest.json").write_text(json.dumps({
            "day": self.date, "race_count_expected": 12,
            "actual_races_processed": 12,
            "full_source_and_odds_verified": 11 if blocked else 12,
            "blocked": 1 if blocked else 0, "races": records,
        }), encoding="utf-8")

    def test_noop_for_fetch_metadata_only(self):
        with tempfile.TemporaryDirectory() as root:
            a, b = Path(root) / "a", Path(root) / "b"
            self.build(a)
            self.build(b, stale=True)
            delta = classify(a, b)
            self.assertTrue(delta["noop"])
            self.assertFalse(delta["recompute_original_690"])
            self.assertFalse(delta["publish_new_odds"])

    def test_odds_change_does_not_trigger_original_690(self):
        with tempfile.TemporaryDirectory() as root:
            a, b = Path(root) / "a", Path(root) / "b"
            self.build(a)
            self.build(b, market="3.1")
            delta = classify(a, b)
            self.assertEqual(delta["odds_only_changed"], ["202605040701"])
            self.assertFalse(delta["recompute_original_690"])
            self.assertTrue(delta["publish_new_odds"])

    def test_race_feature_change_requires_safe_full_rebuild(self):
        with tempfile.TemporaryDirectory() as root:
            a, b = Path(root) / "a", Path(root) / "b"
            self.build(a)
            self.build(b, horse="Changed")
            delta = classify(a, b)
            self.assertEqual(delta["feature_changed"], ["202605040701"])
            self.assertTrue(delta["recompute_original_690"])

    def test_missing_previous_is_all_new(self):
        with tempfile.TemporaryDirectory() as root:
            a, b = Path(root) / "missing", Path(root) / "b"
            self.build(b)
            delta = classify(a, b)
            self.assertEqual(len(delta["new"]), 12)
            self.assertTrue(delta["recompute_original_690"])

    def test_reject_blocked_data_without_producing_update(self):
        with tempfile.TemporaryDirectory() as root:
            a, b = Path(root) / "a", Path(root) / "b"
            self.build(a)
            self.build(b, blocked=True)
            with self.assertRaisesRegex(ValueError, "DELTA_CURRENT_SOURCE_NOT_ALL_VERIFIED"):
                classify(a, b)

    def test_publisher_clock_change_is_odds_change(self):
        with tempfile.TemporaryDirectory() as root:
            a, b = Path(root) / "a", Path(root) / "b"
            self.build(a)
            self.build(b, publisher="18時35分現在")
            delta = classify(a, b)
            self.assertEqual(delta["odds_only_changed"], ["202605040701"])


class LiveRaceTimestampTests(unittest.TestCase):
    def test_on_date_before_official_start_accepted(self):
        start = official_race_cutoff({"scheduled_start_time_jst": "09:45"})
        observed_before_race(DAY + "T09:44:59+09:00", start)
        with self.assertRaisesRegex(ValueError, "SOURCE_NOT_PROVEN_CAPTURED_BEFORE_RACE"):
            observed_before_race(DAY + "T09:45:00+09:00", start)

    def test_without_observed_start_keep_original_midnight_cutoff(self):
        self.assertEqual(official_race_cutoff({}), CUT_OFF)
        with self.assertRaisesRegex(ValueError, "SOURCE_NOT_PROVEN_CAPTURED_BEFORE_RACE"):
            observed_before_race(DAY + "T00:01:00+09:00", CUT_OFF)

    def test_invalid_start_time_rejected(self):
        for start in ("25:00", "9:45", "09:60", "未定"):
            with self.subTest(start=start):
                with self.assertRaisesRegex(ValueError, "OFFICIAL_SCHEDULED_START_TIME_INVALID"):
                    official_race_cutoff({"scheduled_start_time_jst": start})


if __name__ == "__main__":
    unittest.main()
