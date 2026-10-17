#!/usr/bin/env node
/** Verify the byte-for-byte copied ORIGINAL ML bloodline V4 in isolation.
 * No current race results, scores, models, output assets or formulas modified.
 */
import {
  PEDIGREE_FEATURE_BUILDER_VERSION as V4_VERSION,
  createPedigreeFeatureState as createV4,
  lineageFromHorseRecord as lineageV4
} from "../src/pedigree-feature-builder-original-v4.mjs";
import {
  PEDIGREE_FEATURE_BUILDER_VERSION as V3_VERSION,
  createPedigreeFeatureState as createV3
} from "../src/pedigree-feature-builder.mjs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

function requireTrue(cond, msg) { if(!cond) throw Error(msg); }
const originalRead=readFileSync(new URL("../src/pedigree-feature-builder-original-v4.mjs",import.meta.url));
const sha=createHash("sha256").update(originalRead).digest("hex");
requireTrue(V4_VERSION===4 && V3_VERSION===3, "WRONG_ORIGINAL_BUILDER_VERSIONS");
const fixtureHorse={pedigree:[
  {generation:1,slot:0,ancestor_id:"fixture-sire"},
  {generation:2,slot:2,ancestor_id:"fixture-damsire"}
]};
const lineage=lineageV4(fixtureHorse);
requireTrue(lineage.sire_key==="id:fixture-sire" &&
            lineage.damsire_key==="id:fixture-damsire", "ORIGINAL_LINEAGE_CHANGED");
const prevRace={
  race_class_normalized:"2勝クラス",grade:"OLD_OTHER",
  surface:"TURF",venue_code:"05",course_layout:"OUTER",
  track_condition:"GOOD",distance_m:1800
};
const thisRace={...prevRace};
const thirdRace={...prevRace,race_class_normalized:null,grade:"G3"};
const s3=createV3(),s4=createV4();
const b3=s3.snapshot(lineage,thisRace),b4=s4.snapshot(lineage,thisRace);
const k3=new Set(Object.keys(b3)),k4=new Set(Object.keys(b4));
const diff=[...k4].filter(k=>!k3.has(k)).sort();
requireTrue(k3.size===204 && k4.size===238 && diff.length===34,"ORIGINAL_V4_238_COLUMNS_CHANGED");
requireTrue([...k3].every(k=>k4.has(k)),"V3_COLUMNS_CHANGED_IN_V4");
requireTrue(diff.every(k=>k.startsWith("ped_sire_race_class_") ||
                        k.startsWith("ped_damsire_race_class_")),"NON_RACE_CLASS_DIFF");
requireTrue(diff.filter(k=>k.startsWith("ped_sire")).length===17 &&
            diff.filter(k=>k.startsWith("ped_damsire")).length===17,"RACE_CLASS_ROLE_SPLIT_DRIFT");
requireTrue(b4.ped_sire_race_class_starts===0 &&
            b4.ped_damsire_race_class_starts===0,"TARGET_HISTORY_LEAK");
requireTrue(b4.ped_sire_race_class_condition_known===1,
           "NORMALIZED_RACE_CLASS_SELECTION_LOST");
requireTrue(s4.snapshot(lineage,thirdRace).ped_sire_race_class_condition_known===1,
           "GRADE_FALLBACK_CHANGED");
const previousResult={result_status:"FINISHED",official_finish_position:2,
                      margin_type:"LENGTHS",margin_lengths:0.5};
s4.add(lineage,prevRace,previousResult);
const now=s4.snapshot(lineage,thisRace);
requireTrue(now.ped_sire_race_class_starts===1 &&
            now.ped_damsire_race_class_starts===1 &&
            now.ped_sire_race_class_top3_rate===1 &&
            now.ped_sire_race_class_win_rate===0,
            "PRIOR_ONLY_RACE_CLASS_STATE_NOT_COMMITTED");
const diffClass=s4.snapshot(lineage,{...thisRace,race_class_normalized:"G1"});
requireTrue(diffClass.ped_sire_race_class_starts===0,
            "TARGET_WRONG_RACE_CLASS_SAME_STATS");
console.log("ORIGINAL_ML_V4_PEDIGREE_RESTORED "+JSON.stringify({
  contract:"KEIBA_ORIGINAL_7KING_PEDIGREE_V4_CODE_GATE_V1",
  original_model_code_sha256:sha,
  exact_original_v4_file:"ml_features/src/pedigree-feature-builder-original-v4.mjs",
  original_v3_unmodified:true,original_v4_key_count:k4.size,
  original_v3_key_count:k3.size,additional_race_class_keys:diff.length,
  sire_race_class_keys:17,damsire_race_class_keys:17,
  historical_earlier_result_fixture_only:true,
  same_day_target_result_read:false,"2026_result_read":false,
  "2026_real_pedigree_values_generated":false
}));
