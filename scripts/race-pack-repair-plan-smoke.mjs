import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {spawnSync} from "node:child_process";

const dir=await mkdtemp(path.join(os.tmpdir(),"keiba-repair-plan-"));
await mkdir(path.join(dir,"data"),{recursive:true});
await writeFile(path.join(dir,"package.json"),JSON.stringify({type:"module"}));
const manifest={
  days:{
    "2026-09-20":{status:"SUCCESS",race_pack_version:2,result_parser_version:1,lap_parser_version:1,schedule_contract_version:0,races_parsed:24},
    "2026-09-19":{status:"SUCCESS",race_pack_version:3,result_parser_version:3,lap_parser_version:2,schedule_contract_version:1,races_parsed:24},
    "2026-09-13":{status:"SUCCESS",race_pack_version:3,result_parser_version:2,lap_parser_version:2,schedule_contract_version:1,races_parsed:24},
    "2026-09-12":{status:"FAILED",race_pack_version:1,races_parsed:0},
  }
};
await writeFile(path.join(dir,"data","manifest.json"),JSON.stringify(manifest));

const sourceRoot=process.cwd();
for(const rel of ["src/plan-race-pack-repair.mjs","src/result-columns.mjs","src/lap-parser.mjs","src/schedule-integrity.mjs"]){
  const target=path.join(dir,rel);
  await mkdir(path.dirname(target),{recursive:true});
  await writeFile(target,await (await import("node:fs/promises")).readFile(path.join(sourceRoot,rel),"utf8"));
}
const run=spawnSync(process.execPath,["src/plan-race-pack-repair.mjs","2026-09-20","2026-09-01","10"],{cwd:dir,encoding:"utf8"});
assert.equal(run.status,0,run.stderr);
const plan=JSON.parse(run.stdout);
assert.equal(plan.stale_days,2);
assert.deepEqual(plan.dates.map(row=>row.date),["2026-09-20","2026-09-13"]);
assert.ok(plan.dates[0].reasons.includes("result_parser"));
assert.ok(!plan.dates.some(row=>row.date==="2026-09-19"));
assert.ok(!plan.dates.some(row=>row.date==="2026-09-12"));
console.log("race-pack repair planner smoke passed");
