#!/usr/bin/env python3
"""BACKFILL-side original 649 + 19 same-day bias + 22 speed-state inference inputs.

This is an adapter of the *copied* original feature math, not a new model.
Reads only feature dictionaries from the target snapshot; reads older outcomes
solely to compute historical state. It does not assert independent prebet as-of.
"""
from __future__ import annotations
import argparse
from collections import defaultdict
from contextlib import ExitStack
import gzip
import hashlib
import json
import math
from pathlib import Path
import tempfile
from unittest.mock import patch

import numpy as np
import pandas as pd
from audit_2026_generated_core4_v1 import selected_columns, CORE4_SHA, EXPECTED, digest
from verify_2026_original_690_extra_values_v1 import (
    compact_one_year, independent_prior_events, source_rows,
)
import verify_2026_original_690_extra_values_v1 as original_extra
from compute_blind_target_seq_regime_v1 import horse_features
from run_l1_sameday_track_bias_v1 import (
    BiasState, STYLE_FIELDS, infer_front_score, race_summary, read_bias_source,
)

IDENTITY = {"_race_id", "_horse_id", "_race_date"}
FORBIDDEN = {"_finish", "_is_win", "_is_top3", "target", "market_outcome",
             "final_win_odds", "final_popularity", "_score"}
KEY_PREFIX_BLOCK = ("P__", "distill_", "risk_")
YEARS = set(range(2019, 2027))
EXPECTED_BIAS_KEYS = 19
EXPECTED_SPEED_KEYS = 22


def ensure(cond, reason):
    if not cond:
        raise ValueError(reason)


def fin(v):
    if v is None:
        return None
    try:
        result = float(v)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def load_core4(snapshot, race_id):
    target = []
    all_keys = set()
    day = None
    for raw in source_rows(snapshot):
        features = raw.get("features") or {}
        all_keys.update(selected_columns(features))
        if str(raw.get("race_id")) != race_id:
            continue
        observed = str(features.get("race_date") or "")
        ensure(len(observed) == 10, "TARGET_DATE_MISSING")
        ensure(day in (None, observed), "TARGET_DATE_DRIFT")
        day = observed
        names = selected_columns(features)
        record = {k: features.get(k) for k in names}
        record["race_month"] = int(day[5:7])
        record["race_day_of_year"] = pd.Timestamp(day).dayofyear
        hid = str(raw.get("horse_id") or "")
        ensure(hid, "EMPTY_HORSE_ID")
        target.append({"_race_id": race_id, "_horse_id": hid,
                       "_race_date": day, **record})
    ensure(target and len(target) <= 24, "TARGET_NOT_FOUND_OR_BAD_HORSE_COUNT")
    ensure(len({r["_horse_id"] for r in target}) == len(target),
           "DUPLICATE_HORSE_ID")
    ensure(all_keys and len(all_keys) == EXPECTED and
           digest(sorted(all_keys)) == CORE4_SHA,
           "ORIGINAL_CORE4_649_SCHEMA_SHA_DRIFT")
    missing_all = set(all_keys)
    for row in target:
        missing_all -= set(row) - IDENTITY
    for row in target:
        for key in all_keys:
            row.setdefault(key, None)
        ensure(len(set(row) - IDENTITY) == EXPECTED, "CORE4_649_ROW_DRIFT")
        ensure(not (set(row) & FORBIDDEN) and
               not any(k.startswith(KEY_PREFIX_BLOCK) for k in row),
               "TARGET_FORBIDDEN_MODEL_OR_RESULT_FIELD")
    return {"race_id": race_id, "race_date": day, "rows": target}


def prior_context(target, year_files, folder):
    """Existing original two-pass peer-preserving compact reader, parameterized by target date."""
    year_of_target = int(target["race_date"][:4])
    compacts = []
    for year, source in sorted(year_files.items()):
        ensure(year in YEARS and year <= year_of_target, "HISTORY_YEAR_NOT_ALLOWED")
        out = Path(folder) / f"prior-full-race-context-{year}.pkl"
        compact_one_year(source, year, target, out)
        frame = pd.read_pickle(out)
        ensure(frame["_race_date"].astype(str).lt(target["race_date"]).all(),
               "FUTURE_HISTORY_USED")
        compacts.append(frame)
    ensure(compacts, "NO_HISTORICAL_SNAPSHOTS")
    return pd.concat(compacts, ignore_index=True)


def speed22(history, target):
    date = target["race_date"]
    if history.empty:
        prior = history
    else:
        with patch.object(original_extra, "DAY", date):
            prior = independent_prior_events(history)
    byhorse = defaultdict(lambda: prior.iloc[0:0])
    if not prior.empty:
        byhorse.update({
            str(h): grp for h, grp in prior.groupby("_horse_id", sort=False)
        })
    out = {}
    for row in target["rows"]:
        hid = str(row["_horse_id"])
        # frozen pure function: copied from the original ML implementation
        values = horse_features(byhorse[hid], date)
        selected = {k: fin(v) for k, v in values.items()
                    if k.startswith("regime_speed_resid_")}
        ensure(len(selected) == EXPECTED_SPEED_KEYS,
               "ORIGINAL_SPEED_STATE_22_SCHEMA_DRIFT")
        out[(target["race_id"], hid)] = selected
    return out


