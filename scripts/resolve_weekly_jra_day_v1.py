#!/usr/bin/env python3
"""Resolve each actual JRA racing date; never assume weekends or fabricate races.

A daytime tick refreshes today's card. Evening tick prepares tomorrow's
published JRA card, covering Saturday/Sunday and holiday/Monday meetings.
No URL is guessed: only an observed official CNAME can activate the pipeline.
"""
import argparse
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from discover_jra_official_seed_v1 import discover

JST = ZoneInfo("Asia/Tokyo")


def candidate_day(now):
    if now.tzinfo is None:
        raise ValueError("SCHEDULER_REQUIRES_TIMEZONE")
    local = now.astimezone(JST)
    return local.date() + timedelta(days=1 if local.hour >= 18 else 0)


def resolve(now, search=discover):
    day = candidate_day(now).isoformat()
    if not day.startswith("2026-"):
        # The frozen 2026 schema and source history are not automatically
        # redefined for a new research/evaluation year.
        raise ValueError("NEXT_YEAR_SCHEMA_NOT_APPROVED:" + day)
    try:
        url = search(day)
    except ValueError as error:
        if str(error) == "NO_PUBLISHED_JRA_CARD_FOR_DATE":
            return {"status": "NO_PUBLISHED_MEETING", "date": day}
        raise
    if not url.startswith("https://www.jra.go.jp/JRADB/accessD.html?CNAME=pw01dde01"):
        raise ValueError("JRA_CARD_SOURCE_NOT_OFFICIAL")
    return {"status": "OFFICIAL_RACE_DAY", "date": day, "official_seed_url": url}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--github-env", help="Append verified day and official seed to GITHUB_ENV")
    parser.add_argument("--date", help="Optional explicit date from manual workflow input")
    parser.add_argument("--seed", help="Optional official card URL from manual workflow input")
    args = parser.parse_args()
    from discover_jra_official_seed_v1 import extract
    if args.date:
        datetime.strptime(args.date, "%Y-%m-%d")
        if not args.date.startswith("2026-"):
            raise ValueError("NEXT_YEAR_SCHEMA_NOT_APPROVED:" + args.date)
        if args.seed:
            if args.seed not in extract(args.seed, args.date):
                raise ValueError("JRA_MANUAL_SEED_INVALID")
            result = {"status": "OFFICIAL_RACE_DAY", "date": args.date,
                      "official_seed_url": args.seed}
        else:
            try:
                result = {"status": "OFFICIAL_RACE_DAY", "date": args.date,
                          "official_seed_url": discover(args.date)}
            except ValueError as exc:
                if str(exc) != "NO_PUBLISHED_JRA_CARD_FOR_DATE":
                    raise
                result = {"status": "NO_PUBLISHED_MEETING", "date": args.date}
    else:
        result = resolve(datetime.now(JST))
    print("JRA_WEEKLY_DATE_RESOLVER " + str(result), flush=True)
    if args.github_env:
        with open(args.github_env, "a", encoding="utf-8") as stream:
            stream.write("JRA_RACE_DAY_ACTIVE=" +
                         ("true" if result["status"] == "OFFICIAL_RACE_DAY" else "false") + "\n")
            if result["status"] == "OFFICIAL_RACE_DAY":
                stream.write("TARGET_DATE=" + result["date"] + "\n")
                stream.write("KEIBA_LIVE_DATE=" + result["date"] + "\n")
                stream.write("KEIBA_JRA_CARD_URL=" + result["official_seed_url"] + "\n")
    return result


if __name__ == "__main__":
    main()
