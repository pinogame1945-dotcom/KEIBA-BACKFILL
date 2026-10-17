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



def compare_published_race(expected_doc, generated_doc):
    """Compare parsed contract/feature values, independent of JSON object key order.

    SHA-256 of serialized JSON is stricter than feature equality: Python dicts
    can have different insertion orders for omitted CORE4 keys set via a set.
    Never interpret byte-only differences as numerical drift.
    """
    if expected_doc == generated_doc:
        return None

    def first_difference(a, b, path="$"):
        if type(a) is not type(b):
            # Distinguish int/float encoding as a representation change,
            # even if Python compares the two numbers as equal.
            return {"path": path, "reason": "type", "before": type(a).__name__,
                    "after": type(b).__name__}
        if isinstance(a, dict):
            if set(a) != set(b):
                return {"path": path, "reason": "keys",
                        "missing": sorted(set(a)-set(b))[:5],
                        "extra": sorted(set(b)-set(a))[:5]}
            for key in a:
                if a[key] != b[key]:
                    return first_difference(a[key], b[key], path+"."+str(key))
        elif isinstance(a, list):
            if len(a) != len(b):
                return {"path": path, "reason": "list_length",
                        "before": len(a), "after": len(b)}
            for i,(x,y) in enumerate(zip(a,b)):
                if x != y:
                    return first_difference(x,y,path+f"[{i}]")
        return {"path": path, "reason": "value",
                "before": repr(a)[:160], "after": repr(b)[:160]}
    return first_difference(expected_doc, generated_doc)


def canonical_digest(doc):
    return hashlib.sha256(json.dumps(
        doc,ensure_ascii=False,allow_nan=False,
        sort_keys=True,separators=(",",":")).encode("utf-8")).hexdigest()


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
        require(sum(v["starters"] for v in expected.values())==471,
                "BENCHMARK_PUBLISHED_2026_10_17_COHORT_NOT_471")
        outputs=exported/"ml_features"/"delivery"/"690"/day
        emitted={p.stem for p in outputs.glob("2026*.json")}
        require(set(expected)==emitted,"BENCHMARK_CHANGED_RACE_IDS")
        bytes_changed=[]
        values_changed=[]
        canonical_changed=[]
        diff_examples=[]
        for rid in sorted(expected):
            data=(outputs/(rid+".json")).read_bytes()
            observed_sha=hashlib.sha256(data).hexdigest()
            if observed_sha==expected[rid]["sha256"]:
                continue
            bytes_changed.append(rid)
            original_raw=subprocess.check_output([
                "git","show",f"FETCH_HEAD:ml_features/delivery/690/{day}/{rid}.json"
            ])
            require(hashlib.sha256(original_raw).hexdigest()==expected[rid]["sha256"],
                    "PUBLISHED_REFERENCE_SHA_CHANGED:"+rid)
            old=json.loads(original_raw)
            new=json.loads(data)
            difference=compare_published_race(old,new)
            if difference is not None:
                values_changed.append(rid)
                if len(diff_examples)<5:
                    diff_examples.append({"race_id":rid,**difference})
            if canonical_digest(old)!=canonical_digest(new):
                canonical_changed.append(rid)
        elapsed=time.monotonic()-start
        report={
            "date":day,"races":len(expected),
            "horses":sum(v["starters"] for v in expected.values()),
            "different_serialized_json_races":len(bytes_changed),
            "different_parsed_value_races":len(values_changed),
            "different_canonical_json_races":len(canonical_changed),
            "first_differences":diff_examples,
            "build_seconds":round(built-start,2),
            "export_seconds":round(finished-built,2),
            "total_seconds":round(elapsed,2),
            "frozen_690_math_unchanged":True,
            "not_published":True}
        print("FAST_690_FULL_36_RACE_VALUE_PARITY_REPORT "+
              json.dumps(report,sort_keys=True),flush=True)
        require(not values_changed and not canonical_changed,
                "FAST_690_FEATURE_PARITY_MISMATCH:"+",".join(values_changed[:5]))
        print("FAST_690_FULL_36_RACE_VALUE_PARITY_PASSED",flush=True)


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--date",default="2026-10-17")
    parser.add_argument("--runner-temp",required=True)
    args=parser.parse_args()
    check(args.date,args.runner_temp)
