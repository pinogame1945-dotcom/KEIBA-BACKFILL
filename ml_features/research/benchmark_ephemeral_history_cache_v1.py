#!/usr/bin/env python3
"""Compare cold vs warm original 690 on same standard free CPU runner.

Runner-local cache only; never publish or claim speed across GitHub runs.
Frozen 690 and source-day as-of guards remain unchanged.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import hashlib
import subprocess
import tempfile
import time
from auto_new_day_handoff_2026_v1 import build,require
from export_690_delivery_dynamic_v1 import export_day,build_index
from benchmark_fast_690_current_day_v1 import compare_published_race,canonical_digest

def benchmark(temp_root,day="2026-10-17"):
    require(day=="2026-10-17","CACHE_TEST_REQUIRES_PUBLISHED_VERIFIED_DAY")
    with tempfile.TemporaryDirectory(prefix="runner-history-reuse-",dir=temp_root) as work:
        root=Path(work)
        cache=root/"cache"
        t0=time.monotonic()
        build(day,root/"cold",history_cache_dir=cache)
        cold=time.monotonic()-t0
        markers=list(cache.rglob("_runner_cache_complete.json"))
        require(len(markers)==2,"COLD_HISTORY_CACHE_NOT_SEALED")
        t1=time.monotonic()
        combined,compacts,live=build(day,root/"warm",history_cache_dir=cache)
        warm=time.monotonic()-t1
        require(len(list(cache.rglob("_runner_cache_complete.json")))==2,
                "WARM_HISTORY_CACHE_UNEXPECTED_GENERATION_DRIFT")
        dest=root/"published-compare"
        t2=time.monotonic()
        export_day(day,combined,compacts,dest,live)
        build_index(dest)
        exported=time.monotonic()-t2
        subprocess.run(["git","fetch","--no-tags","origin",
                        "handoff/690-feature-data-v1"],check=True)
        original=json.loads(subprocess.check_output(
            ["git","show","FETCH_HEAD:ml_features/delivery/690/index.json"],
            text=True))
        expected={rid:v for rid,v in original["races"].items() if v["date"]==day}
        require(len(expected)==36 and sum(v["starters"] for v in expected.values())==471,
                "CACHED_BENCHMARK_PUBLISHED_COHORT_INVALID")
        mismatches=[]
        for rid,meta in sorted(expected.items()):
            new_path=dest/"ml_features"/"delivery"/"690"/day/(rid+".json")
            require(new_path.is_file(),"CACHED_BENCHMARK_RACE_MISSING:"+rid)
            actual=json.loads(new_path.read_text("utf-8"))
            source=subprocess.check_output([
                "git","show",f"FETCH_HEAD:ml_features/delivery/690/{day}/{rid}.json"
            ])
            require(hashlib.sha256(source).hexdigest()==meta["sha256"],
                    "REFERENCE_RACE_SHA_DRIFT:"+rid)
            baseline=json.loads(source)
            if compare_published_race(baseline,actual) is not None or \
                    canonical_digest(baseline)!=canonical_digest(actual):
                mismatches.append(rid)
        result={
            "date":day,"races":len(expected),"horses":471,
            "original_690_value_mismatch_races":len(mismatches),
            "cold_history_seconds":round(cold,2),
            "warm_history_seconds":round(warm,2),
            "warm_export_seconds":round(exported,2),
            "warm_total_including_export_seconds":round(warm+exported,2),
            "history_reuse_speedup":round(cold/warm,2) if warm else None,
            "cache_scope":"FREE_RUNNER_TEMP_ONLY",
            "cache_persistent_across_runs":False,
            "paid_storage_used":False,
            "model_or_feature_math_changed":False,
        }
        print("RUNNER_HISTORY_CACHE_BENCHMARK "+json.dumps(
            result,sort_keys=True),flush=True)
        require(not mismatches,"CACHED_HISTORY_FROZEN_690_PARITY_MISMATCH:"+
                ",".join(mismatches[:5]))
        print("RUNNER_HISTORY_CACHE_690_VALUES_IDENTICAL",flush=True)

if __name__=="__main__":
    ap=argparse.ArgumentParser()
    ap.add_argument("--runner-temp",required=True)
    a=ap.parse_args()
    benchmark(a.runner_temp)
