import {access,readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";

const DAY_MS=86_400_000;
const DATE_RE=/^\d{4}-\d{2}-\d{2}$/;

export function validDate(value){
  if(typeof value!=="string"||!DATE_RE.test(value))return false;
  const [y,m,d]=value.split("-").map(Number);
  return new Date(Date.UTC(y,m-1,d)).toISOString().slice(0,10)===value;
}

export function addUtcDays(date,days){
  if(!validDate(date)||!Number.isInteger(days))throw new Error("invalid date/day offset: "+date);
  return new Date(Date.parse(date+"T00:00:00Z")+days*DAY_MS).toISOString().slice(0,10);
}

// Japan has no daylight-saving shift. End at yesterday JST; a new result
// must not be archived as a completed race on the day it is still running.
export function lastEligibleJstDate(nowMs=Date.now()){
  if(!Number.isFinite(nowMs))throw new Error("invalid clock");
  return new Date(nowMs+9*60*60*1000-DAY_MS).toISOString().slice(0,10);
}

export function planForwardDates({
  raceManifest,oddsManifest,from,through,maxDates=60,cutoff=lastEligibleJstDate()
}){
  if(!validDate(from)||!validDate(cutoff)||!validDate(through??cutoff)){
    throw new Error("invalid from/through/cutoff date");
  }
  if(!Number.isInteger(maxDates)||maxDates<1||maxDates>90){
    throw new Error("maxDates must be 1..90");
  }
  const end=through??cutoff;
  if(end>cutoff)throw new Error("refusing to collect unfinished or future date "+end+"; last eligible "+cutoff);
  const days=raceManifest?.days??{};
  const nonMeeting=raceManifest?.non_meeting_days??{};
  const exceptions=raceManifest?.schedule_exception_days??{};
  const oddsDays=oddsManifest?.days??{};
  const selected=[];
  let pendingTotal=0,scannedDays=0,alreadyComplete=0;
  for(let date=from;date<=end;date=addUtcDays(date,1)){
    scannedDays++;
    const race=days[date];
    const non=nonMeeting[date]?.status==="CONFIRMED_NO_JRA";
    const exception=exceptions[date]?.status==="NO_RACES_HELD";
    if(non&&exception)throw new Error("conflicting non-meeting states "+date);
    if(race&&race.status!=="SUCCESS")throw new Error("unexpected race manifest status "+date+": "+race.status);
    if(race&&(non||exception))throw new Error("conflicting race and non-meeting state "+date);
    const hasRace=race?.status==="SUCCESS";
    const needsRace=!(hasRace||non||exception);
    const needsOdds=!(non||exception) && oddsDays[date]?.status!=="SUCCESS";
    if(needsRace||needsOdds){
      pendingTotal++;
      if(selected.length<maxDates)selected.push({date,needs_race:needsRace,needs_odds:needsOdds});
    }else alreadyComplete++;
  }
  return {
    schema_version:1,
    from,through:end,cutoff,max_dates:maxDates,
    scanned_days:scannedDays,already_complete:alreadyComplete,
    pending_total:pendingTotal,remaining_after_batch:Math.max(0,pendingTotal-selected.length),
    selected,
  };
}

async function readJson(path,fallback){
  try{return JSON.parse(await readFile(path,"utf8"));}
  catch(e){if(e?.code==="ENOENT")return fallback;throw e;}
}

async function requireFilesForSuccessDays(plan,raceManifest,oddsManifest){
  // A SUCCESS entry with a missing pack is metadata drift, never a silent skip.
  for(let date=plan.from;date<=plan.through;date=addUtcDays(date,1)){
    const race=raceManifest?.days?.[date];
    if(race?.status==="SUCCESS"){
      const path=String(race.file??"");
      if(!path||path.startsWith("/")||path.includes(".."))throw new Error("invalid race file in manifest for "+date);
      try{await access(path);}catch{throw new Error("race SUCCESS pack missing: "+date+" / "+path);}
    }
    const odds=oddsManifest?.days?.[date];
    if(odds?.status==="SUCCESS"){
      const path=String(odds.file??"");
      if(!path||path.startsWith("/")||path.includes(".."))throw new Error("invalid odds file in manifest for "+date);
      try{await access(path);}catch{throw new Error("odds SUCCESS pack missing: "+date+" / "+path);}
    }
  }
}

function parseArgs(args){
  const options={from:"2026-09-01",maxDates:60};
  for(let i=0;i<args.length;i++){
    const key=args[i];
    if(key==="--from")options.from=args[++i];
    else if(key==="--through")options.through=args[++i];
    else if(key==="--max-dates")options.maxDates=Number(args[++i]);
    else throw new Error("unknown argument: "+key);
  }
  return options;
}

async function cli(){
  const options=parseArgs(process.argv.slice(2));
  const raceManifest=await readJson("data/manifest.json",{days:{}});
  const oddsManifest=await readJson("data/odds/manifest.json",{days:{}});
  const plan=planForwardDates({...options,raceManifest,oddsManifest});
  await requireFilesForSuccessDays(plan,raceManifest,oddsManifest);
  console.log(JSON.stringify(plan,null,2));
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===fileURLToPath(new URL("file://"+process.argv[1]))){
  cli().catch(e=>{console.error(e?.stack??String(e));process.exitCode=1;});
}
