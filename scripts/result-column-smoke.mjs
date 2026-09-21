import assert from "node:assert/strict";
import {findLast3fColumn,normalizeResultHeader,parseLast3fSeconds,RESULT_PARSER_VERSION} from "../src/result-columns.mjs";

assert.equal(RESULT_PARSER_VERSION,4);
const headers=[
  "着\n順","馬名","タイム","上\nが\nり\n指\n数","通過","上り","単勝"
];
assert.equal(normalizeResultHeader(headers[3]),"上がり指数");
assert.equal(findLast3fColumn(headers),5);
assert.equal(findLast3fColumn(["着順","馬名","後3F","人気"]),2);
assert.equal(findLast3fColumn(["着順","馬名","上がり指数","人気"]),-1);
assert.equal(parseLast3fSeconds("35.9"),35.9);
assert.equal(parseLast3fSeconds("1:27.6"),87.6);
assert.equal(parseLast3fSeconds("127.6"),87.6);
assert.equal(parseLast3fSeconds("(127.6)"),87.6);
assert.equal(parseLast3fSeconds(""),null);
console.log("result-column regression passed");
