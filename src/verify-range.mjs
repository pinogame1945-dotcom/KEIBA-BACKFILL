import {readFile} from "node:fs/promises";
import {gunzipSync} from "node:zlib";

const [startDate,endDate]=process.argv.slice(2);
const dateRe=/^\d{4}-\d{2}-\d{2}$/;
if(!dateRe.test(startDate??"")||!dateRe.test(endDate??""))throw new Error("usage: node src/verify-range.mjs START_DATE END_DATE");
if(startDate<endDate)throw new Error("start_date must be newest and >= end_date");

const manifest=JSON.parse(await readFile("data/manifest.json","utf8"));
if(Number(manifest.race_pack_version??1)<2)throw new Error("manifest race_pack_version must be >=2");
if(Number(manifest.payout_parser_version??1)<2)throw new Error("manifest payout_parser_version must be >=2");
const payoutArity={
  WIN:1,PLACE:1,BRACKET_QUINELLA:2,QUINELLA:2,WIDE:2,EXACTA:2,TRIO:3,TRIFECTA:3
};
const horseIds=new Set();
const horseIdsByParserVersion=new Map();
let successfulHorsePacks=0;
for(const [packName,pack] of Object.entries(manifest.horse_packs??{})){
  if(pack.status!=="SUCCESS")continue;
  successfulHorsePacks++;
  if((pack.request_delay_ms??0)<1500)throw new Error(`unsafe request delay in ${packName}: ${pack.request_delay_ms}`);
  const parserVersion=Number(pack.pedigree_parser_version??1);
  let sameVersion=horseIdsByParserVersion.get(parserVersion);
  if(!sameVersion){
    sameVersion=new Set();
    horseIdsByParserVersion.set(parserVersion,sameVersion);
  }
  for(const raw of pack.source_horse_ids??[]){
    const id=String(raw);
    if(sameVersion.has(id)){
      throw new Error(`duplicate horse in pedigree parser v${parserVersion}: ${id}`);
    }
    sameVersion.add(id);
    horseIds.add(id);
  }
}

let checkedDays=0;
let checkedNonMeetingDays=0;
let checkedRaces=0;
const currentHorsePacks=new Set();

const dayMs=86400000;
const parseDate=value=>{
  const [y,m,d]=value.split("-").map(Number);
  return new Date(Date.UTC(y,m-1,d));
};
const formatDate=date=>date.toISOString().slice(0,10);
const rangeDates=[];
for(let cursor=parseDate(startDate);formatDate(cursor)>=endDate;cursor=new Date(cursor.getTime()-dayMs)){
  rangeDates.push(formatDate(cursor));
}

for(const date of rangeDates){
  const day=manifest.days?.[date];
  const noMeeting=manifest.non_meeting_days?.[date];

  if(day&&noMeeting){
    throw new Error(`conflicting day classification for ${date}`);
  }

  if(day){
    if(day.status!=="SUCCESS")throw new Error(`day not SUCCESS: ${date}`);
    if(Number(day.race_pack_version??1)<2)throw new Error(`legacy race pack in completed range: ${date}`);
    if(Number(day.payout_parser_version??1)<2)throw new Error(`legacy payout parser in completed range: ${date}`);
    if((day.request_delay_ms??0)<1500)throw new Error(`unsafe request delay for day ${date}: ${day.request_delay_ms}`);
    const text=gunzipSync(await readFile(day.file)).toString("utf8").trim();
    const rows=text?text.split("\n").map(JSON.parse):[];
    if(rows.length!==day.races_parsed)throw new Error(`daily race count mismatch ${date}`);
    checkedDays++;
    checkedRaces+=rows.length;
    for(const row of rows){
      if(!row?.race?.race_id)throw new Error(`missing race_id in ${date}`);
      if(Number(row.race_pack_version??1)<2)throw new Error(`legacy race row ${row.race.race_id}`);
      if(Number(row.payout_parser_version??1)<2)throw new Error(`legacy payout row ${row.race.race_id}`);
      if(!Array.isArray(row.entries)||!Array.isArray(row.results)||!Array.isArray(row.payouts))throw new Error(`invalid race arrays ${row.race.race_id}`);
      if(!row.entries.length||!row.results.length)throw new Error(`empty race ${row.race.race_id}`);
      for(const payout of row.payouts){
        const arity=payoutArity[payout.bet_type];
        if(!arity)throw new Error(`unknown payout bet type ${row.race.race_id}: ${payout.bet_type}`);
        const count=(String(payout.combination??"").match(/\d+/g)??[]).length;
        if(count!==arity)throw new Error(`invalid payout combination ${row.race.race_id} ${payout.bet_type}: ${payout.combination}`);
        if(!Number.isFinite(Number(payout.payout_yen)))throw new Error(`invalid payout amount ${row.race.race_id} ${payout.bet_type}`);
      }
      for(const entry of row.entries??[]){
        if(entry.horse_id&&!horseIds.has(String(entry.horse_id))){
          throw new Error(`horse master missing for ${date}: ${entry.horse_id}`);
        }
      }
    }
    continue;
  }

  if(noMeeting){
    if(noMeeting.status!=="CONFIRMED_NO_JRA")throw new Error(`non-meeting day not confirmed: ${date}`);
    if((noMeeting.request_delay_ms??0)<1500)throw new Error(`unsafe request delay for non-meeting day ${date}: ${noMeeting.request_delay_ms}`);
    if(noMeeting.policy!=="JRA_ZERO_PLUS_NETKEIBA_ZERO_OR_TWO_DISTINCT_NETKEIBA_ZERO"){
      throw new Error(`unknown non-meeting confirmation policy for ${date}`);
    }
    const confirmations=Array.isArray(noMeeting.confirmations)?noMeeting.confirmations:[];
    const distinctUrls=new Set(confirmations.map(item=>String(item.url??"")).filter(Boolean));
    if(confirmations.length<2||distinctUrls.size<2){
      throw new Error(`insufficient non-meeting confirmations for ${date}`);
    }
    for(const item of confirmations){
      if(item.race_ids_found!==0)throw new Error(`non-zero confirmation in non-meeting ledger for ${date}`);
      if(Number(item.html_length??0)<1000)throw new Error(`weak non-meeting evidence for ${date}`);
    }
    if(!noMeeting.evidence_file)throw new Error(`non-meeting evidence file missing from manifest for ${date}`);
    const evidence=JSON.parse(await readFile(noMeeting.evidence_file,"utf8"));
    if(evidence.date!==date||evidence.confirmed!==true){
      throw new Error(`invalid non-meeting evidence file for ${date}`);
    }
    checkedNonMeetingDays++;
    continue;
  }

  throw new Error(`unaccounted calendar date in completed range: ${date}`);
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
  checkedNonMeetingDays,
  accountedCalendarDays:checkedDays+checkedNonMeetingDays,
  checkedRaces,
  checkedHorsePacks:currentHorsePacks.size,
  successfulHorsePacks,
  uniqueHorseMaster:horseIds.size
},null,2));
