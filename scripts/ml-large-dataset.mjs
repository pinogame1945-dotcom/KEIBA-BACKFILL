import { readFile, readdir, writeFile } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { buildMlDataset } from "../src/ml-dataset.mjs";

const output = process.argv[2] || "/tmp/keiba-ml-large.jsonl.gz";
const sourceStart = "2021-01-01";
const sourceEnd = "2025-12-31";
const emitStart = "2022-01-01";
const emitEnd = "2025-12-31";

const dir = "data/daily";
const names = (await readdir(dir))
  .filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl\.gz$/.test(name))
  .sort()
  .filter(name => {
    const date = name.slice(0, 10);
    return date >= sourceStart && date <= sourceEnd;
  });

if (!names.length) throw new Error("no daily files in requested range");

const rows = [];
for (const name of names) {
  const zipped = await readFile(dir + "/" + name);
  const text = gunzipSync(zipped).toString("utf8").trim();
  if (text) rows.push(...text.split("\n").map(JSON.parse));
}

const dataset = buildMlDataset(rows, {
  startDate: emitStart,
  endDate: emitEnd,
  historyLimit: 5,
});
if (!dataset.length) throw new Error("empty large ML dataset");

const lines = dataset.map(row => JSON.stringify(row)).join("\n") + "\n";
await writeFile(output, gzipSync(Buffer.from(lines, "utf8"), { level: 6 }));

const byYear = {};
for (const row of dataset) {
  const year = row.features?.race_date?.slice(0, 4) ?? "unknown";
  byYear[year] ??= { rows: 0, races: new Set() };
  byYear[year].rows += 1;
  byYear[year].races.add(row.race_id);
}

const yearSummary = Object.fromEntries(
  Object.entries(byYear).map(([year, value]) => [
    year,
    { rows: value.rows, races: value.races.size },
  ]),
);

console.log("ML_LARGE_DATASET_READY");
console.log(JSON.stringify({
  ok: true,
  output,
  source_start: sourceStart,
  source_end: sourceEnd,
  source_files: names.length,
  source_races: rows.length,
  emit_start: emitStart,
  emit_end: emitEnd,
  dataset_rows: dataset.length,
  dataset_races: new Set(dataset.map(row => row.race_id)).size,
  rows_with_history: dataset.filter(row => Number(row.features?.prior_starts ?? 0) > 0).length,
  by_year: yearSummary,
}, null, 2));
