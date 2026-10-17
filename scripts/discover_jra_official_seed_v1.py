#!/usr/bin/env python3
"""Discover a published JRA racecard CNAME for a requested day.

Never invent an opaque JRA URL suffix or infer meeting numbers. Search only
observed JRA official links (current menus and previously captured official
cards). If no published card is linked, fail closed and retry another day.
"""
from __future__ import annotations
import argparse
import json
import re
from datetime import date
from pathlib import Path
from urllib.parse import unquote,urlparse
from urllib.request import Request,urlopen
from bs4 import BeautifulSoup

PATTERN=re.compile(r"pw01dde01\d{2}20\d{2}\d{2}\d{2}\d{2}(20\d{6})/([0-9A-Fa-f]{2})")
OFFICIAL="https://www.jra.go.jp/JRADB/accessD.html?CNAME="

def require(ok,reason):
    if not ok:raise ValueError(reason)

def extract(text,day):
    token=day.replace("-","")
    candidates=set()
    for name in PATTERN.finditer(unquote(text)):
        if name.group(1)!=token:continue
        code=name.group(0)
        candidates.add(OFFICIAL+code.replace("/","%2F"))
    return sorted(candidates)

def observed_links(source):
    roots=["https://www.jra.go.jp/JRADB/accessD.html",
           "https://www.jra.go.jp/keiba/",
           "https://www.jra.go.jp/"]
    root=Path(source)/"data/live"
    if root.exists():
        dates=sorted((d for d in root.iterdir() if d.is_dir()),reverse=True)
        for d in dates[:5]:
            for file in list(sorted(d.glob("20*.json")))[:4]:
                try:
                    item=json.loads(file.read_text("utf8"))
                    url=(item.get("source_discovery") or {}).get("jra_card_url")
                    if url and urlparse(url).hostname=="www.jra.go.jp" and url not in roots:
                        roots.append(url)
                except (ValueError,UnicodeError,OSError):
                    continue
    return roots[:20]

def discover(day,source="."):
    require(date.fromisoformat(day).isoformat()==day,"INVALID_DATE")
    found=[]
    for url in observed_links(source):
        try:
            with urlopen(Request(url,headers={"User-Agent":"Mozilla/5.0",
                                             "Accept-Language":"ja"}),timeout=18) as response:
                require(urlparse(response.geturl()).hostname=="www.jra.go.jp",
                        "UNTRUSTED_OFFICIAL_REDIRECT")
                html=response.read(4_000_001)
                require(len(html)<=4_000_000,"OVERSIZED_OFFICIAL_PAGE")
                text=html.decode("cp932",errors="replace")
                found+=extract(text,day)
                found+=extract(html.decode("utf8",errors="replace"),day)
        except (OSError,TimeoutError):
            continue
        if found:break
    require(found,"NO_PUBLISHED_JRA_CARD_FOR_DATE")
    return sorted(set(found))[0]

if __name__=="__main__":
    p=argparse.ArgumentParser()
    p.add_argument("--date",required=True)
    p.add_argument("--source-root",default=".")
    p.add_argument("--seed")
    a=p.parse_args()
    if a.seed:
        require(a.seed in extract(a.seed,a.date),"JRA_SEED_NOT_FROM_OFFICIAL_CARD_FORMAT")
        print(a.seed)
    else:
        print(discover(a.date,a.source_root))
