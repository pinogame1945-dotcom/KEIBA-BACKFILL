import { readFile, writeFile } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import { buildMlDataset } from "../src/ml-dataset.mjs";

const output = process.argv[2] || "/tmp/keiba-ml-smoke.jsonl.gz";
const dates = [
  "2022-06-25","2022-06-26",
  "2022-07-02","2022-07-03","2022-07-09","2022-07-10",
  "2022-07-16","2022-07-17","2022-07-23","2022-07-24",
  "2022-07-30","2022-07-31",
  "2022-08-06","2022-08-07","2022-08-13","2022-08-14",
  "2022-08-20","2022-08-21","2022-08-27","2022-08-28",
  "2022-09-03","2022-09-04","2022-09-10","2022-09-11",
  "2022-09-17","2022-09-18","2022-09-19","2022-09-24",
  "2022-09-25","2022-10-01",
];

const rows = [];
for (const date of dates) {
  const zipped = await readFile("data/daily/" + date + ".jsonl.gz");
  const text = gunzipSync(zipped).toString("utf8").trim();
  if (text) rows.push(...text.split("\n").map(JSON.parse));
}

const dataset = buildMlDataset(rows, {
  startDate: "2022-07-23",
  endDate: "2022-10-01",
  historyLimit: 5,
});
if (!dataset.length) throw new Error("empty ML smoke dataset");

const lines = dataset.map(row => JSON.stringify(row)).join("\n") + "\n";
await writeFile(output, gzipSync(Buffer.from(lines, "utf8"), { level: 9 }));

console.log(JSON.stringify({
  ok: true,
  output,
  source_dates: dates.length,
  source_races: rows.length,
  dataset_rows: dataset.length,
  dataset_races: new Set(dataset.map(row => row.race_id)).size,
  rows_with_history: dataset.filter(row => Number(row.features?.prior_starts ?? 0) > 0).length,
}, null, 2));
