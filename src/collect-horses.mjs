import {load} from "cheerio";
import Encoding from "encoding-japanese";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import {gunzipSync,gzipSync} from "node:zlib";
import path from "node:path";

const DB_BASE="https://db.netkeiba.com";
const USER_AGENT="KEIBA-BACKFILL/0.1 (+https://github.com/pinogame1945-dotcom/KEIBA-BACKFILL)";
const MIN_DELAY_MS=1000;
const delayMs=Math.max(MIN_DELAY_MS,Number(process.env.REQUEST_DELAY_MS||1500));
let lastFetchAt=0;

function clean(value){
  return (value??"").replace(/\s+/g," ").trim();
}
function horseId(href){
  return href?.match(/\/horse\/(\d+)/)?.[1]??null;
}
function trainerId(href){
  return href?.match(/\/trainer\/(?:result\/recent\/)?(\d+)/)?.[1]??null;
}
function ownerId(href){
  return href?.match(/\/owner\/(?:result\/recent\/)?(\d+)/)?.[1]??null;
}
function breederId(href){
  return href?.match(/\/breeder\/(?:result\/recent\/)?(\d+)/)?.[1]??null;
}
function decode(bytes){
  const detected=Encoding.detect(bytes)||"EUCJP";
  return Encoding.convert(bytes,{to:"UNICODE",from:detected,type:"string"});
}
async function sleep(ms){
  await new Promise(resolve=>setTimeout(resolve,ms));
}
async function politeFetch(url){
  const wait=delayMs-(Date.now()-lastFetchAt);
  if(wait>0)await sleep(wait);

  for(let attempt=1;attempt<=2;attempt+=1){
    const response=await fetch(url,{
      headers:{
        "Accept-Language":"ja,en;q=0.5",
        "User-Agent":USER_AGENT
      }
    });
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
    if(attempt===2||response.status<500){
      throw new Error(`HTTP ${response.status} ${url}`);
    }
    await sleep(5000);
  }
  throw new Error(`fetch failed ${url}`);
}

function parseHorseProfile(html,hid,sourceUrl){
  const $=load(html);
  const titleName=clean($("title").first().text())
    .split(/[｜|]/)[0]
    ?.replace(/\s*\([^)]*\)\s*$/,"")
    .trim()||null;
  const name=
    clean($("h1").first().text())||
    clean($(".horse_title h1").first().text())||
    clean($(".HorseName").first().text())||
    titleName||
    null;
  const pageText=clean($.root().text());

  const birthMatch=pageText.match(/生年月日\s*[:：]?\s*((?:19|20)\d{2})年(\d{1,2})月(\d{1,2})日/);
  const birthDate=birthMatch
    ?birthMatch[1]+"-"+String(Number(birthMatch[2])).padStart(2,"0")+"-"+String(Number(birthMatch[3])).padStart(2,"0")
    :null;

  const sexMatch=pageText.slice(0,700).match(/(牡|牝|セ)\s*\d*/);
  const pairs={};
  $("tr").each((_,tr)=>{
    const th=$(tr).find("th").first();
    const td=$(tr).find("td").first();
    if(th.length&&td.length)pairs[clean(th.text())]=clean(td.text());
  });

  let trainer=null,owner=null,breeder=null;
  $("a[href]").each((_,el)=>{
    const href=$(el).attr("href");
    trainer=trainer??trainerId(href);
    owner=owner??ownerId(href);
    breeder=breeder??breederId(href);
  });

  const status=
    pairs["現役・抹消"]??
    pairs["登録"]??
    (pageText.includes("抹消")?"抹消":pageText.includes("現役")?"現役":null);

  if(!name)throw new Error("horse profile name not found: "+hid);

  return {
    horse_id:hid,
    horse_name:name,
    birth_date:birthDate,
    sex:sexMatch?.[1]??null,
    coat_color:pairs["毛色"]??null,
    status,
    trainer_id:trainer,
    owner_id:owner,
    breeder_id:breeder,
    birthplace:pairs["産地"]??null,
    profile_raw_json:JSON.stringify(pairs),
    source_url:sourceUrl,
    fetched_at:new Date().toISOString(),
    parser_version:1
  };
}

