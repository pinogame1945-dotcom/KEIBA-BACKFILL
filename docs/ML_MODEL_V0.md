# LightGBM WIN v0

This is the first machine-learning model for the PC-oriented KEIBA research stack.

## Purpose

Predict one value for every starter: the probability-like score that the horse wins the race.

The score is used to rank all horses in a race. It is not a betting strategy.

## Input boundary

Training reads only the `features` object from ML Dataset v2.

It does not read:
- `target` fields as predictors;
- `market_outcome`;
- final odds;
- popularity;
- payouts.

The supervised label is only `target.is_win`.

## Time split

Training and validation are separated by calendar time. The CLI refuses a split where the training end overlaps the validation start.

## Categorical values

Venue, discipline, surface, direction, weather, track condition, sex, jockey and trainer are treated as categorical features. Validation uses only the category vocabulary learned from the training split; unseen validation categories become missing values.

## Outputs

- LightGBM text model.
- Metadata JSON with data contract, split, parameters, feature list, category levels, metrics and feature importance.
- Optional validation prediction JSONL gzip.

Reported validation metrics include:
- binary log loss;
- Brier score;
- ROC AUC;
- winning-horse Top1 / Top3 / Top6 capture;
- mean winner rank;
- mean reciprocal winner rank;
- race-normalized negative log likelihood.

Raw per-horse LightGBM probabilities are also normalized within each race for evaluation. Ranking itself uses the raw model probability, so normalization does not change order.

## Example

```bash
python ml/train_lightgbm.py \
  --dataset data/ml/datasets/train.jsonl.gz \
  --train-end 2024-12-31 \
  --valid-start 2025-01-01 \
  --valid-end 2025-12-31 \
  --model-out data/ml/models/lightgbm-win-v0.txt \
  --meta-out data/ml/models/lightgbm-win-v0.json \
  --predictions-out data/ml/models/lightgbm-win-v0-valid.jsonl.gz
```

This is v0, not a final model. Model quality must be judged on unseen time periods before promotion.


## Opponent-strength A/B mode

Feature schema v2 adds point-in-time opponent-strength features. For each horse's recent prior races, the dataset builder looks at the opponents from those races and summarizes only performances known strictly before the current target date.

The training CLI supports:

- `--feature-set base`: hides every `opponent_*` field.
- `--feature-set opponent`: includes them.

This allows an apples-to-apples A/B test with the same rows, date split, model parameters and target. No odds are used by either side.


## Opponent network v2

Feature schema v3 adds an Elo-style pairwise opponent network.

Each horse starts at 1500. After a historical race, every finisher is compared pairwise with every other finisher. Beating a highly rated horse gives more credit than beating a weak horse; losing to a highly rated horse costs less than losing to a weak horse. Pairwise updates are normalized by field size.

All races on the same calendar day are scored from the rating state that existed before that day, and their updates are applied only after feature generation. This keeps the network under `STRICT_PRIOR_DATE_ONLY`.

The three feature-set modes are now:
- `base`: no opponent features.
- `opponent`: v1 aggregate opponent win/top3 statistics only.
- `network`: v2 Elo-network features only.
