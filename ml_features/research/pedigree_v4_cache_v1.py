#!/usr/bin/env python3
"""Persist, integrity-check and reuse original pedigree V4 / 238 target columns.
Only standard Git files: never GitHub Actions artifacts, LFS or paid caches.
"""
from __future__ import annotations
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import subprocess

DAY_COUNTS = {"2026-10-10": (24, 315), "2026-10-17": (36, 471)}
CONTRACT = "KEIBA_ORIGINAL_PEDIGREE_V4_238_IMMUTABLE_CACHE_V1"
SOURCES = (
    "data/daily", "data/horses", "data/live/2026-10-17",
    "ml_features/delivery/690",
    "ml_features/src/pedigree-feature-builder-original-v4.mjs",
    "ml_features/src/small-sample-feature-utils.mjs",
    "ml_features/research/compute_real_2026_original_pedigree_v4_238_v1.mjs",
    "ml_features/research/live_json_to_daily_pack_v1.py",
)

def require(ok, reason):
    if not ok:
        raise ValueError(reason)

def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def git_obj(root: Path, name: str) -> str:
    result = subprocess.run(["git", "rev-parse", "HEAD:" + name],
        cwd=root, check=True, text=True, capture_output=True)
    return result.stdout.strip()

def source_fingerprint(root: Path) -> str:
    return digest("\n".join(f"{p}:{git_obj(root,p)}" for p in SOURCES).encode())

def read_json(file: Path):
    return json.loads(file.read_text(encoding="utf-8"))

def validate_document(doc, race_id: str, day: str):
    require(doc.get("contract") == "KEIBA_ORIGINAL_V4_2026_PEDIGREE_238_TEMP_V1",
        "CACHE_PAYLOAD_CONTRACT")
    require(doc.get("race_id") == race_id and doc.get("race_date") == day,
        "CACHE_RACE_ID_DATE")
    require(doc.get("feature_count") == 238 and
        doc.get("target_results_used") is False, "CACHE_FEATURE_OR_TARGET_FLAG")
    rows = doc.get("rows")
    require(isinstance(rows,list) and len(rows)>0, "CACHE_NO_HORSES")
    ids=set()
    feature_keys=None
    for row in rows:
        hid=str(row.get("_horse_id") or "")
        require(hid.isdigit() and hid not in ids, "CACHE_HORSE_DUPLICATED")
        ids.add(hid)
        require(row.get("_race_id")==race_id and row.get("_race_date")==day,
            "CACHE_ROW_IDENTITY")
        keys=set(row)-{"_race_id","_race_date","_horse_id"}
        require(len(keys)==238 and all(k.startswith("ped_") for k in keys),
            "CACHE_NOT_238_PEDIGREE")
        require(feature_keys is None or keys==feature_keys,"CACHE_COLUMN_DRIFT")
        feature_keys=keys
        require(all(v is None or type(v) in (int,float) and float("-inf") < v < float("inf")
            for k,v in row.items() if k.startswith("ped_")), "CACHE_NONFINITE_VALUE")
    return len(rows), feature_keys

def verify(root: Path, cache: Path):
    index=cache/"manifest.json"
    require(index.is_file(), "CACHE_MANIFEST_MISSING")
    manifest=read_json(index)
    require(manifest.get("contract")==CONTRACT, "CACHE_CONTRACT_DRIFT")
    require(manifest.get("fingerprint")==source_fingerprint(root),
            "CACHE_INPUT_CHANGED_REFUSE_STALE_OR_RECOMPUTE")
    require(manifest.get("target_results_used") is False and
            manifest.get("model_executed") is False, "CACHE_TARGET_OR_MODEL_FLAG")
    require(manifest.get("feature_count")==238, "CACHE_FEATURE_COUNT")
    files=manifest.get("files")
    require(isinstance(files,list) and len(files)==60,"CACHE_RACES_NOT_60")
    seen=set()
    totals={day:[0,0] for day in DAY_COUNTS}
    schema=None
    for item in files:
        day=item["day"];rid=item["race_id"]
        require(day in DAY_COUNTS and isinstance(rid,str) and len(rid)==12,
                "CACHE_BAD_RACE_ENTRY")
        require((day,rid) not in seen,"CACHE_REPEATED_RACE")
        seen.add((day,rid))
        location=cache/day/(rid+".json.gz")
        require(location.is_file(),"CACHE_MISSING_FILE:"+rid)
        binary=location.read_bytes()
        require(digest(binary)==item["sha256"],"CACHE_HASH_MISMATCH:"+rid)
        doc=json.loads(gzip.decompress(binary))
        n, keys=validate_document(doc,rid,day)
        require(n==item["horses"],"CACHE_COUNT_MISMATCH:"+rid)
        require(schema is None or schema==keys,"CACHE_SCHEMA_DRIFT")
        schema=keys
        totals[day][0]+=1;totals[day][1]+=n
    for day,expected in DAY_COUNTS.items():
        require(tuple(totals[day])==expected,"CACHE_DAY_COUNT_DRIFT:"+day)
    require(manifest.get("total_races")==60 and manifest.get("total_horses")==786,
            "CACHE_MANIFEST_TOTALS_DRIFT")
    return manifest

