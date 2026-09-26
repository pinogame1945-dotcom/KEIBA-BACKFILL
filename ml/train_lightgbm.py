#!/usr/bin/env python3
import argparse
import gzip
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score

MODEL_VERSION_BASE = "LIGHTGBM_WIN_V0_BASE"
MODEL_VERSION_OPPONENT = "LIGHTGBM_WIN_V0_OPPONENT"
EXPECTED_DATASET_VERSION = 2
EXPECTED_FEATURE_SCHEMA_VERSION = 2
EXPECTED_LEAKAGE_POLICY = "STRICT_PRIOR_DATE_ONLY"

CATEGORICAL_FEATURES = [
    "venue_code",
    "discipline",
    "surface",
    "direction",
    "weather",
    "track_condition",
    "sex",
    "jockey_id",
    "trainer_id",
]


def parse_args():
    parser = argparse.ArgumentParser(description="Train the first KEIBA LightGBM win model.")
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--train-start")
    parser.add_argument("--train-end", required=True)
    parser.add_argument("--valid-start", required=True)
    parser.add_argument("--valid-end", required=True)
    parser.add_argument("--model-out", required=True)
    parser.add_argument("--meta-out", required=True)
    parser.add_argument("--predictions-out")
    parser.add_argument("--feature-set", choices=["base", "opponent"], default="opponent")
    return parser.parse_args()


def load_rows(path):
    rows = []
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, 1):
            text = line.strip()
            if not text:
                continue
            row = json.loads(text)
            if int(row.get("ml_dataset_version", 0)) != EXPECTED_DATASET_VERSION:
                raise ValueError(f"line {line_no}: unsupported ml_dataset_version")
            if int(row.get("feature_schema_version", 0)) != EXPECTED_FEATURE_SCHEMA_VERSION:
                raise ValueError(f"line {line_no}: unsupported feature_schema_version")
            if row.get("leakage_policy") != EXPECTED_LEAKAGE_POLICY:
                raise ValueError(f"line {line_no}: unexpected leakage_policy")
            if not isinstance(row.get("features"), dict):
                raise ValueError(f"line {line_no}: features missing")
            if not isinstance(row.get("target"), dict):
                raise ValueError(f"line {line_no}: target missing")
            rows.append(row)
    if not rows:
        raise ValueError("dataset is empty")
    return rows


def hhmm_to_minutes(value):
    if value is None:
        return np.nan
    text = str(value).strip()
    if ":" not in text:
        return np.nan
    try:
        hour, minute = text.split(":", 1)
        h = int(hour)
        m = int(minute)
    except ValueError:
        return np.nan
    if not (0 <= h <= 23 and 0 <= m <= 59):
        return np.nan
    return h * 60 + m


def flatten(rows, feature_set):
    records = []
    for row in rows:
        features = dict(row["features"])
        if feature_set == "base":
            features = {
                key: value
                for key, value in features.items()
                if not key.startswith("opponent_")
            }
        race_date = features.pop("race_date", None)
        start_time = features.pop("actual_start_time", None)
        parsed_date = pd.to_datetime(race_date, errors="coerce")
        features["race_month"] = int(parsed_date.month) if not pd.isna(parsed_date) else np.nan
        features["race_day_of_year"] = int(parsed_date.dayofyear) if not pd.isna(parsed_date) else np.nan
        features["start_minutes"] = hhmm_to_minutes(start_time)

        target = row.get("target", {})
        result_status = str(target.get("result_status") or "")
        is_win = target.get("is_win")
        if is_win is None:
            continue

        records.append({
            "_race_id": str(row.get("race_id") or ""),
            "_horse_id": str(row.get("horse_id") or ""),
            "_race_date": str(race_date or ""),
            "_result_status": result_status,
            "_target": 1 if bool(is_win) else 0,
            **features,
        })

    if not records:
        raise ValueError("no trainable rows")
    df = pd.DataFrame.from_records(records)
    df["_race_date_dt"] = pd.to_datetime(df["_race_date"], errors="coerce")
    df = df[df["_race_id"].ne("") & df["_horse_id"].ne("") & df["_race_date_dt"].notna()].copy()
    if df.empty:
        raise ValueError("no rows with valid race id / horse id / date")
    return df


def filter_complete_races(df):
    winner_counts = df.groupby("_race_id")["_target"].sum()
    eligible = winner_counts[winner_counts >= 1].index
    return df[df["_race_id"].isin(eligible)].copy()


