import { load } from "cheerio";
import Encoding from "encoding-japanese";
import { mkdir, writeFile, readFile, unlink, access } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";

const DB_BASE = "https://db.netkeiba.com";
const JRA_VENUES = new Set(["01","02","03","04","05","06","07","08","09","10"]);
const JRA_VENUE_CODES = {
  "札幌":"01","函館":"02","福島":"03","新潟":"04","東京":"05",
  "中山":"06","中京":"07","京都":"08","阪神":"09","小倉":"10"
};
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
    const m = href.match(/\/race\/(\d{12})\/?/) ?? href.match(/[?&]race_id=(\d{12})/);
    if (!m) return;
    const id = m[1];
    if (JRA_VENUES.has(id.slice(4, 6))) ids.add(id);
  });
  for (const m of html.matchAll(/(?<!\d)((?:19|20)\d{10})(?!\d)/g)) {
    const id = m[1];
    if (JRA_VENUES.has(id.slice(4, 6))) ids.add(id);
  }
  return [...ids].sort();
}

function parseJraSchedule(html, year) {
  const $ = load(html);
  const text = clean($.root().text());
  const headingRe = /(\d+)回(札幌|函館|福島|新潟|東京|中山|中京|京都|阪神|小倉)(\d+)日/g;
  const matches = [...text.matchAll(headingRe)];
  const seenMeetings = new Set();
  const meetings = [];
  const raceIds = [];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const meetingNo = Number(m[1]);
    const venueName = m[2];
    const dayNo = Number(m[3]);
    const venueCode = JRA_VENUE_CODES[venueName];
    const key = `${venueCode}-${meetingNo}-${dayNo}`;
    if (!venueCode || seenMeetings.has(key)) continue;
    seenMeetings.add(key);

    const start = m.index ?? 0;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length;
    const chunk = text.slice(start, end);
    const raceNos = [...chunk.matchAll(/(?:^|\D)(\d{1,2})レース/g)]
      .map(x => Number(x[1]))
      .filter(n => n >= 1 && n <= 12);
    const uniqueRaceNos = [...new Set(raceNos)].sort((a,b)=>a-b);
    const finalRaceNos = uniqueRaceNos.length ? uniqueRaceNos : Array.from({length:12},(_,n)=>n+1);

    for (const raceNo of finalRaceNos) {
      raceIds.push(
        String(year) +
        venueCode +
        String(meetingNo).padStart(2,"0") +
        String(dayNo).padStart(2,"0") +
        String(raceNo).padStart(2,"0")
      );
    }
    meetings.push({ venue_name: venueName, venue_code: venueCode, meeting_no: meetingNo, day_no: dayNo, race_nos: finalRaceNos });
  }

  return { raceIds: [...new Set(raceIds)].sort(), meetings };
}

