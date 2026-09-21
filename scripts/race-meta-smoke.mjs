import assert from "node:assert/strict";
import {load} from "cheerio";
import {classifyRaceDiscipline,selectRaceMeta} from "../src/race-meta.mjs";

const flatLive=load(`
<html><body>
  <nav>平地・障害レース情報 / 障害特集</nav>
  <div class="RaceName">テスト平地競走</div>
  <div class="RaceData01">芝1600m / 天候 : 晴 / 馬場 : 良 / 発走 : 15:00</div>
  <div class="RaceData02">3歳以上 1勝クラス</div>
</body></html>
`);
const flatMeta=selectRaceMeta(flatLive);
assert.match(flatMeta,/芝1600m/);
assert.ok(!flatMeta.includes("障害特集"),"live meta must not fall back to polluted page text");
assert.equal(
  classifyRaceDiscipline(flatMeta,flatLive(".RaceName").first().text()),
  "FLAT",
  "navigation obstacle text must not turn a live flat race into OBSTACLE",
);

const obstacleLive=load(`
<html><body>
  <nav>平地レース情報</nav>
  <div class="RaceName">障害3歳以上未勝利</div>
  <div class="RaceData01">障芝2880m / 天候 : 晴 / 馬場 : 良 / 発走 : 11:35</div>
  <div class="RaceData02">障害3歳以上 未勝利</div>
</body></html>
`);
const obstacleMeta=selectRaceMeta(obstacleLive);
assert.equal(
  classifyRaceDiscipline(obstacleMeta,obstacleLive(".RaceName").first().text()),
  "OBSTACLE",
  "live obstacle course must remain OBSTACLE",
);

const legacyFlat=load(`
<html><body>
  <div>障害レース情報</div>
  <div class="data_intro">ダ1800m / 天候 : 曇 / 馬場 : 稍重 / 発走 : 10:10</div>
</body></html>
`);
assert.equal(classifyRaceDiscipline(selectRaceMeta(legacyFlat),"平地fixture"),"FLAT");

assert.equal(classifyRaceDiscipline("障3140m / 天候 : 晴",""),"OBSTACLE");
assert.equal(classifyRaceDiscipline("障害 芝 3140m / 天候 : 晴",""),"OBSTACLE");
assert.equal(
  classifyRaceDiscipline("障害レース情報 芝1600m / 天候 : 晴","平地fixture"),
  "FLAT",
  "generic obstacle navigation text must not be enough to classify a flat course",
);

console.log("race meta / discipline regression passed");
