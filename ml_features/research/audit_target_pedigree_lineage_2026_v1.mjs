#!/usr/bin/env node
/** Read-only coverage audit of real 2026 target horse pedigree.
 * No historical results, prediction, numerical parity or new model.
 */
import { readdir, readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { lineageFromHorseRecord } from "../src/pedigree-feature-builder.mjs";

const SOURCE = path.resolve(process.argv[2] ?? ".");
const delivery = path.join(SOURCE, "ml_features/delivery/690");
const wanted = new Map();
const byDate = new Map();

for (const day of ["2026-10-10","2026-10-17"]) {
  const files = (await readdir(path.join(delivery,day))).filter(x => /^2026\d{8}\.json$/.test(x)).sort();
  const expected = day.endsWith("10") ? 24 : 36;
  if (files.length !== expected) throw new Error("TARGET_DAY_COUNT_DRIFT:"+day);
  const ids = new Set();
  for (const name of files) {
    const doc = JSON.parse(await readFile(path.join(delivery,day,name),"utf8"));
    if (doc.contract !== "KEIBA_BACKFILL_TO_ML_690_UNSCORED_V1" ||
        doc.race_date !== day || doc.feature_count !== 690 ||
        doc.used_target_results_or_final_odds !== false) {
      throw new Error("TARGET_FEATURE_SOURCE_CONTRACT_DRIFT:"+name);
    }
    for (const row of doc.rows) {
      const id = String(row._horse_id ?? "");
      if (!id) throw new Error("EMPTY_HORSE_ID");
      ids.add(id);
      wanted.set(id, null);
    }
  }
  const expectedHorses = day.endsWith("10") ? 315 : 471;
  if (ids.size !== expectedHorses) throw new Error("TARGET_HORSE_COUNT_DRIFT:"+day);
  byDate.set(day, ids);
}

const dir=path.join(SOURCE,"data/horses");
const filenames=(await readdir(dir)).filter(n => 
  /^pedigree-v2-all-\d{3}\.jsonl\.gz$/.test(n) ||
  /^horse-\d{4}-\d{2}-\d{2}-\d{3}\.jsonl\.gz$/.test(n)
).sort((a,b) => Number(a.startsWith("horse-"))-Number(b.startsWith("horse-")) || a.localeCompare(b));

let recordsRead=0,matchedRecords=0,matchedWithKeys=0,filesRead=0,srcPedigree=0,srcDated=0;
const missing = new Set(wanted.keys());
for (const name of filenames) {
  if (!missing.size) break;
  const raw=gunzipSync(await readFile(path.join(dir,name))).toString("utf8");
  filesRead++;
  if (name.startsWith("pedigree-v2-")) srcPedigree++; else srcDated++;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    recordsRead++;
    const record=JSON.parse(line);
    const hid=String(record.horse_id ?? "");
    if (!missing.has(hid)) continue;
    matchedRecords++;
    const lineage=lineageFromHorseRecord(record);
    if (lineage.sire_key || lineage.damsire_key) {
      wanted.set(hid,lineage);
      missing.delete(hid);
      matchedWithKeys++;
    }
  }
}

const coverage={};
for(const [date,ids] of byDate){
  let withSire=0,withDamsire=0,both=0;
  const absent=[];
  for(const id of ids){
    const lineage=wanted.get(id);
    if(lineage?.sire_key) withSire++;
    if(lineage?.damsire_key) withDamsire++;
    if(lineage?.sire_key && lineage?.damsire_key) both++;
    if(!lineage?.sire_key || !lineage?.damsire_key) absent.push(id);
  }
  coverage[date]={target_horses:ids.size,with_sire:withSire,
    with_damsire:withDamsire,with_both:both,missing_any:absent.length,
    missing_example:absent.slice(0,15),missing_horse_ids:absent};
}
console.log("REAL_2026_PEDIGREE_LINEAGE_COVERAGE "+JSON.stringify({
  contract:"KEIBA_REAL_2026_PEDIGREE_LINEAGE_COVERAGE_AUDIT_V1",
  race_population:60, horse_population:786,
  profiles_files_read:filesRead,profile_records_read:recordsRead,
  profile_records_matched:matchedRecords,matched_with_any_lineage:matchedWithKeys,
  pedigree_v2_shards_read:srcPedigree,dated_horse_shards_read:srcDated,
  coverage,
  no_target_results_read:true, no_target_outcomes_evaluated:true,
  no_pedigree_statistics_computed:true,
  no_2026_predictions_or_model_training:true,
  full_690_numerical_parity_not_checked:true
}));
