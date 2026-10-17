import sys
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from resolve_weekly_jra_day_v1 import candidate_day, resolve

JST=ZoneInfo("Asia/Tokyo")


class WeeklyDateResolverTests(unittest.TestCase):
 def test_same_day_refresh_uses_current_day_for_weekend(self):
  self.assertEqual(str(candidate_day(datetime(2026,10,17,9,20,tzinfo=JST))),"2026-10-17")

 def test_evening_prepares_tomorrow_not_yesterday(self):
  self.assertEqual(str(candidate_day(datetime(2026,10,17,19,20,tzinfo=JST))),"2026-10-18")

 def test_holiday_monday_only_when_official_card_exists(self):
  monday=datetime(2026,10,11,19,20,tzinfo=JST)
  seen=[]
  def official(day):
   seen.append(day)
   return "https://www.jra.go.jp/JRADB/accessD.html?CNAME=pw01dde0105202604070120261012%2F00"
  record=resolve(monday,search=official)
  self.assertEqual(seen,["2026-10-12"])
  self.assertEqual(record["status"],"OFFICIAL_RACE_DAY")

 def test_absent_card_skips_instead_of_creating_unofficial_races(self):
  def absent(day):raise ValueError("NO_PUBLISHED_JRA_CARD_FOR_DATE")
  record=resolve(datetime(2026,10,20,13,20,tzinfo=JST),search=absent)
  self.assertEqual(record["status"],"NO_PUBLISHED_MEETING")

 def test_untrusted_card_url_is_blocked(self):
  with self.assertRaisesRegex(ValueError,"JRA_CARD_SOURCE_NOT_OFFICIAL"):
   resolve(datetime(2026,10,17,9,20,tzinfo=JST),
           search=lambda day:"https://example.com/race")

 def test_outside_approved_snapshot_year_fails_closed(self):
  with self.assertRaisesRegex(ValueError,"NEXT_YEAR_SCHEMA_NOT_APPROVED"):
   resolve(datetime(2026,12,31,19,20,tzinfo=JST),search=lambda d:"ignored")

 def test_requires_timezone_aware_clock(self):
  with self.assertRaisesRegex(ValueError,"SCHEDULER_REQUIRES_TIMEZONE"):
   candidate_day(datetime(2026,10,17,19,20))


if __name__=="__main__": unittest.main()
