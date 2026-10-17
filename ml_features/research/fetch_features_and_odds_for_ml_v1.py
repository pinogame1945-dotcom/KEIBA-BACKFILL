#!/usr/bin/env python3
"""Fetch frozen L1 690 inputs plus 8-ticket odds by a single netkeiba race ID.

Public read-only Git raw files; validates SHA-256 for BOTH independent blobs
and their exact cross-reference. No recomputation and no betting verdict.
"""
from __future__ import annotations
import argparse,hashlib,json
from pathlib import Path
from urllib.request import urlopen
ROOT="https://raw.githubusercontent.com/pinogame1945-dotcom/KEIBA-BACKFILL/handoff/690-feature-data-v1/"
FEATURE_INDEX="ml_features/delivery/690/index.json"
ODDS_INDEX="ml_features/delivery/odds/index.json"
IDS={"_race_id","_horse_id","_race_date"}
BET_TYPES={"WIN","PLACE","BRACKET_QUINELLA","QUINELLA",
           "WIDE","EXACTA","TRIO","TRIFECTA"}


def require(ok, reason):
    if not ok: raise ValueError(reason)


def read(path, base):
    require(path.startswith("ml_features/delivery/") and
            ".." not in path.split("/"),"UNSAFE_HANDOFF_PATH")
    with urlopen(base.rstrip("/")+"/"+path, timeout=60) as data:
        return data.read()


def sha(data, expected):
    require(len(expected)==64 and
            hashlib.sha256(data).hexdigest()==expected,"HANDOFF_SHA256_MISMATCH")


def fetch(rid,base=ROOT):
    require(rid.isascii() and rid.isdecimal() and len(rid)==12,
            "RACE_ID_INVALID")
    feats=json.loads(read(FEATURE_INDEX,base))
    odds=json.loads(read(ODDS_INDEX,base))
    require(feats["contract"]=="KEIBA_BACKFILL_TO_ML_690_INDEX_V1",
            "FEATURE_INDEX_INVALID")
    require(odds["contract"]=="KEIBA_BACKFILL_TO_ML_ODDS_INDEX_V1",
            "ODDS_INDEX_INVALID")
    f=feats["races"].get(rid)
    o=odds["races"].get(rid)
    require(f and o,"RACE_ID_NOT_YET_READY")
    require(f["date"]==o["date"] and f["sha256"]==o["feature_sha256"],
            "FEATURE_ODDS_SNAPSHOT_MISMATCH")
    fb=read(f["path"],base)
    ob=read(o["path"],base)
    sha(fb,f["sha256"])
    sha(ob,o["sha256"])
    fd=json.loads(fb)
    od=json.loads(ob)
    require(fd["contract"]=="KEIBA_BACKFILL_TO_ML_690_UNSCORED_V1" and
            fd["race_id"]==rid and fd["race_date"]==f["date"] and
            fd["feature_count"]==690 and
            len(fd["rows"])==fd["starters"]==f["starters"],
            "FEATURE_RACE_CONTRACT_MISMATCH")
    require(all(x["_race_id"]==rid and
                len(set(x)-IDS)==690 for x in fd["rows"]),
            "690_HORSE_FEATURES_INVALID")
    require(od["contract"]=="KEIBA_BACKFILL_TO_ML_ODDS_V1" and
            od["race_id"]==rid and od["race_date"]==f["date"] and
            od["feature_sha256"]==f["sha256"] and
            od["feature_reference"]==f["path"],
            "ODDS_RACE_CONTRACT_MISMATCH")
    odata=od["odds"]
    require(odata["source"]==o["source"] and
            odata["snapshot_type"]==o["snapshot_type"] and
            odata["readiness"]==o["readiness"],
            "ODDS_STATUS_OR_SOURCE_MISMATCH")
    if odata["snapshot_type"]=="POST_RACE_FINAL":
        require(odata["source"]=="NETKEIBA_FINAL" and
                set(odata["group_code_to_bet_type"].values())==BET_TYPES and
                set(odata["raw_group_odds"])==set(odata["group_code_to_bet_type"]),
                "HISTORICAL_8_BET_TYPE_DRIFT")
    elif odata["snapshot_type"]=="PRE_RACE_LIVE_ODDS":
        require(odata["source"]=="JRA_OFFICIAL_POST" and
                set(odata["by_bet_type"])==BET_TYPES and
                odata["expected_combination_count"]==
                odata["quoted_combination_count"]+
                odata["no_votes_combination_count"]+
                odata["scratched_combination_count"],
                "LIVE_8_BET_TYPE_DRIFT")
    else:
        raise ValueError("UNKNOWN_ODDS_SNAPSHOT")
    return {
        "contract":"KEIBA_BACKFILL_TO_ML_FEATURES_AND_ODDS_V1",
        "race_id":rid,"race_date":f["date"],
        "features":fd,
        "odds":od,
        "ml_input_ready":True,
        "market_snapshot_time_validated_for_betting":False,
        "feature_asof_certified":False,
        "readiness":"ASOF_UNVERIFIED_DO_NOT_BET"
    }


if __name__=="__main__":
    p=argparse.ArgumentParser()
    p.add_argument("--race-id",required=True)
    p.add_argument("--output",required=True)
    p.add_argument("--base-url",default=ROOT)
    x=p.parse_args()
    doc=fetch(x.race_id,x.base_url)
    out=Path(x.output)
    out.parent.mkdir(parents=True,exist_ok=True)
    out.write_text(json.dumps(doc,ensure_ascii=False,allow_nan=False)+"\n",
                   encoding="utf-8")
    print("BACKFILL_690_AND_8_ODDS_READY "+json.dumps(
        {"race_id":x.race_id,"horses":doc["features"]["starters"],
         "features":690,"odds_source":doc["odds"]["odds"]["source"],
         "odds_snapshot":doc["odds"]["odds"]["snapshot_type"],
         "readiness":doc["readiness"]},sort_keys=True),flush=True)
