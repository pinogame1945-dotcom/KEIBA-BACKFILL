export const SCHEDULE_CONTRACT_VERSION=1;
export const SCHEDULE_SAFE_RACE_PACK_VERSION=3;

export function scheduleIntegrityEnabled(env=process.env){
  return env.SCHEDULE_INTEGRITY_V2==="1"||env.GITHUB_ACTIONS!=="true";
}

export function meetingKey(year,venueCode,meetingNo,dayNo){
  return String(year)+String(venueCode).padStart(2,"0")+
    String(meetingNo).padStart(2,"0")+String(dayNo).padStart(2,"0");
}

export function meetingKeyFromRaceId(raceId){
  const value=String(raceId??"");
  return /^\d{12}$/.test(value)?value.slice(0,10):null;
}

function isoFromMonthDay(year,month,day,scheduledDate){
  let y=Number(year);
  const scheduledMonth=Number(String(scheduledDate).slice(5,7));
  if(scheduledMonth>=11&&Number(month)<=2)y+=1;
  return String(y).padStart(4,"0")+"-"+String(Number(month)).padStart(2,"0")+"-"+String(Number(day)).padStart(2,"0");
}

export function parseJraMeetingScheduleText(text,{year,date,venueCodes}){
  const headingRe=/(\d+)回(札幌|函館|福島|新潟|東京|中山|中京|京都|阪神|小倉)(\d+)日/g;
  const matches=[...String(text??"").matchAll(headingRe)];
  const seen=new Set();
  const meetings=[];
  const raceIds=[];
  for(let i=0;i<matches.length;i+=1){
    const m=matches[i];
    const meetingNo=Number(m[1]);
    const venueName=m[2];
    const dayNo=Number(m[3]);
    const venueCode=venueCodes[venueName];
    if(!venueCode)continue;
    const key=meetingKey(year,venueCode,meetingNo,dayNo);
    if(seen.has(key))continue;
    seen.add(key);
    const start=m.index??0;
    const end=i+1<matches.length?(matches[i+1].index??String(text).length):String(text).length;
    const chunk=String(text).slice(start,end);
    const raceNos=[...new Set(
      [...chunk.matchAll(/(?:^|[^\d第])(\d{1,2})レース/g)]
        .map(x=>Number(x[1]))
        .filter(n=>n>=1&&n<=12)
    )].sort((a,b)=>a-b);
    const moved=chunk.match(/(?:代替競馬|代替開催|代替)[\s\S]{0,80}?(\d{1,2})月\s*(\d{1,2})日/);
    // A meeting can be only partially moved while some races are held as planned.
    // Meeting-level RESCHEDULED is safe only when no race numbers remain on the
    // scheduled day. Partial moves are inferred race-by-race from result dates.
    const cancelled=/中止|延期|取りやめ/.test(chunk);
    const wholeMeetingCancelled=cancelled&&raceNos.length===0&&!moved;
    const wholeMeetingRescheduled=Boolean(moved)&&raceNos.length===0;
    const actualDate=wholeMeetingRescheduled
      ?isoFromMonthDay(year,moved[1],moved[2],date)
      :(wholeMeetingCancelled?null:date);
    const status=wholeMeetingRescheduled
      ?"RESCHEDULED"
      :raceNos.length?"ACTIVE":wholeMeetingCancelled?"CANCELLED":"UNKNOWN";
    const meeting={
      meeting_key:key,venue_name:venueName,venue_code:venueCode,
      meeting_no:meetingNo,day_no:dayNo,race_nos:raceNos,
      scheduled_date:date,actual_date:actualDate,status,
    };
    meetings.push(meeting);
    if(status==="ACTIVE"){
      for(const raceNo of raceNos){
        raceIds.push(key+String(raceNo).padStart(2,"0"));
      }
    }
  }
  return {raceIds:[...new Set(raceIds)].sort(),meetings};
}

export function cancellationEventFromMeeting(meeting,source="JRA_SCHEDULE"){
  if(meeting?.status!=="CANCELLED")return null;
  return {
    meeting_key:meeting.meeting_key,
    venue_code:meeting.venue_code,
    meeting_no:meeting.meeting_no,
    meeting_day:meeting.day_no,
    scheduled_date:meeting.scheduled_date,
    actual_date:null,
    status:"CANCELLED",
    source,
  };
}

export function rescheduleEventFromMeeting(meeting,source="JRA_SCHEDULE"){
  if(meeting?.status!=="RESCHEDULED"||!meeting.actual_date)return null;
  return {
    meeting_key:meeting.meeting_key,
    venue_code:meeting.venue_code,
    meeting_no:meeting.meeting_no,
    meeting_day:meeting.day_no,
    scheduled_date:meeting.scheduled_date,
    actual_date:meeting.actual_date,
    status:"RESCHEDULED",
    scope:"FULL",
    source,
  };
}

export function rescheduleEventFromRaceDates(raceId,scheduledDate,actualDate,source="RESULT_DATE_MISMATCH"){
  const key=meetingKeyFromRaceId(raceId);
  const raceNo=Number(String(raceId??"").slice(10,12));
  if(
    !key||!actualDate||actualDate===scheduledDate||
    !Number.isInteger(raceNo)||raceNo<1||raceNo>12
  )return null;
  return {
    meeting_key:key,
    venue_code:raceId.slice(4,6),
    meeting_no:Number(raceId.slice(6,8)),
    meeting_day:Number(raceId.slice(8,10)),
    scheduled_date:scheduledDate,
    actual_date:actualDate,
    status:"RESCHEDULED",
    scope:"PARTIAL",
    race_nos:[raceNo],
    source,
  };
}

