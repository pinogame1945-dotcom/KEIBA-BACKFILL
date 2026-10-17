#!/usr/bin/env python3
"""ML-side read-only race-ID accessor for GitHub-stored 690 horse inputs.

No model invocation. Refuses invalid SHA-256, partial feature matrices, and
unrecognized race IDs. ASOF_UNVERIFIED_DO_NOT_BET is preserved.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen

ROOT = "https://raw.githubusercontent.com/pinogame1945-dotcom/KEIBA-BACKFILL/handoff/690-feature-data-v1/"
BASE = "ml_features/delivery/690/"


def require(ok, msg):
    if not ok: raise ValueError(msg)


def fetch_race(rid, base=ROOT):
    require(len(rid)==12 and rid.isdecimal(), "RACE_ID_INVALID")
    with urlopen(base+BASE+"index.json", timeout=30) as fh:
        index=json.load(fh)
    require(index["contract"]=="KEIBA_BACKFILL_TO_ML_690_INDEX_V1",
            "INDEX_CONTRACT_DRIFT")
    require(index["readiness"]=="ASOF_UNVERIFIED_DO_NOT_BET",
            "INDEX_READINESS_CONTRACT_DRIFT")
    entry=index["races"].get(rid)
    require(entry is not None, "RACE_ID_NOT_YET_EXPORTED")
    require(entry["path"]==BASE+entry["date"]+"/"+rid+".json",
            "INDEX_PATH_INVALID")
    with urlopen(base+entry["path"], timeout=60) as fh:
        data=fh.read()
    require(hashlib.sha256(data).hexdigest()==entry["sha256"],
            "FEATURE_FILE_SHA256_MISMATCH")
    doc=json.loads(data)
    require(doc["race_id"]==rid and doc["race_date"]==entry["date"] and
            doc["contract"]=="KEIBA_BACKFILL_TO_ML_690_UNSCORED_V1",
            "HANDOFF_RACE_CONTRACT_MISMATCH")
    require(doc["readiness"]=="ASOF_UNVERIFIED_DO_NOT_BET" and
            doc["feature_count"]==690 and doc["starters"]==entry["starters"],
            "HANDOFF_STATUS_OR_COUNT_MISMATCH")
    require(len(doc["rows"])==doc["starters"], "HANDOFF_ROW_COUNT_DRIFT")
    for row in doc["rows"]:
        require(len(set(row)-{"_race_id","_horse_id","_race_date"})==690,
                "HANDOFF_FEATURE_SCHEMA_NOT_690")
    return doc


if __name__=="__main__":
    a=argparse.ArgumentParser()
    a.add_argument("--race-id",required=True)
    a.add_argument("--output",required=True)
    args=a.parse_args()
    doc=fetch_race(args.race_id)
    dest=Path(args.output)
    dest.parent.mkdir(parents=True,exist_ok=True)
    dest.write_text(json.dumps(doc,ensure_ascii=False,
                               allow_nan=False)+"\n",encoding="utf8")
    print(f"HANDOFF_690_FETCH_OK race_id={args.race_id} "+
          f"horses={doc['starters']} features=690 "+
          f"readiness={doc['readiness']}",flush=True)
