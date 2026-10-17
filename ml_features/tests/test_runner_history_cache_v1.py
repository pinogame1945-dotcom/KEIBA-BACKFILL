import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"research"))
from runner_history_cache_v1 import RunnerHistoryCache,digest


class EphemeralFrozenHistoryCacheTests(unittest.TestCase):
    def create(self,root,date="2026-10-17",code="frozen-generation-v1"):
        def mock_tree(_root,name):
            return ("mock-"+name+"-"+code)
        with patch.dict(os.environ,{"RUNNER_TEMP":str(root)}), \
             patch("runner_history_cache_v1.tracked_tree",side_effect=mock_tree):
            return RunnerHistoryCache(root,date,root/"cache")

    def test_snapshot_only_reused_when_hash_matches(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            cache=self.create(root)
            folder=cache.path("prior")
            cache.discard(folder)
            source=folder/"snapshot-2026.jsonl.gz"
            source.write_bytes(b"source-history")
            cache.seal(folder,[source])
            self.assertTrue(cache.valid(folder))
            source.write_bytes(b"source-history-corrupted")
            self.assertFalse(cache.valid(folder))

    def test_compact_requires_exact_horse_cohort(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            cache=self.create(root)
            a=digest({"date":"2026-10-17","horse_ids":["1","2"]})
            b=digest({"date":"2026-10-17","horse_ids":["1","3"]})
            first=cache.path("compact",a)
            second=cache.path("compact",b)
            self.assertNotEqual(first,second)
            cache.discard(first)
            source=first/"prior-full-race-context-2026.pkl"
            source.write_bytes(b"history")
            cache.seal(first,[source])
            self.assertTrue(cache.valid(first))
            self.assertFalse(cache.valid(second))

    def test_new_date_or_feature_generation_invalidates(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            first=self.create(root)
            changed_day=self.create(root,date="2026-10-18")
            changed_code=self.create(root,code="frozen-generation-v2")
            self.assertNotEqual(first.folder,changed_day.folder)
            self.assertNotEqual(first.folder,changed_code.folder)

    def test_reject_out_of_runner_folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            with patch.dict(os.environ,{"RUNNER_TEMP":str(root)}), \
                 patch("runner_history_cache_v1.tracked_tree",return_value="hash"):
                with self.assertRaisesRegex(ValueError,"HISTORY_CACHE_MUST_REMAIN"):
                    RunnerHistoryCache(root,"2026-10-17",root.parent/"unsafe-cache")

    def test_missing_year_file_invalidates_marker(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            cache=self.create(root)
            folder=cache.path("compact",digest("cohort"))
            cache.discard(folder)
            files=[]
            for year in range(2019,2027):
                f=folder/f"prior-full-race-context-{year}.pkl"
                f.write_bytes(str(year).encode())
                files.append(f)
            cache.seal(folder,files)
            self.assertTrue(cache.valid(folder))
            files[-1].unlink()
            self.assertFalse(cache.valid(folder))


if __name__=="__main__":
    unittest.main()