function parseVenueSummaryUrls(html, compactDate) {
  const $ = load(html);
  const urls = new Set();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const m = href.match(new RegExp(`/race/sum/(\\d{2})/${compactDate}/?`));
    if (!m || !JRA_VENUES.has(m[1])) return;
    urls.add(new URL(href, DB_BASE).toString());
  });
  return [...urls].sort();
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

  let table = $("table.race_table_01").first().length
    ? $("table.race_table_01").first()
    : $("table[class*='race_table']").first();
  if (!table.length) {
    $("table").each((_, candidate) => {
      if (table.length) return;
      const headerText = clean($(candidate).find("th").text());
      if (headerText.includes("着順") && headerText.includes("馬名")) table = $(candidate);
    });
  }
  if (!table.length) throw new Error("result table not found: " + raceId);

  const headers = [];
  table.find("tr").first().find("th").each((i, el) => { headers[i] = clean($(el).text()); });
  const findCol = (...needles) =>
    headers.findIndex(h => needles.some(n => h.replace(/\s/g,"").includes(n.replace(/\s/g,""))));
  const idx = {
    finish: findCol("着順"), gate: findCol("枠"), number: findCol("馬番"),
    horse: findCol("馬名"), sexage: findCol("性齢"), weight: findCol("斤量"),
    jockey: findCol("騎手"), time: findCol("タイム"), margin: findCol("着差"),
    corner: findCol("通過"), last3f: findCol("上り","上がり","後3F"), odds: findCol("単勝"),
    popularity: findCol("人気"), body: findCol("馬体重"), trainer: findCol("調教師","厩舎"),
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

const manifestAtStart = await loadManifest();
const dailyPath = path.join("data", "daily", `${date}.jsonl.gz`);
const existingDay = manifestAtStart.days?.[date];
const existingNoMeeting = manifestAtStart.non_meeting_days?.[date];
let dailyFileExists = false;
try {
  await access(dailyPath);
  dailyFileExists = true;
} catch {}

if (existingDay?.status === "SUCCESS") {
  const existingFile = existingDay.file || dailyPath;
  try {
    await access(existingFile);
  } catch {
    throw new Error(`manifest marks ${date} SUCCESS but file is missing: ${existingFile}`);
  }
  console.log(`[skip] existing SUCCESS daily pack for ${date}: ${existingFile}`);
  process.exit(0);
}

if (dailyFileExists) {
  throw new Error(`daily pack already exists without SUCCESS manifest; refusing to overwrite: ${dailyPath}`);
}

if (existingNoMeeting?.status === "CONFIRMED_NO_JRA") {
  const confirmations = Array.isArray(existingNoMeeting.confirmations) ? existingNoMeeting.confirmations : [];
  if (confirmations.length < 2) {
    throw new Error(`invalid non-meeting confirmation ledger for ${date}`);
  }
  console.log(`[skip] existing confirmed non-meeting day ${date}`);
  process.exit(0);
}

const compact = date.replace(/-/g, "");
const [yearText, monthText] = date.split("-");
const year = Number(yearText);
const month = String(Number(monthText));
const mmdd = compact.slice(4);
const jraScheduleUrl = `https://www.jra.go.jp/keiba/calendar${year}/${year}/${month}/${mmdd}.html`;

let listUrl = jraScheduleUrl;
let raceIds = [];
const discoveryDiagnostics = [];

try {
  console.log(`[discover:jra] ${date} ${jraScheduleUrl}`);
  const jraHtml = await politeFetch(jraScheduleUrl);
  const parsedJra = parseJraSchedule(jraHtml, year);
  raceIds = parsedJra.raceIds;
  const $jra = load(jraHtml);
  discoveryDiagnostics.push({
    url: jraScheduleUrl,
    source: "JRA_SCHEDULE",
    title: clean($jra("title").first().text()),
    html_length: jraHtml.length,
    race_ids_found: raceIds.length,
    meetings: parsedJra.meetings
  });
  console.log(`[discover:jra] found ${raceIds.length} race ids`);
} catch (error) {
  discoveryDiagnostics.push({
    url: jraScheduleUrl,
    source: "JRA_SCHEDULE",
    error: error instanceof Error ? error.message : String(error)
  });
}

if (raceIds.length === 0) {
  const discoveryUrls = [
    `${DB_BASE}/race/list/${compact}/`,
    `https://race.netkeiba.com/top/race_list.html?kaisai_date=${compact}`
  ];
  for (const candidate of discoveryUrls) {
    console.log(`[discover] ${date} ${candidate}`);
    try {
      const listHtml = await politeFetch(candidate);
      let ids = parseRaceList(listHtml);
      const $diag = load(listHtml);
      const hrefs = [];
      $diag("a[href]").each((_, el) => {
        const href = $diag(el).attr("href") ?? "";
        if (/race|kaisai/.test(href) && hrefs.length < 50) hrefs.push(href);
      });
      const venueSummaryUrls = parseVenueSummaryUrls(listHtml, compact);
      const venueDiagnostics = [];
      if (ids.length === 0 && venueSummaryUrls.length > 0) {
        const nestedIds = new Set();
        for (const summaryUrl of venueSummaryUrls) {
          console.log(`[discover:venue] ${summaryUrl}`);
          try {
            const summaryHtml = await politeFetch(summaryUrl);
            const summaryIds = parseRaceList(summaryHtml);
            summaryIds.forEach(id => nestedIds.add(id));
            venueDiagnostics.push({
              url: summaryUrl,
              race_ids_found: summaryIds.length,
              html_length: summaryHtml.length
            });
          } catch (error) {
            venueDiagnostics.push({
              url: summaryUrl,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
        ids = [...nestedIds].sort();
      }
      discoveryDiagnostics.push({
        url: candidate,
        source: "NETKEIBA_FALLBACK",
        title: clean($diag("title").first().text()),
        html_length: listHtml.length,
        race_ids_found: ids.length,
        venue_summary_urls: venueSummaryUrls,
        venue_diagnostics: venueDiagnostics,
        href_samples: hrefs
      });
      console.log(`[discover] candidate found ${ids.length} JRA races`);
      if (ids.length > 0) {
        listUrl = candidate;
        raceIds = ids;
        break;
      }
    } catch (error) {
      discoveryDiagnostics.push({
        url: candidate,
        source: "NETKEIBA_FALLBACK",
        error: error instanceof Error ? error.message : String(error)
      });
      console.warn(`[discover] candidate failed ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
console.log(`[discover] selected ${raceIds.length} JRA races`);
if (process.env.DEBUG_DISCOVERY === "1" || process.env.REQUIRE_RACES === "1") {
  await mkdir(path.join("data","debug"), { recursive: true });
  await writeFile(
    path.join("data","debug",`${date}.json`),
    JSON.stringify({ date, raceIds, discoveryDiagnostics }, null, 2) + "\n"
  );
}
if (process.env.REQUIRE_RACES === "1" && raceIds.length === 0) {
  throw new Error(`no JRA races discovered for required smoke date ${date}`);
}
if (process.env.SKIP_EMPTY === "1" && raceIds.length === 0) {
  const successfulZero = discoveryDiagnostics.filter(item =>
    !item.error &&
    item.race_ids_found === 0 &&
    Number(item.html_length ?? 0) >= 1000
  );
  const jraZero = successfulZero.filter(item => item.source === "JRA_SCHEDULE");
  const netkeibaZero = successfulZero.filter(item => item.source === "NETKEIBA_FALLBACK");
  const distinctNetkeibaUrls = new Set(netkeibaZero.map(item => item.url));
  const confirmed =
    (jraZero.length >= 1 && distinctNetkeibaUrls.size >= 1) ||
    distinctNetkeibaUrls.size >= 2;

  await mkdir(path.join("data","debug","non-meeting"), { recursive: true });
  const evidencePath = path.join("data","debug","non-meeting",`${date}.json`);
  await writeFile(
    evidencePath,
    JSON.stringify({
      date,
      confirmed,
      policy: "JRA_ZERO_PLUS_NETKEIBA_ZERO_OR_TWO_DISTINCT_NETKEIBA_ZERO",
      discoveryDiagnostics
    }, null, 2) + "\n"
  );

  if (!confirmed) {
    throw new Error(`UNCONFIRMED_EMPTY_DATE ${date}: insufficient independent zero-race evidence`);
  }

  const manifest = await loadManifest();
  manifest.schema_version = 1;
  manifest.days = manifest.days ?? {};
  manifest.non_meeting_days = manifest.non_meeting_days ?? {};
  manifest.updated_at = new Date().toISOString();
  manifest.non_meeting_days[date] = {
    status: "CONFIRMED_NO_JRA",
    confirmed_at: new Date().toISOString(),
    request_delay_ms: delayMs,
    policy: "JRA_ZERO_PLUS_NETKEIBA_ZERO_OR_TWO_DISTINCT_NETKEIBA_ZERO",
    confirmations: successfulZero.map(item => ({
      source: item.source,
      url: item.url,
      title: item.title ?? null,
      html_length: item.html_length,
      race_ids_found: 0
    })),
    evidence_file: evidencePath.replaceAll("\\","/")
  };
  await saveManifest(manifest);
  console.log(`[skip] confirmed no JRA meeting on ${date} with ${successfulZero.length} zero-race confirmations`);
  process.exit(0);
}

await unlink(path.join("data","debug",`${date}-error.json`)).catch(() => undefined);
const records = [];
for (let i = 0; i < raceIds.length; i++) {
  const raceId = raceIds[i];
  const resultUrls = [
    `https://race.netkeiba.com/race/result.html?race_id=${raceId}`,
    `${DB_BASE}/race/${raceId}/`
  ];
  console.log(`[race ${i + 1}/${raceIds.length}] ${raceId}`);
  try {
    let parsed = null;
    let lastError = null;
    for (const raceUrl of resultUrls) {
      try {
        const html = await politeFetch(raceUrl);
        parsed = parseRaceResult(html, raceId, date, raceUrl);
        break;
      } catch (error) {
        lastError = error;
        console.warn(`[race fallback] ${raceId} ${raceUrl}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!parsed) throw lastError ?? new Error(`all result sources failed: ${raceId}`);
    records.push(parsed);
  } catch (error) {
    await mkdir(path.join("data","debug"), { recursive: true });
    await writeFile(
      path.join("data","debug",`${date}-error.json`),
      JSON.stringify({
        date,
        race_id: raceId,
        race_index: i + 1,
        race_count: raceIds.length,
        parsed_before_error: records.length,
        error: error instanceof Error ? error.message : String(error)
      }, null, 2) + "\n"
    );
    throw error;
  }
}

if (raceIds.length > 0 && records.length !== raceIds.length) {
  throw new Error(`coverage mismatch discovered=${raceIds.length} parsed=${records.length}`);
}

const lines = records.map(r => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
const outDir = path.join("data", "daily");
await mkdir(outDir, { recursive: true });
const outPath = dailyPath;
await writeFile(outPath, gzipSync(Buffer.from(lines, "utf8"), { level: 9 }));

const manifest = await loadManifest();
manifest.schema_version = 1;
manifest.updated_at = new Date().toISOString();
manifest.days[date] = {
  status: "SUCCESS",
  races_discovered: raceIds.length,
  races_parsed: records.length,
  file: outPath.replaceAll("\\","/"),
  request_delay_ms: delayMs,
  discovery_url: listUrl
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
