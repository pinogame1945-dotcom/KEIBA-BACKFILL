import assert from "node:assert/strict";
import {load} from "cheerio";
import {
  RACE_META_PARSER_VERSION,classifyRaceDiscipline,normalizeRaceMeta,
  selectRaceMeta,selectRaceMetaParts,summarizeRaceMetaCoverage,validateRaceMetaFields,
} from "../src/race-meta.mjs";

assert.equal(RACE_META_PARSER_VERSION,2);

const flatLive=load([
  "<html><body>",
  "<nav>平地・障害レース情報 / 障害特集</nav>",
  '<div class="RaceName">テスト平地競走</div>',
  '<div class="RaceData01">芝右 外1600m / 天候 : 晴 / 馬場 : 良 / 発走 : 15:00</div>',
  '<div class="RaceData02">3歳以上オープン (国際)(特指)(別定)</div>',
  "</body></html>",
].join(""));
const flatParts=selectRaceMetaParts(flatLive);
const flatMeta=selectRaceMeta(flatLive);
assert.equal(flatParts.course_meta_raw,"芝右 外1600m");
assert.equal(flatParts.race_condition_raw,"3歳以上オープン (国際)(特指)(別定)");
assert.match(flatMeta,/芝右 外1600m/);
assert.ok(!flatMeta.includes("障害特集"));
assert.equal(classifyRaceDiscipline(flatMeta,"テスト平地競走"),"FLAT");

assert.deepEqual(
  normalizeRaceMeta({...flatParts,race_name:"しらさぎステークス(GIII)"}),
  {
    course_layout:"OUTER",
    course_laps:null,
    course_meta_raw:"芝右 外1600m",
    race_class_raw:"3歳以上オープン",
    race_class_normalized:"OPEN",
    grade:"G3",
    age_condition_raw:"3歳以上",
    age_min:3,
    age_max:null,
    age_condition_type:"THREE_YEAR_PLUS",
    sex_condition_raw:null,
    sex_condition:"ANY",
    weight_rule_raw:"別定",
    weight_rule:"SPECIAL_WEIGHT",
    mixed:false,
    international:true,
    special_designated:true,
    designated:false,
    race_condition_raw:"3歳以上オープン (国際)(特指)(別定)",
    race_meta_raw:"芝右 外1600m / 天候 : 晴 / 馬場 : 良 / 発走 : 15:00 3歳以上オープン (国際)(特指)(別定)",
  },
);

const inner=normalizeRaceMeta({
  course_meta_raw:"芝右 内2000m",
  race_condition_raw:"3歳以上2勝クラス (定量)",
  race_meta_raw:"芝右 内2000m 3歳以上2勝クラス (定量)",
});
assert.equal(inner.course_layout,"INNER");
assert.equal(inner.course_laps,null);
assert.equal(inner.race_class_normalized,"TWO_WIN");
assert.equal(inner.weight_rule,"SET_WEIGHT");

const twoLaps=normalizeRaceMeta({
  course_meta_raw:"芝右 内2周3600m",
  race_condition_raw:"4歳以上オープン (別定)",
  race_meta_raw:"芝右 内2周3600m 4歳以上オープン (別定)",
});
assert.equal(twoLaps.course_layout,"INNER");
assert.equal(twoLaps.course_laps,2);

const normal=normalizeRaceMeta({
  course_meta_raw:"芝右1200m",
  race_condition_raw:"3歳以上1勝クラス (定量)",
  race_meta_raw:"芝右1200m 3歳以上1勝クラス (定量)",
});
assert.equal(normal.course_layout,"NORMAL");

