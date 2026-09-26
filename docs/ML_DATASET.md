# ML dataset v2 / feature schema v2

`data/daily/*.jsonl.gz` remains the immutable source of truth. ML datasets are derived artifacts and are written separately under `data/ml/`.

## Separation of prediction inputs and answer data

Dataset v2 keeps three roles separate:

- `features`: information allowed to influence the prediction.
- `target`: observed race performance used to teach and score the model, such as finish position, finish time and last 3F.
- `market_outcome`: post-race market facts kept only for later evaluation, currently final win odds and final popularity.

Race-level payouts are not duplicated into every horse row. They are written once per race to a companion race-outcome file.

## Leakage boundary

Dataset v2 uses `STRICT_PRIOR_DATE_ONLY`.

For a target race, features may use:
- race/entry facts knowable before the race;
- results from strictly earlier calendar dates for that horse.

Features never use the target race's result, finish time, last 3F, popularity, final odds, payout or prize. Same-day results are also excluded from history.

## Outputs

Horse dataset, one row per starter:

```json
{
  "ml_dataset_version": 2,
  "feature_schema_version": 1,
  "leakage_policy": "STRICT_PRIOR_DATE_ONLY",
  "race_id": "...",
  "horse_id": "...",
  "features": {},
  "target": {},
  "market_outcome": {
    "final_win_odds": 8.4,
    "final_popularity": 4
  }
}
```

Race outcome companion, one row per race:

```json
{
  "ml_dataset_version": 2,
  "race_id": "...",
  "race_date": "YYYY-MM-DD",
  "payouts": []
}
```

Generated files:
- `data/ml/datasets/<name>.jsonl.gz`
- `data/ml/race-outcomes/<name>.jsonl.gz`
- `data/ml/manifest.json`

The builder reads daily packs before `--start` as history warm-up but does not emit them as target rows.

## Command

```bash
npm run build:ml-dataset -- --start 2022-01-01 --end 2025-12-31 --history-limit 5 --name train-2022-2025
```

Full historical odds groups remain in the existing historical-odds packs. They are intentionally not prediction features in v2; a later evaluation join can attach them without changing the canonical BACKFILL source.


## Opponent-strength features

Feature schema v2 adds `opponent_*` fields. They summarize how the opponents from a horse's recent prior races had performed up to, but not including, the current target date. Same-day results are never committed before feature generation, so opponent strength obeys the same `STRICT_PRIOR_DATE_ONLY` boundary.


## Opponent network v2

Feature schema v3 adds `network_*` fields: the horse's point-in-time Elo-style rating, number of rated prior starts, the current field's rating level/spread, the horse's rating gap versus the field, and the expected pairwise score versus current opponents. Rating updates use only completed prior dates; target-day results never affect target-day features.