function parsePedigree(html){
  const $=load(html);
  const table=$("table.blood_table").first().length
    ?$("table.blood_table").first()
    :$("table[class*='blood']").first();
  if(!table.length)return [];

  const counters=new Map();
  const nodes=[];
  table.find("td").each((_,td)=>{
    const cell=$(td);
    const anchor=cell.find("a[href*='/horse/']").first();
    const name=clean(anchor.text())||clean(cell.text()).split(" ")[0]||"";
    if(!name)return;

    const rowspan=Math.max(1,Number(cell.attr("rowspan")??"1"));
    const generationMap={16:1,8:2,4:3,2:4,1:5};
    const generation=generationMap[rowspan];
    if(!generation)return;

    const slot=counters.get(generation)??0;
    counters.set(generation,slot+1);
    nodes.push({
      generation,
      slot,
      ancestor_id:horseId(anchor.attr("href")),
      ancestor_name:name,
      raw_text:clean(cell.text())
    });
  });

  return nodes
    .filter(node=>node.slot<Math.pow(2,node.generation))
    .sort((a,b)=>a.generation-b.generation||a.slot-b.slot);
}

async function loadManifest(){
  try{return JSON.parse(await readFile("data/manifest.json","utf8"));}
  catch{return {schema_version:1,days:{},horse_packs:{}};}
}
async function saveManifest(manifest){
  await mkdir("data",{recursive:true});
  await writeFile("data/manifest.json",JSON.stringify(manifest,null,2)+"\n");
}

function parseArgs(){
  const args=process.argv.slice(2);
  const value=name=>{
    const at=args.indexOf(name);
    return at>=0?args[at+1]:null;
  };
  return {
    sourceDate:value("--source-date")||process.env.SOURCE_DATE||"2026-09-20",
    limit:Number(value("--limit")||process.env.HORSE_LIMIT||10),
    packName:value("--pack-name")||process.env.PACK_NAME||null,
    skipExisting:(value("--skip-existing")??process.env.SKIP_EXISTING??"1")!=="0"
  };
}

async function horseIdsFromDaily(date){
  const file=path.join("data","daily",`${date}.jsonl.gz`);
  const zipped=await readFile(file);
  const text=gunzipSync(zipped).toString("utf8").trim();
  const rows=text?text.split("\n").map(JSON.parse):[];
  const ids=new Set();
  for(const row of rows){
    for(const entry of row.entries??[]){
      const id=String(entry.horse_id??"").trim();
      if(id)ids.add(id);
    }
  }
  return [...ids].sort();
}

const {sourceDate,limit,packName,skipExisting}=parseArgs();
if(!/^\d{4}-\d{2}-\d{2}$/.test(sourceDate)){
  throw new Error("invalid --source-date");
}
if(!Number.isInteger(limit)||limit<1||limit>500){
  throw new Error("--limit must be 1..500");
}

const allHorseIds=await horseIdsFromDaily(sourceDate);
if(!allHorseIds.length)throw new Error("no horse ids in daily pack: "+sourceDate);

const manifestBefore=await loadManifest();
const completedHorseIds=new Set();
for(const entry of Object.values(manifestBefore.horse_packs??{})){
  if(entry?.status!=="SUCCESS")continue;
  for(const id of entry.source_horse_ids??[]){
    completedHorseIds.add(String(id));
  }
}
const pendingHorseIds=skipExisting
  ?allHorseIds.filter(id=>!completedHorseIds.has(id))
  :allHorseIds;
const selected=pendingHorseIds.slice(0,limit);

if(!selected.length){
  console.log(JSON.stringify({
    ok:true,
    sourceDate,
    discoveredHorseIds:allHorseIds.length,
    completedHorseIds:completedHorseIds.size,
    pendingHorseIds:0,
    selected:0,
    message:"no pending horses"
  },null,2));
  process.exit(0);
}

const productionPrefix=`horse-${sourceDate}-`;
const existingIndexes=Object.keys(manifestBefore.horse_packs??{})
  .filter(name=>name.startsWith(productionPrefix))
  .map(name=>Number(name.slice(productionPrefix.length)))
  .filter(Number.isInteger);
const nextIndex=(existingIndexes.length?Math.max(...existingIndexes):0)+1;
const finalPackName=packName||`horse-${sourceDate}-${String(nextIndex).padStart(3,"0")}`;

console.log(JSON.stringify({
  sourceDate,
  discoveredHorseIds:allHorseIds.length,
  completedHorseIds:completedHorseIds.size,
  pendingHorseIds:pendingHorseIds.length,
  selected:selected.length,
  packName:finalPackName
},null,2));

