import {readFile} from "node:fs/promises";
import {RACE_META_PARSER_VERSION} from "./race-meta.mjs";

const [command="plan",maxDaysRaw="6",minDate="2006-09-01"]=process.argv.slice(2);
if(command!=="plan")throw new Error("usage: node src/plan-race-meta-backfill.mjs plan [max_days] [min_date]");
const maxDays=Number(maxDaysRaw);
if(!Number.isInteger(maxDays)||maxDays<1||maxDays>30)throw new Error("max_days must be 1..30");
if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(minDate))throw new Error("invalid min_date");

const manifest=JSON.parse(await readFile("data/manifest.json","utf8"));
const pending=Object.entries(manifest.days??{})
  .filter(([date,day])=>
    date>=minDate&&
    day?.status==="SUCCESS"&&
    Number(day?.races_parsed??0)>0&&
    Boolean(day?.file)&&
    Number(day?.race_meta_parser_version??0)<RACE_META_PARSER_VERSION
  )
  .map(([date])=>date)
  .sort()
  .reverse();

console.log(JSON.stringify({
  ok:true,
  parser_version:RACE_META_PARSER_VERSION,
  min_date:minDate,
  pending_days:pending.length,
  selected_dates:pending.slice(0,maxDays),
  newest_pending:pending[0]??null,
  oldest_pending:pending.at(-1)??null,
},null,2));
