import assert from "node:assert/strict";
import {
  addUtcDays,lastEligibleJstDate,planForwardDates,validDate
} from "../src/forward-backfill-plan.mjs";

assert.equal(validDate("2026-10-15"),true);
assert.equal(validDate("2026-02-30"),false);
assert.equal(validDate("2026-1-15"),false);
assert.equal(addUtcDays("2026-09-30",1),"2026-10-01");
assert.equal(lastEligibleJstDate(Date.parse("2026-10-15T02:00:00Z")),"2026-10-14");
assert.equal(lastEligibleJstDate(Date.parse("2026-10-14T14:30:00Z")),"2026-10-13");

const raceManifest={
  days:{
    "2026-09-19":{status:"SUCCESS",file:"data/daily/2026-09-19.jsonl.gz"},
    "2026-09-20":{status:"SUCCESS",file:"data/daily/2026-09-20.jsonl.gz"},
  },
  non_meeting_days:{"2026-09-21":{status:"CONFIRMED_NO_JRA"}},
  schedule_exception_days:{"2026-09-22":{status:"NO_RACES_HELD"}},
};
const oddsManifest={days:{
  "2026-09-19":{status:"SUCCESS"},
  "2026-09-20":{status:"SOURCE_UNAVAILABLE"},
}};
const params={raceManifest,oddsManifest,from:"2026-09-19",through:"2026-09-24",cutoff:"2026-10-14"};
const plan=planForwardDates({...params,maxDates:2});
assert.equal(plan.scanned_days,6);
assert.equal(plan.pending_total,3);
assert.equal(plan.remaining_after_batch,1);
assert.deepEqual(plan.selected,[
  {date:"2026-09-20",needs_race:false,needs_odds:true},
  {date:"2026-09-23",needs_race:true,needs_odds:true},
]);
assert.deepEqual(planForwardDates({...params,maxDates:60}).selected[2],
  {date:"2026-09-24",needs_race:true,needs_odds:true});
assert.equal(planForwardDates({...params,from:"2026-09-21",through:"2026-09-22"}).pending_total,0);
assert.throws(()=>planForwardDates({...params,through:"2026-10-15"}),/future date/);
assert.throws(()=>planForwardDates({...params,maxDates:91}),/maxDates/);
assert.throws(()=>planForwardDates({
  ...params,raceManifest:{days:{"2026-09-20":{status:"PARTIAL"}}}
}),/unexpected race manifest status/);
assert.throws(()=>planForwardDates({
  ...params,raceManifest:{days:{"2026-09-21":{status:"SUCCESS"}},non_meeting_days:raceManifest.non_meeting_days}
}),/conflicting race and non-meeting state/);

console.log("forward-backfill-plan smoke: PASS (JST cutoff, gaps, odds retry, no-meeting, limits)");
