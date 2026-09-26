import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  buildMlDataset,
  buildRaceOutcomes,
  ML_DATASET_VERSION,
  ML_FEATURE_SCHEMA_VERSION,
  ML_LEAKAGE_POLICY,
} from "./ml-dataset.mjs";

function arg(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : null;
}

function validDate(value, label) {
  if (value == null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`invalid ${label}: ${value}`);
  return value;
}

async function loadDailyRows({ endDate }) {
  const dir = path.join("data", "daily");
  const names = (await readdir(dir))
    .filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(name))
    .sort()
    .filter(name => !endDate || name.slice(0, 10) <= endDate);

  const rows = [];
  const digest = createHash("sha256");
  for (const name of names) {
    const full = path.join(dir, name);
    const zipped = await readFile(full);
    digest.update(name);
    digest.update(zipped);
    const text = gunzipSync(zipped).toString("utf8").trim();
    if (!text) continue;
    for (const line of text.split("\n")) rows.push(JSON.parse(line));
  }
  return { rows, names, sourceDigest: digest.digest("hex") };
}

async function loadManifest() {
  try {
    return JSON.parse(await readFile(path.join("data", "ml", "manifest.json"), "utf8"));
  } catch {
    return { schema_version: 1, datasets: {} };
  }
}

const startDate = validDate(arg("--start"), "--start");
const endDate = validDate(arg("--end"), "--end");
const historyLimit = Number(arg("--history-limit") ?? 5);
const name = arg("--name") ?? `ml-v${ML_DATASET_VERSION}-${startDate ?? "all"}-to-${endDate ?? "latest"}`;
if (startDate && endDate && startDate > endDate) throw new Error("--start must be <= --end");
if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("--name contains unsupported characters");

const loaded = await loadDailyRows({ endDate });
const dataset = buildMlDataset(loaded.rows, { startDate, endDate, historyLimit });
const raceOutcomes = buildRaceOutcomes(loaded.rows, { startDate, endDate });
const raceCount = new Set(dataset.map(row => row.race_id)).size;
const horseCount = new Set(dataset.map(row => row.horse_id)).size;
const outDir = path.join("data", "ml", "datasets");
await mkdir(outDir, { recursive: true });
const outPath = path.join(outDir, `${name}.jsonl.gz`);
const lines = dataset.map(row => JSON.stringify(row)).join("\n") + (dataset.length ? "\n" : "");
await writeFile(outPath, gzipSync(Buffer.from(lines, "utf8"), { level: 9 }));

const raceOutcomeDir = path.join("data", "ml", "race-outcomes");
await mkdir(raceOutcomeDir, { recursive: true });
const raceOutcomePath = path.join(raceOutcomeDir, `${name}.jsonl.gz`);
const raceOutcomeLines = raceOutcomes.map(row => JSON.stringify(row)).join("\n") + (raceOutcomes.length ? "\n" : "");
await writeFile(raceOutcomePath, gzipSync(Buffer.from(raceOutcomeLines, "utf8"), { level: 9 }));

const manifest = await loadManifest();
manifest.schema_version = 1;
manifest.updated_at = new Date().toISOString();
manifest.datasets ??= {};
manifest.datasets[name] = {
  status: "SUCCESS",
  ml_dataset_version: ML_DATASET_VERSION,
  feature_schema_version: ML_FEATURE_SCHEMA_VERSION,
  leakage_policy: ML_LEAKAGE_POLICY,
  generated_at: new Date().toISOString(),
  start_date: startDate,
  end_date: endDate,
  history_limit: historyLimit,
  source_files: loaded.names,
  source_digest_sha256: loaded.sourceDigest,
  rows: dataset.length,
  races: raceCount,
  horses: horseCount,
  file: outPath.replaceAll("\\", "/"),
  race_outcomes: raceOutcomes.length,
  race_outcome_file: raceOutcomePath.replaceAll("\\", "/"),
};
await mkdir(path.join("data", "ml"), { recursive: true });
await writeFile(path.join("data", "ml", "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(JSON.stringify({
  ok: true,
  dataset: name,
  rows: dataset.length,
  races: raceCount,
  horses: horseCount,
  sourceFiles: loaded.names.length,
  output: outPath,
  raceOutcomeOutput: raceOutcomePath,
  leakagePolicy: ML_LEAKAGE_POLICY,
}, null, 2));
