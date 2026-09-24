import assert from "node:assert/strict";
import {
  SCHEDULE_CONTRACT_VERSION,SCHEDULE_SAFE_RACE_PACK_VERSION,
  cancellationEventFromMeeting,meetingKeyFromRaceId,parseJraMeetingScheduleText,rescheduleEventFromMeeting,
  rescheduleAppliesToRace,rescheduleEventFromRaceDates,rescheduleCoversScheduledDate,scheduleForRace,scheduleIntegrityEnabled,
  upsertRescheduleEvents,validateRaceOwnership,
} from "../src/schedule-integrity.mjs";

const venues={
  "札幌":"01","函館":"02","福島":"03","新潟":"04","東京":"05","中山":"06",
  "中京":"07","京都":"08","阪神":"09","小倉":"10",
};
const races=Array.from({length:12},(_,i)=>(i+1)+"レース").join(" ");

const sep21=[
  "4回中山7日",
  "中山競馬は台風のため中止。",
  "代替競馬は9月22日（休日・火曜）に実施。",
  "4回阪神7日",
  "レース番号",races,
].join(" ");
const day21=parseJraMeetingScheduleText(sep21,{
  year:2026,date:"2026-09-21",venueCodes:venues,
});
assert.equal(day21.raceIds.length,12);
assert(day21.raceIds.every(id=>id.startsWith("2026090407")));
const nakayama21=day21.meetings.find(m=>m.venue_code==="06");
assert.equal(nakayama21.status,"RESCHEDULED");
assert.equal(nakayama21.race_nos.length,0);
assert.equal(nakayama21.actual_date,"2026-09-22");

const cancelledOnly=parseJraMeetingScheduleText(
  "1回東京1日 東京競馬は降雪のため中止。",
  {year:2026,date:"2026-02-01",venueCodes:venues},
);
assert.equal(cancelledOnly.raceIds.length,0);
assert.equal(cancelledOnly.meetings[0].status,"CANCELLED");
assert.equal(cancellationEventFromMeeting(cancelledOnly.meetings[0]).status,"CANCELLED");

const partialCancellation=parseJraMeetingScheduleText(
  ["1回小倉6日","第4競走は中止。","レース番号","1レース 2レース 3レース 5レース 6レース 7レース 8レース 9レース 10レース 11レース 12レース"].join(" "),
  {year:2026,date:"2026-02-08",venueCodes:venues},
);
assert.equal(partialCancellation.meetings[0].status,"ACTIVE");
assert.equal(partialCancellation.raceIds.length,11);
assert.equal(cancellationEventFromMeeting(partialCancellation.meetings[0]),null);

const sep22=["4回中山7日","レース番号",races].join(" ");
const day22=parseJraMeetingScheduleText(sep22,{
  year:2026,date:"2026-09-22",venueCodes:venues,
});
assert.equal(day22.raceIds.length,12);
assert(day22.raceIds.every(id=>id.startsWith("2026060407")));

const event=rescheduleEventFromMeeting(nakayama21);
assert.equal(event.meeting_key,"2026060407");
const manifest={days:{},rescheduled_meetings:{}};
upsertRescheduleEvents(manifest,[event],"2026-09-21T12:00:00.000Z");
assert.equal(
  scheduleForRace(manifest,"202606040701","2026-09-22").scheduledDate,
  "2026-09-21",
);
assert.equal(
  scheduleForRace(manifest,"202606040701","2026-09-22").status,
  "RESCHEDULED",
);

const chained={days:{},rescheduled_meetings:{}};
upsertRescheduleEvents(chained,[{
  meeting_key:"2026080204",venue_code:"08",meeting_no:2,meeting_day:4,
  scheduled_date:"2026-02-09",actual_date:"2026-02-10",status:"RESCHEDULED",source:"JRA_SCHEDULE",
}],"2026-02-09T00:00:00.000Z");
upsertRescheduleEvents(chained,[{
  meeting_key:"2026080204",venue_code:"08",meeting_no:2,meeting_day:4,
  scheduled_date:"2026-02-08",actual_date:"2026-02-09",status:"RESCHEDULED",source:"JRA_SCHEDULE",
}],"2026-02-08T00:00:00.000Z");
const chainedEvent=chained.rescheduled_meetings["2026080204"];
assert.equal(chainedEvent.scheduled_date,"2026-02-08");
assert.equal(chainedEvent.actual_date,"2026-02-10");
assert.equal(rescheduleCoversScheduledDate(chainedEvent,"2026-02-08"),true);
assert.equal(rescheduleCoversScheduledDate(chainedEvent,"2026-02-09"),true);
assert.equal(rescheduleCoversScheduledDate(chainedEvent,"2026-02-10"),false);

const partialManifest={days:{},rescheduled_meetings:{}};
for(let raceNo=3;raceNo<=12;raceNo+=1){
  const raceId="2020060302"+String(raceNo).padStart(2,"0");
  upsertRescheduleEvents(partialManifest,[
    rescheduleEventFromRaceDates(raceId,"2020-03-29","2020-03-31"),
  ],"2020-03-31T00:00:00.000Z");
}
const partialEvent=partialManifest.rescheduled_meetings["2020060302"];
assert.equal(partialEvent.scope,"PARTIAL");
assert.deepEqual(partialEvent.race_nos,[3,4,5,6,7,8,9,10,11,12]);
assert.equal(rescheduleAppliesToRace(partialEvent,"202006030201"),false);
assert.equal(rescheduleAppliesToRace(partialEvent,"202006030203"),true);
assert.deepEqual(
  scheduleForRace(partialManifest,"202006030201","2020-03-29"),
  {scheduledDate:"2020-03-29",status:"ACTIVE"},
);
assert.deepEqual(
  scheduleForRace(partialManifest,"202006030203","2020-03-31"),
  {scheduledDate:"2020-03-29",status:"RESCHEDULED"},
);

const partialMeetingText=[
  "3回中山2日",
  "1レース 2レース",
  "中山競馬は第3レース以降を中止。",
  "代替競馬は3月31日に実施。",
].join(" ");
const partialMeeting=parseJraMeetingScheduleText(partialMeetingText,{
  year:2020,date:"2020-03-29",venueCodes:venues,
});
assert.equal(partialMeeting.meetings[0].status,"ACTIVE");
assert.deepEqual(partialMeeting.meetings[0].race_nos,[1,2]);
assert.equal(rescheduleEventFromMeeting(partialMeeting.meetings[0]),null);

const inferred=rescheduleEventFromRaceDates(
  "202606040701","2026-09-21","2026-09-22",
);
assert.equal(inferred.meeting_key,event.meeting_key);

const valid={
  race_pack_version:SCHEDULE_SAFE_RACE_PACK_VERSION,
  schedule_contract_version:SCHEDULE_CONTRACT_VERSION,
  race:{
    race_id:"202606040701",
    scheduled_date:"2026-09-21",
    actual_date:"2026-09-22",
  },
};
assert.equal(validateRaceOwnership(valid,"2026-09-22"),true);
assert.throws(()=>validateRaceOwnership(valid,"2026-09-21"),/owner date mismatch/);
assert.equal(meetingKeyFromRaceId("202606040701"),"2026060407");

assert.equal(scheduleIntegrityEnabled({GITHUB_ACTIONS:"true"}),false);
assert.equal(scheduleIntegrityEnabled({
  GITHUB_ACTIONS:"true",SCHEDULE_INTEGRITY_V2:"1",
}),true);
assert.equal(scheduleIntegrityEnabled({}),true);

console.log("schedule integrity smoke passed");