def split_by_date(df, train_start, train_end, valid_start, valid_end):
    train_start_dt = pd.to_datetime(train_start) if train_start else None
    train_end_dt = pd.to_datetime(train_end)
    valid_start_dt = pd.to_datetime(valid_start)
    valid_end_dt = pd.to_datetime(valid_end)

    if train_end_dt >= valid_start_dt:
        raise ValueError("train_end must be before valid_start")
    if valid_start_dt > valid_end_dt:
        raise ValueError("valid_start must be <= valid_end")

    train_mask = df["_race_date_dt"] <= train_end_dt
    if train_start_dt is not None:
        train_mask &= df["_race_date_dt"] >= train_start_dt
    valid_mask = (df["_race_date_dt"] >= valid_start_dt) & (df["_race_date_dt"] <= valid_end_dt)

    train = filter_complete_races(df[train_mask].copy())
    valid = filter_complete_races(df[valid_mask].copy())
    if train.empty:
        raise ValueError("training split is empty")
    if valid.empty:
        raise ValueError("validation split is empty")
    if train["_target"].nunique() < 2:
        raise ValueError("training split needs both winners and non-winners")
    if valid["_target"].nunique() < 2:
        raise ValueError("validation split needs both winners and non-winners")
    return train, valid


def model_columns(df):
    return [
        column for column in df.columns
        if not column.startswith("_")
    ]


def prepare_frames(train, valid):
    columns = model_columns(train)
    if set(columns) != set(model_columns(valid)):
        raise ValueError("train/validation feature columns differ")

    x_train = train[columns].copy()
    x_valid = valid[columns].copy()

    categorical = [column for column in CATEGORICAL_FEATURES if column in columns]
    for column in categorical:
        train_values = x_train[column].astype("string").fillna("__MISSING__")
        categories = sorted(set(train_values.tolist()))
        x_train[column] = pd.Categorical(train_values, categories=categories)
        valid_values = x_valid[column].astype("string").fillna("__MISSING__")
        x_valid[column] = pd.Categorical(valid_values, categories=categories)

    for column in columns:
        if column in categorical:
            continue
        if pd.api.types.is_bool_dtype(x_train[column]):
            x_train[column] = x_train[column].astype("float64")
            x_valid[column] = x_valid[column].astype("float64")
        else:
            x_train[column] = pd.to_numeric(x_train[column], errors="coerce")
            x_valid[column] = pd.to_numeric(x_valid[column], errors="coerce")

    category_levels = {
        column: [str(value) for value in x_train[column].cat.categories]
        for column in categorical
    }
    return x_train, x_valid, categorical, category_levels


def race_normalize(frame, raw_probability):
    out = frame[["_race_id", "_horse_id", "_race_date", "_target"]].copy()
    out["raw_win_probability"] = np.asarray(raw_probability, dtype=float)
    sums = out.groupby("_race_id")["raw_win_probability"].transform("sum")
    sizes = out.groupby("_race_id")["raw_win_probability"].transform("size")
    safe = np.where(sums > 0, out["raw_win_probability"] / sums, 1.0 / sizes)
    out["race_normalized_win_probability"] = safe
    out["predicted_rank"] = (
        out.groupby("_race_id")["raw_win_probability"]
        .rank(method="first", ascending=False)
        .astype(int)
    )
    return out


def ranking_metrics(predictions):
    race_results = []
    for _, group in predictions.groupby("_race_id", sort=False):
        ranked = group.sort_values("raw_win_probability", ascending=False)
        winner_ranks = ranked.loc[ranked["_target"] == 1, "predicted_rank"].tolist()
        if not winner_ranks:
            continue
        best_rank = min(winner_ranks)
        winner_probability = float(
            ranked.loc[ranked["_target"] == 1, "race_normalized_win_probability"].sum()
        )
        race_results.append((best_rank, min(max(winner_probability, 1e-15), 1.0)))

    if not race_results:
        raise ValueError("validation has no race winners")

    ranks = np.array([rank for rank, _ in race_results], dtype=float)
    probabilities = np.array([prob for _, prob in race_results], dtype=float)
    return {
        "races": int(len(race_results)),
        "top1_winner_capture": float(np.mean(ranks <= 1)),
        "top3_winner_capture": float(np.mean(ranks <= 3)),
        "top6_winner_capture": float(np.mean(ranks <= 6)),
        "mean_winner_rank": float(np.mean(ranks)),
        "mean_reciprocal_winner_rank": float(np.mean(1.0 / ranks)),
        "race_normalized_nll": float(np.mean(-np.log(probabilities))),
    }


