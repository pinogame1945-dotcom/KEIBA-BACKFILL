import {readFile} from "node:fs/promises";
import {RESULT_PARSER_VERSION} from "./result-columns.mjs";
import {LAP_PARSER_VERSION} from "./lap-parser.mjs";
import {SCHEDULE_CONTRACT_VERSION,SCHEDULE_SAFE_RACE_PACK_VERSION} from "./schedule-integrity.mjs";

const [newest="9999-12-31",oldest="0000-01-01",limitRaw="10"]=process.argv.slice(2);
const dateRe=/^\d{4}-\d{2}-\d{2}$/;
if(!dateRe.test(newest)||!dateRe.test(oldest))throw new Error("dates must be YYYY-MM-DD");
if(newest<oldest)throw new Error("newest_date must be >= oldest_date");
const limit=Number(limitRaw);
if(!Number.isInteger(limit)||limit<1||limit>20)throw new Error("max_repairs must be 1..20");

const manifest=JSON.parse(await readFile("data/manifest.json","utf8"));
const stale=[];
for(const [date,entry] of Object.entries(manifest.days??{})){
  if(date>newest||date<oldest)continue;
  if(entry?.status!=="SUCCESS")continue;
  const reasons=[];
  if(Number(entry.race_pack_version??1)<SCHEDULE_SAFE_RACE_PACK_VERSION)reasons.push("race_pack");
  if(Number(entry.result_parser_version??1)<RESULT_PARSER_VERSION)reasons.push("result_parser");
  if(Number(entry.lap_parser_version??1)<LAP_PARSER_VERSION)reasons.push("lap_parser");
  if(Number(entry.schedule_contract_version??0)<SCHEDULE_CONTRACT_VERSION)reasons.push("schedule_contract");
  if(reasons.length)stale.push({date,reasons,races:Number(entry.races_parsed??0)});
}
stale.sort((a,b)=>b.date.localeCompare(a.date));
const selected=stale.slice(0,limit);
console.log(JSON.stringify({
  ok:true,
  newest,
  oldest,
  current_contract:{
    race_pack_version:SCHEDULE_SAFE_RACE_PACK_VERSION,
    result_parser_version:RESULT_PARSER_VERSION,
    lap_parser_version:LAP_PARSER_VERSION,
    schedule_contract_version:SCHEDULE_CONTRACT_VERSION,
  },
  stale_days:stale.length,
  selected_days:selected.length,
  remaining_after_selected:Math.max(0,stale.length-selected.length),
  dates:selected,
},null,2));