const records=[];
const failures=[];
const timings=[];
const packStartedAt=Date.now();
for(let i=0;i<selected.length;i+=1){
  const hid=selected[i];
  const profileUrl=`${DB_BASE}/horse/${hid}/`;
  const pedigreeUrl=`${DB_BASE}/horse/ped/${hid}/`;
  console.log(`[horse ${i+1}/${selected.length}] ${hid}`);
  try{
    const horseStartedAt=Date.now();
    const profileStartedAt=Date.now();
    const profileHtml=await politeFetch(profileUrl);
    const profileFetchedAt=Date.now();
    const profile=parseHorseProfile(profileHtml,hid,profileUrl);
    const pedigreeStartedAt=Date.now();
    const pedigreeHtml=await politeFetch(pedigreeUrl);
    const pedigreeFetchedAt=Date.now();
    const pedigree=parsePedigree(pedigreeHtml);
    if(!pedigree.length)throw new Error("pedigree empty");
    if(!pedigree.some(node=>node.generation===1&&node.slot===0)){
      throw new Error("sire missing");
    }
    if(!pedigree.some(node=>node.generation===1&&node.slot===1)){
      throw new Error("dam missing");
    }
    records.push({
      schema_version:1,
      kind:"horse",
      horse_id:hid,
      profile,
      pedigree
    });
    const horseFinishedAt=Date.now();
    const timing={
      horse_id:hid,
      profile_fetch_ms:profileFetchedAt-profileStartedAt,
      pedigree_fetch_ms:pedigreeFetchedAt-pedigreeStartedAt,
      total_ms:horseFinishedAt-horseStartedAt
    };
    timings.push(timing);
    console.log(`[timing] ${hid} total=${timing.total_ms}ms profile=${timing.profile_fetch_ms}ms pedigree=${timing.pedigree_fetch_ms}ms`);
  }catch(error){
    failures.push({
      horse_id:hid,
      error:error instanceof Error?error.message:String(error)
    });
    break;
  }
}

await mkdir(path.join("data","debug"),{recursive:true});
if(failures.length){
  await writeFile(
    path.join("data","debug",`${finalPackName}-error.json`),
    JSON.stringify({sourceDate,selected,records:records.length,failures,timings},null,2)+"\n"
  );
  throw new Error("horse pack failed at "+failures[0].horse_id+": "+failures[0].error);
}

if(records.length!==selected.length){
  throw new Error(`horse coverage mismatch selected=${selected.length} records=${records.length}`);
}

const outDir=path.join("data","horses");
await mkdir(outDir,{recursive:true});
const outPath=path.join(outDir,`${finalPackName}.jsonl.gz`);
const lines=records.map(row=>JSON.stringify(row)).join("\n")+"\n";
await writeFile(outPath,gzipSync(Buffer.from(lines,"utf8"),{level:9}));

const manifest=manifestBefore;
manifest.schema_version=1;
manifest.days=manifest.days??{};
manifest.horse_packs=manifest.horse_packs??{};
manifest.updated_at=new Date().toISOString();
const sortedDurations=timings.map(t=>t.total_ms).sort((a,b)=>a-b);
const average=value=>Math.round(value.reduce((sum,n)=>sum+n,0)/Math.max(1,value.length));
const median=value=>{
  if(!value.length)return 0;
  const middle=Math.floor(value.length/2);
  return value.length%2?value[middle]:Math.round((value[middle-1]+value[middle])/2);
};
const packFinishedAt=Date.now();
const timingSummary={
  total_ms:packFinishedAt-packStartedAt,
  average_ms_per_horse:average(sortedDurations),
  median_ms_per_horse:median(sortedDurations),
  min_ms_per_horse:sortedDurations[0]??0,
  max_ms_per_horse:sortedDurations.at(-1)??0,
  average_profile_fetch_ms:average(timings.map(t=>t.profile_fetch_ms)),
  average_pedigree_fetch_ms:average(timings.map(t=>t.pedigree_fetch_ms)),
  measured_horses:timings.length
};
manifest.horse_packs[finalPackName]={
  status:"SUCCESS",
  records:records.length,
  file:outPath.replaceAll("\\","/"),
  source_dates:[sourceDate],
  source_horse_ids:selected,
  request_delay_ms:delayMs,
  timing:timingSummary
};
await saveManifest(manifest);

console.log(JSON.stringify({
  ok:true,
  packName:finalPackName,
  records:records.length,
  firstHorse:records[0]?.profile?.horse_name??null,
  pedigreeNodes:records.reduce((sum,row)=>sum+row.pedigree.length,0),
  timing:timingSummary,
  output:outPath
},null,2));
