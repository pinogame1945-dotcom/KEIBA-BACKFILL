import {readFile} from "node:fs/promises";
import {
  SCHEDULE_CONTRACT_VERSION,scheduleIntegrityEnabled,
} from "./schedule-integrity.mjs";

const DEFAULT_MIN_DATE="2007-07-28";
const DEFAULT_BATCH=10;
const scheduleIntegrity=scheduleIntegrityEnabled();

async function load(path,fallback){
  try{return JSON.parse(await readFile(path,"utf8"));}
  catch(error){
    if(error?.code==="ENOENT")return fallback;
    throw error;
  }
}

const command=process.argv[2]??"plan";
const maxDays=Math.max(1,Math.min(30,Number(process.argv[3]??DEFAULT_BATCH)));
const minDate=String(process.argv[4]??DEFAULT_MIN_DATE);

if(!/^\d{4}-\d{2}-\d{2}$/.test(minDate)){
  throw new Error("invalid min_date: "+minDate);
}

const raceManifest=await load("data/manifest.json",{days:{}});
const oddsManifest=await load("data/odds/manifest.json",{days:{}});

const raceDays=Object.entries(raceManifest.days??{})
  .filter(([date,entry])=>
    date>=minDate&&
    entry?.status==="SUCCESS"&&
    Number(entry?.races_parsed??0)>0&&
    typeof entry?.file==="string"&&entry.file.length>0
  )
  .map(([date])=>date)
  .sort((a,b)=>b.localeCompare(a));

const completed=new Set(
  Object.entries(oddsManifest.days??{})
    .filter(([date,entry])=>{
      if(
        entry?.status!=="SUCCESS"||
        Number(entry?.odds_pack_version??0)<1||
        Number(entry?.decoder_contract_version??0)<1
      )return false;
      const raceEntry=raceManifest.days?.[date];
      if(
        scheduleIntegrity&&
        Number(raceEntry?.schedule_contract_version??0)>=SCHEDULE_CONTRACT_VERSION
      ){
        return Number(entry?.schedule_contract_version??0)>=SCHEDULE_CONTRACT_VERSION;
      }
      return true;
    })
    .map(([date])=>date)
);

const pending=raceDays.filter(date=>!completed.has(date));
const selected=pending.slice(0,maxDays);
const result={
  action:selected.length?"collect":"stop",
  min_date:minDate,
  max_days:maxDays,
  race_days:raceDays.length,
  completed_days:raceDays.filter(date=>completed.has(date)).length,
  pending_days:pending.length,
  newest_pending:pending[0]??null,
  oldest_pending:pending[pending.length-1]??null,
  selected,
};

if(command==="plan"||command==="summary"){
  console.log(JSON.stringify(result));
}else{
  throw new Error("unknown command: "+command);
}
