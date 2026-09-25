import {readFile} from "node:fs/promises";
import {
  RACE_META_CONTRACT_VERSION,RACE_META_SAFE_RACE_PACK_VERSION,
} from "./race-meta.mjs";

const [newest="9999-12-31",oldest="0000-01-01",limitRaw="10"]=process.argv.slice(2);
const dateRe=/^\d{4}-\d{2}-\d{2}$/;
if(!dateRe.test(newest)||!dateRe.test(oldest)){
  throw new Error("dates must be YYYY-MM-DD");
}
if(newest<oldest)throw new Error("newest_date must be >= oldest_date");
const limit=Number(limitRaw);
if(!Number.isInteger(limit)||limit<1||limit>20){
  throw new Error("max_repairs must be 1..20");
}

const manifest=JSON.parse(await readFile("data/manifest.json","utf8"));
const stale=[];
for(const [date,entry] of Object.entries(manifest.days??{})){
  if(date>newest||date<oldest)continue;
  if(entry?.status!=="SUCCESS")continue;
  const missingContract=
    Number(entry.race_meta_contract_version??0)<RACE_META_CONTRACT_VERSION;
  const oldPack=
    Number(entry.race_pack_version??0)<RACE_META_SAFE_RACE_PACK_VERSION;
  if(!missingContract&&!oldPack)continue;
  stale.push({
    date,
    races:Number(entry.races_parsed??0),
    race_pack_version:Number(entry.race_pack_version??0),
    race_meta_contract_version:Number(entry.race_meta_contract_version??0),
  });
}
stale.sort((a,b)=>b.date.localeCompare(a.date));
const selected=stale.slice(0,limit);
console.log(JSON.stringify({
  ok:true,
  mode:"MANUAL_RACE_META_REPAIR",
  auto_continue:false,
  newest,
  oldest,
  required:{
    race_pack_version:RACE_META_SAFE_RACE_PACK_VERSION,
    race_meta_contract_version:RACE_META_CONTRACT_VERSION,
  },
  stale_days:stale.length,
  selected_days:selected.length,
  remaining_after_selected:Math.max(0,stale.length-selected.length),
  dates:selected,
},null,2));
