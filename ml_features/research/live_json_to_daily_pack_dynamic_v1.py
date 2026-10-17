#!/usr/bin/env python3
"""Strict, pre-race-only adapter: verified 2026-10-17 live JSON -> temporary BACKFILL daily pack.

This is a format adapter. It never interprets market odds as results, never fills
missing facts with invented values, and never publishes model readiness.
"""
import argparse
from datetime import datetime, timezone
import os
from collections import Counter
import gzip
import json
import re
from pathlib import Path

DAY = os.environ.get("KEIBA_LIVE_DATE", "2026-10-17")
CUT_OFF = datetime.fromisoformat(DAY+"T00:00:00+09:00").astimezone(timezone.utc)
EXPECTED_IDS = {
    f"2026{venue}04{day}{no:02d}"
    for venue, day in (("04", "01"), ("05", "06"), ("08", "06"))
    for no in range(1, 13)
}
ALLOWED_STATUSES = {"LISTED", "SCRATCHED", "EXCLUDED"}
BET_TYPES = {"WIN", "PLACE", "BRACKET_QUINELLA", "QUINELLA",
             "WIDE", "EXACTA", "TRIO", "TRIFECTA"}
IDENTITY = ("race.venue_code", "race.meeting_no", "race.meeting_day",
            "race.race_no", "race.race_id")


def require(cond, reason):
    if not cond:
        raise ValueError(reason)


def observed_before_race(value, cutoff=CUT_OFF):
    require(isinstance(value, str), "SOURCE_CAPTURE_TIME_ABSENT")
    at = datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(at.tzinfo is not None and at.astimezone(timezone.utc) < cutoff,
            "SOURCE_NOT_PROVEN_CAPTURED_BEFORE_RACE")


def official_race_cutoff(source):
    # Previously captured days without an official scheduled time retain the
    # strict pre-midnight rule; never fabricate a race's starting time.
    start = source.get("scheduled_start_time_jst")
    if start is None:
        return CUT_OFF
    require(isinstance(start, str) and
            re.fullmatch(r"(?:[01][0-9]|2[0-3]):[0-5][0-9]", start),
            "OFFICIAL_SCHEDULED_START_TIME_INVALID")
    return datetime.fromisoformat(DAY + "T" + start + ":00+09:00").astimezone(timezone.utc)


