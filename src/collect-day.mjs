import { load } from "cheerio";
import Encoding from "encoding-japanese";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { gunzipSync,gzipSync } from "node:zlib";
import path from "node:path";
import {access,rename} from "node:fs/promises";
import {
  normalizePayoutRows,PAYOUT_PARSER_VERSION,RACE_PACK_VERSION,
} from "./payout-normalization.mjs";
import {findLast3fColumn,parseLast3fSeconds,RESULT_PARSER_VERSION} from "./result-columns.mjs";
import {LAP_PARSER_VERSION,expectedLapSegments,parseRaceLaps} from "./lap-parser.mjs";
import {flatLast3fDayQuality,listSuspiciousFlatLast3f} from "./result-quality.mjs";
import {classifyRaceDiscipline,selectRaceMeta} from "./race-meta.mjs";
import {
  SCHEDULE_CONTRACT_VERSION,SCHEDULE_SAFE_RACE_PACK_VERSION,
  cancellationEventFromMeeting,meetingKeyFromRaceId,parseJraMeetingScheduleText,
  rescheduleEventFromMeeting,rescheduleEventFromRaceDates,scheduleForRace,
  scheduleIntegrityEnabled,upsertCancellationEvents,upsertRescheduleEvents,
  validateRaceOwnership,
} from "./schedule-integrity.mjs";

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
const scheduleIntegrity=scheduleIntegrityEnabled();
const effectiveRacePackVersion=scheduleIntegrity
  ?SCHEDULE_SAFE_RACE_PACK_VERSION
  :RACE_PACK_VERSION;

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
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const wait = delayMs - (Date.now() - lastFetchAt);
    if (wait > 0) await sleep(wait);

    let response;
    try {
      response = await fetch(url, {
        headers: {
          "Accept-Language": "ja,en;q=0.5",
          "User-Agent": USER_AGENT
        }
      });
      lastFetchAt = Date.now();
    } catch (error) {
      lastFetchAt = Date.now();
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === maxAttempts) {
        throw new Error(`NETWORK_FETCH_FAILED after ${maxAttempts} attempts ${url}: ${message}`);
      }
      console.warn(`[fetch] transient network failure attempt ${attempt}/${maxAttempts} ${url}: ${message}`);
      await sleep(5000 * attempt);
      continue;
    }

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

    if (attempt === maxAttempts || response.status < 500) {
      throw new Error(`HTTP ${response.status} ${url}`);
    }
    await sleep(5000 * attempt);
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

