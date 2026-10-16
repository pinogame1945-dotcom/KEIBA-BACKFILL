"""JRA published navigation / odds POST transport, isolated from ML."""
import re,hashlib
from urllib.request import Request,urlopen
from urllib.parse import urlparse,urlencode
from bs4 import BeautifulSoup
CARD="https://www.jra.go.jp/JRADB/accessD.html?CNAME=pw01dde0105202604061120261017%2F22"
ODDS="https://www.jra.go.jp/JRADB/accessO.html"
def fetch(url,cname=None):
 kwargs={}
 if cname is not None:
  kwargs={"data":urlencode({"cname":cname}).encode("ascii"),"method":"POST"}
 headers={"User-Agent":"Mozilla/5.0","Accept-Language":"ja","Referer":CARD}
 if cname:
  headers.update({"Content-Type":"application/x-www-form-urlencoded","Origin":"https://www.jra.go.jp"})
 with urlopen(Request(url,headers=headers,**kwargs),timeout=22) as r:
  assert urlparse(r.geturl()).hostname=="www.jra.go.jp"
  d=r.read(5000000)
  assert len(d)<5000000
  h=r.headers
  last=r.geturl()
 enc=(re.search(r"charset=([\w-]+)",h.get("Content-Type",""),re.I) or [])
 codes=([enc.group(1)] if enc else [])+["utf-8","cp932","euc_jp"]
 content=None
 for cd in dict.fromkeys(codes):
  try:
   v=d.decode(cd)
   if "オッズ" in v:content=v;break
  except (UnicodeError,LookupError):continue
 if not content:raise ValueError("UNREADABLE_JRA_HTML")
 return content,{"url":last,"sha256":hashlib.sha256(d).hexdigest(),"bytes":len(d),"http_date":h.get("Date")}
