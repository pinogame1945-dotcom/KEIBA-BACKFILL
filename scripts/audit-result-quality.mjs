import {readFile} from "node:fs/promises";
import {gunzipSync} from "node:zlib";

const manifest=JSON.parse(await readFile("data/manifest.json","utf8"));
const dateArg=process.argv[2]??null;
const days=Object.entries(manifest.days??{})
  .filter(([date,entry])=>entry?.status==="SUCCESS"&&(!dateArg||date===dateArg))
  .sort(([a],[b])=>a.localeCompare(b));

const summaries=[];
let totalFinished=0,totalTimed=0,totalLast3f=0;
for(const [date,entry] of days){
  const text=gunzipSync(await readFile(entry.file)).toString("utf8").trim();
  const rows=text?text.split("\n").map(JSON.parse):[];
  const finished=rows.flatMap(row=>row.results??[]).filter(row=>
    row?.result_status==="FINISHED"&&row?.official_finish_position!=null
  );
  const timed=finished.filter(row=>row?.finish_time_ms!=null);
  const last3f=timed.filter(row=>row?.last_3f!=null);
  totalFinished+=finished.length;
  totalTimed+=timed.length;
  totalLast3f+=last3f.length;
  summaries.push({
    date,
    races:rows.length,
    result_parser_version:Number(entry.result_parser_version??1),
    finished:finished.length,
    finish_time_pct:finished.length?Number((timed.length/finished.length*100).toFixed(1)):0,
    last3f_pct:timed.length?Number((last3f.length/timed.length*100).toFixed(1)):0,
  });
}
console.log(JSON.stringify({
  days:summaries.length,
  finished:totalFinished,
  finish_time_pct:totalFinished?Number((totalTimed/totalFinished*100).toFixed(1)):0,
  last3f_pct:totalTimed?Number((totalLast3f/totalTimed*100).toFixed(1)):0,
  summaries,
},null,2));