def safe_auc(y_true, probability):
    if len(np.unique(y_true)) < 2:
        return None
    return float(roc_auc_score(y_true, probability))


def main():
    args = parse_args()
    rows = load_rows(args.dataset)
    frame = flatten(rows, args.feature_set)
    train, valid = split_by_date(
        frame,
        args.train_start,
        args.train_end,
        args.valid_start,
        args.valid_end,
    )
    x_train, x_valid, categorical, category_levels = prepare_frames(train, valid)
    y_train = train["_target"].astype(int)
    y_valid = valid["_target"].astype(int)

    params = {
        "objective": "binary",
        "n_estimators": 600,
        "learning_rate": 0.03,
        "num_leaves": 31,
        "min_child_samples": 30,
        "subsample": 0.9,
        "subsample_freq": 1,
        "colsample_bytree": 0.9,
        "reg_lambda": 1.0,
        "random_state": 42,
        "n_jobs": -1,
        "verbosity": -1,
        "deterministic": True,
        "force_col_wise": True,
    }

    model = lgb.LGBMClassifier(**params)
    model.fit(
        x_train,
        y_train,
        eval_set=[(x_valid, y_valid)],
        eval_metric="binary_logloss",
        categorical_feature=categorical,
        callbacks=[lgb.early_stopping(50, verbose=False)],
    )

    raw_probability = model.predict_proba(
        x_valid,
        num_iteration=model.best_iteration_,
    )[:, 1]
    raw_probability = np.clip(raw_probability, 1e-15, 1 - 1e-15)
    predictions = race_normalize(valid, raw_probability)

    metrics = {
        "validation_rows": int(len(valid)),
        "validation_races": int(valid["_race_id"].nunique()),
        "raw_logloss": float(log_loss(y_valid, raw_probability, labels=[0, 1])),
        "raw_brier": float(brier_score_loss(y_valid, raw_probability)),
        "raw_roc_auc": safe_auc(y_valid.to_numpy(), raw_probability),
        **ranking_metrics(predictions),
    }

    model_out = Path(args.model_out)
    meta_out = Path(args.meta_out)
    model_out.parent.mkdir(parents=True, exist_ok=True)
    meta_out.parent.mkdir(parents=True, exist_ok=True)
    model.booster_.save_model(str(model_out))

    gain = model.booster_.feature_importance(importance_type="gain")
    feature_names = model.booster_.feature_name()
    importance = sorted(
        [
            {"feature": feature, "gain": float(value)}
            for feature, value in zip(feature_names, gain)
        ],
        key=lambda item: item["gain"],
        reverse=True,
    )

    model_version = MODEL_VERSION_BASE if args.feature_set == "base" else MODEL_VERSION_OPPONENT

    metadata = {
        "model_version": model_version,
        "feature_set": args.feature_set,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "dataset_contract": {
            "ml_dataset_version": EXPECTED_DATASET_VERSION,
            "feature_schema_version": EXPECTED_FEATURE_SCHEMA_VERSION,
            "leakage_policy": EXPECTED_LEAKAGE_POLICY,
        },
        "target": "target.is_win",
        "ability_uses_odds": False,
        "split": {
            "train_start": args.train_start,
            "train_end": args.train_end,
            "valid_start": args.valid_start,
            "valid_end": args.valid_end,
            "train_rows": int(len(train)),
            "train_races": int(train["_race_id"].nunique()),
            "valid_rows": int(len(valid)),
            "valid_races": int(valid["_race_id"].nunique()),
        },
        "params": params,
        "best_iteration": int(model.best_iteration_ or params["n_estimators"]),
        "features": feature_names,
        "categorical_features": categorical,
        "category_levels": category_levels,
        "metrics": metrics,
        "feature_importance_gain": importance,
    }
    meta_out.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if args.predictions_out:
        prediction_out = Path(args.predictions_out)
        prediction_out.parent.mkdir(parents=True, exist_ok=True)
        with gzip.open(prediction_out, "wt", encoding="utf-8") as fh:
            for record in predictions.sort_values(
                ["_race_date", "_race_id", "predicted_rank"]
            ).to_dict(orient="records"):
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")

    print("ML_LIGHTGBM_V0")
    print(json.dumps({
        "model_version": model_version,
        "feature_set": args.feature_set,
        "best_iteration": metadata["best_iteration"],
        "train_rows": metadata["split"]["train_rows"],
        "train_races": metadata["split"]["train_races"],
        "valid_rows": metadata["split"]["valid_rows"],
        "valid_races": metadata["split"]["valid_races"],
        "metrics": metrics,
        "top_features": importance[:10],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
