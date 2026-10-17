#!/usr/bin/env python3
"""Classify verified JRA live snapshot changes without changing frozen 690 math.

Published source must be complete before any output is accepted. Observation
timestamps, HTTP headers, and transport hashes are deliberately not model
feature changes. Every other new/modified source fact is conservative:
recalculate the full original 690 day, rather than guessing feature locality.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

VERIFIED = "SOURCE_AND_ODDS_VERIFIED"


def require(test, reason):
    if not test:
        raise ValueError(reason)


def read_races(root):
    root = Path(root)
    if not root.is_dir():
        return {}, None
    manifest_file = root / "manifest.json"
    require(manifest_file.is_file(), "DELTA_MANIFEST_MISSING")
    manifest = json.loads(manifest_file.read_text("utf-8"))
    entries = manifest.get("races")
    require(isinstance(entries, list), "DELTA_MANIFEST_RACES_INVALID")
    ids = [item.get("race_id") for item in entries]
    require(len(ids) == len(set(ids)) and
            all(isinstance(i, str) and len(i) == 12 and i.isdigit() for i in ids),
            "DELTA_DUPLICATED_OR_INVALID_RACE_ID")
    docs = {}
    for rid in ids:
        path = root / (rid + ".json")
        require(path.is_file(), "DELTA_SNAPSHOT_MISSING:" + rid)
        doc = json.loads(path.read_text("utf-8"))
        require(doc.get("race_id") == rid, "DELTA_SNAPSHOT_ID_MISMATCH:" + rid)
        docs[rid] = doc
    require(manifest.get("actual_races_processed") == len(ids) and
            manifest.get("race_count_expected") == len(ids),
            "DELTA_PARTIAL_DAY_NOT_ALLOWED")
    return docs, manifest


def feature_source(doc):
    net = dict(doc.get("netkeiba") or {})
    net.pop("meta", None)
    jra = dict(doc.get("jra_card") or {})
    jra.pop("meta", None)
    discovery = dict(doc.get("source_discovery") or {})
    discovery.pop("jra_odds_cname", None)
    return {"race_id": doc.get("race_id"),
            "race_date": doc.get("race_date"),
            "source_discovery": discovery,
            "netkeiba": net, "jra_card": jra}


def market_source(doc):
    odds = dict(doc.get("jra_odds") or {})
    observations = odds.get("page_observations")
    if isinstance(observations, dict):
        odds["page_observations"] = {
            k: {name: val for name, val in v.items()
                if name not in ("fetched_at_utc", "sha256", "http_date")}
            for k, v in observations.items()
        }
    return odds


def classify(prior_dir, current_dir):
    old, previous_manifest = read_races(prior_dir)
    new, current_manifest = read_races(current_dir)
    require(current_manifest is not None, "DELTA_CURRENT_DAY_MISSING")
    require(current_manifest.get("day") and
            all(doc.get("race_date") == current_manifest["day"] for doc in new.values()),
            "DELTA_DATE_MISMATCH")
    require(len(new) in (12, 24, 36) and
            all(sum(rid[4:6] == venue for rid in new) == 12
                for venue in {rid[4:6] for rid in new}),
            "DELTA_INCOMPLETE_RACE_DAY")
    require(current_manifest.get("blocked") == 0 and
            current_manifest.get("full_source_and_odds_verified") == len(new) and
            all(doc.get("status") == VERIFIED and
                not doc.get("errors") and doc.get("includes_results") is False and
                doc.get("includes_final_odds") is False
                for doc in new.values()),
            "DELTA_CURRENT_SOURCE_NOT_ALL_VERIFIED")
    if previous_manifest is not None:
        require(previous_manifest.get("day") == current_manifest["day"] and
                set(old) == set(new) and
                all(doc.get("status") == VERIFIED for doc in old.values()),
                "DELTA_PREVIOUS_RACE_SET_OR_STATE_DRIFT")
    result = {"new": [], "feature_changed": [],
              "odds_only_changed": [], "unchanged": []}
    for rid in sorted(new):
        if rid not in old:
            result["new"].append(rid)
        elif feature_source(old[rid]) != feature_source(new[rid]):
            result["feature_changed"].append(rid)
        elif market_source(old[rid]) != market_source(new[rid]):
            result["odds_only_changed"].append(rid)
        else:
            result["unchanged"].append(rid)
    result.update({
        "date": current_manifest["day"],
        "race_count": len(new),
        "recompute_original_690": bool(result["new"] or result["feature_changed"]),
        "publish_new_odds": bool(result["new"] or result["feature_changed"] or
                                 result["odds_only_changed"]),
        "noop": len(result["unchanged"]) == len(new),
        "guarantee": "FULL_690_REBUILD_ON_ANY_FEATURE_CHANGE_NO_SPECULATIVE_PARTIAL_FEATURES",
    })
    return result


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--prior-dir", required=True)
    p.add_argument("--current-dir", required=True)
    p.add_argument("--out", required=True)
    a = p.parse_args()
    report = classify(a.prior_dir, a.current_dir)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                            encoding="utf-8")
    print("LIVE_DAY_DELTA " + json.dumps(report, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
