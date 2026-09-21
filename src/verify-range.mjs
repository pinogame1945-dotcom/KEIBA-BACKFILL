import {readFile} from "node:fs/promises";
import {gunzipSync} from "node:zlib";
import {
  SCHEDULE_CONTRACT_VERSION,SCHEDULE_SAFE_RACE_PACK_VERSION,
  meetingKeyFromRaceId,scheduleIntegrityEnabled,validateRaceOwnership,
} from "./schedule-integrity.mjs";
import {RESULT_PARSER_VERSION} from "./result-columns.mjs";
import {LAP_PARSER_VERSION,expectedLapSegments} from "./lap-parser.mjs";
import {flatLast3fDayQuality,raceFlatLast3fQuality} from "./result-quality.mjs";

const [startDate,endDate]=process.argv.slice(2);
const dateRe=/^\d{4}-\d{2}-\d{2}$/;
if(!dateRe.test(startDate??"")||!dateRe.test(endDate??""))throw new Error("usage: node src/verify-range.mjs START_DATE END_DATE");
if(startDate<endDate)throw new Error("start_date must be newest and >= end_date");

const manifest=JSON.parse(await readFile("data/manifest.json","utf8"));
if(Number(manifest.race_pack_version??1)<2)throw new Error("manifest race_pack_version must be >=2");
if(Number(manifest.payout_parser_version??1)<2)throw new Error("manifest payout_parser_version must be >=2");
const scheduleIntegrity=scheduleIntegrityEnabled();
const payoutArity={
  WIN:1,PLACE:1,BRACKET_QUINELLA:2,QUINELLA:2,WIDE:2,EXACTA:2,TRIO:3,TRIFECTA:3
};
const horseIds=new Set();
const horseIdsByParserVersion=new Map();
const dayRowsCache=new Map();
let successfulHorsePacks=0;
if(scheduleIntegrity){
  for(const [key,event] of Object.entries(manifest.rescheduled_meetings??{})){
    if(!/^\d{10}$/.test(key))throw new Error("invalid rescheduled meeting key: "+key);
    if(event?.status!=="RESCHEDULED")throw new Error("invalid rescheduled meeting status: "+key);
    const scheduled=String(event?.scheduled_date??"");
    const actual=String(event?.actual_date??"");
    if(!dateRe.test(scheduled)||!dateRe.test(actual)||scheduled>=actual){
      throw new Error("invalid reschedule dates: "+key+" "+scheduled+" -> "+actual);
    }

    const scheduledEntry=manifest.days?.[scheduled];
    if(scheduledEntry?.file){
      let rows=dayRowsCache.get(scheduled);
      if(!rows){
        const text=gunzipSync(await readFile(scheduledEntry.file)).toString("utf8").trim();
        rows=text?text.split("\n").map(JSON.parse):[];
        dayRowsCache.set(scheduled,rows);
      }
      if(rows.some(row=>meetingKeyFromRaceId(row?.race?.race_id)===key)){
        throw new Error("rescheduled meeting still owned by scheduled day: "+key+" / "+scheduled);
      }
    }

    const actualEntry=manifest.days?.[actual];
    if(actualEntry?.file){
      let rows=dayRowsCache.get(actual);
      if(!rows){
        const text=gunzipSync(await readFile(actualEntry.file)).toString("utf8").trim();
        rows=text?text.split("\n").map(JSON.parse):[];
        dayRowsCache.set(actual,rows);
      }
      const moved=rows.filter(row=>meetingKeyFromRaceId(row?.race?.race_id)===key);
      if(!moved.length){
        throw new Error("rescheduled meeting missing from actual day: "+key+" / "+actual);
      }
      for(const row of moved){
        if(
          String(row?.race?.actual_date??"")!==actual||
          String(row?.race?.scheduled_date??"")!==scheduled
        ){
          throw new Error("rescheduled race dates disagree with ledger: "+String(row?.race?.race_id??""));
        }
      }
    }
  }
  for(const [key,event] of Object.entries(manifest.cancelled_meetings??{})){
    if(!/^\d{10}$/.test(key))throw new Error("invalid cancelled meeting key: "+key);
    if(event?.status!=="CANCELLED")throw new Error("invalid cancelled meeting status: "+key);
    const scheduled=String(event?.scheduled_date??"");
    if(!dateRe.test(scheduled)||event?.actual_date!=null){
      throw new Error("invalid cancelled meeting dates: "+key+" / "+scheduled);
    }
    const scheduledEntry=manifest.days?.[scheduled];
    if(scheduledEntry?.file){
      let rows=dayRowsCache.get(scheduled);
      if(!rows){
        const text=gunzipSync(await readFile(scheduledEntry.file)).toString("utf8").trim();
        rows=text?text.split("\n").map(JSON.parse):[];
        dayRowsCache.set(scheduled,rows);
      }
      if(rows.some(row=>meetingKeyFromRaceId(row?.race?.race_id)===key)){
        throw new Error("cancelled meeting still present in race pack: "+key+" / "+scheduled);
      }
    }
  }
}

