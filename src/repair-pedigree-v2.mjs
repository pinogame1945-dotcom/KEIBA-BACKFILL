import Encoding from "encoding-japanese";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import {gunzipSync,gzipSync} from "node:zlib";
import path from "node:path";
import {parsePedigreeV2} from "./pedigree-parser.mjs";

const DB_BASE="https://db.netkeiba.com";
const USER_AGENT="KEIBA-BACKFILL/0.1 (+https://github.com/pinogame1945-dotcom/KEIBA-BACKFILL)";
const PEDIGREE_PARSER_VERSION=2;
const HORSE_PACK_VERSION=2;
const delayMs=Math.max(1000,Number(process.env.REQUEST_DELAY_MS||1500));
let lastFetchAt=0;

function decode(bytes){
  const detected=Encoding.detect(bytes)||"EUCJP";
  return Encoding.convert(bytes,{to:"UNICODE",from:detected,type:"string"});
}
async function sleep(ms){await new Promise(resolve=>setTimeout(resolve,ms));}
async function politeFetch(url){
  const wait=delayMs-(Date.now()-lastFetchAt);
  if(wait>0)await sleep(wait);
  for(let attempt=1;attempt<=2;attempt+=1){
    const response=await fetch(url,{headers:{
      "Accept-Language":"ja,en;q=0.5",
      "User-Agent":USER_AGENT,
    }});
    lastFetchAt=Date.now();
    if(response.status===403||response.status===429){
      throw new Error(`RATE_LIMIT HTTP ${response.status} ${url}`);
    }
    if(response.ok){
      const bytes=new Uint8Array(await response.arrayBuffer());
      const text=decode(bytes);
      if(/アクセス制限|通信制限|不正なアクセス/.test(text)){
        throw new Error(`RATE_LIMIT content ${url}`);
      }
      return text;
    }
    if(attempt===2||response.status<500)throw new Error(`HTTP ${response.status} ${url}`);
    await sleep(5000);
  }
  throw new Error("fetch failed "+url);
}
function arg(name){
  const args=process.argv.slice(2),at=args.indexOf(name);
  return at>=0?args[at+1]:null;
}
const sourceDate=arg("--source-date")||process.env.SOURCE_DATE||null;
const limit=Number(arg("--limit")||process.env.HORSE_LIMIT||100);
if(sourceDate&&!/^\d{4}-\d{2}-\d{2}$/.test(sourceDate))throw new Error("invalid --source-date");
if(!Number.isInteger(limit)||limit<1||limit>200)throw new Error("--limit must be 1..200");

const manifest=JSON.parse(await readFile("data/manifest.json","utf8"));
let targetDateHorseIds=null;
if(sourceDate){
  const daily=manifest.days?.[sourceDate];
  if(!daily?.file)throw new Error("daily pack missing for source date: "+sourceDate);
  const text=gunzipSync(await readFile(daily.file)).toString("utf8").trim();
  targetDateHorseIds=new Set();
  for(const line of text.split("\n").filter(Boolean)){
    const row=JSON.parse(line);
    for(const entry of row.entries??[]){
      if(entry?.horse_id)targetDateHorseIds.add(String(entry.horse_id));
    }
  }
}
const legacyIds=new Set();
const v2Ids=new Set();
const datesByHorse=new Map();
for(const entry of Object.values(manifest.horse_packs??{})){
  if(entry?.status!=="SUCCESS")continue;
  const dates=(entry.source_dates??[]).map(String);
  const ids=(entry.source_horse_ids??[]).map(String);
  if(
    Number(entry.horse_pack_version??0)>=HORSE_PACK_VERSION&&
    Number(entry.pedigree_parser_version??0)>=PEDIGREE_PARSER_VERSION
  ){
    for(const id of ids)v2Ids.add(id);
    continue;
  }
  for(const id of ids){
    legacyIds.add(id);
    const set=datesByHorse.get(id)??new Set();
    for(const d of dates)set.add(d);
    datesByHorse.set(id,set);
  }
}
const pending=[...legacyIds]
  .filter(id=>!v2Ids.has(id))
  .filter(id=>!targetDateHorseIds||targetDateHorseIds.has(id))
  .sort();
const selected=pending.slice(0,limit);
if(!selected.length){
  console.log(JSON.stringify({ok:true,sourceDate,pending:0,selected:0,message:"no pedigree v2 repair pending"},null,2));
  process.exit(0);
}

const prefix="pedigree-v2-"+(sourceDate??"all")+"-";
const indexes=Object.keys(manifest.horse_packs??{})
  .filter(name=>name.startsWith(prefix))
  .map(name=>Number(name.slice(prefix.length))).filter(Number.isInteger);
const next=(indexes.length?Math.max(...indexes):0)+1;
const packName=prefix+String(next).padStart(3,"0");

const records=[];
const timings=[];
for(let i=0;i<selected.length;i+=1){
  const hid=selected[i];
  const started=Date.now();
  console.log(`[pedigree-v2 ${i+1}/${selected.length}] ${hid}`);
  const html=await politeFetch(`${DB_BASE}/horse/ped/${hid}/`);
  const pedigree=parsePedigreeV2(html);
  if(!pedigree.length)throw new Error("pedigree empty: "+hid);
  if(!pedigree.some(n=>n.generation===1&&n.slot===0)||!pedigree.some(n=>n.generation===1&&n.slot===1)){
    throw new Error("pedigree parent pair missing: "+hid);
  }
  records.push({
    schema_version:1,
    horse_pack_version:HORSE_PACK_VERSION,
    pedigree_parser_version:PEDIGREE_PARSER_VERSION,
    kind:"horse",
    horse_id:hid,
    profile:null,
    pedigree,
  });
  timings.push(Date.now()-started);
}

const outDir=path.join("data","horses");
await mkdir(outDir,{recursive:true});
const outPath=path.join(outDir,packName+".jsonl.gz");
await writeFile(outPath,gzipSync(Buffer.from(records.map(r=>JSON.stringify(r)).join("\n")+"\n","utf8"),{level:9}));

const sourceDates=[...new Set(selected.flatMap(id=>[...(datesByHorse.get(id)??[]) ]))].sort();
manifest.updated_at=new Date().toISOString();
manifest.horse_packs=manifest.horse_packs??{};
manifest.horse_packs[packName]={
  status:"SUCCESS",
  horse_pack_version:HORSE_PACK_VERSION,
  pedigree_parser_version:PEDIGREE_PARSER_VERSION,
  repair_from_pedigree_parser_v1:true,
  records:records.length,
  file:outPath.replaceAll("\\","/"),
  source_dates:sourceDates,
  source_horse_ids:selected,
  request_delay_ms:delayMs,
  timing:{
    total_ms:timings.reduce((a,b)=>a+b,0),
    average_ms_per_horse:Math.round(timings.reduce((a,b)=>a+b,0)/Math.max(1,timings.length)),
    measured_horses:timings.length,
  },
};
await writeFile("data/manifest.json",JSON.stringify(manifest,null,2)+"\n");
console.log(JSON.stringify({
  ok:true,sourceDate,packName,records:records.length,
  pendingBefore:pending.length,pendingAfter:Math.max(0,pending.length-selected.length),
  output:outPath,
},null,2));