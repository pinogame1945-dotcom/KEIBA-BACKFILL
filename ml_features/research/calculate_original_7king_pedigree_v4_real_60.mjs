#!/usr/bin/env node
/** Frozen original EB13 pedigree V4: 2018-onward strictly-prior target inference.
 * Pre-race targets' own results/odds are NEVER used. Prior races' completed
 * results are used only as historical feature state, not training/evaluation.
 */
import {readdir,readFile,writeFile,mkdir} from "node:fs/promises";
import {gunzipSync} from "node:zlib";
import path from "node:path";
import {createPedigreeFeatureState,lineageFromHorseRecord} from "./frozen_7king_eb13_v4/pedigree-feature-builder.mjs";
const root=path.resolve(process.argv[2]??".");
const dest=path.resolve(process.argv[3]??"/tmp/frozen-7king-pedigree-v4-60");
const need=(ok,err)=>{if(!ok)throw Error(err)};
const parse=async p=>JSON.parse(await readFile(p,"utf8"));
const zip=async p=>gunzipSync(await readFile(p)).toString("utf8").split("\n").filter(Boolean).map(JSON.parse);
const days=["2026-10-10","2026-10-17"];
const limits={"2026-10-10":[24,315],"2026-10-17":[36,471]};
const targets={};const targetIds=new Set();
for(const day of days){
  const dir=path.join(root,"ml_features/delivery/690",day);
  const files=(await readdir(dir)).filter(n=>/^2026\d{8}\.json$/.test(n)).sort();
  need(files.length===limits[day][0],"RACE_COUNT:"+day);
  let count=0;const races=new Map();
  for(const name of files){
    const obj=await parse(path.join(dir,name)),rid=obj.race_id;
    need(obj.contract==="KEIBA_BACKFILL_TO_ML_690_UNSCORED_V1" &&
         obj.race_date===day && obj.feature_count===690 &&
         obj.used_target_results_or_final_odds===false,"INPUT_DRIFT:"+name);
    const ids=obj.rows.map(x=>String(x._horse_id));
    need(new Set(ids).size===ids.length && obj.starters===ids.length,"DUPLICATED_RUNNERS");
    count+=ids.length;ids.forEach(id=>targetIds.add(id));
    races.set(rid,{ids,rows:obj.rows});
  }
  need(count===limits[day][1],"HORSE_COUNT:"+day);
  targets[day]=races;
}
const horseDir=path.join(root,"data/horses");
const packs=(await readdir(horseDir)).filter(n=>
  /^horse-\d{4}-\d{2}-\d{2}-\d+\.jsonl\.gz$/.test(n) ||
  /^pedigree-v2-all-\d{3}\.jsonl\.gz$/.test(n))
  .sort((a,b)=>Number(a.startsWith("pedigree-"))-Number(b.startsWith("pedigree-"))||
                 a.localeCompare(b));
const lineage=new Map();
let scanned=0;
for(const name of packs){
  const rows=await zip(path.join(horseDir,name));
  for(const record of rows){
    scanned++;
    const id=String(record.horse_id??"");
    if(!id)continue;
    const old=lineage.get(id);
    if(old?.sire_key && old?.damsire_key)continue;
    const keys=lineageFromHorseRecord(record);
    if(keys.sire_key || keys.damsire_key)lineage.set(id,keys);
  }
}
for(const id of targetIds)need(lineage.get(id)?.sire_key&&lineage.get(id)?.damsire_key,
  "MISSING_REAL_TARGET_PEDIGREE:"+id);
console.log("REAL_FROZEN_V4_TARGET_PEDIGREE_786_PRESENT "+JSON.stringify({targetIds:targetIds.size,scanned,packs:packs.length}));
const state=createPedigreeFeatureState();
const output=new Map();
const count={history_dates:0,history_races:0,history_finished_starts:0};
async function emit(day,meta){
  const wanted=targets[day];
  need(meta.size===wanted.size,"TARGET_RACE_META_MISSING:"+day);
  let num=0,knownClass=0;
  for(const [rid,cohort] of wanted){
    const race=meta.get(rid);
    need(race,"MISSING_RACE_METADATA:"+rid);
    need(race.race_class_normalized && race.race_class_normalized!=="UNKNOWN",
         "UNKNOWN_RACE_CLASS:"+rid);
    const rows=[];
    for(const horseId of cohort.ids){
      const base=cohort.rows.find(x=>String(x._horse_id)===horseId);
      for(const k of ["surface","venue_code","distance_m","track_condition"])
        need(base[k]===race[k],"MISMATCH_ORIGINAL_RACE_META:"+rid+":"+k+
             " got="+String(race[k])+" expected="+String(base[k]));
      const features=state.snapshot(lineage.get(horseId),race);
      need(Object.keys(features).length===238,"FROZEN_V4_NOT_238");
      need(features.ped_sire_known===1 && features.ped_damsire_known===1,
           "NOT_BOTH_PEDIGREES:"+horseId);
      need(features.ped_sire_race_class_condition_known===1 &&
           features.ped_damsire_race_class_condition_known===1,
           "RACE_CLASS_NOT_KNOWN:"+rid);
      rows.push({horse_id:horseId,features});
      num++;
    }
    knownClass++;
    output.set(rid,{contract:"KEIBA_7KING_ORIGINAL_EB13_PEDIGREE_238_UNSCORED_V1",
      race_id:rid,race_date:day,starters:rows.length,feature_count:238,
      original_eb13_builder_blob_sha:"e22df9ec79f9c02c773e519f4dc6b187d2889f83",
      original_history_start:"2018-01-01",
      asof_policy:"STRICT_PRIOR_DATE_ONLY",
      historical_results_used_for_feature_state_only:true,
      target_2026_results_or_final_odds_used:false,
      model_training_or_prediction_executed:false,
      capture_asof_independently_verified:false,
      original_eb13_numerical_parity_verified:false,rows});
  }
  need(num===limits[day][1],"TARGET_HORSE_DATA_NOT_COMPLETE");
  console.log("FROZEN_V4_238_REAL_TARGET_FEATURES_READY "+JSON.stringify(
    {day,races:knownClass,horses:num,features:238,scope:"UNSCORED_ORIGINAL_BLOODLINE_ONLY"}));
}
const dated=path.join(root,"data/daily");
const files=(await readdir(dated)).filter(n=>/^\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(n) &&
  n.slice(0,10)>="2018-01-01" && n.slice(0,10)<"2026-10-17").sort();
