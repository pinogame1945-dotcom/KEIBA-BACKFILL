#!/usr/bin/env node
/**
 * Compute ORIGINAL pedigree V4 238 fields for the 2026-10-10 and
 * 2026-10-17 uns cored 690 delivery population, without updating V3.
 * This script NEVER reads target outcomes from race packs.
 */
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import {
  PEDIGREE_FEATURE_BUILDER_VERSION,
  createPedigreeFeatureState,
  lineageFromHorseRecord,
} from "../src/pedigree-feature-builder-original-v4.mjs";

const ROOT = path.resolve(process.argv[2] ?? ".");
const OUT = path.resolve(process.argv[3] ?? "/tmp/keiba-pedigree-v4");
const OCT10 = "2026-10-10", OCT17 = "2026-10-17";
const START = "2022-01-01"; // Frozen yearly-superset source start, not a new model specification.
const TARGET_DAYS = [OCT10, OCT17];
const EXPECTED = new Map([[OCT10,[24,315]],[OCT17,[36,471]]]);
const PEDIGREE_PREFIX = "ped_";

function requireTrue(ok, message) { if (!ok) throw Error(message); }
function dateOf(row) { return String(row?.race?.actual_date ?? row?.race?.scheduled_date ?? "").slice(0,10); }
function horseId(row) { return String(row?.horse_id ?? ""); }
function resultOk(entry, result) {
  const status = String(entry?.entry_status ?? "").toUpperCase();
  if (status === "SCRATCHED" || status === "EXCLUDED") return false;
  if (["SCRATCHED","EXCLUDED"].includes(String(result?.result_status ?? "").toUpperCase())) return false;
  return String(result?.result_status ?? "").toUpperCase() === "FINISHED" &&
    Number.isFinite(Number(result?.official_finish_position)) &&
    Number(result.official_finish_position) >= 1;
}
async function readPack(filename) {
  const buf = await readFile(filename);
  const raw = gunzipSync(buf).toString("utf8").trim();
  return raw ? raw.split("\n").filter(Boolean).map(JSON.parse) : [];
}
async function readTargetSpecs() {
  const byDay = new Map(), requiredIds = new Set(), specs = new Map();
  for (const day of TARGET_DAYS) {
    const dir = path.join(ROOT,"ml_features/delivery/690",day);
    const files = (await readdir(dir)).filter(n=>/^2026\d{8}\.json$/.test(n)).sort();
    requireTrue(files.length===EXPECTED.get(day)[0],"TARGET_RACE_COUNT:"+day+":"+files.length);
    const population = new Map();
    for (const file of files) {
      const doc = JSON.parse(await readFile(path.join(dir,file),"utf8"));
      requireTrue(doc.contract==="KEIBA_BACKFILL_TO_ML_690_UNSCORED_V1" &&
        doc.used_target_results_or_final_odds===false && doc.race_date===day &&
        doc.feature_count===690,"690_CONTRACT_DRIFT:"+file);
      requireTrue(doc.race_id===file.slice(0,12),"RACE_ID_DRIFT:"+file);
      const ids = new Set();
      for (const row of doc.rows) {
        const hid = String(row._horse_id ?? "");
        requireTrue(hid && row._race_id===doc.race_id && row._race_date===day,
          "TARGET_ID_DRIFT:"+file);
        requireTrue(!ids.has(hid),"DUP_HORSE_IN_RACE:"+file+":"+hid);
        ids.add(hid); requiredIds.add(hid);
      }
      requireTrue(ids.size===doc.starters,"STARTER_DRIFT:"+file);
      population.set(doc.race_id,ids);
    }
    const count = [...population.values()].reduce((sum, ids)=>sum+ids.size,0);
    requireTrue(count===EXPECTED.get(day)[1],"TARGET_HORSE_COUNT:"+day+":"+count);
    byDay.set(day,population);
    specs.set(day,{races:population.size,horses:count});
  }
  // A horse may race on both target dates. 786 counts entries, not unique horse IDs.
  requireTrue(requiredIds.size>0 && requiredIds.size<=786,"TARGET_EMPTY_OR_TOO_MANY_UNIQUE_HORSES");
  return {byDay,requiredIds,specs};
}
async function targetRaces(day, originalPopulation, livePack) {
  // Read only race metadata and entry identity. Never access target results,
  // odds, payouts, margins or lap information.
  const filename = day===OCT10
    ? path.join(ROOT,"data/daily",day+".jsonl.gz")
    : livePack;
  const pack = await readPack(filename);
  const target = new Map();
  for (const row of pack) {
    const race = row.race ?? {};
    const rid = String(race.race_id ?? "");
    requireTrue(dateOf(row)===day,"TARGET_DATE_MISMATCH:"+rid);
    requireTrue(!target.has(rid),"DUP_TARGET_RACE:"+rid);
    requireTrue(rid && rid.length===12,"INVALID_TARGET_RACE_ID:"+rid);
    const ids = new Set((row.entries ?? []).map(horseId).filter(Boolean));
    requireTrue(ids.size===(row.entries??[]).length,"DUP_TARGET_ENTRY:"+rid);
    target.set(rid,{race,ids});
  }
  requireTrue(target.size===originalPopulation.size,"TARGET_PACK_RACE_COUNT:"+day);
  for (const [rid,ids] of originalPopulation) {
    const actual = target.get(rid);
    requireTrue(actual,"TARGET_MISSING_RACE:"+rid);
    for (const hid of ids) requireTrue(actual.ids.has(hid),"TARGET_MISSING_ENTRY:"+rid+":"+hid);
  }
  return target;
}
async function loadHistoricalNames() {
  return (await readdir(path.join(ROOT,"data/daily")))
    .filter(n=>/^\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(n))
    .filter(n=>n.slice(0,10)>=START && n.slice(0,10)<OCT17 && n.slice(0,10)!==OCT10)
    .sort();
}
async function loadLineage(ids) {
  const dir=path.join(ROOT,"data/horses");
  const names=(await readdir(dir)).filter(n=>
    /^pedigree-v2-all-\d{3}\.jsonl\.gz$/.test(n) ||
    /^horse-\d{4}-\d{2}-\d{2}-\d{3}\.jsonl\.gz$/.test(n))
    .sort((a,b)=>Number(a.startsWith("horse-"))-Number(b.startsWith("horse-")) || a.localeCompare(b));
  const map=new Map();
  let filesRead=0, recordsRead=0;
  for(const name of names) {
    if(map.size===ids.size) break;
    const rows=await readPack(path.join(dir,name));
    filesRead++;
    for(const record of rows){
      recordsRead++;
      const id=horseId(record);
      if(!ids.has(id) || map.has(id)) continue;
      const lineage=lineageFromHorseRecord(record);
      if(lineage.sire_key && lineage.damsire_key) map.set(id,lineage);
    }
  }
  return {map,filesRead,recordsRead};
}
async function run() {
  requireTrue(PEDIGREE_FEATURE_BUILDER_VERSION===4,"ORIGINAL_V4_CHANGED");
  const {byDay,requiredIds} = await readTargetSpecs();
  const livePack=process.argv[4];
  requireTrue(livePack && livePack.endsWith(".jsonl.gz"),"LIVE_TEMP_DAYPACK_REQUIRED");
  const targets=new Map();
  targets.set(OCT10,await targetRaces(OCT10,byDay.get(OCT10),livePack));
  targets.set(OCT17,await targetRaces(OCT17,byDay.get(OCT17),livePack));
  const histNames=await loadHistoricalNames();
  requireTrue(histNames.length>0,"HISTORICAL_RACE_FILES_EMPTY");
  const allIds=new Set(requiredIds);
  let historicalRaces=0, historicalEntries=0;
  // Two-pass lookup mirrors the original yearly snapshot builder: collect IDs,
  // then resolve static lineages, then stream results in date order.
  for(const filename of histNames) {
    const rows=await readPack(path.join(ROOT,"data/daily",filename));
    for(const row of rows) {
      requireTrue(dateOf(row)===filename.slice(0,10),"HISTORY_WRONG_DAY:"+filename);
      historicalRaces++;
      for(const entry of row.entries??[]) {
        const id=horseId(entry);
        if(id) {allIds.add(id);historicalEntries++;}
      }
    }
  }
  const lineage=await loadLineage(allIds);
  for(const id of requiredIds) requireTrue(lineage.map.has(id),"MISSING_TARGET_LINEAGE:"+id);
  const state=createPedigreeFeatureState();
  const output=new Map(TARGET_DAYS.map(day=>[day,new Map()]));
  let priorUpdates=0,historyUnknownLineage=0,historyBadClass=0,lastDay="";
  async function snapshotDay(day) {
    const docs=targets.get(day);
    for(const [rid,meta] of docs) {
      const rows=[];
      for(const hid of byDay.get(day).get(rid)){
        const feat=state.snapshot(lineage.map.get(hid),meta.race);
        const keys=Object.keys(feat);
        requireTrue(keys.length===238 && keys.every(k=>k.startsWith(PEDIGREE_PREFIX)),
          "V4_PEDIGREE_238_SCHEMA_DRIFT:"+rid+":"+hid);
        requireTrue(Object.values(feat).every(v=>v===null ||
          (typeof v==="number" && Number.isFinite(v))),"NONFINITE_PEDIGREE:"+rid+":"+hid);
        rows.push({_race_id:rid,_horse_id:hid,_race_date:day,...feat});
      }
      output.get(day).set(rid,rows);
    }
  }
  let snapped10=false;
  for(const filename of histNames) {
    const day=filename.slice(0,10);
    if(day>OCT10&&!snapped10){await snapshotDay(OCT10);snapped10=true;}
    requireTrue(day>lastDay,"HISTORY_NOT_DATE_SORTED:"+day);
    lastDay=day;
    const races=await readPack(path.join(ROOT,"data/daily",filename));
    // All rows of a day are necessarily read as a group; update state only
    // after the whole day is complete. Target days are never added.
    for(const row of races) {
      const results=new Map((row.results??[]).map(r=>[horseId(r),r]));
      for(const entry of row.entries??[]){
        const hid=horseId(entry);
        const result=results.get(hid);
        if(!result || !resultOk(entry,result))continue;
        const ancestor=lineage.map.get(hid);
        if(!ancestor){historyUnknownLineage++;continue;}
        if(row.race?.race_class_normalized==null && row.race?.grade==null) historyBadClass++;
        state.add(ancestor,row.race,result);
        priorUpdates++;
      }
    }
  }
  if(!snapped10)await snapshotDay(OCT10);
  await snapshotDay(OCT17);
  await mkdir(OUT,{recursive:true});
  const dates={};let countRaces=0,countHorses=0;
  let classUnknown=0, layoutUnknown=0;
  for(const day of TARGET_DAYS){
    const raceRows=output.get(day);
    let dayHorseCount=0;
    for(const [rid,rows] of raceRows) {
      const meta=targets.get(day).get(rid).race;
      const doc={contract:"KEIBA_ORIGINAL_V4_2026_PEDIGREE_238_TEMP_V1",
        race_id:rid,race_date:day,feature_count:238,
        historical_source_start:START,original_v4:true,target_results_used:false,
        rows};
      const basename=path.join(OUT,day,rid+".json");
      await mkdir(path.dirname(basename),{recursive:true});
      await writeFile(basename,JSON.stringify(doc)+"\n");
      dayHorseCount+=rows.length;
      classUnknown+=rows.filter(r=>r.ped_sire_race_class_condition_known===0).length;
      layoutUnknown+=rows.filter(r=>r.ped_sire_course_layout_condition_known===0).length;
    }
    requireTrue(raceRows.size===EXPECTED.get(day)[0] && dayHorseCount===EXPECTED.get(day)[1],
      "FINAL_238_COUNT_DRIFT:"+day);
    dates[day]={races:raceRows.size,horses:dayHorseCount};
    countRaces+=raceRows.size;countHorses+=dayHorseCount;
  }
  requireTrue(countRaces===60&&countHorses===786&&priorUpdates>0,
    "REAL_HISTORICAL_PEDIGREE_NOT_CALCULATED");
  const report={
    contract:"KEIBA_ORIGINAL_V4_PEDIGREE_2026_REAL_RUN_V1",
    date_ranges:{history_start:START,history_end_exclusive:OCT17,
      target_days:TARGET_DAYS,never_commit_target_day_results:true},
    target:dates,feature_count:238,feature_cells:238*countHorses,
    historical_races:historicalRaces,historical_entries:historicalEntries,
    historical_valid_lineage_updates:priorUpdates,
    historical_unknown_lineage_starters:historyUnknownLineage,
    historical_missing_race_class:historyBadClass,
    pedigree_profiles_read:lineage.filesRead,records_read:lineage.recordsRead,
    lineages_resolved:lineage.map.size,
    target_race_class_unavailable_horses:classUnknown,
    target_course_layout_unavailable_horses:layoutUnknown,
    original_v3_changed:false,original_v4_source_changed:false,
    target_2026_outcomes_used:false,model_trained:false,betting_ready:false,
    output_destination:"RUNNER_TEMP_ONLY",
  };
  await writeFile(path.join(OUT,"report.json"),JSON.stringify(report,null,2)+"\n");
  console.log("REAL_2026_238_PEDIGREE_V4 "+JSON.stringify(report));
}
await run();
