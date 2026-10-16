#!/usr/bin/env python3
"""Strict comparative audit: ORIGINAL Phase3 batch 690 vs BACKFILL generic 690.

Both paths use the immutable transferred source math. This compares every
race/horse/feature value, missingness and numeric drift, with no ML inference.
Only runner-temp inputs/outputs. Not a historical pre-race timing certificate.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import json
import math
from pathlib import Path

import pandas as pd

from build_690_any_race_v1 import (
    IDENTITY, bias19, load_core4, speed22
)

DAY = "2026-10-10"
IDS = {f"2026{venue}0403{n:02d}" for venue in ("05", "08")
       for n in range(1, 13)}
YEARS = range(2019, 2027)
N_FEATURES = 690
N_STARTERS = 315
N_CELLS = 217350


def check(condition, reason):
    if not condition:
        raise ValueError(reason)


def reference_documents(source):
    reference = {}
    for path in sorted(Path(source).glob("2026*.json")):
        doc = json.loads(path.read_text(encoding="utf-8"))
        rid = str(doc.get("race_id", ""))
        check(rid in IDS and rid not in reference, "UNEXPECTED_OR_REPEATED_REFERENCE_RACE")
        check(doc.get("contract") == "KEIBA_20261010_24_ORIGINAL_690_UNSCORED_INPUT_V1",
              "REFERENCE_CONTRACT_DRIFT")
        check(doc.get("race_date") == DAY and doc.get("feature_count") == 690,
              "REFERENCE_DAY_OR_SCHEMA_DRIFT")
        check(doc.get("used_target_labels") is False and
              doc.get("used_result_payout_or_final_odds") is False,
              "REFERENCE_RESULT_OR_MARKET_UNSAFE")
        reference[rid] = doc
    check(set(reference) == IDS, "NOT_24_REFERENCE_RACES")
    return reference


def load_shared_history(folder):
    frames = []
    for year in YEARS:
        file = Path(folder) / f"prior-full-race-context-{year}.pkl"
        check(file.is_file(), f"HISTORY_YEAR_MISSING:{year}")
        frame = pd.read_pickle(file)
        check(frame["_race_date"].astype(str).lt(DAY).all(),
              f"FUTURE_HISTORY_LEAK:{year}")
        frames.append(frame)
    history = pd.concat(frames, ignore_index=True)
    check(not history.empty, "NO_PRIOR_CONTEXT_ROWS")
    check(not history.duplicated(["_race_id", "_horse_id"]).any(),
          "DUPLICATE_PRIOR_EVENT")
    return history


def diff(a, b):
    if a is None or b is None:
        return ("identical" if a is None and b is None else "missingness_mismatch", None)
    if isinstance(a, bool) or isinstance(b, bool):
        return ("identical" if type(a) is type(b) and a == b else "value_mismatch", None)
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if not math.isfinite(float(a)) or not math.isfinite(float(b)):
            return ("nonfinite_invalid", None)
        if a == b:
            return "identical", 0.
        delta = abs(float(a) - float(b))
        if math.isclose(float(a), float(b), rel_tol=1e-5, abs_tol=1e-5):
            return "approx_only", delta
        return "value_mismatch", delta
    return ("identical" if type(a) is type(b) and a == b else "value_mismatch", None)


def validate_table(rid, rows):
    found = set()
    for row in rows:
        key = str(row.get("_horse_id", ""))
        check(key and key not in found and str(row.get("_race_id")) == rid and
              row.get("_race_date") == DAY,
              "INVALID_TARGET_HORSE_OR_RACE")
        found.add(key)
        check(len(set(row) - IDENTITY) == N_FEATURES, "NOT_690_PER_HORSE")
        for col in set(row) - IDENTITY:
            v = row[col]
            check(v is None or not isinstance(v, float) or math.isfinite(v),
                  "NONFINITE_FEATURE_VALUE")
    return {str(row["_horse_id"]): row for row in rows}


def run(original_dir, snapshot, prior_dir, output):
    originals = reference_documents(original_dir)
    generated = {rid: load_core4(snapshot, rid) for rid in sorted(IDS)}
    for rid, target in generated.items():
        check(target["race_date"] == DAY, "BACKFILL_DATE_MISMATCH")
    check(sum(len(d["rows"]) for d in generated.values()) == N_STARTERS,
          "BACKFILL_HORSE_COUNT_NOT_315")
    all_rows = [row for d in generated.values() for row in d["rows"]]
    check(len({row["_horse_id"] for row in all_rows}) == N_STARTERS,
          "DUPLICATE_HORSE_ACROSS_RACES")
    history = load_shared_history(prior_dir)
    # Original generic 22-feature function on one shared date-level cohort:
    # same code as its one-race operation, with frozen date and full peer rows.
    speed = speed22(history, {"race_date": DAY, "race_id": "2026_24_BATCH",
                              "rows": all_rows})
    by_horse_speed = {
        horse: data for (batch, horse), data in speed.items()
    }
    check(len(by_horse_speed) == N_STARTERS, "SPEED_22_POPULATION_DRIFT")

    totals = Counter()
    by_column = Counter()
    by_race = Counter()
    examples = []
    ref_horses = 0
    for rid in sorted(IDS):
        original = validate_table(rid, originals[rid]["rows"])
        target = generated[rid]
        own_bias = bias19(snapshot, target)
        candidate_rows = []
        for row in target["rows"]:
            hid = row["_horse_id"]
            key = rid, hid
            check(key in own_bias and hid in by_horse_speed,
                  "HISTORY_OR_BIAS_TARGET_MISSING")
            candidate_rows.append({**row, **own_bias[key], **by_horse_speed[hid]})
        candidate = validate_table(rid, candidate_rows)
        check(set(original) == set(candidate), "ORIGINAL_AND_BACKFILL_HORSE_SET_MISMATCH")
        ref_horses += len(original)
        for hid in sorted(original):
            left, right = original[hid], candidate[hid]
            cols = set(left) - IDENTITY
            check(cols == set(right) - IDENTITY,
                  "ORIGINAL_AND_BACKFILL_690_COLUMN_SET_MISMATCH")
            for col in sorted(cols):
                result, delta = diff(left[col], right[col])
                totals[result] += 1
                if result != "identical":
                    by_column[col] += 1
                    by_race[rid] += 1
                    if len(examples) < 40:
                        examples.append({"race_id": rid, "horse_id": hid,
                                         "column": col, "reference": left[col],
                                         "backfill": right[col], "category": result,
                                         "absolute_error": delta})
    check(ref_horses == N_STARTERS and sum(totals.values()) == N_CELLS,
          "REFERENCE_TOTAL_NOT_315X690")
    exact = totals["identical"] == N_CELLS
    near = totals["identical"] + totals["approx_only"] == N_CELLS
    report = {
        "contract": "KEIBA_BACKFILL_20261010_24_FULL_690_CELL_PARITY_AUDIT_V1",
        "race_date": DAY, "races": len(IDS), "starters": ref_horses,
        "columns": N_FEATURES, "cells": N_CELLS,
        "exact_numeric_and_null_parity": exact,
        "within_original_1e-5_tolerance": near,
        "categories": dict(totals),
        "mismatch_columns_count": len(by_column),
        "mismatch_by_column": dict(by_column.most_common(60)),
        "mismatch_by_race": dict(by_race),
        "first_mismatches": examples,
        "actual_pre_race_capture_time_verified": False,
        "model_executed": False,
        "readiness": "ASOF_UNVERIFIED_DO_NOT_BET"
    }
    dest = Path(output)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(report, ensure_ascii=False, indent=2,
                               allow_nan=False) + "\n", encoding="utf-8")
    print("BACKFILL_690_FULL_PARITY " +
          json.dumps({k: report[k] for k in
                      ("races", "starters", "columns", "cells",
                       "exact_numeric_and_null_parity",
                       "within_original_1e-5_tolerance", "categories",
                       "mismatch_columns_count")},
                     sort_keys=True), flush=True)
    if not exact:
        raise ValueError("690_STRICT_PARITY_NOT_PROVEN")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--original-dir", required=True)
    p.add_argument("--snapshot-2026", required=True)
    p.add_argument("--compact-dir", required=True)
    p.add_argument("--output", required=True)
    a = p.parse_args()
    run(a.original_dir, a.snapshot_2026, a.compact_dir, a.output)


if __name__ == "__main__":
    main()