def bias19(snapshot, target):
    day = target["race_date"]
    rid = target["race_id"]
    first = target["rows"][0]
    venue = str(first["venue_code"])
    surface = str(first["surface"])
    number = int(first["race_no"])
    ensure(all(str(r["venue_code"]) == venue and
               str(r["surface"]) == surface and
               int(r["race_no"]) == number
               for r in target["rows"]), "TARGET_META_DRIFT")
    styles = {}
    matched = []
    for record in source_rows(snapshot):
        feat = record.get("features") or {}
        if feat.get("race_date") != day:
            continue
        if str(record.get("race_id")) == rid:
            hid = str(record.get("horse_id"))
            ensure(hid not in styles, "DUPLICATE_TARGET_STYLE")
            styles[hid] = {k: feat.get(k) for k in STYLE_FIELDS}
            continue
        if (str(feat.get("venue_code")) == venue and
                str(feat.get("surface")) == surface and
                int(feat.get("race_no") or 0) < number):
            matched.append(record)
    ensure(set(styles) == {str(r["_horse_id"]) for r in target["rows"]},
           "TARGET_STYLE_IDS_DRIFT")
    previous = None
    if matched:
        with tempfile.TemporaryDirectory() as t:
            path = Path(t) / "previous-races.jsonl.gz"
            with gzip.open(path, "wt", encoding="utf8") as out:
                for item in matched:
                    out.write(json.dumps(item, ensure_ascii=False) + "\n")
            previous = read_bias_source(path, int(day[:4]))
            previous["front_score"] = infer_front_score(previous)
    state = BiasState()
    if previous is not None:
        for _, subset in previous[["_race_id", "race_no"]].drop_duplicates().sort_values(
                ["race_no", "_race_id"]).groupby("race_no", sort=True):
            pending = [race_summary(previous.loc[previous["_race_id"].eq(r)].copy())
                       for r in subset["_race_id"].tolist()]
            for item in pending:
                state.update(item)
    current = pd.DataFrame.from_records(
        [{**row, **styles[str(row["_horse_id"])]} for row in target["rows"]]
    )
    for name in STYLE_FIELDS:
        if name not in current:
            current[name] = np.nan
    if "field_size" not in current:
        current["field_size"] = len(current)
    front = infer_front_score(current)
    nums = pd.to_numeric(current["horse_number"], errors="coerce")
    inner = (1 - (nums - 1) / max(1., float(len(current) - 1))).clip(0, 1)
    snap = state.snapshot()
    out = {}
    for i, row in current.iterrows():
        f = float(front.loc[i])
        n = float(inner.loc[i])
        values = {
            **snap, "horse_front_score": f, "horse_inner_score": n,
            "fit_front_mean": f * float(snap["daybias_front_gap_mean"]),
            "fit_front_ewma": f * float(snap["daybias_front_gap_ewma"]),
            "fit_inner_mean": n * float(snap["daybias_inner_gap_mean"]),
            "fit_inner_ewma": n * float(snap["daybias_inner_gap_ewma"]),
        }
        ensure(len(values) == EXPECTED_BIAS_KEYS,
               "ORIGINAL_DAYBIAS_19_SCHEMA_DRIFT")
        out[(rid, str(row["_horse_id"]))] = {k: fin(v) for k, v in values.items()}
    return out


def run(snapshot, history_sources, rid, output):
    target = load_core4(snapshot, rid)
    ensure(rid[:4] == target["race_date"][:4], "RACE_YEAR_MISMATCH")
    with tempfile.TemporaryDirectory() as folder:
        prior = prior_context(target, history_sources, folder)
        speed = speed22(prior, target)
    bias = bias19(snapshot, target)
    rows = []
    keys_expected = None
    for item in target["rows"]:
        key = rid, str(item["_horse_id"])
        joined = {**item, **speed[key], **bias[key]}
        features = set(joined) - IDENTITY
        ensure(len(features) == 690, "FEATURE_690_COUNT_DRIFT")
        if keys_expected is not None:
            ensure(features == keys_expected, "FEATURE_690_HORSE_SCHEMA_MISMATCH")
        keys_expected = features
        rows.append(joined)
    doc = {
        "contract": "KEIBA_BACKFILL_ORIGINAL_L1_690_INPUT_V1",
        "race_id": rid, "race_date": target["race_date"],
        "feature_count": 690, "starters": len(rows),
        "readiness": "ASOF_UNVERIFIED_DO_NOT_BET",
        "source_capture_asof_independently_verified": False,
        "used_target_results_or_final_odds": False,
        "source_contract": "ORIGINAL_L1_CORE4_649_PLUS_ORIGINAL_DAYBIAS19_REGIME22",
        "rows": rows
    }
    dest = Path(output)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(doc, ensure_ascii=False, allow_nan=False) + "\n",
                    encoding="utf8")
    return doc


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--snapshot", required=True, help="TARGET YEAR ML-derived data snapshot JSONL or JSONL.GZ")
    p.add_argument("--prior-snapshot", action="append", required=True,
                   help="YEAR:/path/to/snapshot, repeat for original prior years")
    p.add_argument("--race-id", required=True)
    p.add_argument("--output", required=True)
    a = p.parse_args()
    ensure(len(a.race_id) == 12 and a.race_id.isdigit(), "RACE_ID_INVALID")
    years = {}
    for value in a.prior_snapshot:
        year, sep, path = value.partition(":")
        ensure(sep and year.isdigit() and int(year) not in years, "BAD_PRIOR_SOURCE")
        years[int(year)] = path
    result = run(a.snapshot, years, a.race_id, a.output)
    print("BACKFILL_ORIGINAL_690_CREATED_ASOF_UNVERIFIED " +
          json.dumps({"race_id": result["race_id"], "starters": result["starters"],
                      "feature_count": result["feature_count"]}))


if __name__ == "__main__":
    main()
