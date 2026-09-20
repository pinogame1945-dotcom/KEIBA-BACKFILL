import {readFile} from "node:fs/promises";
import {gunzipSync} from "node:zlib";

const [startDate,endDate]=process.argv.slice(2);
const dateRe=/^\d{4}-\d{2}-\d{2}$/;
if(!dateRe.test(startDate??"")||!dateRe.test(endDate??""))throw new Error("usage: node src/verify-range.mjs START_DATE END_DATE");
if(startDate<endDate)throw new Error("start_date must be newest and >= end_date");

const manifest=JSON.parse(await readFile("data/manifest.json","utf8"));
const horseIds=new Set();
let successfulHorsePacks=0;
for(const [packName,pack] of Object.entries(manifest.horse_packs??{})){
  if(pack.status!=="SUCCESS")continue;
  successfulHorsePacks++;
  if((pack.request_delay_ms??0)<1500)throw new Error(`unsafe request delay in ${packName}: ${pack.request_delay_ms}`);
  for(const raw of pack.source_horse_ids??[]){
    const id=String(raw);
    if(horseIds.has(id))throw new Error(`duplicate horse across packs: ${id}`);
    horseIds.add(id);
  }
}

let checkedDays=0;
let checkedRaces=0;
const currentHorsePacks=new Set();

for(const [date,day] of Object.entries(manifest.days??{})){
  if(date>endDate&&date<=startDate || date===endDate){
    if(day.status!=="SUCCESS")throw new Error(`day not SUCCESS: ${date}`);
    if((day.request_delay_ms??0)<1500)throw new Error(`unsafe request delay for day ${date}: ${day.request_delay_ms}`);
    const text=gunzipSync(await readFile(day.file)).toString("utf8").trim();
    const rows=text?text.split("\n").map(JSON.parse):[];
    if(rows.length!==day.races_parsed)throw new Error(`daily race count mismatch ${date}`);
    checkedDays++;
    checkedRaces+=rows.length;
    for(const row of rows){
      if(!row?.race?.race_id)throw new Error(`missing race_id in ${date}`);
      if(!Array.isArray(row.entries)||!Array.isArray(row.results))throw new Error(`invalid race arrays ${row.race.race_id}`);
      if(!row.entries.length||!row.results.length)throw new Error(`empty race ${row.race.race_id}`);
      for(const entry of row.entries??[]){
        if(entry.horse_id&&!horseIds.has(String(entry.horse_id))){
          throw new Error(`horse master missing for ${date}: ${entry.horse_id}`);
        }
      }
    }
  }
}

for(const [packName,pack] of Object.entries(manifest.horse_packs??{})){
  if(pack.status!=="SUCCESS")continue;
  const inRange=(pack.source_dates??[]).some(date=>date<=startDate&&date>=endDate);
  if(!inRange)continue;
  currentHorsePacks.add(packName);
  const text=gunzipSync(await readFile(pack.file)).toString("utf8").trim();
  const rows=text?text.split("\n").map(JSON.parse):[];
  if(rows.length!==pack.records)throw new Error(`horse record count mismatch ${packName}`);
  const manifestIds=new Set((pack.source_horse_ids??[]).map(String));
  const actualIds=new Set();
  for(const row of rows){
    const id=String(row.horse_id??"");
    if(row.schema_version!==1||row.kind!=="horse"||!id)throw new Error(`invalid horse record in ${packName}`);
    if(actualIds.has(id))throw new Error(`duplicate horse inside ${packName}: ${id}`);
    actualIds.add(id);
    if(!manifestIds.has(id))throw new Error(`horse missing from pack manifest ${packName}: ${id}`);
    if(!row.profile?.horse_name)throw new Error(`horse name missing: ${id}`);
    if(!Array.isArray(row.pedigree)||row.pedigree.length!==62)throw new Error(`incomplete pedigree ${id}: ${row.pedigree?.length??0}`);
    const positions=new Set(row.pedigree.map(node=>`${node.generation}:${node.slot}`));
    if(positions.size!==62)throw new Error(`duplicate pedigree positions: ${id}`);
    for(let generation=1;generation<=5;generation++){
      for(let slot=0;slot<2**generation;slot++){
        if(!positions.has(`${generation}:${slot}`))throw new Error(`missing pedigree position ${id} ${generation}:${slot}`);
      }
    }
  }
  if(actualIds.size!==manifestIds.size)throw new Error(`horse id manifest mismatch ${packName}`);
}

console.log(JSON.stringify({
  ok:true,
  range:{start:startDate,end:endDate},
  checkedDays,
  checkedRaces,
  checkedHorsePacks:currentHorsePacks.size,
  successfulHorsePacks,
  uniqueHorseMaster:horseIds.size
},null,2));