need(files.length>=500 && files[0].slice(0,10).startsWith("2018-") && files.at(-1).slice(0,10)>="2026-10-10","HISTORY_FROM_2018_MISSING");
for(const file of files){
  const day=file.slice(0,10);
  const daily=await zip(path.join(dated,file));
  need(daily.every(x=>String(x.race?.actual_date??x.race?.scheduled_date??"").slice(0,10)===day),
       "HISTORICAL_SOURCE_ACTUAL_DATE_DRIFT:"+day);
  // Produce target 10/10 from DATE-START state. Never read target outcomes
  // for its own features; only later may its completed races become prior state.
  if(day==="2026-10-10")await emit(day,new Map(daily.map(x=>[String(x.race.race_id),x.race])));
  let pending=[];
  for(const raceRow of daily){
    count.history_races++;
    const resultById=new Map((raceRow.results??[]).map(x=>[String(x.horse_id),x]));
    for(const entry of raceRow.entries??[]){
      const id=String(entry.horse_id??"");
      const result=resultById.get(id);
      if(!result || !id)continue;
      const e=String(entry.entry_status??"").toUpperCase();
      const v=String(result.result_status??"").toUpperCase();
      const n=Number(result.official_finish_position);
      if(e==="SCRATCHED"||e==="EXCLUDED"||v!=="FINISHED"||
         !Number.isInteger(n)||n<1)continue;
      pending.push({id,race:raceRow.race,result});
    }
  }
  // Only after all race features from this calendar day are generated.
  for(const x of pending){
    state.add(lineage.get(x.id)??{sire_key:null,damsire_key:null},x.race,x.result);
    count.history_finished_starts++;
  }
  count.history_dates++;
}
need([...output.values()].filter(x=>x.race_date==="2026-10-10").length===24,
     "OCT10_DAILY_TARGET_MISSING");
const actual=new Map();
for(const rid of targets["2026-10-17"].keys()){
  const x=await parse(path.join(root,"data/live/2026-10-17",rid+".json"));
  need(x.contract==="JRA_20261017_ALL_RACES_PRE_RACE_AUDIT_V1" &&
       x.race_id===rid && x.includes_results===false &&
       x.includes_final_odds===false,"OCT17_PRE_RACE_SOURCE_NOT_CLEAN:"+rid);
  const race={};
  for(const cell of x.netkeiba.features_149??[])
    if(cell.feature_id.startsWith("race.") &&
       cell.status==="OBSERVED_OR_DERIVED_FROM_PAGE")
      race[cell.feature_id.slice(5)]=cell.observed_value;
  need(["surface","venue_code","distance_m",
        "track_condition","race_class_normalized"].every(k=>race[k]!=null),
       "NOT_ENOUGH_REAL_PRE_RACE_METADATA:"+rid);
  actual.set(rid,race);
}
await emit("2026-10-17",actual);
need(output.size===60,"FROZEN_238_RACE_POPULATION_NOT_60");
await mkdir(dest,{recursive:true});
for(const day of days)await mkdir(path.join(dest,day),{recursive:true});
for(const [rid,row] of output)
  await writeFile(path.join(dest,row.race_date,rid+".json"),JSON.stringify(row)+"\n");
const manifest={contract:"KEIBA_7KING_FROZEN_EB13_PEDIGREE_V4_REAL_60_MANIFEST_V1",
  races:60,horses:786,columns:238,history_start:"2018-01-01",
  ...count, historic_results_including_2026_past_dates_used_only_as_prior_feature_state:true,
  target_2026_not_used_as_training_or_evaluation_labels:true,
  target_2026_results_or_odds_not_read_for_same_race:true,
  original_ml_2025_model_scores_not_run:true,
  numeric_eb13_parity_unverified:true,
  prestart_capture_unverified:true,
  betting_not_approved:true};
await writeFile(path.join(dest,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
console.log("FROZEN_ORIGINAL_238_PEDIGREE_NUMERIC_60_786_CREATED "+JSON.stringify(manifest));