def convert(doc):
    rid = str(doc.get("race_id") or "")
    require(rid in EXPECTED_IDS and doc.get("race_date") == DAY,
            "RACE_ID_OR_DATE_INVALID")
    require(doc.get("status") == "SOURCE_AND_ODDS_VERIFIED", "SOURCE_NOT_VERIFIED")
    require(doc.get("includes_results") is False and
            doc.get("includes_final_odds") is False and
            doc.get("models_executed") is False and
            doc.get("backfill_history_features_computed") is False,
            "LIVE_SOURCE_NOT_PRE_RACE")
    source = doc.get("source_discovery") or {}
    cutoff = official_race_cutoff(source)
    observed_before_race(doc.get("captured_at_utc"), cutoff)
    net = doc.get("netkeiba") or {}
    jra = doc.get("jra_card") or {}
    odds = doc.get("jra_odds") or {}
    require(jra.get("identity_verified") is True, "OFFICIAL_RUNNER_IDENTITY_NOT_VERIFIED")
    require(odds.get("combination_coverage_complete") is True and
            odds.get("publisher_update_display_consistent") is True and
            odds.get("snapshot_type") == "PRE_RACE_LIVE_ODDS",
            "JRA_ODDS_INTEGRITY_NOT_VERIFIED")
    require(set(odds.get("by_bet_type") or {}) == BET_TYPES,
            "EIGHT_BET_TYPES_NOT_COVERED")
    for page in (odds.get("page_observations") or {}).values():
        observed_before_race(page.get("fetched_at_utc"), cutoff)
    observed_before_race((net.get("meta") or {}).get("fetched_at_utc"), cutoff)
    require(net.get("runner_count") in range(3, 19) and
            isinstance(net.get("runners"), list) and
            len(net["runners"]) == net["runner_count"],
            "RUNNER_POPULATION_INVALID")

    ledger = net.get("features_149")
    require(isinstance(ledger, list) and len(ledger) == 149 and
            len({x.get("feature_id") for x in ledger}) == 149,
            "ORIGINAL_149_SOURCE_LEDGER_INVALID")
    facts = {x["feature_id"]: x for x in ledger}
    for key in IDENTITY:
        require(key in facts and facts[key].get("observed_value") is not None,
                "RACE_KEY_NOT_OBSERVED:" + key)
    require(str(facts["race.race_id"]["observed_value"]) == rid,
            "SOURCE_RACE_ID_MISMATCH")
    source = doc.get("source_discovery") or {}
    require(source.get("race_id") == rid and source.get("race_date") == DAY and
            str(source.get("venue_code")) == rid[4:6] and
            str(source.get("race_no")).zfill(2) == rid[-2:],
            "DISCOVERY_RACE_META_MISMATCH")

    def val(key):
        info = facts.get("race." + key, {})
        return info.get("observed_value") if info.get("status") == "OBSERVED_OR_DERIVED_FROM_PAGE" else None

    official = jra.get("official_horse_set") or []
    require(len(official) == net["runner_count"] and
            len({x.get("horse_name") for x in official}) == len(official),
            "OFFICIAL_HORSE_POPULATION_MISMATCH")
    observed_names = {x.get("horse_name"): x for x in official}
    entries = []
    for h in net["runners"]:
        name = h.get("horse_name")
        checked = observed_names.get(name)
        require(checked is not None, "HORSE_NOT_IN_JRA_CARD")
        status = checked.get("entry_status")
        require(status in ALLOWED_STATUSES, "UNSUPPORTED_OFFICIAL_ENTRY_STATUS")
        num, gate = h.get("horse_number"), h.get("gate")
        require(type(num) is int and 1 <= num <= 18 and
                type(gate) is int and 1 <= gate <= 8 and
                isinstance(h.get("horse_id"), str) and h["horse_id"].isdigit(),
                "HORSE_NUMBER_GATE_OR_ID_INVALID")
        if status == "LISTED":
            require(checked.get("horse_number") == num, "LISTED_HORSE_NUMBER_DRIFT")
        else:
            require(checked.get("horse_number") in (num, None),
                    "WITHDRAWN_HORSE_NUMBER_DRIFT")
        require(checked.get("gate") == gate, "HORSE_FRAME_DRIFT")
        entries.append({
            "race_id": rid, "horse_id": h["horse_id"],
            "horse_name": name, "gate": gate, "horse_number": num,
            "sex": h.get("sex"), "age": h.get("age"),
            "carried_weight": h.get("carried_weight"),
            "jockey_id": h.get("jockey_id"),
            "trainer_id": h.get("trainer_id"),
            "body_weight": h.get("body_weight"),
            "body_weight_diff": h.get("body_weight_diff"),
            "entry_status": status if status != "LISTED" else "STARTED"
        })
    require(len({x["horse_id"] for x in entries}) == len(entries) and
            sorted(x["horse_number"] for x in entries) == list(range(1, len(entries) + 1)),
            "RUNNER_DUPLICATE_OR_NUMBER_GAP")
    require(any(x["entry_status"] == "STARTED" for x in entries), "NO_ACTIVE_STARTERS")
    # Reuse the original BACKFILL historical obstacle/dual-surface normalization.
    # The 149-field live page audit can leave these unset even when the source
    # explicitly publishes 障2910m(芝ダート); never invent an unsupported surface.
    raw_course = str(net.get("raw_course") or "")
    raw_name = str(net.get("race_name") or "")
    discipline = val("discipline")
    surface = val("surface")
    if discipline is None and ("障害" in raw_name or
                               (raw_course.count("障") and "m" in raw_course)):
        discipline = "OBSTACLE"
        if surface is None:
            if "芝" in raw_course and "ダート" in raw_course:
                surface = "MIXED"
            elif "芝" in raw_course:
                surface = "TURF"
            elif "ダ" in raw_course:
                surface = "DIRT"
    race = {
        "race_id": rid, "actual_date": None, "scheduled_date": DAY,
        "venue_code": rid[4:6],
        "meeting_no": int(rid[6:8]), "meeting_day": int(rid[8:10]),
        "race_no": int(rid[10:12]), "race_name": net.get("race_name"),
        "race_status": "SCHEDULED", "discipline": discipline,
        "surface": surface, "distance_m": val("distance_m"),
        "direction": val("direction"),
        "weather": val("weather"), "track_condition": val("track_condition"),
        "actual_start_time": None,
        "course_layout": val("course_layout"), "course_laps": val("course_laps"),
        "race_class_raw": val("race_class_raw"),
        "race_class_normalized": val("race_class_normalized"),
        "grade": val("grade"), "age_condition_raw": val("age_condition_raw"),
        "age_min": val("age_min"), "age_max": val("age_max"),
        "sex_condition": val("sex_condition"), "weight_rule": val("weight_rule"),
        "mixed": val("mixed"), "international": val("international"),
        "special_designated": val("special_designated"), "designated": val("designated"),
        "course_meta_raw": val("course_meta_raw"),
        "race_condition_raw": val("race_condition_raw"),
        "field_size": len(entries),
        "source_url": net.get("source_url"),
        "race_meta_source_url": net.get("source_url")
    }
    require(race["surface"] in ("TURF", "DIRT", "MIXED") and
            type(race["distance_m"]) is int and race["distance_m"] > 0,
            "RACE_SURFACE_OR_DISTANCE_UNKNOWN")
    return {
        "schema_version": 1,
        "race": race, "entries": entries,
        # These source slots must remain empty for --allow-unresulted-targets.
        "results": [], "payouts": [], "odds": [], "laps": [], "corners": [],
        "live_source_status": "PRE_RACE_OBSERVED_ASOF_UNVERIFIED",
        "live_source_observed_at": doc["captured_at_utc"],
        "live_jra_source_hashes": {bet: o.get("sha256") for bet, o in
                                  (odds.get("page_observations") or {}).items()},
        "live_market_data_stored_separately": True,
    }


