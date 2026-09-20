import { load } from "cheerio";
import Encoding from "encoding-japanese";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";

const DB_BASE = "https://db.netkeiba.com";
const JRA_VENUES = new Set(["01","02","03","04","05","06","07","08","09","10"]);
const USER_AGENT = "KEIBA-BACKFILL/0.1 (+https://github.com/pinogame1945-dotcom/KEIBA-BACKFILL)";
const MIN_DELAY_MS = 1000;
const delayMs = Math.max(MIN_DELAY_MS, Number(process.env.REQUEST_DELAY_MS || 1500));
let lastFetchAt = 0;

function clean(v) {
  return (v ?? "").replace(/\s+/g, " ").trim();
}
function intOrNull(v) {
  const n = Number.parseInt(clean(v).replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}
function floatOrNull(v) {
  const n = Number.parseFloat(clean(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
function horseId(href) {
  return href?.match(/\/horse\/(\d+)/)?.[1] ?? null;
}
function jockeyId(href) {
  return href?.match(/\/jockey\/(?:result\/recent\/)?(\d+)/)?.[1] ?? null;
}
function trainerId(href) {
  return href?.match(/\/trainer\/(?:result\/recent\/)?(\d+)/)?.[1] ?? null;
}
function ownerId(href) {
  return href?.match(/\/owner\/(?:result\/recent\/)?(\d+)/)?.[1] ?? null;
}
function finishTimeMs(value) {
  const m = clean(value).match(/^(?:(\d+):)?(\d+)\.(\d)$/);
  if (!m) return null;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 1000) + Number(m[3]) * 100;
}
function bodyWeight(value) {
  const text = clean(value);
  const m = text.match(/(\d+)\s*\(([+-]?\d+)\)/);
  if (m) return [Number(m[1]), Number(m[2])];
  return [intOrNull(text), null];
}
function resultStatus(value) {
  const text = clean(value);
  const pos = intOrNull(text);
  if (pos != null) return ["FINISHED", pos];
  if (text.includes("取消")) return ["SCRATCHED", null];
  if (text.includes("除外")) return ["EXCLUDED", null];
  if (text.includes("失格")) return ["DISQUALIFIED", null];
  if (text.includes("中止")) return ["DNF", null];
  return [text || "UNKNOWN", null];
}
function directCells($, row, all = false) {
  const children = $(row).children();
  return all ? children.filter("th,td") : children.filter("td");
}
function splitCellLines($, cell) {
  const clone = cell.clone();
  clone.find("br").each((_, br) => $(br).replaceWith("\n"));
  const lines = clone.text().split(/\n+/).map(clean).filter(Boolean);
  return lines.length ? lines : [clean(clone.text())].filter(Boolean);
}
function valueAt(values, index) {
  if (index < values.length) return values[index] ?? null;
  return values.length === 1 ? values[0] ?? null : null;
}
function decode(bytes) {
  const detected = Encoding.detect(bytes) || "EUCJP";
  return Encoding.convert(bytes, { to: "UNICODE", from: detected, type: "string" });
}
async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}
async function politeFetch(url) {
  const wait = delayMs - (Date.now() - lastFetchAt);
  if (wait > 0) await sleep(wait);

  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await fetch(url, {
      headers: {
        "Accept-Language": "ja,en;q=0.5",
        "User-Agent": USER_AGENT
      }
    });
    lastFetchAt = Date.now();

    if (response.status === 403 || response.status === 429) {
      throw new Error(`RATE_LIMIT HTTP ${response.status} ${url}`);
    }
    if (response.ok) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      const text = decode(bytes);
      if (/アクセス制限|通信制限|不正なアクセス/.test(text)) {
        throw new Error(`RATE_LIMIT content ${url}`);
      }
      return text;
    }

    if (attempt === 2 || response.status < 500) {
      throw new Error(`HTTP ${response.status} ${url}`);
    }
    await sleep(5000);
  }
  throw new Error(`fetch failed ${url}`);
}

function parseRaceList(html) {
  const $ = load(html);
  const ids = new Set();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const m = href.match(/\/race\/(\d{12})\/?/);
    if (!m) return;
    const id = m[1];
    if (JRA_VENUES.has(id.slice(4, 6))) ids.add(id);
  });
  return [...ids].sort();
}