function normalizedRescheduleScope(event){
  return event?.scope==="PARTIAL"||Array.isArray(event?.race_nos)?"PARTIAL":"FULL";
}

function normalizedRescheduleRaceNos(event){
  return [...new Set(
    (Array.isArray(event?.race_nos)?event.race_nos:[])
      .map(Number)
      .filter(n=>Number.isInteger(n)&&n>=1&&n<=12)
  )].sort((a,b)=>a-b);
}

export function rescheduleAppliesToRace(event,raceId){
  if(event?.status!=="RESCHEDULED")return false;
  if(normalizedRescheduleScope(event)==="FULL")return true;
  const value=String(raceId??"");
  if(!/^\d{12}$/.test(value))return false;
  return normalizedRescheduleRaceNos(event).includes(Number(value.slice(10,12)));
}

export function upsertRescheduleEvents(manifest,events,now=new Date().toISOString()){
  manifest.rescheduled_meetings??={};
  for(const event of events.filter(Boolean)){
    const current=manifest.rescheduled_meetings[event.meeting_key]??null;
    const incomingScope=normalizedRescheduleScope(event);
    const currentScope=current?normalizedRescheduleScope(current):null;
    if(
      current&&currentScope==="PARTIAL"&&incomingScope==="PARTIAL"&&
      (
        String(current.scheduled_date)!==String(event.scheduled_date)||
        String(current.actual_date)!==String(event.actual_date)
      )
    ){
      throw new Error(
        "AMBIGUOUS_PARTIAL_RESCHEDULE "+event.meeting_key+" "+
        String(current.scheduled_date)+"->"+String(current.actual_date)+" / "+
        String(event.scheduled_date)+"->"+String(event.actual_date)
      );
    }

    const scheduledDate=current?.scheduled_date&&current.scheduled_date<event.scheduled_date
      ?current.scheduled_date:event.scheduled_date;
    const actualDate=current?.actual_date&&current.actual_date>event.actual_date
      ?current.actual_date:event.actual_date;
    const history=Array.isArray(current?.history)?[...current.history]:[];
    const pair={
      scheduled_date:event.scheduled_date,
      actual_date:event.actual_date,
      source:event.source,
      scope:incomingScope,
      ...(incomingScope==="PARTIAL"?{race_nos:normalizedRescheduleRaceNos(event)}:{}),
    };
    if(!history.some(item=>
      item.scheduled_date===pair.scheduled_date&&
      item.actual_date===pair.actual_date&&
      item.source===pair.source&&
      normalizedRescheduleScope(item)===pair.scope&&
      JSON.stringify(normalizedRescheduleRaceNos(item))===JSON.stringify(normalizedRescheduleRaceNos(pair))
    ))history.push(pair);

    const scope=current
      ?(currentScope==="FULL"||incomingScope==="FULL"?"FULL":"PARTIAL")
      :incomingScope;
    const raceNos=scope==="PARTIAL"
      ?[...new Set([
          ...normalizedRescheduleRaceNos(current),
          ...normalizedRescheduleRaceNos(event),
        ])].sort((a,b)=>a-b)
      :[];

    manifest.rescheduled_meetings[event.meeting_key]={
      ...event,
      scheduled_date:scheduledDate,
      actual_date:actualDate,
      status:"RESCHEDULED",
      scope,
      ...(scope==="PARTIAL"?{race_nos:raceNos}:{}),
      history,
      updated_at:now,
    };
    if(scope==="FULL")delete manifest.rescheduled_meetings[event.meeting_key].race_nos;
  }
  return manifest;
}

export function rescheduleCoversScheduledDate(event,date){
  if(event?.status!=="RESCHEDULED")return false;
  const target=String(date??"");
  const finalActual=String(event?.actual_date??"");
  if(String(event?.scheduled_date??"")===target&&finalActual>target)return true;
  const history=Array.isArray(event?.history)?event.history:[];
  return history.some(step=>
    String(step?.scheduled_date??"")===target&&
    String(step?.actual_date??"")>target
  );
}

export function upsertCancellationEvents(manifest,events,now=new Date().toISOString()){
  manifest.cancelled_meetings??={};
  for(const event of events.filter(Boolean)){
    const current=manifest.cancelled_meetings[event.meeting_key]??null;
    manifest.cancelled_meetings[event.meeting_key]={
      ...(current??{}),...event,
      status:"CANCELLED",
      updated_at:now,
    };
  }
  return manifest;
}

export function scheduleForRace(manifest,raceId,actualDate){
  const key=meetingKeyFromRaceId(raceId);
  const event=key?manifest?.rescheduled_meetings?.[key]:null;
  if(
    event?.status==="RESCHEDULED"&&
    event.actual_date===actualDate&&
    rescheduleAppliesToRace(event,raceId)
  ){
    return {scheduledDate:event.scheduled_date,status:"RESCHEDULED"};
  }
  return {scheduledDate:actualDate,status:"ACTIVE"};
}

export function validateRaceOwnership(record,ownerDate){
  const raceId=String(record?.race?.race_id??"");
  const actualDate=String(record?.race?.actual_date??"");
  if(!/^\d{12}$/.test(raceId))throw new Error("invalid race id in schedule ownership");
  if(actualDate!==ownerDate){
    throw new Error("race owner date mismatch: "+ownerDate+" / "+raceId+" / "+actualDate);
  }
  const scheduled=record?.race?.scheduled_date==null?actualDate:String(record.race.scheduled_date);
  if(scheduled>actualDate){
    throw new Error("scheduled_date after actual_date: "+raceId+" / "+scheduled+" > "+actualDate);
  }
  return true;
}
