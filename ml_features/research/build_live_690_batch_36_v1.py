#!/usr/bin/env python3
"""Full 690 feature reassembly for 2026-10-17's verified pre-race 36-race card.

Unmodified CORE4 selector, 19 original same-day bias formulas and 22 original
speed regime formulas. The common history compact is computed once for 471
horses. No prediction, post-race target, or betting readiness is claimed.
"""
from __future__ import annotations

import argparse
from collections import Counter
import json
import math
from pathlib import Path

import pandas as pd

from build_690_any_race_v1 import (
    IDENTITY, bias19, load_core4, speed22
)

DAY = "2026-10-17"
RACES = {f"2026{venue}04{day}{n:02d}" for venue,day in
         (("04", "01"), ("05", "06"), ("08", "06")) for n in range(1, 13)}
YEARS = range(2019, 2027)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def collect(snapshot):
    sources = {rid: load_core4(snapshot, rid) for rid in sorted(RACES)}
    require(len(sources) == 36, "EXPECTED_36_RACES")
    require(all(doc["race_date"] == DAY for doc in sources.values()),
            "LIVE_RACE_DATE_MISMATCH")
    population = [row for doc in sources.values() for row in doc["rows"]]
    require(len(population) == 471, "EXPECTED_471_ACTIVE_RUNNERS")
    require(len({row["_horse_id"] for row in population}) == 471,
            "REPEATED_HORSE_ACROSS_LIVE_RACES")
    return sources, population


def validate_prior(folder):
    frames = []
    for year in YEARS:
        f = Path(folder) / f"prior-full-race-context-{year}.pkl"
        require(f.exists(), f"PRIOR_YEAR_NOT_READY:{year}")
        df = pd.read_pickle(f)
        require(df["_race_date"].astype(str).lt(DAY).all(),
                f"PRIOR_TIME_LEAK:{year}")
        frames.append(df)
    complete = pd.concat(frames, ignore_index=True)
    require(not complete.empty and not complete.duplicated(
        ["_race_id", "_horse_id"]).any(), "HISTORY_EMPTY_OR_DUPLICATED")
    return complete


def run(snapshot, prior_dir, output_dir):
    sources, population = collect(snapshot)
    prior = validate_prior(prior_dir)
    speed = speed22(prior, {"race_date": DAY, "race_id": "2026_36_BATCH",
                            "rows": population})
    speed_by_horse = {horse: data for (_, horse),data in speed.items()}
    require(len(speed_by_horse) == 471, "SPEED_22_COUNT_NOT_471")
    dest = Path(output_dir)
    dest.mkdir(parents=True, exist_ok=True)
    cols = None
    summary = Counter()
    all_null = Counter()
    for rid in sorted(RACES):
        source = sources[rid]
        bias = bias19(snapshot, source)
        output = []
        for row in source["rows"]:
            hid = str(row["_horse_id"])
            require(hid in speed_by_horse and (rid,hid) in bias,
                    "MISSING_ORIGINAL_41_FEATURES")
            joined = {**row, **bias[(rid,hid)], **speed_by_horse[hid]}
            features = set(joined) - IDENTITY
            require(len(features) == 690, "FEATURE_COUNT_NOT_690")
            if cols is None:
                cols = features
            require(cols == features, "FEATURE_690_NAME_MISMATCH")
            for key in features:
                val = joined[key]
                require(val is None or not isinstance(val, float) or
                        math.isfinite(val), "NONFINITE_690_INPUT")
                all_null[key] += int(val is None)
            summary["cells"] += 690
            output.append(joined)
        summary["races"] += 1
        summary["horses"] += len(output)
        (dest / f"{rid}.json").write_text(json.dumps({
            "contract": "KEIBA_BACKFILL_20261017_ORIGINAL_690_UNSCORED_TRIAL_V1",
            "race_id": rid, "race_date": DAY, "starters": len(output),
            "feature_count": 690,
            "readiness": "ASOF_UNVERIFIED_DO_NOT_BET",
            "used_target_results_or_final_odds": False,
            "source_capture_asof_independently_verified": False,
            "rows": output,
        }, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    require(summary["races"] == 36 and summary["horses"] == 471 and
            summary["cells"] == 471*690 and len(cols) == 690,
            "LIVE_36_690_TARGET_COUNT_DRIFT")
    report = {
        "contract": "KEIBA_BACKFILL_20261017_36_LIVE_690_AUDIT_V1",
        "race_date": DAY, "races": 36, "active_horses": 471,
        "features_per_horse": 690, "feature_cells": summary["cells"],
        "nonnull_cells": summary["cells"]-sum(all_null.values()),
        "null_cells": sum(all_null.values()),
        "fully_null_columns": sorted(c for c in cols if all_null[c] == 471),
        "readiness": "ASOF_UNVERIFIED_DO_NOT_BET",
        "target_outcomes_used": False,
        "model_executed": False,
        "live_prestart_asof_independently_certified": False,
    }
    (dest/"manifest.json").write_text(json.dumps(
        report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("BACKFILL_LIVE_36_FULL_690 " + json.dumps(
        report, ensure_ascii=False, sort_keys=True), flush=True)
    return report


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--snapshot-2026", required=True)
    ap.add_argument("--compact-dir", required=True)
    ap.add_argument("--out", required=True)
    options = ap.parse_args()
    run(options.snapshot_2026, options.compact_dir, options.out)
