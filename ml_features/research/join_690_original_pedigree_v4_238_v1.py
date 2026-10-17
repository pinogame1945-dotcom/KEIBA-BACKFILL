#!/usr/bin/env python3
"""Read saved pedigree V4 once and join to frozen 690 target rows by race/horse.
No historical replay, model execution, 2026 target outcomes or training.
"""
from __future__ import annotations
import argparse
import gzip
import json
from pathlib import Path
from pedigree_v4_cache_v1 import verify, DAY_COUNTS, require

EXPECTED_PED_LEGACY=204
EXPECTED_PED_RACE_CLASS=34
TARGET_690_CONTRACT="KEIBA_BACKFILL_TO_ML_690_UNSCORED_V1"
JOIN_CONTRACT="KEIBA_BACKFILL_690_PLUS_ORIGINAL_V4_238_UNSCORED_V1"

def joined(root: Path, cache: Path, output: Path):
    manifest=verify(root,cache)
    output.mkdir(parents=True,exist_ok=True)
    totals={}
    all_schema=None
    for day,(expected_races,expected_horses) in DAY_COUNTS.items():
        joined_races=0
        joined_horses=0
        for pedigree_file in sorted((cache/day).glob("*.json.gz")):
            rid=pedigree_file.name.removesuffix(".json.gz")
            pedigree=json.loads(gzip.decompress(pedigree_file.read_bytes()))
            source_path=root/"ml_features"/"delivery"/"690"/day/(rid+".json")
            require(source_path.is_file(),"MISSING_ORIGINAL_690:"+rid)
            orig=json.loads(source_path.read_text(encoding="utf-8"))
            require(orig.get("contract")==TARGET_690_CONTRACT and
                    orig.get("used_target_results_or_final_odds") is False and
                    orig.get("feature_count")==690 and
                    orig.get("race_id")==rid and orig.get("race_date")==day,
                    "FROZEN_690_CONTRACT_DRIFT:"+rid)
            require(orig.get("readiness")=="ASOF_UNVERIFIED_DO_NOT_BET",
                    "READY_FOR_BETTING_FLAG_DRIFT:"+rid)
            ped_by_id={str(row["_horse_id"]):row for row in pedigree["rows"]}
            require(len(ped_by_id)==len(pedigree["rows"]),"DUP_PED_HORSE:"+rid)
            rows=[]
            for original in orig["rows"]:
                hid=str(original["_horse_id"])
                require(hid in ped_by_id,"HORSE_MISSING_IN_PED_238:"+rid+":"+hid)
                require(original["_race_id"]==rid and original["_race_date"]==day,
                        "FROZEN_690_ROW_IDENTITY_DRIFT:"+rid+":"+hid)
                base={k:v for k,v in original.items() if not k.startswith("_")}
                ped={k:v for k,v in ped_by_id[hid].items() if k.startswith("ped_")}
                require(len(base)==690 and len(ped)==238,"690_OR_238_SCHEMA_DRIFT:"+rid)
                require(not set(base).intersection(ped),"690_AND_PEDIGREE_COLUMN_COLLISION")
                raceclass=[k for k in ped if k.startswith("ped_sire_race_class_")
                    or k.startswith("ped_damsire_race_class_")]
                require(len(raceclass)==EXPECTED_PED_RACE_CLASS and
                    len(ped)-len(raceclass)==EXPECTED_PED_LEGACY,
                    "V4_RACE_CLASS_SPLIT_DRIFT:"+rid)
                features={**base,**ped}
                keys=set(features)
                require(len(keys)==928,"MERGED_FEATURE_COUNT_NOT_928")
                require(all_schema is None or keys==all_schema,
                        "MERGED_928_SCHEMA_DIFFERS_BETWEEN_RACES")
                all_schema=keys
                require(all(v is None or not isinstance(v,float) or
                    float("-inf") < v < float("inf") for v in features.values()),
                    "NONFINITE_MERGED_FEATURE:"+rid+":"+hid)
                require("target" not in features and "market_outcome" not in features,
                    "FORBIDDEN_TARGET_OR_MARKET_OUTCOME")
                rows.append({"_race_id":rid,"_horse_id":hid,"_race_date":day,
                             **features})
            require({r["_horse_id"] for r in rows}==set(ped_by_id) and
                    len(rows)==orig["starters"],
                    "MERGED_ID_OR_RUNNER_COUNT_DRIFT:"+rid)
            doc={
                "contract":JOIN_CONTRACT,"race_id":rid,"race_date":day,
                "starters":len(rows),"feature_count":928,
                "source_690_contract":TARGET_690_CONTRACT,
                "source_pedigree_v4_cache_fingerprint":manifest["fingerprint"],
                "readiness":"ASOF_UNVERIFIED_DO_NOT_BET",
                "used_target_results_or_final_odds":False,
                "2026_results_read_or_evaluated":False,
                "seven_king_models_executed":False,
                "rows":rows,
            }
            dest=output/day/(rid+".json")
            dest.parent.mkdir(parents=True,exist_ok=True)
            dest.write_text(json.dumps(doc,ensure_ascii=False,
                separators=(",",":"),allow_nan=False)+"\n",encoding="utf-8")
            joined_races+=1
            joined_horses+=len(rows)
        require((joined_races,joined_horses)==(expected_races,expected_horses),
            "MERGE_TARGET_DAY_COUNTS:"+day)
        totals[day]={"races":joined_races,"horses":joined_horses}
    report={
        "contract":"KEIBA_690_PLUS_V4_238_ON_DEMAND_JOIN_AUDIT_V1",
        "source_cached_pedigree":True,
        "historical_recalculation":False,
        "target":totals,"feature_count":928,"pedigree_count":238,
        "original_690_count":690,"total_horses":786,"total_races":60,
        "saved_original_v4_schema_slices":{
            "pedlegacy":EXPECTED_PED_LEGACY,
            "pedv1":238,"condrc_race_class":EXPECTED_PED_RACE_CLASS},
        "note":"These are pedigree slice counts, not a validation against 7 model schema.json files.",
        "2026_outcomes_used":False,"model_executed":False,
        "approved_for_betting":False,
    }
    (output/"join-report.json").write_text(json.dumps(report,ensure_ascii=False,
        indent=2)+"\n",encoding="utf-8")
    print("ORIGINAL_690_PLUS_PEDIGREE_238_JOINED "+json.dumps(
        report,sort_keys=True),flush=True)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--root",default=".")
    parser.add_argument("--cache",default="ml_features/delivery/pedigree-v4")
    parser.add_argument("--output",required=True)
    args=parser.parse_args()
    root=Path(args.root).resolve()
    cache=(root/args.cache).resolve()
    joined(root,cache,Path(args.output).resolve())

if __name__=="__main__":
    main()