function parseRaceResult(html, raceId, fallbackDate, sourceUrl) {
  const $ = load(html);
  const titleCandidate = clean($("title").first().text()).split(/[｜|]/)[0]?.trim() || null;
  const raceName = clean($("h1").first().text()) || clean($(".race_name").first().text()) || titleCandidate || null;
  const pageText = clean($.root().text());
  const dm = pageText.match(/((?:19|20)\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  const actualDate = dm
    ? `${dm[1]}-${String(Number(dm[2])).padStart(2,"0")}-${String(Number(dm[3])).padStart(2,"0")}`
    : fallbackDate;

  const meta = $(".data_intro").first().length
    ? clean($(".data_intro").first().text())
    : $(".race_head").first().length
      ? clean($(".race_head").first().text())
      : pageText;

  const distance = intOrNull(meta.match(/(\d{3,4})m/)?.[1]);
  const discipline = meta.includes("障") ? "OBSTACLE" : "FLAT";
  const surface = meta.includes("芝") && meta.includes("ダート")
    ? "MIXED"
    : meta.includes("芝")
      ? "TURF"
      : meta.includes("ダ")
        ? "DIRT"
        : null;
  const direction = meta.includes("左") ? "LEFT" : meta.includes("右") ? "RIGHT" : null;
  const weather = meta.match(/天候\s*[:：]?\s*([^ /]+)/)?.[1] ?? null;
  const track = meta.match(/馬場\s*[:：]?\s*([^ /]+)/)?.[1] ?? null;
  const startTime = meta.match(/(\d{1,2}:\d{2})発走/)?.[1] ?? null;

  const table = $("table.race_table_01").first().length
    ? $("table.race_table_01").first()
    : $("table[class*='race_table']").first();
  if (!table.length) throw new Error("result table not found: " + raceId);

  const headers = [];
  table.find("tr").first().find("th").each((i, el) => { headers[i] = clean($(el).text()); });
  const findCol = (...needles) =>
    headers.findIndex(h => needles.some(n => h.replace(/\s/g,"").includes(n.replace(/\s/g,""))));
  const idx = {
    finish: findCol("着順"), gate: findCol("枠"), number: findCol("馬番"),
    horse: findCol("馬名"), sexage: findCol("性齢"), weight: findCol("斤量"),
    jockey: findCol("騎手"), time: findCol("タイム"), margin: findCol("着差"),
    corner: findCol("通過"), last3f: findCol("上り","上がり"), odds: findCol("単勝"),
    popularity: findCol("人気"), body: findCol("馬体重"), trainer: findCol("調教師"),
    owner: findCol("馬主"), prize: findCol("賞金")
  };

  const entries = [];
  const results = [];
  table.find("tr").each((_, tr) => {
    const cells = directCells($, tr);
    if (!cells.length) return;
    const cellText = index => index >= 0 ? clean(cells.eq(index).text()) : "";
    const horseCell = idx.horse >= 0 ? cells.eq(idx.horse) : null;
    const ha = horseCell?.find("a[href*='/horse/']").first();
    const hid = horseId(ha?.attr("href"));
    if (!hid) return;

    const [status, official] = resultStatus(cellText(idx.finish));
    const [bw, bwDiff] = bodyWeight(cellText(idx.body));
    const sexAge = cellText(idx.sexage).match(/(牡|牝|セ)\s*(\d+)/);
    const jc = idx.jockey >= 0 ? cells.eq(idx.jockey) : null;
    const tc = idx.trainer >= 0 ? cells.eq(idx.trainer) : null;
    const oc = idx.owner >= 0 ? cells.eq(idx.owner) : null;
    const ja = jc?.find("a[href]").first();
    const ta = tc?.find("a[href]").first();
    const oa = oc?.find("a[href]").first();
    const rawCells = [];
    cells.each((__, td) => rawCells.push(clean($(td).text())));
    const marginRaw = cellText(idx.margin);

    entries.push({
      race_id: raceId,
      horse_id: hid,
      gate: intOrNull(cellText(idx.gate)),
      horse_number: intOrNull(cellText(idx.number)),
      horse_name: clean(ha?.text()) || cellText(idx.horse),
      sex: sexAge?.[1] ?? null,
      age: sexAge ? Number(sexAge[2]) : null,
      carried_weight: floatOrNull(cellText(idx.weight)),
      jockey_id: jockeyId(ja?.attr("href")),
      jockey_name: clean(ja?.text()) || cellText(idx.jockey),
      trainer_id: trainerId(ta?.attr("href")),
      trainer_name: clean(ta?.text()) || cellText(idx.trainer),
      owner_id: ownerId(oa?.attr("href")),
      owner_name: clean(oa?.text()) || cellText(idx.owner),
      body_weight: bw,
      body_weight_diff: bwDiff,
      entry_status: status === "SCRATCHED" || status === "EXCLUDED" ? status : "STARTED"
    });
    results.push({
      race_id: raceId,
      horse_id: hid,
      official_finish_position: official,
      result_status: status,
      finish_time_ms: finishTimeMs(cellText(idx.time)),
      margin_raw: marginRaw || null,
      last_3f: floatOrNull(cellText(idx.last3f)),
      corner_raw: cellText(idx.corner) || null,
      win_odds: floatOrNull(cellText(idx.odds)),
      popularity: intOrNull(cellText(idx.popularity)),
      prize_money: floatOrNull(cellText(idx.prize))
    });
  });

  const payouts = [];
  const betMap = {
    "単勝":"WIN","複勝":"PLACE","枠連":"BRACKET_QUINELLA","馬連":"QUINELLA","ワイド":"WIDE",
    "馬単":"EXACTA","三連複":"TRIO","3連複":"TRIO","三連単":"TRIFECTA","3連単":"TRIFECTA"
  };
  $("tr").each((_, tr) => {
    const cells = directCells($, tr, true);
    if (cells.length < 2) return;
    const betType = betMap[clean(cells.eq(0).text())];
    if (!betType) return;
    const combinations = splitCellLines($, cells.eq(1));
    const amounts = splitCellLines($, cells.eq(2)).map(t => intOrNull(t.replace(/円/g,"")));
    const popularities = splitCellLines($, cells.eq(3)).map(t => intOrNull(t.replace(/人気/g,"")));
    const rowCount = Math.max(combinations.length, amounts.length, popularities.length, 1);
    for (let i = 0; i < rowCount; i++) {
      payouts.push({
        race_id: raceId,
        bet_type: betType,
        combination: valueAt(combinations, i),
        payout_yen: valueAt(amounts, i),
        popularity: valueAt(popularities, i)
      });
    }
  });

  const laps = [];
  const corners = [];
  $("tr").each((_, tr) => {
    const cells = directCells($, tr, true);
    if (cells.length < 2) return;
    const label = clean(cells.eq(0).text());
    if (label === "ラップ") {
      const raw = clean(cells.eq(1).text());
      [...raw.matchAll(/\d{1,2}\.\d/g)].map(m => Number(m[0])).forEach((value, i) => {
        laps.push({ race_id: raceId, segment_no: i + 1, lap_seconds: value });
      });
    }
    if (/[1-4]コーナー/.test(label)) {
      corners.push({ race_id: raceId, corner_label: label, passage_raw: clean(cells.eq(1).text()) });
    }
  });

  if (!entries.length) throw new Error("no horse rows parsed: " + raceId);

  return {
    schema_version: 1,
    race: {
      race_id: raceId,
      actual_date: actualDate,
      venue_code: raceId.slice(4,6),
      meeting_no: Number(raceId.slice(6,8)),
      meeting_day: Number(raceId.slice(8,10)),
      race_no: Number(raceId.slice(10,12)),
      race_name: raceName,
      race_status: "COMPLETED",
      discipline, surface, distance_m: distance, direction,
      weather, track_condition: track, actual_start_time: startTime,
      source_url: sourceUrl
    },
    entries, results, payouts, laps, corners
  };
}

async function loadManifest() {
  try {
    return JSON.parse(await readFile("data/manifest.json", "utf8"));
  } catch {
    return { schema_version: 1, days: {} };
  }
}
async function saveManifest(manifest) {
  await mkdir("data", { recursive: true });
  await writeFile("data/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
}

const date = process.argv[2] || process.env.BACKFILL_DATE;
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  throw new Error("Usage: node src/collect-day.mjs YYYY-MM-DD");
}

const compact = date.replace(/-/g, "");
const listUrl = `${DB_BASE}/race/list/${compact}/`;
console.log(`[discover] ${date} ${listUrl}`);
const listHtml = await politeFetch(listUrl);
const raceIds = parseRaceList(listHtml);
console.log(`[discover] ${raceIds.length} JRA races`);

const records = [];
for (let i = 0; i < raceIds.length; i++) {
  const raceId = raceIds[i];
  const raceUrl = `${DB_BASE}/race/${raceId}/`;
  console.log(`[race ${i + 1}/${raceIds.length}] ${raceId}`);
  const html = await politeFetch(raceUrl);
  records.push(parseRaceResult(html, raceId, date, raceUrl));
}

if (raceIds.length > 0 && records.length !== raceIds.length) {
  throw new Error(`coverage mismatch discovered=${raceIds.length} parsed=${records.length}`);
}

const lines = records.map(r => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
const outDir = path.join("data", "daily");
await mkdir(outDir, { recursive: true });
const outPath = path.join(outDir, `${date}.jsonl.gz`);
await writeFile(outPath, gzipSync(Buffer.from(lines, "utf8"), { level: 9 }));

const manifest = await loadManifest();
manifest.schema_version = 1;
manifest.updated_at = new Date().toISOString();
manifest.days[date] = {
  status: "SUCCESS",
  races_discovered: raceIds.length,
  races_parsed: records.length,
  file: outPath.replaceAll("\\","/"),
  request_delay_ms: delayMs
};
await saveManifest(manifest);

console.log(JSON.stringify({
  ok: true,
  date,
  races: records.length,
  entries: records.reduce((n,r) => n + r.entries.length, 0),
  payouts: records.reduce((n,r) => n + r.payouts.length, 0),
  output: outPath
}, null, 2));
