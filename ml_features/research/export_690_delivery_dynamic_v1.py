#!/usr/bin/env python3
"""Export immutable-schema 690 pre-inference horse feature inputs for ML handoff.

Used with original 2019-2025 Kaggle state and a strictly-prior 2026 local
snapshot. Produces 24 or 36 race-ID-keyed plain JSONs, without ML predictions,
bets, targets, final odds, or claims of as-of/numeric-parity certification.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import pandas as pd
from datetime import date as Date
from collections import defaultdict
from verify_2026_original_690_extra_values_v1 import source_rows

from build_690_any_race_v1 import IDENTITY, bias19, load_core4, speed22

RACES = {
    "2026-10-10": {f"2026{v}0403{n:02d}" for v in ("05", "08") for n in range(1,13)},
    "2026-10-17": {f"2026{v}04{d}{n:02d}"
                   for v,d in (("04","01"), ("05","06"), ("08","06"))
                   for n in range(1,13)},
}
POPULATION = {"2026-10-10": 315, "2026-10-17": 471}
PREFIX = "ml_features/delivery/690"


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def load_history(folder, date):
    frames = []
    for year in range(2019, 2027):
        source = Path(folder) / f"prior-full-race-context-{year}.pkl"
        require(source.is_file(), f"MISSING_ORIGINAL_PRIOR_YEAR:{year}")
        frame = pd.read_pickle(source)
        require(frame["_race_date"].astype(str).lt(date).all(),
                f"HISTORY_LOOKAHEAD:{year}")
        frames.append(frame)
    merged = pd.concat(frames, ignore_index=True)
    require(not merged.empty and
            not merged.duplicated(["_race_id", "_horse_id"]).any(),
            "DUPLICATED_OR_EMPTY_PRIOR_HISTORY")
    return merged


def export_day(date, snapshot, history_dir, root):
    require(Date.fromisoformat(date).isoformat()==date and date.startswith("2026-"),
            "TARGET_DATE_OUTSIDE_APPROVED_2026_YEAR")
    discovered=defaultdict(set)
    for record in source_rows(snapshot):
        if (record.get("features") or {}).get("race_date") != date:
            continue
        race_id=str(record.get("race_id") or "")
        require(len(race_id)==12 and race_id.isdigit() and
                race_id.startswith(date[:4]),"INVALID_LIVE_RACE_ID")
        discovered[race_id[4:6]].add(race_id)
    require(1<=len(discovered)<=3 and all(len(v)==12 for v in discovered.values())
            and all({int(r[-2:]) for r in v}==set(range(1,13))
                    for v in discovered.values()), "OFFICIAL_RACE_SET_NOT_COMPLETE")
    races=sorted(set.union(*discovered.values()))
    if date in RACES:
        require(set(races)==RACES[date],"FROZEN_EXISTING_RACE_SET_DRIFT")
    targets = [load_core4(snapshot, race) for race in races]
    require(all(t["race_date"] == date for t in targets),
            "WRONG_FEATURE_TARGET_DATE")
    starters = sum(len(t["rows"]) for t in targets)
    require(starters == POPULATION[date] if date in POPULATION
            else all(3<=len(t["rows"])<=18 for t in targets),
            "ACTIVE_HORSE_COUNT_DRIFT")
    runners = [r for t in targets for r in t["rows"]]
    require(len({r["_horse_id"] for r in runners}) == starters,
            "HORSE_DUPLICATED_BETWEEN_RACES")
    history = load_history(history_dir, date)
    speed = speed22(history, {"race_id": date + "-full-card",
                              "race_date": date, "rows": runners})
    speed_by_horse = {hid: vals for (_,hid),vals in speed.items()}
    require(len(speed_by_horse) == starters, "22_SPEED_HORSE_COUNT_DRIFT")

    target_folder = Path(root)/PREFIX/date
    target_folder.mkdir(parents=True, exist_ok=True)
    feature_schema = None
    nulls = Counter()
    for target in targets:
        rid = target["race_id"]
        bias = bias19(snapshot, target)
        joined_rows = []
        for row in target["rows"]:
            hid = str(row["_horse_id"])
            require(hid in speed_by_horse and (rid,hid) in bias,
                    "ORIGINAL_EXTRA41_NOT_GENERATED")
            combined = {**row, **bias[(rid,hid)], **speed_by_horse[hid]}
            cols = set(combined) - IDENTITY
            require(len(cols) == 690, "NOT_690_FEATURE_COLUMNS")
            if feature_schema is None:
                feature_schema = cols
            require(feature_schema == cols, "HORSE_FEATURE_SCHEMA_DRIFT")
            for col in cols:
                val = combined[col]
                require(val is None or
                        (not isinstance(val, float) or math.isfinite(val)),
                        "NONFINITE_FEATURE")
                nulls[col] += (val is None)
            joined_rows.append(combined)
        doc = {
            "contract": "KEIBA_BACKFILL_TO_ML_690_UNSCORED_V1",
            "race_id": rid, "race_date": date,
            "feature_count": 690, "starters": len(joined_rows),
            "source_contract": "ORIGINAL_CORE4_649_DAYBIAS_19_SPEED_REGIME_22",
            "used_target_results_or_final_odds": False,
            "source_capture_asof_independently_verified": False,
            "original_ml_full_numerical_parity_verified": False,
            "readiness": "ASOF_UNVERIFIED_DO_NOT_BET",
            "rows": joined_rows
        }
        (target_folder / f"{rid}.json").write_text(
            json.dumps(doc, ensure_ascii=False, allow_nan=False,
                       separators=(",",":"))+"\n", encoding="utf8")
        print("HANDOFF_690_RACE_WRITTEN " +
              json.dumps({"race_id":rid,"horses":len(joined_rows),
                          "features":690},sort_keys=True), flush=True)
    require(len(races)==12*len(discovered),"RACE_COUNT_DRIFT")
    print("HANDOFF_690_DAY_COMPLETE "+json.dumps({
        "date":date,"races":len(races),"horses":starters,
        "cells":starters*690,"nullable_columns":
        sum(x for x in (nulls[col] > 0 for col in feature_schema)),
        "data_dir":str(target_folder),
        "readiness":"ASOF_UNVERIFIED_DO_NOT_BET"
    },sort_keys=True),flush=True)


def build_index(root):
    top = Path(root)/PREFIX
    index = {}
    all_names = set()
    day_counts = Counter()
    days=sorted(set(RACES)|{
        p.name for p in top.iterdir()
        if p.is_dir() and len(p.name)==10 and
        p.name[:4]=="2026" and p.name[4]=="-" and p.name[7]=="-"
    }) if top.exists() else sorted(RACES)
    for day in days:
        folder = top/day
        if not folder.is_dir():
            continue
        for path in sorted(folder.glob("2026*.json")):
            payload = path.read_bytes()
            doc = json.loads(payload)
            race = str(doc["race_id"])
            require((day not in RACES or race in RACES[day]) and
                    race not in index and path.stem==race and
                    race.startswith(day[:4]) and race.isdigit() and len(race)==12,
                    "INDEX_UNRECOGNIZED_RACE_ID")
            require(doc["feature_count"]==690 and doc["race_date"]==day
                    and doc["contract"]=="KEIBA_BACKFILL_TO_ML_690_UNSCORED_V1",
                    "INDEX_CONTRACT_INVALID")
            rows = doc["rows"]
            require(len(rows)==doc["starters"] and len(rows)>0,
                    "INDEX_HORSE_COUNT_INVALID")
            for row in rows:
                names = set(row)-IDENTITY
                require(len(names)==690 and
                        (not all_names or names==all_names),
                        "INDEX_FEATURE_SCHEMA_DRIFT")
                all_names = names
            index[race] = {
                "date": day, "starters": len(rows),
                "path": f"{PREFIX}/{day}/{race}.json",
                "sha256": hashlib.sha256(payload).hexdigest()
            }
            day_counts[day] += len(rows)
        day_races=[k for k,v in index.items() if v["date"]==day]
        if day in RACES:
            require(len(day_races)==len(RACES[day]) and
                    day_counts[day]==POPULATION[day],
                    f"FROZEN_DAY_MANIFEST_DRIFT:{day}")
        else:
            groups=defaultdict(set)
            for rid in day_races:groups[rid[4:6]].add(int(rid[-2:]))
            require(1<=len(groups)<=3 and
                    all(v==set(range(1,13)) for v in groups.values()),
                    f"NEW_DAY_MANIFEST_INCOMPLETE:{day}")
    require(index, "NO_HANDOFF_RACES_YET")
    result = {
        "contract": "KEIBA_BACKFILL_TO_ML_690_INDEX_V1",
        "repository": "pinogame1945-dotcom/KEIBA-BACKFILL",
        "branch": "handoff/690-feature-data-v1",
        "feature_count":690,
        "total_races":len(index),
        "total_horses":sum(entry["starters"] for entry in index.values()),
        "feature_name_sha256":hashlib.sha256(
            "\n".join(sorted(all_names)).encode()).hexdigest(),
        "readiness":"ASOF_UNVERIFIED_DO_NOT_BET",
        "original_ml_full_numerical_parity_verified":False,
        "races":dict(sorted(index.items()))
    }
    top.mkdir(parents=True,exist_ok=True)
    (top/"index.json").write_text(json.dumps(
        result,ensure_ascii=False,indent=2)+"\n",encoding="utf8")
    print("HANDOFF_690_INDEX_COMPLETE "+json.dumps({
        "races":result["total_races"],"horses":result["total_horses"],
        "feature_count":690},sort_keys=True),flush=True)


if __name__=="__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--date")
    p.add_argument("--snapshot")
    p.add_argument("--compact-dir")
    p.add_argument("--out-root",required=True)
    p.add_argument("--index-only",action="store_true")
    a=p.parse_args()
    if not a.index_only:
        require(bool(a.date and a.snapshot and a.compact_dir),
                "EXPORT_DATE_SNAPSHOT_COMPACT_REQUIRED")
        export_day(a.date,a.snapshot,a.compact_dir,a.out_root)
    build_index(a.out_root)
