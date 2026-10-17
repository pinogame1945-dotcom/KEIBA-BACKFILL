#!/usr/bin/env python3
"""Free-CPU no-write numerical+byte parity benchmark for frozen 690 fast view.

Builds the exact 2026-10-17 pre-race features again, but never pushes to Git
or modifies the existing handoff. Compare each race JSON SHA-256 with the
already published reference from the last known successful slow pipeline.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time

ROOT=Path.cwd()
sys.path.insert(0,str(ROOT/"ml_features"/"research"))
from auto_new_day_handoff_2026_v1 import build, require
from export_690_delivery_dynamic_v1 import export_day, build_index


def check(day, runner_temp):
    require(day=="2026-10-17","BENCHMARK_DAY_NOT_ORIGINAL_VERIFIED_10_17")
    start=time.monotonic()
    with tempfile.TemporaryDirectory(dir=runner_temp,prefix="fast-690-parity-") as tmp:
        root=Path(tmp)
        combined, compact, live = build(day,root/"compute")
        built=time.monotonic()
        exported=root/"export"
        export_day(day,combined,compact,exported,live)
        build_index(exported)
        finished=time.monotonic()
        subprocess.run(["git","fetch","--no-tags","origin",
                        "handoff/690-feature-data-v1"],check=True)
        index=json.loads(subprocess.check_output(
            ["git","show","FETCH_HEAD:ml_features/delivery/690/index.json"],
            text=True))
        expected={rid:v for rid,v in index["races"].items() if v["date"]==day}
        require(len(expected)==36, "BENCHMARK_PUBLISHED_DAY_NOT_36")
        outputs=exported/"ml_features"/"delivery"/"690"/day
        emitted={p.stem for p in outputs.glob("2026*.json")}
        require(set(expected)==emitted,"BENCHMARK_CHANGED_RACE_IDS")
        mismatches=[]
        for rid in sorted(expected):
            digest=hashlib.sha256((outputs/(rid+".json")).read_bytes()).hexdigest()
            if digest!=expected[rid]["sha256"]:
                mismatches.append(rid)
        require(not mismatches,"BENCHMARK_690_BYTE_PARITY_MISMATCH:"+",".join(mismatches[:5]))
        elapsed=time.monotonic()-start
        print("FAST_690_FULL_36_RACE_BYTE_PARITY_PASSED "+json.dumps({
            "date":day,"race_count":len(expected),
            "horse_count":sum(v["starters"] for v in expected.values()),
            "all_feature_json_sha256_identical":True,
            "build_seconds":round(built-start,2),
            "export_seconds":round(finished-built,2),
            "total_seconds":round(elapsed,2),
            "old_run_total_seconds":6491,
            "frozen_690_math_unchanged":True,
            "not_published":True,
        },sort_keys=True),flush=True)


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--date",default="2026-10-17")
    parser.add_argument("--runner-temp",required=True)
    args=parser.parse_args()
    check(args.date,args.runner_temp)
