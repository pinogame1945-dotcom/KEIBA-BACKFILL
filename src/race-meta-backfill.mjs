import {load} from "cheerio";
import Encoding from "encoding-japanese";
import {readFile,writeFile,rename} from "node:fs/promises";
import {gunzipSync,gzipSync} from "node:zlib";
import {
  RACE_META_PARSER_VERSION,normalizeRaceMeta,selectRaceMetaParts,
  summarizeRaceMetaCoverage,validateRaceMetaFields,
} from "./race-meta.mjs";

const [date]=process.argv.slice(2);
if(!/^\d{4}-\d{2}-\d{2}$/.test(date??"")){
  throw new Error("Usage: node src/race-meta-backfill.mjs YYYY-MM-DD");
}

const DB_BASE="https://db.netkeiba.com";
const USER_AGENT="KEIBA-BACKFILL/0.1 (+https://github.com/pinogame1945-dotcom/KEIBA-BACKFILL)";
const delayMs=Math.max(1000,Number(process.env.REQUEST_DELAY_MS||1500));
let lastFetchAt=0;

const clean=value=>String(value??"").replace(/\s+/g," ").trim();
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function decode(bytes){
  const detected=Encoding.detect(bytes)||"EUCJP";
  return Encoding.convert(bytes,{to:"UNICODE",from:detected,type:"string"});
}

async function politeFetch(url){
  const maxAttempts=3;
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    const wait=delayMs-(Date.now()-lastFetchAt);
    if(wait>0)await sleep(wait);
    let response;
    try{
      response=await fetch(url,{
        headers:{
          "Accept-Language":"ja,en;q=0.5",
          "User-Agent":USER_AGENT,
        },
      });
      lastFetchAt=Date.now();
    }catch(error){
      lastFetchAt=Date.now();
      if(attempt<maxAttempts){
        await sleep(5000*attempt);
        continue;
      }
      throw new Error(
        "RACE_META_NETWORK_FETCH_FAILED after "+maxAttempts+" attempts: "+
        (error instanceof Error?error.message:String(error))
      );
    }

    if(response.status===403||response.status===429){
      throw new Error("RACE_META_RATE_LIMIT HTTP "+response.status+" "+url);
    }
    if(response.status>=500&&attempt<maxAttempts){
      await sleep(5000*attempt);
      continue;
    }
    if(!response.ok)throw new Error("RACE_META_HTTP_"+response.status+" "+url);
    const bytes=new Uint8Array(await response.arrayBuffer());
    return decode(bytes);
  }
  throw new Error("RACE_META_FETCH_EXHAUSTED "+url);
}

async function fetchNormalizedMeta(row){
  const raceId=String(row?.race?.race_id??"");
  if(!/^\d{12}$/.test(raceId))throw new Error("invalid race_id in race meta pack: "+raceId);
  const urls=[
    "https://race.netkeiba.com/race/result.html?race_id="+raceId,
    DB_BASE+"/race/"+raceId+"/",
  ];
  let lastError=null;
  for(const url of urls){
    try{
      const html=await politeFetch(url);
      const $=load(html);
      const titleCandidate=clean($("title").first().text()).split(/[｜|]/)[0]?.trim()||null;
      const sourceRaceName=
        clean($(".RaceName").first().text())||
        clean($("h1").first().text())||
        clean($(".race_name").first().text())||
        row?.race?.race_name||
        titleCandidate||
        null;
      const parts=selectRaceMetaParts($);
      if(!parts.race_meta_raw||!parts.course_meta_raw){
        throw new Error("race meta source missing required raw course/meta");
      }
      const normalized=normalizeRaceMeta({...parts,race_name:sourceRaceName});
      validateRaceMetaFields(normalized);
      return {normalized,sourceUrl:url};
    }catch(error){
      lastError=error;
      console.warn(
        "[race-meta fallback] "+raceId+" "+url+": "+
        (error instanceof Error?error.message:String(error))
      );
    }
  }
  throw lastError??new Error("all race meta sources failed: "+raceId);
}

const manifestPath="data/manifest.json";
const manifest=JSON.parse(await readFile(manifestPath,"utf8"));
const day=manifest.days?.[date];
if(!day||day.status!=="SUCCESS"||!day.file){
  throw new Error("race meta backfill requires SUCCESS race day: "+date);
}

const zipped=await readFile(day.file);
const text=gunzipSync(zipped).toString("utf8").trim();
const rows=text?text.split("\n").map(JSON.parse):[];
if(rows.length!==Number(day.races_parsed??0)){
  throw new Error("race meta source pack count mismatch "+date);
}

if(
  Number(day.race_meta_parser_version??0)>=RACE_META_PARSER_VERSION&&
  rows.every(row=>Number(row?.race_meta_parser_version??0)>=RACE_META_PARSER_VERSION)
){
  console.log(JSON.stringify({ok:true,date,skipped:true,races:rows.length},null,2));
  process.exit(0);
}

const updated=[];
for(let i=0;i<rows.length;i++){
  const row=rows[i];
  const raceId=String(row?.race?.race_id??"");
  console.log("[race-meta "+(i+1)+"/"+rows.length+"] "+raceId);
  const {normalized,sourceUrl}=await fetchNormalizedMeta(row);
  updated.push({
    ...row,
    race_meta_parser_version:RACE_META_PARSER_VERSION,
    race:{
      ...row.race,
      ...normalized,
      race_meta_source_url:sourceUrl,
    },
  });
}

const coverage=summarizeRaceMetaCoverage(updated);
for(const row of updated)validateRaceMetaFields(row.race);

const lines=updated.map(row=>JSON.stringify(row)).join("\n")+(updated.length?"\n":"");
const tempPath=day.file+".race-meta.tmp";
await writeFile(tempPath,gzipSync(Buffer.from(lines,"utf8"),{level:9}));
await rename(tempPath,day.file);

manifest.race_meta_parser_version=Math.max(
  Number(manifest.race_meta_parser_version??0),
  RACE_META_PARSER_VERSION,
);
day.race_meta_parser_version=RACE_META_PARSER_VERSION;
day.race_meta_coverage=coverage;
day.race_meta_updated_at=new Date().toISOString();
await writeFile(manifestPath,JSON.stringify(manifest,null,2)+"\n");

console.log(JSON.stringify({
  ok:true,date,skipped:false,races:updated.length,
  race_meta_parser_version:RACE_META_PARSER_VERSION,
  coverage,
},null,2));
