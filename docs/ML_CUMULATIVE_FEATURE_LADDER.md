# Cumulative ML feature ladder

This research workflow adds feature families cumulatively and evaluates every step on the exact same time split.

Fixed split:
- train: 2022-01-01 through 2024-12-31
- holdout: 2025-01-01 through 2025-12-31
- 2021 is history warm-up only

Stages:
1. base
2. opponent_v1 = base + aggregate opponent history
3. opponent_both = previous + Elo/network opponent features
4. lap = previous + historical race-lap features
5. style = previous + historical corner/running-position features
6. pedigree = previous + pedigree IDs / coverage
7. distance = previous + richer historical distance adaptation

Current-race result, last 3F, lap, corner passage, odds, popularity and payouts are never predictors. Lap and style features come only from prior dates. Pedigree is immutable lineage information and is joined from horse packs.

The workflow also records GNU time maximum resident set size and elapsed time for dataset construction and every training stage, plus disk usage before/after.
