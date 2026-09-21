import {access,mkdir,readFile,rename,writeFile} from "node:fs/promises";
import {gunzipSync,gzipSync} from "node:zlib";
import path from "node:path";
import {
  NETKEIBA_ODDS_START_DATE,ODDS_DECODER_CONTRACT_VERSION,ODDS_PACK_VERSION,
  archiveHistoricalOddsPayload,parseNetkeibaOddsResponse,
} from "./historical-odds-pack.mjs";
import {
  SCHEDULE_CONTRACT_VERSION,scheduleIntegrityEnabled,
} from "./schedule-integrity.mjs";

const API="https://race.netkeiba.com/api/api_get_jra_odds.html";
const MIN_DELAY_MS=1000;
const delayMs=Math.max(MIN_DELAY_MS,Number(process.env.REQUEST_DELAY_MS||1500));
let lastFetchAt=0;
const scheduleIntegrity=scheduleIntegrityEnabled();

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function politeFetch(url){
  const wait=delayMs-(Date.now()-lastFetchAt);
  if(wait>0)await sleep(wait);
  for(let attempt=1;attempt<=2;attempt+=1){
    const response=await fetch(url,{
      headers:{
        "User-Agent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        "Referer":"https://race.netkeiba.com/",
        "Accept":"application/json, text/javascript, */*",
        "Accept-Language":"ja,en;q=0.5",
      },
      signal:AbortSignal.timeout(25_000),
    });
    lastFetchAt=Date.now();
    const text=await response.text();
    if(response.status===403||response.status===429){
      throw new Error("RATE_LIMIT HTTP "+response.status+" "+url);
    }
    if(response.ok)return text;
    if(attempt===2||response.status<500){
      throw new Error("HTTP "+response.status+" "+url+" body="+text.slice(0,120));
    }
    await sleep(5000);
  }
  throw new Error("fetch failed "+url);
}

function sourceUrl(raceId){
  const url=new URL(API);
  for(const [key,value] of Object.entries({
    pid:"api_get_jra_odds",
    race_id:raceId,
    type:"all",
    action:"init",
    sort:"odds",
    compress:"0",
    output:"json",
  }))url.searchParams.set(key,value);
  return url.toString();
}

async function loadJson(file,fallback){
  try{return JSON.parse(await readFile(file,"utf8"));}
  catch(error){
    if(error?.code==="ENOENT")return fallback;
    throw error;
  }
}

async function exists(file){
  try{await access(file);return true;}
  catch{return false;}
}

async function atomicWrite(file,bytes){
  await mkdir(path.dirname(file),{recursive:true});
  const tmp=file+".tmp-"+process.pid;
  await writeFile(tmp,bytes);
  await rename(tmp,file);
}

function readRaceOwnersFromDay(bytes,ownerDate){
  const text=gunzipSync(bytes).toString("utf8").trim();
  if(!text)return [];
  const byId=new Map();
  for(const line of text.split("\n")){
    if(!line.trim())continue;
    const row=JSON.parse(line);
    const raceId=String(row?.race?.race_id??"");
    if(!/^\d{12}$/.test(raceId))throw new Error("daily pack contains invalid race id");
    const actualDate=String(row?.race?.actual_date??ownerDate);
    const scheduledDate=String(row?.race?.scheduled_date??actualDate);
    if(scheduleIntegrity&&actualDate!==ownerDate){
      throw new Error("odds source race owner mismatch: "+ownerDate+" / "+raceId+" / "+actualDate);
    }
    const existing=byId.get(raceId);
    if(existing&&(
      existing.actualDate!==actualDate||existing.scheduledDate!==scheduledDate
    )){
      throw new Error("conflicting race ownership in daily pack: "+raceId);
    }
    byId.set(raceId,{raceId,actualDate,scheduledDate});
  }
  return [...byId.values()].sort((a,b)=>a.raceId.localeCompare(b.raceId));
}

const date=process.argv[2]||process.env.ODDS_BACKFILL_DATE;
if(!date||!/^\d{4}-\d{2}-\d{2}$/.test(date)){
  throw new Error("Usage: node src/collect-historical-odds.mjs YYYY-MM-DD");
}

const oddsManifestPath="data/odds/manifest.json";
const oddsDailyPath=path.join("data","odds","daily",date+".jsonl.gz");
const oddsManifest=await loadJson(oddsManifestPath,{
  schema_version:1,
  odds_pack_version:ODDS_PACK_VERSION,
  decoder_contract_version:ODDS_DECODER_CONTRACT_VERSION,
  days:{},
});
oddsManifest.days??={};

const rootManifest=await loadJson("data/manifest.json",{days:{}});
const raceDayEntry=rootManifest?.days?.[date]??null;
const requiresScheduleContract=Boolean(
  scheduleIntegrity&&
  Number(raceDayEntry?.schedule_contract_version??0)>=SCHEDULE_CONTRACT_VERSION
);

