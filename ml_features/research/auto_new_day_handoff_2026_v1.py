#!/usr/bin/env python3
"""One pre-race 2026 meeting day: untouched original 690 math + eight JRA odds.

All heavy state history stays inside free runner temp. Publish into existing
Git handoff branch in a SINGLE commit only if all source/690/odds checks pass.
No model training, betting, L1.75/L2.1/L3 edits, or paid artifacts.
"""
from __future__ import annotations
import argparse
from collections import Counter
from datetime import date,timedelta
import gzip
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT=Path.cwd()
ML=ROOT/"ml_features"/"research"
sys.path.insert(0,str(ML))
from export_690_delivery_dynamic_v1 import load_core4
from verify_2026_original_690_extra_values_v1 import compact_one_year,source_rows


def require(ok,reason):
    if not ok:raise ValueError(reason)


def command(*args, cwd=ROOT, env=None):
    display=" ".join(map(str,args))
    print("AUTO_DAY_COMMAND",display[:400],flush=True)
    subprocess.run([str(x) for x in args],cwd=cwd,env=env,check=True)


def find_one(directory):
    paths=list(Path(directory).rglob("snapshot-2026.jsonl.gz"))
    require(len(paths)==1,"2026_SNAPSHOT_UNIQUE_FILE_REQUIRED")
    return paths[0]


