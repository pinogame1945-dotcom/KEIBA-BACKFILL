import assert from "node:assert/strict";
import {
  normalizePayoutRows,PAYOUT_PARSER_VERSION,RACE_PACK_VERSION,
} from "../src/payout-normalization.mjs";

assert.equal(RACE_PACK_VERSION,2);
assert.equal(PAYOUT_PARSER_VERSION,2);

function rows(betType,combinationLines,amountLines,popularityLines=[]){
  return normalizePayoutRows({
    raceId:"202609090101",
    betType,
    combinationLines,
    amountLines,
    popularityLines,
  });
}

assert.deepEqual(
  rows("WIN",["4"],["580円"],["2人気"]),
  [{race_id:"202609090101",bet_type:"WIN",combination:"4",payout_yen:580,popularity:2}],
);

assert.deepEqual(
  rows("PLACE",["4","8","15"],["210円","180円","350円"],["1人気","2人気","5人気"]).map(x=>[x.combination,x.payout_yen]),
  [["4",210],["8",180],["15",350]],
);

assert.deepEqual(
  rows("BRACKET_QUINELLA",["3","5"],["370円","370円"],["2人気","2人気"]),
  [{race_id:"202609090101",bet_type:"BRACKET_QUINELLA",combination:"3-5",payout_yen:370,popularity:2}],
);

assert.deepEqual(
  rows("QUINELLA",["4","8"],["410円","410円"],["2人気","2人気"]),
  [{race_id:"202609090101",bet_type:"QUINELLA",combination:"4-8",payout_yen:410,popularity:2}],
);

assert.deepEqual(
  rows(
    "WIDE",
    ["4","8","8","15","4","15"],
    ["210円","350円","750円"],
    ["1人気","3人気","7人気"],
  ).map(x=>[x.combination,x.payout_yen,x.popularity]),
  [["4-8",210,1],["8-15",350,3],["4-15",750,7]],
);

assert.deepEqual(
  rows("EXACTA",["8","4"],["820円"],["3人気"]).map(x=>[x.combination,x.payout_yen]),
  [["8→4",820]],
);

assert.deepEqual(
  rows("TRIO",["4","8","15"],["1260円"],["4人気"]).map(x=>[x.combination,x.payout_yen]),
  [["4-8-15",1260]],
);

assert.deepEqual(
  rows("TRIFECTA",["8","4","15"],["4980円"],["12人気"]).map(x=>[x.combination,x.payout_yen]),
  [["8→4→15",4980]],
);

assert.deepEqual(
  rows(
    "WIDE",
    ["4 - 8","8 - 15","4 - 15"],
    ["210円","350円","750円"],
  ).map(x=>x.combination),
  ["4-8","8-15","4-15"],
);

assert.throws(
  ()=>rows("QUINELLA",["4","8","15"],["410円"]),
  /arity mismatch/,
);

console.log(JSON.stringify({
  ok:true,
  racePackVersion:RACE_PACK_VERSION,
  payoutParserVersion:PAYOUT_PARSER_VERSION,
  covered:["WIN","PLACE","BRACKET_QUINELLA","QUINELLA","WIDE","EXACTA","TRIO","TRIFECTA"],
},null,2));
