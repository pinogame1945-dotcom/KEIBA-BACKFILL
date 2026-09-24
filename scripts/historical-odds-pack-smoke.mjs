import assert from "node:assert/strict";
import {
  archiveHistoricalOddsPayload,finalOddsTuple,nonFinalHistoricalOddsStatus,parseNetkeibaOddsResponse,summarizeOddsGroups,
} from "../src/historical-odds-pack.mjs";

assert.deepEqual(
  finalOddsTuple(["980.9","0.0","274","251.1","0.0","72"]),
  ["251.1","0.0","72"],
);
assert.deepEqual(finalOddsTuple(["176.7","0.0","30"]),["176.7","0.0","30"]);

const payload={
  status:"result",
  data:{
    official_datetime:"2010-11-26 14:00:02",
    odds:{
      "1":{"06":["134.4","0.0","3","8.8","0.0","4"]},
      "2":{"06":["1.3","2.8","4","1.9","3.4","2"]},
      "3":{"0308":["0.0","0.0","9999","6.9","0.0","3"]},
      "4":{"0616":["5.0","0.0","1","7.1","0.0","1"]},
      "5":{"0616":["1.6","2.1","4","2.8","3.1","1"]},
      "6":{"0616":["514.4","0.0","59","18.8","0.0","7"]},
      "7":{"020616":["0.0","0.0","9999","49.4","0.0","14"]},
      "8":{"061602":["980.9","0.0","274","251.1","0.0","72"]},
    },
  },
};

const summary=summarizeOddsGroups(payload.data.odds);
assert.deepEqual(Object.keys(summary).sort(),["1","2","3","4","5","6","7","8"]);
for(const group of Object.values(summary)){
  assert.equal(group.status,"PRICED");
  assert.equal(group.invalid_shapes,0);
}

const archived=archiveHistoricalOddsPayload({
  raceId:"201005050810",
  payload,
  sourceUrl:"https://race.netkeiba.com/api/api_get_jra_odds.html",
  fetchedAt:"2026-09-21T00:00:00.000Z",
  actualDate:"2010-11-27",
  scheduledDate:"2010-11-26",
  scheduleContractVersion:1,
});
assert.equal(archived.odds_pack_version,1);
assert.equal(archived.decoder_contract_version,1);
assert.equal(archived.odds["8"]["061602"][3],"251.1");
assert.equal(archived.group_summary["8"].priced_rows,1);
assert.equal(archived.actual_date,"2010-11-27");
assert.equal(archived.scheduled_date,"2010-11-26");
assert.equal(archived.schedule_contract_version,1);

const parsed=parseNetkeibaOddsResponse(JSON.stringify(payload));
assert.equal(parsed.status,"result");
const jsonp=parseNetkeibaOddsResponse("callback("+JSON.stringify(payload)+");");
assert.equal(jsonp.data.odds["4"]["0616"][3],"7.1");
assert.equal(nonFinalHistoricalOddsStatus({status:"result"}),null);
assert.equal(nonFinalHistoricalOddsStatus({status:"yoso"}),"yoso");
assert.equal(nonFinalHistoricalOddsStatus({status:"middle"}),"middle");
assert.equal(nonFinalHistoricalOddsStatus({}),null);

assert.throws(()=>archiveHistoricalOddsPayload({
  raceId:"201005050810",
  payload:{status:"middle",data:{odds:payload.data.odds}},
  sourceUrl:null,
}));

console.log("historical odds pack smoke passed");