const classes=[
  ["3歳新馬 (馬齢)","NEWCOMER","WEIGHT_FOR_AGE"],
  ["3歳未勝利 (馬齢)","MAIDEN","WEIGHT_FOR_AGE"],
  ["4歳以上500万下 (定量)","ONE_WIN","SET_WEIGHT"],
  ["4歳以上1000万下 (ハンデ)","TWO_WIN","HANDICAP"],
  ["4歳以上900万下 (別定)","TWO_WIN","SPECIAL_WEIGHT"],
  ["3歳以上1600万下 (定量)","THREE_WIN","SET_WEIGHT"],
  ["3歳以上オープン (別定)","OPEN","SPECIAL_WEIGHT"],
];
for(const [condition,expectedClass,expectedWeight] of classes){
  const meta=normalizeRaceMeta({
    course_meta_raw:"芝右1600m",
    race_condition_raw:condition,
    race_meta_raw:"芝右1600m "+condition,
  });
  assert.equal(meta.race_class_normalized,expectedClass,condition);
  assert.equal(meta.weight_rule,expectedWeight,condition);
  validateRaceMetaFields(meta);
}

const female=normalizeRaceMeta({
  course_meta_raw:"芝左1800m",
  race_condition_raw:"3歳以上2勝クラス 牝[指](定量)",
  race_meta_raw:"芝左1800m 3歳以上2勝クラス 牝[指](定量)",
});
assert.equal(female.sex_condition,"FEMALE_ONLY");
assert.equal(female.designated,true);

for(const [name,expected] of [
  ["天皇賞（秋）(GI)","G1"],
  ["京都記念(GⅡ)","G2"],
  ["テスト(G3)","G3"],
  ["交流重賞(JpnI)","JPN1"],
  ["交流重賞(JpnII)","JPN2"],
  ["交流重賞(JpnIII)","JPN3"],
  ["テストステークス(L)","L"],
]){
  const meta=normalizeRaceMeta({
    course_meta_raw:"芝右2000m",
    race_condition_raw:"3歳以上オープン (定量)",
    race_meta_raw:"芝右2000m 3歳以上オープン (定量)",
    race_name:name,
  });
  assert.equal(meta.grade,expected,name);
}

const legacy=load([
  "<html><body>",
  '<div class="data_intro">',
  "芝右 外1200m / 天候 : 曇 / 芝 : 良 / 発走 : 16:00 ",
  "2010年01月11日 1回中山4日目 4歳以上1000万下 (混)[指](定量)",
  "</div>",
  "</body></html>",
].join(""));
const legacyParts=selectRaceMetaParts(legacy);
assert.equal(legacyParts.course_meta_raw,"芝右 外1200m");
assert.match(legacyParts.race_condition_raw,/4歳以上1000万下/);
const legacyNormalized=normalizeRaceMeta({...legacyParts,race_name:"4歳以上1000万下"});
assert.equal(legacyNormalized.race_class_normalized,"TWO_WIN");
assert.equal(legacyNormalized.mixed,true);
assert.equal(legacyNormalized.designated,true);

const obstacleLive=load([
  "<html><body>",
  '<div class="RaceName">障害3歳以上未勝利</div>',
  '<div class="RaceData01">障芝2880m / 天候 : 晴 / 馬場 : 良 / 発走 : 11:35</div>',
  '<div class="RaceData02">障害3歳以上 未勝利</div>',
  "</body></html>",
].join(""));
assert.equal(
  classifyRaceDiscipline(selectRaceMeta(obstacleLive),"障害3歳以上未勝利"),
  "OBSTACLE",
);

const coverage=summarizeRaceMetaCoverage([
  {race:normalizeRaceMeta({
    course_meta_raw:"芝右1200m",
    race_condition_raw:"3歳以上1勝クラス (定量)",
    race_meta_raw:"芝右1200m 3歳以上1勝クラス (定量)",
  })},
  {race:normalizeRaceMeta({})},
]);
assert.equal(coverage.total_races,2);
assert.equal(coverage.course_layout.known,1);
assert.equal(coverage.course_layout.unknown,1);

console.log(JSON.stringify({
  ok:true,
  raceMetaParserVersion:RACE_META_PARSER_VERSION,
  covered:[
    "OUTER","INNER","NORMAL","2LAPS","HANDICAP","SPECIAL_WEIGHT","SET_WEIGHT",
    "WEIGHT_FOR_AGE","LEGACY_CLASSES","NEWCOMER","MAIDEN","OPEN","GRADE",
    "AGE","SEX","MIXED","INTERNATIONAL","SPECIAL_DESIGNATED","DESIGNATED","RAW",
  ],
},null,2));
