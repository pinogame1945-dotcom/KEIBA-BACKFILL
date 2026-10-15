import {readFile} from "node:fs/promises";
import {gunzipSync} from "node:zlib";
import {validDate} from "../src/forward-backfill-plan.mjs";

const date=process.argv[2];
if(!validDate(date))throw new Error("Usage: node scripts/forward-horse-pending.mjs YYYY-MM-DD");
const manifest=JSON.parse(await readFile("data/manifest.json","utf8"));
const day=manifest.days?.[date];
if(!day){
  if(manifest.non_meeting_days?.[date]?.status==="CONFIRMED_NO_JRA"||
     manifest.schedule_exception_days?.[date]?.status==="NO_RACES_HELD"){
    console.log(0);
    process.exit(0);
  }
  throw new Error("day missing from manifest: "+date);
}
if(day.status!=="SUCCESS")throw new Error("invalid day status "+date);
const text=gunzipSync(await readFile(day.file)).toString("utf8").trim();
const required=new Set();
for(const line of text.split("\n").filter(Boolean)){
  const row=JSON.parse(line);
  for(const entry of row.entries??[])if(entry.horse_id)required.add(String(entry.horse_id));
}
const completed=new Set();
for(const pack of Object.values(manifest.horse_packs??{})){
  if(pack.status!=="SUCCESS")continue;
  if(Number(pack.horse_pack_version??0)<2||Number(pack.pedigree_parser_version??0)<2)continue;
  for(const id of pack.source_horse_ids??[])completed.add(String(id));
}
console.log([...required].filter(id=>!completed.has(id)).length);
