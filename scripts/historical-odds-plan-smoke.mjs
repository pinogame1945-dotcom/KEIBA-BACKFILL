import assert from "node:assert/strict";
import {mkdtemp,writeFile,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";

const dir=await mkdtemp(path.join(tmpdir(),"keiba-odds-plan-"));
await mkdir(path.join(dir,"data","odds"),{recursive:true});
await writeFile(path.join(dir,"data","manifest.json"),JSON.stringify({
  days:{
    "2026-09-20":{status:"SUCCESS",races_parsed:24,file:"data/daily/2026-09-20.jsonl.gz"},
    "2026-09-19":{status:"SUCCESS",races_parsed:24,file:"data/daily/2026-09-19.jsonl.gz",schedule_contract_version:1},
    "2026-09-18":{status:"NO_MEETING",races_parsed:0},
    "2007-07-27":{status:"SUCCESS",races_parsed:12,file:"data/daily/2007-07-27.jsonl.gz"}
  }
}));
await writeFile(path.join(dir,"data","odds","manifest.json"),JSON.stringify({
  days:{
    "2026-09-20":{
      status:"SUCCESS",odds_pack_version:1,decoder_contract_version:1
    },
    "2026-09-19":{
      status:"SUCCESS",odds_pack_version:1,decoder_contract_version:1
    }
  }
}));

const script=new URL("../src/plan-historical-odds-backfill.mjs",import.meta.url).pathname;
const run=spawnSync(process.execPath,[script,"plan","10","2007-07-28"],{
  cwd:dir,encoding:"utf8"
});
if(run.status!==0)throw new Error(run.stderr||"planner failed");
const result=JSON.parse(run.stdout.trim());
assert.equal(result.action,"collect");
assert.equal(result.pending_days,1);
assert.deepEqual(result.selected,["2026-09-19"]);
assert.equal(result.completed_days,1);
assert.equal(result.race_days,2);

console.log("historical odds planner smoke passed");
