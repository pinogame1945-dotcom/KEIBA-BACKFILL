import assert from "node:assert/strict";
import {canonicalNetkeibaHorseId,extractNetkeibaHorseId,knownHorseIdAlias} from "../src/horse-id.mjs";

assert.equal(canonicalNetkeibaHorseId("000a011226"),"2000190015");
assert.equal(canonicalNetkeibaHorseId("000a011220"),"2000190016");
assert.equal(canonicalNetkeibaHorseId("000a024978"),"000a024978");
assert.equal(extractNetkeibaHorseId("/horse/000a011226/"),"2000190015");
assert.equal(extractNetkeibaHorseId("/horse/2005106153/"),"2005106153");
assert.deepEqual(knownHorseIdAlias("000a011220"),{source_id:"000a011220",canonical_id:"2000190016"});
assert.equal(knownHorseIdAlias("000a024978"),null);
console.log("horse id canonicalization smoke passed");