const existing=oddsManifest.days[date];
if(existing?.status==="SUCCESS"&&
   Number(existing.odds_pack_version)===ODDS_PACK_VERSION&&
   Number(existing.decoder_contract_version)===ODDS_DECODER_CONTRACT_VERSION&&
   (!requiresScheduleContract||
    Number(existing.schedule_contract_version??0)>=SCHEDULE_CONTRACT_VERSION)){
  if(!await exists(oddsDailyPath)){
    throw new Error("odds manifest marks SUCCESS but file missing: "+oddsDailyPath);
  }
  console.log("[skip] existing historical odds pack "+date);
  process.exit(0);
}

if(date<NETKEIBA_ODDS_START_DATE){
  oddsManifest.days[date]={
    status:"UNSUPPORTED",
    reason:"BEFORE_NETKEIBA_ODDS_START",
    supported_from:NETKEIBA_ODDS_START_DATE,
    odds_pack_version:ODDS_PACK_VERSION,
    decoder_contract_version:ODDS_DECODER_CONTRACT_VERSION,
    updated_at:new Date().toISOString(),
  };
  await atomicWrite(oddsManifestPath,Buffer.from(JSON.stringify(oddsManifest,null,2)+"\n"));
  console.log("[skip] netkeiba historical odds unavailable before "+NETKEIBA_ODDS_START_DATE);
  process.exit(0);
}

const dayPath=path.join("data","daily",date+".jsonl.gz");
if(!await exists(dayPath)){
  if(rootManifest?.non_meeting_days?.[date]?.status==="CONFIRMED_NO_JRA"){
    oddsManifest.days[date]={
      status:"NO_MEETING",
      odds_pack_version:ODDS_PACK_VERSION,
      decoder_contract_version:ODDS_DECODER_CONTRACT_VERSION,
      updated_at:new Date().toISOString(),
    };
    await atomicWrite(oddsManifestPath,Buffer.from(JSON.stringify(oddsManifest,null,2)+"\n"));
    console.log("[skip] confirmed non-meeting day "+date);
    process.exit(0);
  }
  throw new Error("race pack required before odds backfill: "+dayPath);
}

const raceOwners=readRaceOwnersFromDay(await readFile(dayPath),date);
if(!raceOwners.length)throw new Error("race pack has no races: "+dayPath);

const records=[];
let rawResponseBytes=0;
for(let i=0;i<raceOwners.length;i+=1){
  const owner=raceOwners[i];
  const raceId=owner.raceId;
  const url=sourceUrl(raceId);
  console.log("[odds] "+date+" "+(i+1)+"/"+raceOwners.length+" "+raceId);
  const text=await politeFetch(url);
  rawResponseBytes+=Buffer.byteLength(text);
  const payload=parseNetkeibaOddsResponse(text);
  records.push(archiveHistoricalOddsPayload({
    raceId,payload,sourceUrl:url,fetchedAt:new Date().toISOString(),
    actualDate:requiresScheduleContract?owner.actualDate:null,
    scheduledDate:requiresScheduleContract?owner.scheduledDate:null,
    scheduleContractVersion:requiresScheduleContract?SCHEDULE_CONTRACT_VERSION:null,
  }));
}

const jsonl=records.map(row=>JSON.stringify(row)).join("\n")+"\n";
const zipped=gzipSync(Buffer.from(jsonl,"utf8"),{level:9});
await atomicWrite(oddsDailyPath,zipped);

const groups={};
for(const row of records){
  for(const [key,item] of Object.entries(row.group_summary??{})){
    const current=groups[key]??{races:0,rows:0,priced_rows:0,unavailable_races:0};
    current.races+=1;
    current.rows+=Number(item.rows??0);
    current.priced_rows+=Number(item.priced_rows??0);
    if(item.status!=="PRICED")current.unavailable_races+=1;
    groups[key]=current;
  }
}
oddsManifest.schema_version=1;
oddsManifest.odds_pack_version=ODDS_PACK_VERSION;
oddsManifest.decoder_contract_version=ODDS_DECODER_CONTRACT_VERSION;
oddsManifest.days[date]={
  status:"SUCCESS",
  races:records.length,
  file:oddsDailyPath,
  odds_pack_version:ODDS_PACK_VERSION,
  decoder_contract_version:ODDS_DECODER_CONTRACT_VERSION,
  ...(requiresScheduleContract?{schedule_contract_version:SCHEDULE_CONTRACT_VERSION}:{}),
  request_delay_ms:delayMs,
  raw_response_bytes:rawResponseBytes,
  compressed_bytes:zipped.length,
  groups,
  updated_at:new Date().toISOString(),
};
await atomicWrite(oddsManifestPath,Buffer.from(JSON.stringify(oddsManifest,null,2)+"\n"));

console.log(JSON.stringify({
  date,races:records.length,file:oddsDailyPath,
  raw_response_bytes:rawResponseBytes,compressed_bytes:zipped.length,groups,
},null,2));
