export const LAP_PARSER_VERSION=2;

function clean(value){
  return (value??"").replace(/\s+/g," ").trim();
}

export function expectedLapSegments(distance){
  const n=Number(distance);
  if(!Number.isFinite(n)||n<=0)return 0;
  return Math.ceil(n/200);
}

function directCells($,row){
  return $(row).children().filter("th,td");
}

function numericLap(value){
  const text=clean(value);
  if(!/^\d{1,2}\.\d$/.test(text))return null;
  const n=Number(text);
  return Number.isFinite(n)&&n>=5&&n<=25?n:null;
}

function modernLapValues($,distance){
  const expected=expectedLapSegments(distance);
  let best=null;
  $("table").each((_,tableNode)=>{
    const table=$(tableNode);
    const rows=table.find("tr");
    if(rows.length<2)return;

    const headerCells=directCells($,rows.first());
    if(headerCells.length<2)return;
    const headers=headerCells.toArray().map(cell=>clean($(cell).text()));
    if(!headers.every(header=>/^\d{2,4}m$/i.test(header)))return;
    if(expected>0&&headers.length!==expected)return;

    let candidate=null;
    rows.slice(1).each((__,row)=>{
      const cells=directCells($,row);
      if(cells.length!==headers.length)return;
      const values=cells.toArray().map(cell=>numericLap($(cell).text()));
      if(values.some(value=>value==null))return;
      candidate={
        values:values.map(Number),
        raw:cells.toArray().map(cell=>clean($(cell).text())).join(" | "),
      };
    });
    if(candidate)best=candidate;
  });
  return best;
}

function legacyLapValues($){
  let best=null;
  $("tr").each((_,row)=>{
    const cells=directCells($,row);
    if(cells.length<2)return;
    if(clean(cells.eq(0).text())!=="ラップ")return;
    const raw=clean(cells.eq(1).text());
    const values=[...raw.matchAll(/\d{1,2}\.\d/g)]
      .map(match=>Number(match[0]))
      .filter(value=>Number.isFinite(value)&&value>=5&&value<=25);
    if(values.length)best={values,raw};
  });
  return best;
}

export function parseRaceLaps($,raceId,distance){
  const expected=expectedLapSegments(distance);
  const modern=modernLapValues($,distance);
  const legacy=legacyLapValues($);
  const selected=
    modern&&(!expected||modern.values.length===expected)?modern:
    legacy&&(!expected||legacy.values.length===expected)?legacy:
    modern??legacy;
  if(!selected)return [];
  return selected.values.map((value,index)=>({
    race_id:raceId,
    segment_no:index+1,
    lap_seconds:value,
    raw_text:selected.raw,
  }));
}
