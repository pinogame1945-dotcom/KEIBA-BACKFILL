export const ML_DATASET_VERSION = 2;
export const ML_FEATURE_SCHEMA_VERSION = 2;
export const ML_LEAKAGE_POLICY = "STRICT_PRIOR_DATE_ONLY";

function finite(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isEligibleStarter(entry, result) {
  const entryStatus = String(entry?.entry_status ?? "").toUpperCase();
  const resultStatus = String(result?.result_status ?? "").toUpperCase();
  if (entryStatus === "SCRATCHED" || entryStatus === "EXCLUDED") return false;
  if (resultStatus === "SCRATCHED" || resultStatus === "EXCLUDED") return false;
  return true;
}

function mean(values) {
  const clean = values.map(finite).filter(value => value != null);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function rate(items, predicate) {
  if (!items.length) return null;
  return items.filter(predicate).length / items.length;
}

function isoDate(value) {
  const text = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function daysBetween(fromDate, toDate) {
  const from = isoDate(fromDate);
  const to = isoDate(toDate);
  if (!from || !to) return null;
  const delta = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Number.isFinite(delta) ? Math.round(delta / 86400000) : null;
}

function stableRaceDate(row) {
  return isoDate(row?.race?.actual_date ?? row?.race?.scheduled_date);
}

function resultMap(row) {
  return new Map((row?.results ?? []).map(result => [String(result?.horse_id ?? ""), result]));
}

function eligibleStarterIds(row, results) {
  return (row?.entries ?? [])
    .filter(entry => {
      const horseId = String(entry?.horse_id ?? "");
      const result = results.get(horseId) ?? null;
      return horseId && result && isEligibleStarter(entry, result);
    })
    .map(entry => String(entry.horse_id));
}

function opponentFieldSummary(opponentHorseIds, horseStatsById) {
  const known = (opponentHorseIds ?? [])
    .map(horseId => horseStatsById.get(String(horseId)))
    .filter(stats => stats && stats.starts > 0);

  if (!known.length) {
    return {
      known_count: 0,
      avg_starts: null,
      avg_win_rate: null,
      avg_top3_rate: null,
      max_win_rate: null,
    };
  }

  const winRates = known.map(stats => stats.wins / stats.starts);
  const top3Rates = known.map(stats => stats.top3 / stats.starts);
  return {
    known_count: known.length,
    avg_starts: mean(known.map(stats => stats.starts)),
    avg_win_rate: mean(winRates),
    avg_top3_rate: mean(top3Rates),
    max_win_rate: Math.max(...winRates),
  };
}

function opponentSnapshot(history, horseStatsById, limit) {
  const recent = history.slice(-limit).reverse();
  const summaries = recent.map(item => opponentFieldSummary(item.opponentHorseIds, horseStatsById));
  const measured = summaries.filter(summary => summary.known_count > 0);
  const previous = summaries[0] ?? null;

  return {
    opponent_previous_known_count: previous?.known_count ?? 0,
    opponent_previous_avg_starts: previous?.avg_starts ?? null,
    opponent_previous_avg_win_rate: previous?.avg_win_rate ?? null,
    opponent_previous_avg_top3_rate: previous?.avg_top3_rate ?? null,
    opponent_previous_max_win_rate: previous?.max_win_rate ?? null,
    opponent_recent_races_measured: measured.length,
    opponent_recent_avg_known_count: mean(measured.map(summary => summary.known_count)),
    opponent_recent_avg_starts: mean(measured.map(summary => summary.avg_starts)),
    opponent_recent_avg_win_rate: mean(measured.map(summary => summary.avg_win_rate)),
    opponent_recent_avg_top3_rate: mean(measured.map(summary => summary.avg_top3_rate)),
    opponent_recent_max_win_rate: measured.length
      ? Math.max(...measured.map(summary => summary.max_win_rate).filter(value => value != null))
      : null,
  };
}

function updateHorseStats(horseStatsById, horseId, result) {
  const key = String(horseId ?? "");
  if (!key) return;
  const stats = horseStatsById.get(key) ?? { starts: 0, wins: 0, top3: 0 };
  stats.starts += 1;
  const finish = finite(result?.official_finish_position);
  if (finish === 1) stats.wins += 1;
  if (finish != null && finish <= 3) stats.top3 += 1;
  horseStatsById.set(key, stats);
}

function historySnapshot(history, current, limit, horseStatsById) {
  const recent = history.slice(-limit).reverse();
  const currentDistance = finite(current.race?.distance_m);
  const currentSurface = current.race?.surface ?? null;
  const currentVenue = current.race?.venue_code ?? null;
  const previous = recent[0] ?? null;

  const finished = recent.filter(item => item.result?.result_status === "FINISHED" && item.result?.official_finish_position != null);
  const sameSurface = finished.filter(item => item.race?.surface && item.race.surface === currentSurface);
  const sameVenue = finished.filter(item => item.race?.venue_code && item.race.venue_code === currentVenue);
  const sameDistance = finished.filter(item => finite(item.race?.distance_m) === currentDistance && currentDistance != null);

  const speeds = finished.map(item => {
    const distance = finite(item.race?.distance_m);
    const timeMs = finite(item.result?.finish_time_ms);
    return distance != null && timeMs != null && timeMs > 0 ? distance / (timeMs / 1000) : null;
  });

  return {
    prior_starts: history.length,
    recent_window_starts: recent.length,
    days_since_last_start: previous ? daysBetween(previous.date, current.date) : null,
    previous_finish_position: finite(previous?.result?.official_finish_position),
    previous_last_3f: finite(previous?.result?.last_3f),
    previous_distance_m: finite(previous?.race?.distance_m),
    distance_change_m: previous && currentDistance != null && finite(previous?.race?.distance_m) != null
      ? currentDistance - finite(previous.race.distance_m)
      : null,
    jockey_continues: previous?.entry?.jockey_id && current.entry?.jockey_id
      ? String(previous.entry.jockey_id) === String(current.entry.jockey_id)
      : null,
    recent_avg_finish: mean(finished.map(item => item.result?.official_finish_position)),
    recent_win_rate: rate(finished, item => Number(item.result?.official_finish_position) === 1),
    recent_top3_rate: rate(finished, item => Number(item.result?.official_finish_position) <= 3),
    recent_avg_last_3f: mean(finished.map(item => item.result?.last_3f)),
    recent_avg_speed_mps: mean(speeds),
    same_surface_starts: sameSurface.length,
    same_surface_top3_rate: rate(sameSurface, item => Number(item.result?.official_finish_position) <= 3),
    same_distance_starts: sameDistance.length,
    same_distance_top3_rate: rate(sameDistance, item => Number(item.result?.official_finish_position) <= 3),
    same_venue_starts: sameVenue.length,
    same_venue_top3_rate: rate(sameVenue, item => Number(item.result?.official_finish_position) <= 3),
    ...opponentSnapshot(history, horseStatsById, limit),
  };
}

function currentFeatures(row, entry, historyFeatures) {
  const race = row.race ?? {};
  return {
    race_date: stableRaceDate(row),
    venue_code: race.venue_code ?? null,
    meeting_no: finite(race.meeting_no),
    meeting_day: finite(race.meeting_day),
    race_no: finite(race.race_no),
    discipline: race.discipline ?? null,
    surface: race.surface ?? null,
    distance_m: finite(race.distance_m),
    direction: race.direction ?? null,
    weather: race.weather ?? null,
    track_condition: race.track_condition ?? null,
    actual_start_time: race.actual_start_time ?? null,
    gate: finite(entry?.gate),
    horse_number: finite(entry?.horse_number),
    sex: entry?.sex ?? null,
    age: finite(entry?.age),
    carried_weight: finite(entry?.carried_weight),
    jockey_id: entry?.jockey_id ?? null,
    trainer_id: entry?.trainer_id ?? null,
    body_weight: finite(entry?.body_weight),
    body_weight_diff: finite(entry?.body_weight_diff),
    ...historyFeatures,
  };
}

function targetFrom(result) {
  const finish = finite(result?.official_finish_position);
  return {
    result_status: result?.result_status ?? null,
    finish_position: finish,
    is_win: finish === 1,
    is_top3: finish != null ? finish <= 3 : null,
    finish_time_ms: finite(result?.finish_time_ms),
    margin_raw: result?.margin_raw ?? null,
    last_3f: finite(result?.last_3f),
    prize_money: finite(result?.prize_money),
  };
}

function marketOutcomeFrom(result) {
  return {
    final_win_odds: finite(result?.win_odds),
    final_popularity: finite(result?.popularity),
  };
}

export function buildRaceOutcomes(raceRows, {
  startDate = null,
  endDate = null,
} = {}) {
  return (raceRows ?? [])
    .map(row => ({ row, date: stableRaceDate(row) }))
    .filter(item => item.date)
    .filter(item => (!startDate || item.date >= startDate) && (!endDate || item.date <= endDate))
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.row?.race?.race_id ?? "").localeCompare(String(b.row?.race?.race_id ?? "")))
    .map(({ row, date }) => ({
      ml_dataset_version: ML_DATASET_VERSION,
      race_id: String(row?.race?.race_id ?? ""),
      race_date: date,
      payouts: (row?.payouts ?? []).map(payout => ({
        bet_type: payout?.bet_type ?? null,
        combination: payout?.combination ?? null,
        payout_yen: finite(payout?.payout_yen),
        popularity: finite(payout?.popularity),
      })),
    }))
    .filter(row => row.race_id);
}

export function buildMlDataset(raceRows, {
  startDate = null,
  endDate = null,
  historyLimit = 5,
} = {}) {
  if (!Number.isInteger(historyLimit) || historyLimit < 1 || historyLimit > 100) {
    throw new Error("historyLimit must be an integer from 1 to 100");
  }

  const normalized = (raceRows ?? [])
    .map(row => ({ row, date: stableRaceDate(row) }))
    .filter(item => item.date)
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.row?.race?.race_id ?? "").localeCompare(String(b.row?.race?.race_id ?? "")));

  const historyByHorse = new Map();
  const horseStatsById = new Map();
  const out = [];
  let index = 0;

  while (index < normalized.length) {
    const date = normalized[index].date;
    const day = [];
    while (index < normalized.length && normalized[index].date === date) {
      day.push(normalized[index].row);
      index += 1;
    }

    // Generate every row for the day before committing any same-day result to history.
    // This guarantees a strict date-level anti-leakage boundary even when exact post times
    // are missing or historical schedules have been repaired.
    for (const row of day) {
      const raceId = String(row?.race?.race_id ?? "");
      const results = resultMap(row);
      for (const entry of row?.entries ?? []) {
        const horseId = String(entry?.horse_id ?? "");
        if (!raceId || !horseId) continue;
        const result = results.get(horseId) ?? null;
        if (!result || !isEligibleStarter(entry, result)) continue;
        const history = historyByHorse.get(horseId) ?? [];
        const current = { date, race: row.race ?? {}, entry };
        const features = currentFeatures(
          row,
          entry,
          historySnapshot(history, current, historyLimit, horseStatsById),
        );
        const inRange = (!startDate || date >= startDate) && (!endDate || date <= endDate);
        if (inRange) {
          out.push({
            ml_dataset_version: ML_DATASET_VERSION,
            feature_schema_version: ML_FEATURE_SCHEMA_VERSION,
            leakage_policy: ML_LEAKAGE_POLICY,
            race_id: raceId,
            horse_id: horseId,
            features,
            target: targetFrom(result),
            market_outcome: marketOutcomeFrom(result),
          });
        }
      }
    }

    for (const row of day) {
      const results = resultMap(row);
      const starterIds = eligibleStarterIds(row, results);
      for (const entry of row?.entries ?? []) {
        const horseId = String(entry?.horse_id ?? "");
        const result = results.get(horseId) ?? null;
        if (!horseId || !result || !isEligibleStarter(entry, result)) continue;
        const history = historyByHorse.get(horseId) ?? [];
        history.push({
          date,
          race: row.race ?? {},
          entry,
          result,
          opponentHorseIds: starterIds.filter(id => id !== horseId),
        });
        historyByHorse.set(horseId, history);
      }
    }

    // Commit daily performance stats only after every feature row for the day was generated.
    // This keeps same-day races outside the opponent-strength view.
    for (const row of day) {
      const results = resultMap(row);
      for (const entry of row?.entries ?? []) {
        const horseId = String(entry?.horse_id ?? "");
        const result = results.get(horseId) ?? null;
        if (!horseId || !result || !isEligibleStarter(entry, result)) continue;
        updateHorseStats(horseStatsById, horseId, result);
      }
    }
  }

  return out;
}