function parseJraScheduleLegacy(html, year) {
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

function parseJraSchedule(html,year,date){
  if(!scheduleIntegrity)return parseJraScheduleLegacy(html,year);
  const $=load(html);
  return parseJraMeetingScheduleText(clean($.root().text()),{
    year,date,venueCodes:JRA_VENUE_CODES,
  });
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
  const raceName = clean($(".RaceName").first().text()) || clean($("h1").first().text()) || clean($(".race_name").first().text()) || titleCandidate || null;
  const pageText = clean($.root().text());
  const dm = pageText.match(/((?:19|20)\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  const actualDate = dm
    ? `${dm[1]}-${String(Number(dm[2])).padStart(2,"0")}-${String(Number(dm[3])).padStart(2,"0")}`
    : fallbackDate;

  const meta = selectRaceMeta($);

  const distance = intOrNull(meta.match(/(\d{3,4})m/)?.[1]);
  const discipline = classifyRaceDiscipline(meta,raceName);
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

  let table = $("table.race_table_01").first();
  if (!table.length) table = $("table.RaceTable01").first();
  if (!table.length) table = $("#All_Result_Table table").first();
  if (!table.length) table = $("table[class*='race_table']").first();
  if (!table.length) table = $("table[class*='RaceTable']").first();
  if (!table.length) {
    $("table").each((_, candidate) => {
      if (table.length) return;
      const headerText = clean($(candidate).find("th").text()).replace(/\s/g,"");
      if (
        headerText.includes("着順") &&
        headerText.includes("馬名") &&
        (headerText.includes("騎手") || headerText.includes("タイム"))
      ) table = $(candidate);
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
    corner: findCol("通過"), last3f: findLast3fColumn(headers), odds: findCol("単勝"),
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
      last_3f: parseLast3fSeconds(cellText(idx.last3f)),
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
    payouts.push(...normalizePayoutRows({
      raceId,
      betType,
      combinationLines: splitCellLines($, cells.eq(1)),
      amountLines: splitCellLines($, cells.eq(2)),
      popularityLines: splitCellLines($, cells.eq(3)),
    }));
  });

  const laps = parseRaceLaps($,raceId,distance);
  const corners = [];
  $("tr").each((_, tr) => {
    const cells = directCells($, tr, true);
    if (cells.length < 2) return;
    const label = clean(cells.eq(0).text());
    if (/[1-4]コーナー/.test(label)) {
      corners.push({ race_id: raceId, corner_label: label, passage_raw: clean(cells.eq(1).text()) });
    }
  });

  if (!entries.length) throw new Error("no horse rows parsed: " + raceId);

  return {
    schema_version: 1,
    race_pack_version: effectiveRacePackVersion,
    payout_parser_version: PAYOUT_PARSER_VERSION,
    result_parser_version: RESULT_PARSER_VERSION,
    lap_parser_version: LAP_PARSER_VERSION,
    ...(scheduleIntegrity?{schedule_contract_version:SCHEDULE_CONTRACT_VERSION}:{}),
    race: {
      race_id: raceId,
      actual_date: actualDate,
      ...(scheduleIntegrity?{scheduled_date:fallbackDate,schedule_status:"ACTIVE"}:{}),
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

async function repairRescheduledTargetPacks(manifest,events){
  if(!scheduleIntegrity||!events.length)return [];
  const repaired=[];
  // The manifest ledger is canonical. Raw discovery can emit multiple candidates
  // for the same meeting while walking adjacent historical dates.
  const canonicalEvents=new Map();
  for(const candidate of events.filter(Boolean)){
    const event=manifest.rescheduled_meetings?.[candidate.meeting_key]??candidate;
    if(event?.status!=="RESCHEDULED"||!event.meeting_key||!event.actual_date)continue;
    canonicalEvents.set(event.meeting_key,event);
  }
  const byActual=new Map();
  for(const event of canonicalEvents.values()){
    const list=byActual.get(event.actual_date)??[];
    list.push(event);
    byActual.set(event.actual_date,list);
  }
  for(const [actualDate,dateEvents] of byActual){
    const entry=manifest.days?.[actualDate];
    if(!entry?.file)continue;
    let bytes;
    try{bytes=await readFile(entry.file);}catch{continue;}
    const text=gunzipSync(bytes).toString("utf8").trim();
    const rows=text?text.split("\n").map(JSON.parse):[];
    let changed=false;
    for(const row of rows){
      const key=meetingKeyFromRaceId(row?.race?.race_id);
      const event=dateEvents.find(item=>item.meeting_key===key);
      if(!event)continue;
      if(String(row?.race?.actual_date??"")!==actualDate){
        throw new Error("target pack actual_date mismatch during reschedule repair: "+actualDate+" / "+String(row?.race?.race_id??""));
      }
      // Always converge the row to the canonical ledger. Keeping the earlier
      // row value here can preserve a stale candidate and split pack vs ledger.
      const scheduled=String(event.scheduled_date??"");
      if(!scheduled){
        throw new Error("reschedule ledger missing scheduled_date during repair: "+event.meeting_key);
      }
      if(row.race.scheduled_date!==scheduled||row.race.schedule_status!=="RESCHEDULED"||
         Number(row.race_pack_version??0)<SCHEDULE_SAFE_RACE_PACK_VERSION||
         Number(row.schedule_contract_version??0)<SCHEDULE_CONTRACT_VERSION){
        row.race.scheduled_date=scheduled;
        row.race.schedule_status="RESCHEDULED";
        row.race_pack_version=SCHEDULE_SAFE_RACE_PACK_VERSION;
        row.schedule_contract_version=SCHEDULE_CONTRACT_VERSION;
        changed=true;
      }
    }
    if(!changed)continue;
    rows.forEach(row=>validateRaceOwnership(row,actualDate));
    const out=rows.map(row=>JSON.stringify(row)).join("\n")+(rows.length?"\n":"");
    const tmp=entry.file+".schedule-v1.tmp";
    await writeFile(tmp,gzipSync(Buffer.from(out,"utf8"),{level:9}));
    await rename(tmp,entry.file);
    entry.race_pack_version=Math.max(
      Number(entry.race_pack_version??0),SCHEDULE_SAFE_RACE_PACK_VERSION,
    );
    entry.schedule_contract_version=SCHEDULE_CONTRACT_VERSION;
    entry.reschedule_repaired_at=new Date().toISOString();
    entry.rescheduled_meetings=[
      ...new Set([
        ...(entry.rescheduled_meetings??[]),
        ...dateEvents.map(item=>item.meeting_key),
      ]),
    ];
    repaired.push(actualDate);
  }
  return repaired;
}

const date = process.argv[2] || process.env.BACKFILL_DATE;
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  throw new Error("Usage: node src/collect-day.mjs YYYY-MM-DD");
}

const rebuildLegacy = process.env.REBUILD_LEGACY_PAYOUT_V1 === "1";
const forceRecollectCurrent = process.env.FORCE_RECOLLECT_CURRENT === "1";
const dailyPath = path.join("data","daily",`${date}.jsonl.gz`);
const manifestAtStart = await loadManifest();
const existingDay = manifestAtStart.days?.[date];
let dailyFileExists = false;
try {
  await access(dailyPath);
  dailyFileExists = true;
} catch {}

const scheduleUpgradeExisting=Boolean(
  scheduleIntegrity&&existingDay?.status==="SUCCESS"&&(
    Number(existingDay.race_pack_version??0)<SCHEDULE_SAFE_RACE_PACK_VERSION||
    Number(existingDay.schedule_contract_version??0)<SCHEDULE_CONTRACT_VERSION
  )
);
const resultParserUpgradeExisting=Boolean(
  existingDay?.status==="SUCCESS"&&
  Number(existingDay.result_parser_version??1)<RESULT_PARSER_VERSION
);
const lapParserUpgradeExisting=Boolean(
  existingDay?.status==="SUCCESS"&&
  Number(existingDay.lap_parser_version??1)<LAP_PARSER_VERSION
);
if (existingDay?.status === "SUCCESS" &&
    !forceRecollectCurrent &&
    !resultParserUpgradeExisting &&
    !lapParserUpgradeExisting &&
    Number(existingDay.race_pack_version ?? 1) >= effectiveRacePackVersion &&
    Number(existingDay.payout_parser_version ?? 1) >= PAYOUT_PARSER_VERSION &&
    (!scheduleIntegrity||
      Number(existingDay.schedule_contract_version??0)>=SCHEDULE_CONTRACT_VERSION)) {
  if (!dailyFileExists) {
    throw new Error(`manifest marks ${date} current SUCCESS but file is missing: ${dailyPath}`);
  }
  console.log(`[skip] existing current race pack for ${date}`);
  process.exit(0);
}
if(
  forceRecollectCurrent&&existingDay?.status==="SUCCESS"&&
  !resultParserUpgradeExisting&&!lapParserUpgradeExisting&&!scheduleUpgradeExisting
){
  if(!dailyFileExists){
    throw new Error(`cannot force-recollect missing current pack: ${dailyPath}`);
  }
  console.log(`[probe] force recollect current SUCCESS day ${date}`);
}

const legacyExisting = Boolean(existingDay) &&
  (
    existingDay.status === "LEGACY_PAYOUT_V1" ||
    Number(existingDay.race_pack_version ?? 1) < RACE_PACK_VERSION ||
    Number(existingDay.payout_parser_version ?? 1) < PAYOUT_PARSER_VERSION
  );

if (legacyExisting && !rebuildLegacy) {
  throw new Error(
    `LEGACY_PAYOUT_V1 ${date}: refusing to reuse or overwrite old payout pack; run explicit repair mode`
  );
}
if (
  dailyFileExists&&!forceRecollectCurrent&&!legacyExisting&&
  !scheduleUpgradeExisting&&!resultParserUpgradeExisting&&!lapParserUpgradeExisting
) {
  throw new Error(`daily race pack already exists without compatible manifest metadata: ${dailyPath}`);
}
if (legacyExisting && rebuildLegacy) {
  console.log(`[repair] rebuilding legacy payout-v1 race pack for ${date}`);
}
if(scheduleUpgradeExisting){
  console.log(`[repair] upgrading race pack to schedule contract v${SCHEDULE_CONTRACT_VERSION} for ${date}`);
}
if(resultParserUpgradeExisting){
  console.log(`[repair] rebuilding result parser v${Number(existingDay.result_parser_version??1)} pack with result parser v${RESULT_PARSER_VERSION} for ${date}`);
}
if(lapParserUpgradeExisting){
  console.log(`[repair] rebuilding lap parser v1 pack with lap parser v${LAP_PARSER_VERSION} for ${date}`);
}

const existingNoMeeting = manifestAtStart.non_meeting_days?.[date];
if (existingNoMeeting?.status === "CONFIRMED_NO_JRA") {
  const confirmations = Array.isArray(existingNoMeeting.confirmations)
    ? existingNoMeeting.confirmations
    : [];
  const distinctUrls = new Set(confirmations.map(item => String(item.url ?? "")).filter(Boolean));
  if (confirmations.length < 2 || distinctUrls.size < 2) {
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
const rescheduleEvents=[];
const cancelledEvents=[];
let jraHasUnknownMeeting=false;

try {
  console.log(`[discover:jra] ${date} ${jraScheduleUrl}`);
  const jraHtml = await politeFetch(jraScheduleUrl);
  const parsedJra = parseJraSchedule(jraHtml,year,date);
  raceIds = parsedJra.raceIds;
  if(scheduleIntegrity){
    for(const meeting of parsedJra.meetings){
      const event=rescheduleEventFromMeeting(meeting);
      if(event)rescheduleEvents.push(event);
      const cancelled=cancellationEventFromMeeting(meeting);
      if(cancelled)cancelledEvents.push(cancelled);
      if(meeting.status==="UNKNOWN")jraHasUnknownMeeting=true;
    }
  }
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

if (raceIds.length === 0 || (scheduleIntegrity&&jraHasUnknownMeeting)) {
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
        raceIds=[...new Set([...raceIds,...ids])].sort();
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
if(
  scheduleIntegrity&&raceIds.length===0&&
  (rescheduleEvents.length>0||cancelledEvents.length>0)
){
  const manifest=await loadManifest();
  manifest.schema_version=1;
  manifest.days=manifest.days??{};
  manifest.updated_at=new Date().toISOString();
  upsertRescheduleEvents(manifest,rescheduleEvents);
  upsertCancellationEvents(manifest,cancelledEvents);
  const repairedTargets=await repairRescheduledTargetPacks(manifest,rescheduleEvents);
  delete manifest.days[date];
  if(manifest.non_meeting_days)delete manifest.non_meeting_days[date];
  manifest.schedule_exception_days=manifest.schedule_exception_days??{};
  manifest.schedule_exception_days[date]={
    status:"NO_RACES_HELD",
    schedule_contract_version:SCHEDULE_CONTRACT_VERSION,
    rescheduled_meetings:[...new Set(rescheduleEvents.map(item=>item.meeting_key))],
    cancelled_meetings:[...new Set(cancelledEvents.map(item=>item.meeting_key))],
    updated_at:new Date().toISOString(),
  };
  manifest.race_pack_version=Math.max(
    Number(manifest.race_pack_version??1),effectiveRacePackVersion,
  );
  manifest.payout_parser_version=Math.max(
    Number(manifest.payout_parser_version??1),PAYOUT_PARSER_VERSION,
  );
  await saveManifest(manifest);
  console.log(JSON.stringify({
    ok:true,date,races:0,scheduleExceptionOnly:true,
    repairedTargets,
    rescheduledMeetings:manifest.schedule_exception_days[date].rescheduled_meetings,
    cancelledMeetings:manifest.schedule_exception_days[date].cancelled_meetings,
  },null,2));
  process.exit(0);
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
let rescheduledAway=0;
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
        if(parsed.race.discipline==="FLAT"){
          const expected=expectedLapSegments(parsed.race.distance_m);
          if(expected>0&&parsed.laps.length!==expected){
            throw new Error(
              `FLAT_LAPS_INCOMPLETE ${raceId}: expected=${expected} actual=${parsed.laps.length}`
            );
          }
        }
        break;
      } catch (error) {
        lastError = error;
        console.warn(`[race fallback] ${raceId} ${raceUrl}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!parsed) throw lastError ?? new Error(`all result sources failed: ${raceId}`);
    if(scheduleIntegrity&&parsed.race.actual_date!==date){
      const event=rescheduleEventFromRaceDates(
        raceId,date,parsed.race.actual_date,
      );
      if(event)rescheduleEvents.push(event);
      rescheduledAway+=1;
      console.log(`[rescheduled] ${raceId} owner ${date} -> ${parsed.race.actual_date}; excluded from ${date} pack`);
      continue;
    }
    if(scheduleIntegrity){
      const schedule=scheduleForRace(manifestAtStart,raceId,parsed.race.actual_date);
      parsed.race.scheduled_date=schedule.scheduledDate;
      parsed.race.schedule_status=schedule.status;
      parsed.race_pack_version=effectiveRacePackVersion;
      parsed.schedule_contract_version=SCHEDULE_CONTRACT_VERSION;
      validateRaceOwnership(parsed,date);
    }
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

if (raceIds.length > 0 && records.length+rescheduledAway !== raceIds.length) {
  throw new Error(
    `coverage mismatch discovered=${raceIds.length} parsed=${records.length} rescheduled=${rescheduledAway}`
  );
}

const finishedResults=records.flatMap(row=>row.results??[]).filter(row=>
  row?.result_status==="FINISHED"&&row?.official_finish_position!=null
);
const timedResults=finishedResults.filter(row=>row?.finish_time_ms!=null);
const finishTimeCoverage=finishedResults.length?timedResults.length/finishedResults.length:0;
const flatLast3f=flatLast3fDayQuality(records);
const flatLapTargets=records.filter(row=>
  row?.race?.discipline==="FLAT"&&expectedLapSegments(row?.race?.distance_m)>0
);
const completeLapRaces=flatLapTargets.filter(row=>
  row.laps?.length===expectedLapSegments(row?.race?.distance_m)
).length;
const flatRaceCount=records.filter(row=>row?.race?.discipline==="FLAT").length;
const obstacleRaceCount=records.filter(row=>row?.race?.discipline==="OBSTACLE").length;
const resultQuality={
  finished_results:finishedResults.length,
  finish_time_present:timedResults.length,
  last3f_scope:"FLAT",
  flat_finished_results:flatLast3f.finishedResults,
  flat_finish_time_present:flatLast3f.timedResults,
  last3f_present:flatLast3f.present,
  last3f_suspicious:flatLast3f.suspicious,
  finish_time_coverage_pct:Number((finishTimeCoverage*100).toFixed(1)),
  flat_finish_time_coverage_pct:Number((flatLast3f.finishTimeCoverage*100).toFixed(1)),
  last3f_coverage_pct:Number((flatLast3f.last3fCoverage*100).toFixed(1)),
  flat_races:flatRaceCount,
  obstacle_races:obstacleRaceCount,
  flat_lap_target_races:flatLapTargets.length,
  flat_lap_complete_races:completeLapRaces,
  flat_lap_coverage_pct:flatLapTargets.length
    ?Number((completeLapRaces/flatLapTargets.length*100).toFixed(1))
    :100,
};
if(flatLast3f.timedResults>=8&&flatLast3f.finishTimeCoverage>=0.8&&flatLast3f.last3fCoverage<0.9){
  throw new Error(
    "RESULT_QUALITY_LAST3F_LOW "+date+
    ": scope=FLAT finish_time="+resultQuality.flat_finish_time_coverage_pct+
    "% last3f="+resultQuality.last3f_coverage_pct+"%"
  );
}
if(flatLast3f.suspicious>0){
  const suspiciousRows=listSuspiciousFlatLast3f(records);
  throw new Error(
    "RESULT_QUALITY_LAST3F_SUSPICIOUS "+date+
    ": scope=FLAT suspicious="+flatLast3f.suspicious+
    " rows="+JSON.stringify(suspiciousRows.slice(0,10))
  );
}
if(records.length>=8&&flatRaceCount===0){
  throw new Error(
    "RESULT_QUALITY_DISCIPLINE_NO_FLAT "+date+
    ": races="+records.length+" obstacle="+obstacleRaceCount
  );
}
if(flatLapTargets.length>0&&completeLapRaces!==flatLapTargets.length){
  throw new Error(
    "RESULT_QUALITY_FLAT_LAPS_INCOMPLETE "+date+
    ": complete="+completeLapRaces+"/"+flatLapTargets.length
  );
}

const manifest = await loadManifest();
manifest.schema_version=1;
manifest.days=manifest.days??{};
manifest.updated_at=new Date().toISOString();

if(scheduleIntegrity){
  upsertRescheduleEvents(manifest,rescheduleEvents);
  upsertCancellationEvents(manifest,cancelledEvents);
  const repairedTargets=await repairRescheduledTargetPacks(manifest,rescheduleEvents);
  if(repairedTargets.length){
    console.log("[repair] rescheduled target packs: "+repairedTargets.join(","));
  }
}

if(
  scheduleIntegrity&&records.length===0&&
  (rescheduleEvents.length>0||cancelledEvents.length>0)
){
  await unlink(dailyPath).catch(()=>undefined);
  delete manifest.days[date];
  if(manifest.non_meeting_days)delete manifest.non_meeting_days[date];
  manifest.schedule_exception_days=manifest.schedule_exception_days??{};
  manifest.schedule_exception_days[date]={
    status:"NO_RACES_HELD",
    schedule_contract_version:SCHEDULE_CONTRACT_VERSION,
    rescheduled_meetings:[...new Set(rescheduleEvents.map(item=>item.meeting_key))],
    cancelled_meetings:[...new Set(cancelledEvents.map(item=>item.meeting_key))],
    updated_at:new Date().toISOString(),
  };
  manifest.race_pack_version=Math.max(
    Number(manifest.race_pack_version??1),effectiveRacePackVersion,
  );
  manifest.payout_parser_version=Math.max(
    Number(manifest.payout_parser_version??1),PAYOUT_PARSER_VERSION,
  );
  await saveManifest(manifest);
  console.log(JSON.stringify({
    ok:true,date,races:0,rescheduledAway,scheduleExceptionOnly:true,
    rescheduledMeetings:manifest.schedule_exception_days[date].rescheduled_meetings,
    cancelledMeetings:manifest.schedule_exception_days[date].cancelled_meetings,
  },null,2));
  process.exit(0);
}

const lines=records.map(r=>JSON.stringify(r)).join("\n")+(records.length?"\n":"");
const outDir=path.join("data","daily");
await mkdir(outDir,{recursive:true});
const outPath=path.join(outDir,`${date}.jsonl.gz`);
const tempPath=outPath+".race-pack.tmp";
await writeFile(tempPath,gzipSync(Buffer.from(lines,"utf8"),{level:9}));
await rename(tempPath,outPath);

manifest.race_pack_version=Math.max(
  Number(manifest.race_pack_version??1),effectiveRacePackVersion,
);
manifest.payout_parser_version=Math.max(
  Number(manifest.payout_parser_version??1),PAYOUT_PARSER_VERSION,
);
manifest.result_parser_version=Math.max(
  Number(manifest.result_parser_version??1),RESULT_PARSER_VERSION,
);
manifest.lap_parser_version=Math.max(
  Number(manifest.lap_parser_version??1),LAP_PARSER_VERSION,
);
if(manifest.schedule_exception_days)delete manifest.schedule_exception_days[date];
if(manifest.non_meeting_days)delete manifest.non_meeting_days[date];
manifest.days[date]={
  status:"SUCCESS",
  race_pack_version:effectiveRacePackVersion,
  payout_parser_version:PAYOUT_PARSER_VERSION,
  result_parser_version:RESULT_PARSER_VERSION,
  lap_parser_version:LAP_PARSER_VERSION,
  result_quality:resultQuality,
  ...(scheduleIntegrity?{schedule_contract_version:SCHEDULE_CONTRACT_VERSION}:{}),
  repaired_from_legacy_payout_v1:legacyExisting||undefined,
  repaired_for_schedule_integrity:scheduleUpgradeExisting||undefined,
  repaired_from_result_parser_v1:resultParserUpgradeExisting||undefined,
  repaired_from_lap_parser_v1:lapParserUpgradeExisting||undefined,
  races_discovered:raceIds.length,
  races_rescheduled_away:rescheduledAway||undefined,
  races_parsed:records.length,
  file:outPath.replaceAll("\\","/"),
  request_delay_ms:delayMs,
  discovery_url:listUrl,
  ...(scheduleIntegrity&&rescheduleEvents.length
    ?{rescheduled_meetings:[...new Set(rescheduleEvents.map(item=>item.meeting_key))]}
    :{}),
  ...(scheduleIntegrity&&cancelledEvents.length
    ?{cancelled_meetings:[...new Set(cancelledEvents.map(item=>item.meeting_key))]}
    :{}),
};
await saveManifest(manifest);

console.log(JSON.stringify({
  ok:true,date,races:records.length,rescheduledAway,
  entries:records.reduce((n,r)=>n+r.entries.length,0),
  payouts:records.reduce((n,r)=>n+r.payouts.length,0),
  resultQuality,
  output:outPath,
},null,2));