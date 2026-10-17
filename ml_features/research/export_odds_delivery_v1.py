#!/usr/bin/env python3
"""Copy existing odds (NOT feature or model recomputation) to ML race-ID handoff.

2026-10-10: preserved netkeiba post-race FINAL odds from gzip day pack.
2026-10-17: preserved JRA official pre-race quoted/no-vote/scratched odds.
No information is silently filled. Output is tagged by source and snapshot.
The input features are an existing 690 index with validated race membership.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path

BET_TYPES = {
    "1": "WIN", "2": "PLACE", "3": "BRACKET_QUINELLA",
    "4": "QUINELLA", "5": "WIDE", "6": "EXACTA",
    "7": "TRIO", "8": "TRIFECTA",
}
BASE = Path("ml_features/delivery")
DATES = ("2026-10-10", "2026-10-17")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def make_historical(race, item):
    require(item.get("race_id") == race, "HISTORICAL_RACE_ID_DRIFT")
    require(item.get("source_status") == "result" and
            item.get("odds_kind") == "FINAL" and
            item.get("source") == "NETKEIBA_FINAL",
            f"NOT_CONFIRMED_FINAL_ODDS:{race}")
    odds = item.get("odds")
    require(isinstance(odds, dict) and odds, "HISTORICAL_ODDS_MISSING")
    require(set(odds).issubset(BET_TYPES), "HISTORICAL_UNKNOWN_BET_GROUP")
    present = set(odds)
    missing = set(BET_TYPES) - present
    # Netkeiba FINAL may omit an unoffered/unpublished ticket group,
    # especially on obstacle races. Preserve missingness; never invent odds.
    for typ, combos in odds.items():
        require(isinstance(combos, dict), f"ODDS_GROUP_INVALID:{race}:{typ}")
        for key, vals in combos.items():
            require(isinstance(key, str) and isinstance(vals, list) and
                    len(vals) >= 3, "HISTORICAL_ODDS_ROW_INVALID")
    return {
        "source": "NETKEIBA_FINAL", "snapshot_type": "POST_RACE_FINAL",
        "source_fetched_at": item.get("fetched_at"),
        "source_official_datetime": item.get("source_official_datetime"),
        "quote_format": "NETKEIBA_GROUP_CODE_RAW_TUPLES",
        "group_code_to_bet_type": BET_TYPES,
        "present_bet_types": sorted(BET_TYPES[c] for c in present),
        "source_absent_bet_types": sorted(BET_TYPES[c] for c in missing),
        "all_eight_bet_types_present": not missing,
        "raw_group_odds": odds,
        "group_summary": item.get("group_summary"),
        "readiness": "FINAL_ODDS_NOT_PRE_RACE_ASOF",
    }


def make_live(race, item):
    require(item.get("race_id") == race and
            item.get("includes_results") is False and
            item.get("includes_final_odds") is False and
            item.get("status") == "SOURCE_AND_ODDS_VERIFIED" and
            not item.get("errors"), "LIVE_SOURCE_NOT_VERIFIED")
    v = item.get("jra_odds") or {}
    require(v.get("source") == "JRA_OFFICIAL_POST" and
            v.get("snapshot_type") == "PRE_RACE_LIVE_ODDS" and
            v.get("combination_coverage_complete") is True,
            f"LIVE_ODDS_COVERAGE_NOT_VERIFIED:{race}")
    require(set(v.get("by_bet_type") or {}) == set(BET_TYPES.values()),
            f"LIVE_8_TYPES_NOT_PRESENT:{race}")
    quoted=v.get("quotes")
    no_votes=v.get("no_votes")
    scratched=v.get("scratched_combinations")
    require(all(isinstance(a,list) for a in (quoted,no_votes,scratched)),
            "LIVE_ODDS_QUOTES_MISSING")
    total=len(quoted)+len(no_votes)+len(scratched)
    require(total == v.get("expected_combination_count") and
            len(quoted) == v.get("quoted_combination_count") and
            len(no_votes) == v.get("no_votes_combination_count") and
            len(scratched) == v.get("scratched_combination_count"),
            f"LIVE_ODDS_COMBINATIONS_DRIFT:{race}")
    require(item.get("captured_at_utc"), "LIVE_CAPTURE_TIMESTAMP_MISSING")
    return {
        "source": "JRA_OFFICIAL_POST",
        "snapshot_type": "PRE_RACE_LIVE_ODDS",
        "source_captured_at_utc": item["captured_at_utc"],
        "publisher_update_display_consistent":
            v.get("publisher_update_display_consistent"),
        "publisher_update_day_not_inferred":
            v.get("publisher_update_day_not_inferred"),
        "page_observations": v.get("page_observations"),
        "quote_format": "JRA_QUOTE_ARRAYS",
        "by_bet_type": v["by_bet_type"],
        "expected_combination_count": v["expected_combination_count"],
        "quoted_combination_count": len(quoted),
        "no_votes_combination_count": len(no_votes),
        "scratched_combination_count": len(scratched),
        "quotes": quoted, "no_votes": no_votes,
        "scratched_combinations": scratched,
        "not_offered_bet_types": v.get("not_offered_bet_types"),
        "readiness": "PRE_RACE_OBSERVED_ASOF_UNVERIFIED",
    }


def export_date(date, source_root, dest_root):
    require(date in DATES, "OUT_OF_SCOPE_DATE")
    source=Path(source_root)
    target=Path(dest_root)
    feature_index=load_json(target/BASE/"690/index.json")
    require(feature_index.get("contract") ==
            "KEIBA_BACKFILL_TO_ML_690_INDEX_V1",
            "ML_FEATURE_INDEX_INVALID")
    selected={rid: v for rid,v in feature_index["races"].items()
              if v["date"] == date}
    require(len(selected) == (24 if date == DATES[0] else 36),
            "NOT_ALL_FEATURE_RACES_EXPORTED")
    if date == DATES[0]:
        pack=source/"data/odds/daily"/(date+".jsonl.gz")
        require(pack.is_file(), "HISTORICAL_FINAL_ODDS_PACK_MISSING")
        with gzip.open(pack,"rt",encoding="utf-8") as fh:
            items=[json.loads(line) for line in fh if line.strip()]
        all_odds={}
        for item in items:
            rid=str(item.get("race_id") or "")
            require(rid not in all_odds and len(rid)==12, "ODDS_DUPLICATE_RACE")
            all_odds[rid]=item
        require(set(selected).issubset(all_odds),
                "HISTORICAL_ODDS_RACES_MISSING")
    else:
        source_dir=source/"data/live"/date
        require(source_dir.is_dir(),"JRA_LIVE_SOURCE_MISSING")
        all_odds={}
        for file in source_dir.glob("*.json"):
            if file.stem.isdigit() and len(file.stem)==12:
                item=load_json(file)
                require(item.get("race_id")==file.stem, "LIVE_FILENAME_DRIFT")
                all_odds[file.stem]=item
        require(set(selected).issubset(all_odds), "JRA_LIVE_RACES_MISSING")
    result_dir=target/BASE/"odds"/date
    result_dir.mkdir(parents=True,exist_ok=True)
    for rid in sorted(selected):
        original=all_odds[rid]
        odds=make_historical(rid,original) if date==DATES[0] else make_live(rid,original)
        doc={
            "contract": "KEIBA_BACKFILL_TO_ML_ODDS_V1",
            "race_id":rid,"race_date":date,
            "feature_reference":selected[rid]["path"],
            "feature_sha256":selected[rid]["sha256"],
            "original_is_unmodified_source": True,
            "odds":odds,
        }
        (result_dir/(rid+".json")).write_text(
            json.dumps(doc,ensure_ascii=False,separators=(",",":"),
                       allow_nan=False)+"\n",encoding="utf8")
    print("ODDS_HANDOFF_DAY_WRITTEN "+json.dumps(
        {"date":date,"races":len(selected),"source":
         "NETKEIBA_FINAL" if date==DATES[0] else "JRA_OFFICIAL_POST"},
        sort_keys=True),flush=True)


def index_odds(root, *, require_complete=True):
    target=Path(root)
    fi=load_json(target/BASE/"690/index.json")
    races=fi["races"]
    found={}
    for rid,f in sorted(races.items()):
        file=target/BASE/"odds"/f["date"]/(rid+".json")
        if not file.is_file():
            if require_complete:
                raise ValueError(f"ODDS_HANDOFF_RACE_NOT_EXPORTED:{rid}")
            continue
        data=file.read_bytes()
        doc=json.loads(data)
        require(doc["race_id"] == rid and
                doc["feature_sha256"] == f["sha256"] and
                doc["feature_reference"] == f["path"],
                "ODDS_FEATURE_REFERENCE_MISMATCH")
        found[rid]={
            "date":f["date"],"path":str(BASE/"odds"/f["date"]/(rid+".json")),
            "sha256":hashlib.sha256(data).hexdigest(),
            "source":doc["odds"]["source"],
            "snapshot_type":doc["odds"]["snapshot_type"],
            "readiness":doc["odds"]["readiness"],
            "feature_sha256":f["sha256"],
        }
    out={"contract":"KEIBA_BACKFILL_TO_ML_ODDS_INDEX_V1",
         "repository":fi["repository"],"branch":fi["branch"],
         "total_races":len(found),
         "feature_index_path":str(BASE/"690/index.json"),
         "feature_contract":fi["contract"],
         "races":found}
    d=target/BASE/"odds"
    d.mkdir(parents=True,exist_ok=True)
    (d/"index.json").write_text(
        json.dumps(out,ensure_ascii=False,indent=2)+"\n",encoding="utf8")
    print("ODDS_HANDOFF_INDEX "+json.dumps(
        {"races":len(found),"complete":len(found)==len(races)},sort_keys=True),
          flush=True)


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--source-root",default=".")
    parser.add_argument("--out-root",required=True)
    parser.add_argument("--date",choices=DATES)
    parser.add_argument("--index-only",action="store_true")
    p=parser.parse_args()
    if not p.index_only:
        require(p.date,"DATE_REQUIRED")
        export_date(p.date,p.source_root,p.out_root)
    index_odds(p.out_root, require_complete=False)
