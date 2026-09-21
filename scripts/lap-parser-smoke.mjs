import assert from "node:assert/strict";
import {load} from "cheerio";
import {expectedLapSegments,parseRaceLaps,LAP_PARSER_VERSION} from "../src/lap-parser.mjs";

assert.equal(LAP_PARSER_VERSION,2);
assert.equal(expectedLapSegments(2200),11);
assert.equal(expectedLapSegments(2500),13);

const modern=load(`
<html><body>
<h2>ラップタイム</h2>
<table>
<tr><th>200m</th><th>400m</th><th>600m</th><th>800m</th><th>1000m</th></tr>
<tr><td>12.4</td><td>23.8</td><td>35.9</td><td>48.2</td><td>1:00.5</td></tr>
<tr><td>12.4</td><td>11.4</td><td>12.1</td><td>12.3</td><td>12.3</td></tr>
</table>
</body></html>`);
assert.deepEqual(
  parseRaceLaps(modern,"202606010101",1000).map(row=>row.lap_seconds),
  [12.4,11.4,12.1,12.3,12.3],
);

const legacy=load(`
<table><tr><th>ラップ</th><td>12.7 - 11.5 - 12.0 - 12.3 - 12.4</td></tr></table>
`);
assert.deepEqual(
  parseRaceLaps(legacy,"202606010102",1000).map(row=>row.lap_seconds),
  [12.7,11.5,12.0,12.3,12.4],
);

const incomplete=load(`
<table><tr><th>200m</th><th>400m</th><th>600m</th></tr>
<tr><td>12.4</td><td>23.8</td><td>35.9</td></tr>
<tr><td>12.4</td><td>11.4</td><td>12.1</td></tr>
</table>
`);
assert.equal(parseRaceLaps(incomplete,"202606010103",1000).length,3);

console.log("lap parser smoke passed");
