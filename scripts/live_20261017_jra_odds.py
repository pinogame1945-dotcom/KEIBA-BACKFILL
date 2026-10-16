"""Port of the validated Fuji JRA numeric odds and win/place parsers; no ML imports."""
import re,unicodedata
TYPES={"単勝・複勝":"WIN_PLACE","枠連":"BRACKET_QUINELLA","馬連":"QUINELLA",
       "ワイド":"WIDE","馬単":"EXACTA","3連複":"TRIO","3連単":"TRIFECTA"}
N=0
RUNNERS={}
POSITIVE=re.compile(r"(?:\\d+)(?:\\.\\d+)?")
RANGE=re.compile(r"(\\d+(?:\\.\\d+)?)\\s*[-－ー〜~]\\s*(\\d+(?:\\.\\d+)?)")
def clean(t):return re.sub(r"\\s+"," ",unicodedata.normalize("NFKC",t or "")).strip()
def parse_one_odd(value,ranged=False):
 text=clean(value)
 if "票数なし" in text or text in ("－","-","発売なし","発売前"):
  return {"status":"NO_VOTES","odds":None} if not ranged else {"status":"NO_VOTES","odds_min":None,"odds_max":None}
 if ranged:
  m=RANGE.fullmatch(text)
  if not m:raise ValueError("NOT_NUMERIC_JRA_ODDS_RANGE:"+text[:80])
  low,high=map(float,m.groups())
  if not (0<low<=high):raise ValueError("INVALID_RANGE")
  return {"status":"QUOTED","odds_min":low,"odds_max":high}
 if not POSITIVE.fullmatch(text):raise ValueError("NOT_NUMERIC_JRA_ODDS:"+text[:80])
 value=float(text)
 if value<=0:raise ValueError("INVALID_ODDS")
 return {"status":"QUOTED","odds":value}
def parse_winplace(soup):
 tab=soup.select("table.tanpuku")
 if len(tab)!=1:raise ValueError("WIN_PLACE_TABLE_MISSING")
 seen=[]
 for tr in tab[0].select("tr"):
  no=tr.select_one("td.num");name=tr.select_one("td.horse")
  if not no:continue
  i=int(clean(no.get_text(" ",strip=True)))
  if i not in RUNNERS:raise ValueError("UNKNOWN_HORSE")
  nm=clean(name.get_text(" ",strip=True)) if name else ""
  if nm!=clean(RUNNERS[i]["horse_name"]):raise ValueError("HORSE_NAME_MISMATCH:"+str(i)+":"+nm)
  w=tr.select_one("td.odds_tan")
  p=tr.select_one("td.odds_fuku")
  if w is None or p is None:raise ValueError("WIN_PLACE_QUOTE_CELL_ABSENT")
  seen.append((i,clean(w.get_text(" ",strip=True)),clean(p.get_text(" ",strip=True))))
 if len(seen)!=N or {x[0] for x in seen}!=set(range(1,N+1)):raise ValueError("INVALID_WIN_PLACE_RUNNER_SET")
 return {"WIN":[((i,),w) for i,w,_ in seen],"PLACE":[((i,),p) for i,_,p in seen]}
