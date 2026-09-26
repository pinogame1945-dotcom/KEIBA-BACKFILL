import assert from "node:assert/strict";
import {
  MARGIN_PARSER_VERSION,normalizeMarginRaw,validateMarginFields,
} from "../src/margin-normalization.mjs";

assert.equal(MARGIN_PARSER_VERSION,1);

const cases=[
  ["",null,null],
  [null,null,null],
  ["2","LENGTHS",2],
  ["0.2","LENGTHS",0.2],
  ["1/2","LENGTHS",0.5],
  ["3/4","LENGTHS",0.75],
  ["1.1/2","LENGTHS",1.5],
  ["2 1/2","LENGTHS",2.5],
  ["1・1/4","LENGTHS",1.25],
  ["１．１／２","LENGTHS",1.5],
  ["ハナ","NOSE",null],
  ["アタマ","HEAD",null],
  ["クビ","NECK",null],
  ["大差","LARGE",null],
  ["同着","DEAD_HEAT",null],
  ["判定不能","OTHER",null],
];

for(const [raw,type,lengths] of cases){
  const normalized=normalizeMarginRaw(raw);
  assert.equal(normalized.margin_type,type,String(raw));
  assert.equal(normalized.margin_lengths,lengths,String(raw));
  validateMarginFields({...normalized});
}

assert.equal(normalizeMarginRaw("2/2").margin_type,"OTHER");
assert.equal(normalizeMarginRaw("1.2/2").margin_type,"OTHER");

console.log(JSON.stringify({
  ok:true,
  marginParserVersion:MARGIN_PARSER_VERSION,
  policy:"numeric lengths stay numeric; categorical margins stay categorical",
},null,2));