def convert_directory(source, output):
    source = Path(source)
    manifest = json.loads((source / "manifest.json").read_text("utf-8"))
    global EXPECTED_IDS
    entries = manifest.get("races") or []
    EXPECTED_IDS = {str(rec.get("race_id")) for rec in entries}
    counts = Counter(rid[4:6] for rid in EXPECTED_IDS)
    require(len(EXPECTED_IDS)==len(entries) and
            1<=len(counts)<=3 and all(n==12 for n in counts.values()) and
            all(len(rid)==12 and rid.isdigit() and rid.startswith(DAY[:4]) for rid in EXPECTED_IDS) and
            manifest.get("day") == DAY and
            manifest.get("race_count_expected") == len(EXPECTED_IDS) and
            manifest.get("actual_races_processed") == len(EXPECTED_IDS) and
            manifest.get("full_source_and_odds_verified") == len(EXPECTED_IDS) and
            manifest.get("blocked") == 0,
            "LIVE_MANIFEST_NOT_FULL_VERIFIED")
    records = manifest.get("races") or []
    require(len(records) == len(EXPECTED_IDS) and {r.get("race_id") for r in records} == EXPECTED_IDS,
            "MANIFEST_RACE_SET_MISMATCH")
    converted = []
    for rid in sorted(EXPECTED_IDS):
        doc = json.loads((source / (rid + ".json")).read_text("utf-8"))
        converted.append(convert(doc))
    require({r["race"]["race_id"] for r in converted} == EXPECTED_IDS,
            "DAILY_PACK_RACE_SET_MISMATCH")
    dest = Path(output)
    dest.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(dest, "wt", encoding="utf-8") as out:
        for row in converted:
            out.write(json.dumps(row, ensure_ascii=False, allow_nan=False) + "\n")
    result = {
        "contract": "KEIBA_BACKFILL_LIVE_TO_DAYPACK_DYNAMIC_AUDIT_V1",
        "day": DAY, "races": len(converted),
        "listed_horses": sum(len(r["entries"]) for r in converted),
        "active_horses": sum(sum(e["entry_status"] == "STARTED"
                                for e in r["entries"]) for r in converted),
        "withdrawn_horses": sum(sum(e["entry_status"] != "STARTED"
                                   for e in r["entries"]) for r in converted),
        "contains_results_or_payouts_or_final_odds": False,
        "pre_race_source_timestamp_observed": True,
        "readiness": "ASOF_UNVERIFIED_DO_NOT_BET",
        "output": str(dest)
    }
    print("LIVE_DAY_PACK_ADAPTER " + json.dumps(result, ensure_ascii=False), flush=True)
    return result


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--live-dir", required=True)
    p.add_argument("--output", required=True)
    a = p.parse_args()
    convert_directory(a.live_dir, a.output)
