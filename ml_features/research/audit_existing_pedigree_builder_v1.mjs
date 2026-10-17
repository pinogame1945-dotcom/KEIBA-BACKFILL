#!/usr/bin/env node
/** Inspect ORIGINAL pre-existing pedigree generator; do not substitute values.
 *  Node module executes no 2026 outcome access and performs no feature edits.
 *  The snapshot is schema-only and must never be used as a real prediction.
 */
import { writeFileSync } from "node:fs";
import { createPedigreeFeatureState, lineageFromHorseRecord } from "../src/pedigree-feature-builder.mjs";

const resultPath = process.argv[2];
if (!resultPath) throw new Error("SCHEMA_OUTPUT_REQUIRED");

const race = {
  surface: "TURF", venue_code: "05", course_layout: "OUTER",
  track_condition: "GOOD", distance_m: 1800,
};
const state = createPedigreeFeatureState();
const lineage = lineageFromHorseRecord({
  pedigree: [
    {generation:1, slot:0, ancestor_id:"sire-fixture"},
    {generation:2, slot:2, ancestor_id:"damsire-fixture"},
  ],
});
if (lineage.sire_key !== "id:sire-fixture" ||
    lineage.damsire_key !== "id:damsire-fixture") {
  throw new Error("ORIGINAL_LINEAGE_EXTRACTION_CHANGED");
}
const before = state.snapshot(lineage, race);
if (!Object.keys(before).every(k => k.startsWith("ped_"))) {
  throw new Error("PEDIGREE_PREFIX_DRIFT");
}
const sample2024 = {
  result_status:"FINISHED", official_finish_position:1,
  margin_type:"LENGTHS", margin_lengths:0.0,
};
// Only completed HISTORICAL FICTIONAL race is used for isolated unit test.
state.add(lineage, race, sample2024);
const after = state.snapshot(lineage, race);
const names = Object.keys(after).sort();
if (names.length !== Object.keys(before).length ||
    names.join("|") !== Object.keys(before).sort().join("|")) {
  throw new Error("ORIGINAL_PEDIGREE_DYNAMIC_KEY_DRIFT");
}
if (before.ped_sire_all_starts !== 0 ||
    after.ped_sire_all_starts !== 1) {
  throw new Error("HISTORICAL_ONLY_PEDIGREE_STATE_NOT_UPDATING");
}
if (after.ped_damsire_all_starts !== 1) {
  throw new Error("MATERNAL_GRANDSIRE_STATE_NOT_UPDATING");
}
const report = {
  contract: "KEIBA_EXISTING_PEDIGREE_FEATURE_BUILDER_SCHEMA_AUDIT_V1",
  pedigree_key_count: names.length,
  names,
  frozen_builder_file: "ml_features/src/pedigree-feature-builder.mjs",
  no_model_training:true,
  no_real_2026_results:true,
  no_2026_pedigree_values_generated:true,
  source_lineage_is_synthetic_fixture:true,
  point_in_time_unit_fixture_starts_before: before.ped_sire_all_starts,
  point_in_time_unit_fixture_starts_after: after.ped_sire_all_starts,
};
writeFileSync(resultPath, JSON.stringify(report, null, 2)+"\n");
console.log("EXISTING_PEDIGREE_GENERATOR_SCHEMA_READY "+JSON.stringify({
  columns: names.length,
  historical_snapshot_state_transition_ok:true,
  original_generator_unchanged:true,
  real_2026_features_calculated:false,
}));
