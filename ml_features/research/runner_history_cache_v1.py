#!/usr/bin/env python3
"""Re-use strictly checked frozen-history intermediates ONLY within a free runner.

No Git writes, no Actions cache/artifacts, no external storage. Cache is invalid
when source Git objects, feature generator, date, horse cohort or file SHA differ.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

def require(ok,reason):
    if not ok:
        raise ValueError(reason)

def sha(path):
    h=hashlib.sha256()
    with open(path,"rb") as source:
        for block in iter(lambda: source.read(1048576),b""):
            h.update(block)
    return h.hexdigest()

def digest(item):
    return hashlib.sha256(json.dumps(item,sort_keys=True,
        ensure_ascii=False,separators=(",",":")).encode()).hexdigest()

def tracked_tree(root,path):
    return subprocess.check_output(["git","rev-parse","HEAD:"+path],
                                   cwd=root,text=True).strip()

class RunnerHistoryCache:
    """Scoped ephemeral files. Main build() uses this only when explicitly opted in."""
    def __init__(self,root,date,folder):
        temp=os.environ.get("RUNNER_TEMP")
        require(bool(temp),"RUNNER_TEMP_REQUIRED_FOR_HISTORY_CACHE")
        allowed=Path(temp).resolve()
        folder=Path(folder).resolve()
        require(folder!=allowed and folder.is_relative_to(allowed),
                "HISTORY_CACHE_MUST_REMAIN_WITHIN_FREE_RUNNER_TEMP")
        require(date.startswith("2026-") and len(date)==10,
                "HISTORY_CACHE_APPROVED_2026_SCOPE")
        source={
            "date":date,
            "daily_git_tree":tracked_tree(root,"data/daily"),
            "horses_git_tree":tracked_tree(root,"data/horses"),
            "ml_git_tree":tracked_tree(root,"ml_features"),
            "contracts_git_tree":tracked_tree(root,"contracts"),
        }
        self.fingerprint=digest(source)
        self.folder=folder/self.fingerprint
        self.folder.mkdir(parents=True,exist_ok=True)

    def path(self,kind,cohort=None):
        require(kind in ("prior","compact"),"UNKNOWN_HISTORY_CACHE_KIND")
        if kind=="compact":
            require(isinstance(cohort,str) and len(cohort)==64 and
                    all(c in "0123456789abcdef" for c in cohort),
                    "CACHE_COHORT_HASH_INVALID")
        return self.folder/(kind+("-"+cohort if cohort else ""))

    def valid(self,path):
        path=Path(path)
        marker=path/"_runner_cache_complete.json"
        if not marker.is_file():
            return False
        try:
            info=json.loads(marker.read_text("utf8"))
            require(info["fingerprint"]==self.fingerprint,
                    "CACHE_SOURCE_GENERATION_DRIFT")
            files=info["files"]
            require(isinstance(files,dict) and bool(files),"CACHE_FILE_LIST_INVALID")
            for rel,expected in files.items():
                item=path/rel
                require(item.is_file() and item.resolve().is_relative_to(path.resolve()) and
                        sha(item)==expected,"CACHE_FILE_MISSING_OR_TAMPERED")
            return True
        except (OSError,ValueError,KeyError,TypeError):
            return False

    def discard(self,path):
        path=Path(path)
        require(path.parent==self.folder,"CACHE_DELETE_OUTSIDE_EPHEMERAL_SCOPE")
        if path.exists():
            shutil.rmtree(path)
        path.mkdir(parents=True)

    def seal(self,path,files):
        path=Path(path)
        require(path.parent==self.folder,"CACHE_SEAL_OUTSIDE_EPHEMERAL_SCOPE")
        mapped={}
        for f in files:
            f=Path(f)
            require(f.is_file() and f.resolve().is_relative_to(path.resolve()),
                    "CACHE_FILE_OUTSIDE_SCOPE")
            mapped[str(f.relative_to(path))]=sha(f)
        require(mapped,"EMPTY_HISTORY_CACHE_CANNOT_BE_REUSED")
        temp=path/"_runner_cache_complete.tmp"
        temp.write_text(json.dumps({"fingerprint":self.fingerprint,
                        "files":mapped},sort_keys=True)+"\n",encoding="utf8")
        temp.replace(path/"_runner_cache_complete.json")
        require(self.valid(path),"CACHE_ROUNDTRIP_FAILED")