for(const [packName,pack] of Object.entries(manifest.horse_packs??{})){
  if(pack.status!=="SUCCESS")continue;
  successfulHorsePacks++;
  if((pack.request_delay_ms??0)<1500)throw new Error(`unsafe request delay in ${packName}: ${pack.request_delay_ms}`);
  const horsePackVersion=Number(pack.horse_pack_version??1);
  const parserVersion=Number(pack.pedigree_parser_version??1);
  if(horsePackVersion<2||parserVersion<2)continue;
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
let checkedScheduleExceptionDays=0;
let checkedRaces=0;
const currentHorsePacks=new Set();
const raceOwners=new Map();

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
  const scheduleException=manifest.schedule_exception_days?.[date];

  const classifications=[day,noMeeting,scheduleException].filter(Boolean).length;
  if(classifications>1){
    throw new Error(`conflicting day classification for ${date}`);
  }

  if(day){
    if(day.status!=="SUCCESS")throw new Error(`day not SUCCESS: ${date}`);
    if(Number(day.race_pack_version??1)<2)throw new Error(`legacy race pack in completed range: ${date}`);
    if(Number(day.payout_parser_version??1)<2)throw new Error(`legacy payout parser in completed range: ${date}`);
    if(Number(day.result_parser_version??1)<RESULT_PARSER_VERSION){
      throw new Error(`legacy result parser in completed range: ${date}`);
    }
    if(Number(day.lap_parser_version??1)<LAP_PARSER_VERSION){
      throw new Error(`legacy lap parser in completed range: ${date}`);
    }
    if(scheduleIntegrity){
      if(Number(day.race_pack_version??0)<SCHEDULE_SAFE_RACE_PACK_VERSION){
        throw new Error(`schedule-safe race pack version missing: ${date}`);
      }
      if(Number(day.schedule_contract_version??0)<SCHEDULE_CONTRACT_VERSION){
        throw new Error(`schedule contract missing: ${date}`);
      }
    }
    if((day.request_delay_ms??0)<1500)throw new Error(`unsafe request delay for day ${date}: ${day.request_delay_ms}`);
    const text=gunzipSync(await readFile(day.file)).toString("utf8").trim();
    const rows=text?text.split("\n").map(JSON.parse):[];
    if(rows.length!==day.races_parsed)throw new Error(`daily race count mismatch ${date}`);
    const flatLast3f=flatLast3fDayQuality(rows);
    if(flatLast3f.timedResults>=8&&flatLast3f.finishTimeCoverage>=0.8&&flatLast3f.last3fCoverage<0.9){
      throw new Error(`last3f coverage below contract: ${date} / scope=FLAT / ${Number((flatLast3f.last3fCoverage*100).toFixed(1))}%`);
    }
    if(flatLast3f.suspicious>0){
      throw new Error(`suspicious flat last3f rows in completed range: ${date} / ${flatLast3f.suspicious}`);
    }
    if(day.result_quality?.last3f_scope==="FLAT"){
      const manifestCoverage=Number(day.result_quality?.last3f_coverage_pct??0);
      const recomputedCoverage=Number((flatLast3f.last3fCoverage*100).toFixed(1));
      if(manifestCoverage!==recomputedCoverage){
        throw new Error(`manifest/recomputed flat last3f coverage mismatch: ${date} / ${manifestCoverage}% != ${recomputedCoverage}%`);
      }
      const manifestSuspicious=Number(day.result_quality?.last3f_suspicious??0);
      if(manifestSuspicious!==flatLast3f.suspicious){
        throw new Error(`manifest/recomputed flat last3f suspicious mismatch: ${date} / ${manifestSuspicious} != ${flatLast3f.suspicious}`);
      }
    }
    dayRowsCache.set(date,rows);
    checkedDays++;
    checkedRaces+=rows.length;
    for(const row of rows){
      if(!row?.race?.race_id)throw new Error(`missing race_id in ${date}`);
      if(Number(row.race_pack_version??1)<2)throw new Error(`legacy race row ${row.race.race_id}`);
      if(scheduleIntegrity){
        if(Number(row.race_pack_version??0)<SCHEDULE_SAFE_RACE_PACK_VERSION){
          throw new Error(`schedule-safe race row version missing ${row.race.race_id}`);
        }
        if(Number(row.schedule_contract_version??0)<SCHEDULE_CONTRACT_VERSION){
          throw new Error(`race row schedule contract missing ${row.race.race_id}`);
        }
        validateRaceOwnership(row,date);
        const raceId=String(row.race.race_id);
        const priorOwner=raceOwners.get(raceId);
        if(priorOwner&&priorOwner!==date){
          throw new Error(`cross-day duplicate race_id ${raceId}: ${priorOwner} / ${date}`);
        }
        raceOwners.set(raceId,date);
        const actualDate=String(row.race.actual_date);
        const scheduledDate=String(row.race.scheduled_date??actualDate);
        if(scheduledDate<actualDate){
          const key=meetingKeyFromRaceId(raceId);
          const event=key?manifest.rescheduled_meetings?.[key]:null;
          if(
            !event||
            event.status!=="RESCHEDULED"||
            event.scheduled_date!==scheduledDate||
            event.actual_date!==actualDate
          ){
            throw new Error(`missing reschedule ledger for ${raceId}: ${scheduledDate} -> ${actualDate}`);
          }
        }
      }
      if(Number(row.payout_parser_version??1)<2)throw new Error(`legacy payout row ${row.race.race_id}`);
      if(Number(row.result_parser_version??1)<RESULT_PARSER_VERSION){
        throw new Error(`legacy result parser row ${row.race.race_id}`);
      }
      if(Number(row.lap_parser_version??1)<LAP_PARSER_VERSION){
        throw new Error(`legacy lap parser row ${row.race.race_id}`);
      }
      if(!Array.isArray(row.entries)||!Array.isArray(row.results)||!Array.isArray(row.payouts)||!Array.isArray(row.laps)){
        throw new Error(`invalid race arrays ${row.race.race_id}`);
      }
      if(row.race?.discipline==="FLAT"){
        const expected=expectedLapSegments(row.race?.distance_m);
        if(expected>0&&row.laps.length!==expected){
          throw new Error(`incomplete flat laps ${row.race.race_id}: ${row.laps.length}/${expected}`);
        }
      }
      const last3fQuality=raceFlatLast3fQuality(row);
      if(last3fQuality.eligible&&last3fQuality.timed>=8&&last3fQuality.bad/last3fQuality.timed>0.1){
        throw new Error(`last3f row quality below contract ${row.race.race_id}: scope=FLAT bad=${last3fQuality.bad}/${last3fQuality.timed}`);
      }
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

  if(scheduleException){
    if(!scheduleIntegrity){
      throw new Error(`schedule-exception date requires schedule integrity: ${date}`);
    }
    if(scheduleException.status!=="NO_RACES_HELD"){
      throw new Error(`unknown schedule exception day status: ${date}`);
    }
    if(Number(scheduleException.schedule_contract_version??0)<SCHEDULE_CONTRACT_VERSION){
      throw new Error(`schedule exception contract missing: ${date}`);
    }
    const moved=Array.isArray(scheduleException.rescheduled_meetings)
      ?scheduleException.rescheduled_meetings:[];
    const cancelled=Array.isArray(scheduleException.cancelled_meetings)
      ?scheduleException.cancelled_meetings:[];
    if(!moved.length&&!cancelled.length){
      throw new Error(`schedule exception day has no meeting evidence: ${date}`);
    }
    for(const key of moved){
      const event=manifest.rescheduled_meetings?.[key];
      if(
        !event||event.status!=="RESCHEDULED"||
        event.scheduled_date!==date||!event.actual_date
      ){
        throw new Error(`invalid rescheduled ledger ${date} / ${key}`);
      }
    }
    for(const key of cancelled){
      const event=manifest.cancelled_meetings?.[key];
      if(
        !event||event.status!=="CANCELLED"||
        event.scheduled_date!==date||event.actual_date!=null
      ){
        throw new Error(`invalid cancelled ledger ${date} / ${key}`);
      }
    }
    checkedScheduleExceptionDays++;
    continue;
  }

  throw new Error(`unaccounted calendar date in completed range: ${date}`);
}

for(const [packName,pack] of Object.entries(manifest.horse_packs??{})){
  if(pack.status!=="SUCCESS")continue;
  const inRange=(pack.source_dates??[]).some(date=>date<=startDate&&date>=endDate);
  if(!inRange)continue;
  currentHorsePacks.add(packName);
  const repairOnly=pack.repair_from_pedigree_parser_v1===true;
  const packHorseVersion=Number(pack.horse_pack_version??1);
  const packPedigreeVersion=Number(pack.pedigree_parser_version??1);
  if(repairOnly&&(packHorseVersion<2||packPedigreeVersion<2)){
    throw new Error(`invalid pedigree repair pack contract ${packName}: horse_pack_version=${packHorseVersion} pedigree_parser_version=${packPedigreeVersion}`);
  }
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
    if(repairOnly){
      if(Number(row.horse_pack_version??0)<2||Number(row.pedigree_parser_version??0)<2){
        throw new Error(`invalid pedigree repair row version ${packName}: ${id}`);
      }
      if(row.profile!==null){
        throw new Error(`pedigree repair row must not contain profile data ${packName}: ${id}`);
      }
    }else if(!row.profile?.horse_name){
      throw new Error(`horse name missing: ${id}`);
    }
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
  checkedScheduleExceptionDays,
  accountedCalendarDays:checkedDays+checkedNonMeetingDays+checkedScheduleExceptionDays,
  checkedRaces,
  checkedHorsePacks:currentHorsePacks.size,
  successfulHorsePacks,
  uniqueHorseMaster:horseIds.size
},null,2));