def build(date_text, output):
    d=date.fromisoformat(date_text)
    require(d.year==2026,"OUTSIDE_FROZEN_2026_FEATURE_HISTORY")
    parent=Path(output)
    parent.mkdir(parents=True,exist_ok=True)
    overlay=parent/"overlay"/"data"/"daily"
    overlay.mkdir(parents=True,exist_ok=True)
    horses=parent/"overlay"/"data"/"horses"
    horses.symlink_to(ROOT/"data"/"horses",target_is_directory=True)

    command(sys.executable,ML/"live_json_to_daily_pack_dynamic_v1.py",
            "--live-dir",ROOT/"data"/"live"/date_text,
            "--output",overlay/(date_text+".jsonl.gz"))
    for old in (ROOT/"data"/"daily").glob("*.jsonl.gz"):
        dt=old.name[:10]
        if "2022-01-01"<=dt<date_text:
            (overlay/old.name).symlink_to(old)
    prior_day=(d-timedelta(days=1)).isoformat()
    fixed=["--source-start","2022-01-01",
           "--first-model-ready-year","2023","--prediction-phase","FINAL",
           "--feature-sets","BASE,OPPONENT,NETWORK,LAP,STYLE,DISTANCE,BACKFILL,AUTO,ACTOR,TIME_PACE",
           "--source-sha","03950cfe132abeca15ef17dbc7c6885ceb1591b7",
           "--ml-source-sha","c782a7e0c6e2f09b2d0603b23336eab31ad5bc77"]
    builder=ML/"build-yearly-superset-snapshots.mjs"
    command("node",builder,"--source-root",ROOT,"--out-dir",parent/"prior",
            "--source-end",prior_day,"--emit-start","2026-01-01",
            "--emit-end",prior_day,*fixed)
    command("node",builder,"--source-root",parent/"overlay",
            "--out-dir",parent/"live","--source-end",date_text,
            "--emit-start",date_text,"--emit-end",date_text,
            "--allow-unresulted-targets",*fixed)
    old,new=find_one(parent/"prior"),find_one(parent/"live")
    combined=parent/"combined-2026.jsonl.gz"
    numbers=Counter()
    with gzip.open(combined,"wt",encoding="utf-8") as dest:
        for is_live,path in ((False,old),(True,new)):
            with gzip.open(path,"rt",encoding="utf-8") as source:
                for line in source:
                    if not line.strip():continue
                    item=json.loads(line)
                    day=(item.get("features") or {}).get("race_date")
                    require(day and (day==date_text if is_live else day<date_text),
                            "STRICT_PRIOR_HISTORY_BOUNDARY")
                    if is_live:
                        require(item.get("target") is None and
                                item.get("market_outcome") is None,
                                "LIVE_TARGET_RESULTS_OR_FINAL_MARKET_FOUND")
                    numbers["live" if is_live else "prior"]+=1
                    dest.write(line)
    require(numbers["live"]>0 and numbers["prior"]>0,"LIVE_OR_PRIOR_MISSING")
    print("AUTO_DAY_CORE4_HISTORY_READY",dict(numbers),flush=True)

    ids=sorted({str(it["race_id"]) for it in source_rows(combined)
                if (it.get("features") or {}).get("race_date")==date_text})
    per_venue=Counter(x[4:6] for x in ids)
    require(len(ids) in (12,24,36) and
            all(count==12 for count in per_venue.values()),
            "NEW_DAY_RACE_SET_INCOMPLETE")
    rows=[r for race in ids for r in load_core4(combined,race)["rows"]]
    require(3*len(ids)<=len(rows)<=18*len(ids),"NEW_DAY_STARTERS_OUTSIDE_RANGE")
    doc={"race_id":"day-cohort","race_date":date_text,"rows":rows}
    compact=parent/"compact"
    compact.mkdir(exist_ok=True)
    compact_one_year(combined,2026,doc,
                     compact/"prior-full-race-context-2026.pkl")
    (parent/"cohort.json").write_text(json.dumps(doc),encoding="utf-8")
    print("AUTO_DAY_LIVE_COHORT",len(ids),len(rows),flush=True)

    remote=parent/"pinned-original"
    remote.mkdir(exist_ok=True)
    for year in range(2019,2026):
        cmd=subprocess.run(
            ["bash","scripts/fetch_original_state_history_snapshot.sh",
             str(year),str(remote)],cwd=ROOT/"ml_features",check=True,
            stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
        print("ORIGINAL_YEAR_FETCH_COMPLETED",year,flush=True)
        lines=[line.strip() for line in cmd.stdout.splitlines() if line.strip()]
        require(lines,"ORIGINAL_YEAR_NO_OUTPUT")
        raw=Path(lines[-1])
        require(raw.is_file() and raw.stat().st_size>0,
                "ORIGINAL_YEAR_SOURCE_NOT_DOWNLOADED")
        compact_one_year(raw,year,doc,
                         compact/f"prior-full-race-context-{year}.pkl")
        raw.unlink()
    print("AUTO_DAY_ALL_ORIGINAL_2019_2025_STATE_READY",flush=True)
    return combined,compact


def publish(day,source,compact,root):
    dest=Path(root)/"publication"
    command("git","fetch","--no-tags","origin","handoff/690-feature-data-v1")
    command("git","worktree","add","--detach",dest,"FETCH_HEAD")
    command(sys.executable,ML/"export_690_delivery_dynamic_v1.py",
            "--date",day,"--snapshot",source,"--compact-dir",compact,
            "--out-root",dest)
    command(sys.executable,ML/"export_odds_delivery_v1.py",
            "--date",day,"--source-root",ROOT,"--out-root",dest)
    shutil.copyfile(ML/"fetch_features_and_odds_for_ml_v1.py",
                    dest/"ml_features"/"fetch_features_and_odds_for_ml_v1.py")
    f=json.loads((dest/"ml_features/delivery/690/index.json").read_text())
    o=json.loads((dest/"ml_features/delivery/odds/index.json").read_text())
    ids=sorted(rid for rid,rec in f["races"].items() if rec["date"]==day)
    require(len(ids) in (12,24,36) and all(rid in o["races"] for rid in ids),
            "NEW_DAY_FEATURE_ODDS_ID_DISAGREEMENT")
    command(sys.executable,ML/"fetch_features_and_odds_for_ml_v1.py",
            "--race-id",ids[0],"--base-url",dest.as_uri()+"/",
            "--output",Path(root)/"full-example.json")
    require(sum(p.stat().st_size for p in
            (dest/"ml_features"/"delivery").rglob("*.json"))<250*1024*1024,
            "GIT_HANDOFF_STORAGE_GUARD_250M")
    command("git","add","ml_features/delivery",
            "ml_features/fetch_features_and_odds_for_ml_v1.py",cwd=dest)
    command("git","-c","user.name=github-actions-bot",
            "-c","user.email=41898282+github-actions[bot]@users.noreply.github.com",
            "commit","-m","data: pre-race 690 and eight ticket odds published together",cwd=dest)
    command("git","push","origin",
            "HEAD:refs/heads/handoff/690-feature-data-v1",cwd=dest)
    print("AUTO_NEW_RACE_DAY_COMPLETE",json.dumps({
        "date":day,"races":len(ids),"source":"JRA_OFFICIAL_POST",
        "readiness":"ASOF_UNVERIFIED_DO_NOT_BET",
        "feature_count":690,"eight_odds":True},sort_keys=True),flush=True)


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--date",required=True)
    parser.add_argument("--runner-temp",required=True)
    a=parser.parse_args()
    directory=Path(a.runner_temp)/"auto-day"
    with tempfile.TemporaryDirectory(dir=a.runner_temp,prefix="auto-day-") as temp:
        first,prior=build(a.date,directory)
        publish(a.date,first,prior,directory)
