"""Safety regression for the 2026-10-17 pre-race day-pack bridge."""
import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "research"))
from live_json_to_daily_pack_v1 import convert, EXPECTED_IDS


def source():
    rid = "202605040605"
    return {
        "race_id": rid, "race_date": "2026-10-17",
        "status": "SOURCE_AND_ODDS_VERIFIED",
        "includes_results": False, "includes_final_odds": False,
        "models_executed": False, "backfill_history_features_computed": False,
        "captured_at_utc": "2026-10-16T13:00:00+00:00",
        "source_discovery": {"race_id": rid, "race_date": "2026-10-17",
                             "venue_code": "05", "race_no": 5},
        "netkeiba": {
            "meta": {"fetched_at_utc": "2026-10-16T13:00:00+00:00"},
            "runner_count": 3, "race_name": "2歳新馬",
            "source_url": "https://race.netkeiba.com/race/shutuba.html?race_id=" + rid,
            "runners": [
                {"horse_id": "202410000" + str(i), "horse_name": f"馬{i}",
                 "horse_number": i, "gate": i, "sex": "牡", "age": 2,
                 "carried_weight": 56, "jockey_id": None, "trainer_id": None,
                 "body_weight": None, "body_weight_diff": None}
                for i in range(1, 4)],
            "features_149": [
                {"feature_id": name, "status": "OBSERVED_OR_DERIVED_FROM_PAGE",
                 "observed_value": value}
                for name, value in [
                    ("race.venue_code", "05"), ("race.meeting_no", 4),
                    ("race.meeting_day", 6), ("race.race_no", 5),
                    ("race.race_id", rid), ("race.discipline", "FLAT"),
                    ("race.surface", "TURF"), ("race.distance_m", 1800),
                ]
            ] + [
                {"feature_id": f"test.{i}", "status": "NOT_YET_PUBLISHED",
                 "observed_value": None} for i in range(141)]
        },
        "jra_card": {
            "identity_verified": True, "official_horse_set": [
                {"horse_name": f"馬{i}", "horse_number": i if i != 2 else None,
                 "gate": i, "entry_status": "SCRATCHED" if i == 2 else "LISTED"}
                for i in range(1, 4)]
        },
        "jra_odds": {
            "combination_coverage_complete": True,
            "publisher_update_display_consistent": True,
            "snapshot_type": "PRE_RACE_LIVE_ODDS",
            "by_bet_type": dict.fromkeys(("WIN", "PLACE", "BRACKET_QUINELLA",
             "QUINELLA", "WIDE", "EXACTA", "TRIO", "TRIFECTA"), {}),
            "page_observations": {"WIN_PLACE": {
                "fetched_at_utc": "2026-10-16T13:00:00+00:00", "sha256": "abc"}},
        }
    }


class LiveAdapterTests(unittest.TestCase):
    def test_race_set_has_three_venues_and_36(self):
        self.assertEqual(len(EXPECTED_IDS), 36)

    def test_preserve_cancelled_runner_and_block_results(self):
        row = convert(source())
        self.assertEqual(len(row["entries"]), 3)
        self.assertEqual(row["entries"][1]["entry_status"], "SCRATCHED")
        self.assertEqual(row["race"]["actual_date"], None)
        self.assertEqual(row["race"]["scheduled_date"], "2026-10-17")
        self.assertEqual(row["results"], [])
        self.assertEqual(row["odds"], [])
        self.assertEqual(row["payouts"], [])

    def test_block_future_observed_source(self):
        a = source()
        a["captured_at_utc"] = "2026-10-17T00:30:00+00:00"
        with self.assertRaisesRegex(ValueError, "SOURCE_NOT_PROVEN_CAPTURED_BEFORE_RACE"):
            convert(a)

    def test_block_unverified_odds(self):
        a = source()
        a["jra_odds"]["publisher_update_display_consistent"] = False
        with self.assertRaisesRegex(ValueError, "JRA_ODDS_INTEGRITY_NOT_VERIFIED"):
            convert(a)

    def test_do_not_allow_results(self):
        a = source()
        a["includes_results"] = True
        with self.assertRaisesRegex(ValueError, "LIVE_SOURCE_NOT_PRE_RACE"):
            convert(a)


if __name__ == "__main__":
    unittest.main()
