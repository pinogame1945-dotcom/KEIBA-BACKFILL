import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {flatLast3fDayQuality,raceFlatLast3fQuality} from "../src/result-quality.mjs";

const obstacle=JSON.parse(await readFile("fixtures/result-quality/obstacle-race.json","utf8"));
const flat=JSON.parse(await readFile("fixtures/result-quality/flat-race.json","utf8"));

const obstacleRace=raceFlatLast3fQuality(obstacle);
assert.equal(obstacleRace.eligible,false,"obstacle race must be excluded from flat last3f quality");
assert.equal(obstacleRace.timed,0,"obstacle timed rows must not enter flat denominator");
assert.equal(obstacleRace.bad,0,"obstacle last3f values must not be flagged by flat 20-60s contract");

const obstacleOnlyDay=flatLast3fDayQuality([obstacle]);
assert.equal(obstacleOnlyDay.flatRaces,0,"obstacle-only day must have zero flat last3f targets");
assert.equal(obstacleOnlyDay.timedResults,0,"obstacle-only day must have zero flat timed results");
assert.equal(obstacleOnlyDay.suspicious,0,"obstacle-only day must not create flat suspicious rows");
assert.equal(obstacleOnlyDay.last3fCoverage,1,"empty flat denominator must not fail day coverage");

const flatRace=raceFlatLast3fQuality(flat);
assert.equal(flatRace.eligible,true,"flat race must be checked");
assert.equal(flatRace.timed,8,"flat fixture must contribute all timed finishers");
assert.equal(flatRace.bad,1,"flat 72.4s last3f must violate the 20-60s flat contract");
assert.ok(flatRace.bad/flatRace.timed>0.1,"flat fixture must trip row-quality threshold");

const mixedDay=flatLast3fDayQuality([flat,obstacle]);
assert.equal(mixedDay.flatRaces,1,"mixed day must count only flat races for last3f quality");
assert.equal(mixedDay.timedResults,8,"obstacle rows must not contaminate flat last3f denominator");
assert.equal(mixedDay.present,8,"flat last3f presence must be computed from flat rows only");
assert.equal(mixedDay.suspicious,1,"only the bad flat row must be suspicious");

console.log("flat-only last3f quality smoke ok");
