import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createMlDatasetProcessor } from "../src/ml-dataset.mjs";
import { createHistoricalExtraProcessor } from "../src/historical-extra-builder.mjs";
import { applyPredictionPhase } from "../src/l1-feature-contract.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
function pack(withResult = false) {
  const entries = [1, 2, 3].map(n => ({
    horse_id: "202410000" + n, horse_number: n, gate: n,
    entry_status: "RUNNER", sex: "M", age: 3, carried_weight: 56
  }));
  return {
    race: {
      race_id: "202605040301", actual_date: "2026-10-10",
      venue_code: "05", surface: "TURF", distance_m: 1600,
      weather: "SUNNY", track_condition: "GOOD", race_no: 1
    },
    entries,
    results: withResult ? entries.map((e, i) => ({
      horse_id: e.horse_id, official_finish_position: i + 1,
      result_status: "FINISHED"
    })) : []
  };
}

test("historical mode remains result-dependent", () => {
  const p = createMlDatasetProcessor({ includeAutoFeatures: true });
  assert.equal(p.processDay([pack(false)], "2026-10-10").length, 0);
});
test("pre-race mode creates 3 fresh feature records without a result", () => {
  const p = createMlDatasetProcessor({ includeAutoFeatures: true });
  const rows = p.processDay([pack(false)], "2026-10-10", {
    allowUnresultedTargets: true
  });
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map(x => x.horse_id)).size, 3);
  for (const row of rows) {
    assert.equal(row.target, null);
    assert.equal(row.market_outcome, null);
    assert.equal(row.leakage_policy, "STRICT_PRIOR_DATE_ONLY");
    assert.equal(row.features.horse_number > 0, true);
  }
  assert.equal(p.debugStateSizes().history_horses, 0);
});
test("frozen historical feature numerics match with pre-race switch on", () => {
  const orig = createMlDatasetProcessor({ includeAutoFeatures: true });
  const now = createMlDatasetProcessor({ includeAutoFeatures: true });
  const a = orig.processDay([pack(true)], "2026-10-10");
  const c = now.processDay([pack(true)], "2026-10-10", {
    allowUnresultedTargets: true
  });
  assert.equal(a.length, 3);
  assert.deepEqual(c, a);
});
test("the original historical-extra family also scores unresulted starters", () => {
  const p = createHistoricalExtraProcessor();
  const x = p.processDay([pack(false)], "2026-10-10", {
    allowUnresultedTargets: true
  });
  assert.equal(x.size, 3);
  assert.equal(p.debugStateSizes().history_horses, 0);
});
test("existing prediction phase EARLY blocks unsafe same-day keys", () => {
  const out = applyPredictionPhase({
    weather: "SUNNY", track_condition: "GOOD",
    body_weight: 480, horse_number: 2
  }, "EARLY");
  assert.deepEqual(out, {horse_number: 2});
});
test("live target requires one final source date", () => {
  const result = spawnSync(process.execPath,
    [path.join(here, "../research/build-yearly-superset-snapshots.mjs"),
      "--allow-unresulted-targets",
      "--source-start", "2026-01-01",
      "--source-end", "2026-10-10",
      "--emit-start", "2026-10-09",
      "--emit-end", "2026-10-10",
      "--source-sha", "synthetic", "--ml-source-sha", "synthetic"],
    { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LIVE_TARGET_MUST_BE_ONE_FINAL_SOURCE_DATE/);
});