def pack(root: Path, cache: Path, raw: Path):
    require(not (cache/"manifest.json").exists(), "CACHE_ALREADY_EXISTS_NO_OVERWRITE")
    report=read_json(raw/"report.json")
    require(report.get("contract")=="KEIBA_ORIGINAL_V4_PEDIGREE_2026_REAL_RUN_V1",
            "COMPUTE_RUN_REPORT_WRONG")
    require(report.get("target_2026_outcomes_used") is False and
            report.get("original_v3_changed") is False, "COMPUTE_CHANGED_FROZEN_LOGIC")
    manifest={"contract":CONTRACT,
              "fingerprint":source_fingerprint(root),
              "feature_count":238,
              "total_races":60,"total_horses":786,
              "target_results_used":False,"model_executed":False,
              "history_valid_lineage_updates":report["historical_valid_lineage_updates"],
              "target_course_layout_unavailable_horses":
                    report["target_course_layout_unavailable_horses"],
              "files":[]}
    expected_schema=None
    for day,(races,horses) in DAY_COUNTS.items():
        files=sorted((raw/day).glob("*.json"))
        require(len(files)==races,"RAW_RACE_COUNT:"+day)
        day_horses=0
        for file in files:
            rid=file.stem
            doc=read_json(file)
            n,keys=validate_document(doc,rid,day)
            require(expected_schema is None or keys==expected_schema,
                    "RAW_FEATURE_SCHEMA_INCONSISTENT")
            expected_schema=keys
            day_horses+=n
            payload=(json.dumps(doc,ensure_ascii=False,separators=(",",":"))+"\n").encode()
            stream=io.BytesIO()
            with gzip.GzipFile(fileobj=stream,mode="wb",mtime=0,filename="") as z:
                z.write(payload)
            binary=stream.getvalue()
            dest=cache/day/(rid+".json.gz")
            dest.parent.mkdir(parents=True,exist_ok=True)
            dest.write_bytes(binary)
            manifest["files"].append({"day":day,"race_id":rid,
                                      "horses":n,"sha256":digest(binary)})
        require(day_horses==horses,"RAW_HORSE_COUNT:"+day)
    (cache/"manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,
        indent=2)+"\n",encoding="utf-8")
    verify(root,cache)
    print("ORIGINAL_238_PEDIGREE_PERSISTED",json.dumps(
        {"races":60,"horses":786,"feature_count":238,
         "fingerprint":manifest["fingerprint"],"files":len(manifest["files"])},
         sort_keys=True),flush=True)

def main():
    p=argparse.ArgumentParser()
    p.add_argument("action",choices=["status","pack","verify"])
    p.add_argument("--root",default=".")
    p.add_argument("--cache",default="ml_features/delivery/pedigree-v4")
    p.add_argument("--raw")
    args=p.parse_args()
    root=Path(args.root).resolve()
    cache=(root/args.cache).resolve()
    require(cache.is_relative_to(root),"CACHE_OUTSIDE_REPOSITORY")
    if args.action=="status":
        if not (cache/"manifest.json").exists():
            require(not cache.exists() or not list(cache.iterdir()),
                    "INCOMPLETE_CACHE_REFUSE_OVERWRITE")
            print("PEDIGREE_V4_CACHE_MISS",flush=True)
            return
        verify(root,cache)
        print("PEDIGREE_V4_CACHE_HIT",flush=True)
    elif args.action=="pack":
        require(args.raw is not None,"RAW_DIR_REQUIRED")
        pack(root,cache,Path(args.raw))
    else:
        verify(root,cache)
        print("PEDIGREE_V4_CACHE_VERIFIED",flush=True)

if __name__=="__main__":
    main()
