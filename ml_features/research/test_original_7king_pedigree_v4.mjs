#!/usr/bin/env node
/** Original 2025 seven-king pedigree v4 forensic compatibility. Read-only.
 * Do not edit original frozen math or train/score 2026 data.
 */
import {readFileSync} from "node:fs";
import {createPedigreeFeatureState as v4, lineageFromHorseRecord} from "./frozen_7king_eb13_v4/pedigree-feature-builder.mjs";
import {createPedigreeFeatureState as v3} from "../src/pedigree-feature-builder.mjs";
const fail=(what)=>{throw new Error(what)};
const fixture={
  race_class_normalized:"TWO_YEAR_MAIDEN",
  surface:"TURF",venue_code:"05",
  course_layout:"OUTER",track_condition:"GOOD",distance_m:1800,
};
const lineage=lineageFromHorseRecord({pedigree:[
  {generation:1,slot:0,ancestor_id:"frozen-test-sire"},
  {generation:2,slot:2,ancestor_id:"frozen-test-damsire"}
]});
if(!lineage.sire_key || !lineage.damsire_key) fail("FROZEN_LINEAGE_EXTRACTION_FAILED");
const s4=v4(),s3=v3();
const snap4=s4.snapshot(lineage,fixture),snap3=s3.snapshot(lineage,fixture);
const k4=Object.keys(snap4),k3=Object.keys(snap3);
const added=k4.filter(k=>!k3.includes(k)).sort();
const removed=k3.filter(k=>!k4.includes(k));
if(k4.length!==238 || k3.length!==204 || added.length!==34 || removed.length) {
  fail("FROZEN_V4_238_V3_204_SCHEMA_DRIFT:"+JSON.stringify({
    n4:k4.length,n3:k3.length,added:added.length,removed:removed.length}));
}
if(!added.every(k=>/^ped_(sire|damsire)_race_class_/.test(k))) fail("NON_RACECLASS_COLUMN_ADDED");
if(added.filter(k=>k.startsWith("ped_sire_")).length!==17 ||
   added.filter(k=>k.startsWith("ped_damsire_")).length!==17) fail("CLASS_ROLE_SPLIT_DRIFT");
const historyRace={...fixture,race_class_normalized:"TWO_YEAR_MAIDEN"};
const res={result_status:"FINISHED",official_finish_position:2,margin_type:"LENGTHS",margin_lengths:0.25};
for(const [key,val] of Object.entries(snap3)){
  if(JSON.stringify(snap4[key])!==JSON.stringify(val)) fail("FROZEN_V3_COMMON_COLUMN_CHANGED_BEFORE_UPDATE:"+key);
}
s4.add(lineage,historyRace,res);s3.add(lineage,historyRace,res);
const after4=s4.snapshot(lineage,fixture),after3=s3.snapshot(lineage,fixture);
for(const [key,val] of Object.entries(after3)){
  if(JSON.stringify(after4[key])!==JSON.stringify(val)) fail("FROZEN_V3_COMMON_COLUMN_CHANGED_AFTER_UPDATE:"+key);
}
if(after4.ped_sire_race_class_starts!==1 ||
   after4.ped_damsire_race_class_starts!==1 ||
   after4.ped_sire_race_class_top3_rate!==1) fail("FROZEN_ORIGINAL_RACECLASS_HISTORY_NOT_USED");
const absent=s4.snapshot(lineage,{...fixture,race_class_normalized:null,grade:null});
if(absent.ped_sire_race_class_condition_known!==0)fail("UNKNOWN_RACE_CLASS_NOT_FLAGGED");
if(k4.length!==Object.keys(after4).length)fail("FROZEN_SCHEMA_CHANGED_DURING_STATE");
console.log("ORIGINAL_FROZEN_7KING_PEDIGREE_V4_SCHEMA_TEST_SUCCESS "+JSON.stringify({
 original_ml_ref:"0200a8b31d1ea3f4830b9b5357cb8e593d486a56",
 archived_pedigree_keys:238, prior_backfill_v3_pedigree_keys:204,
 exact_raceclass_keys_added:34, shared204_values_unchanged_in_synthetic_test:true,
 both_lineages_tested:true, 
 real_2026_pedigree_stats_computed:false,model_inference_executed:false,
 original_model_or_feature_math_edited:false,target_2026_results_read:false,
 added_names:added
}));
