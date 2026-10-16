# KEIBA-BACKFILL: 純粋AI用特徴量移管（2026-10-16）

## 移管内容
KEIBA-ML の `c782a7e0c6e2f09b2d0603b23336eab31ad5bc77` から、CORE4 元データ由来の特徴量生成器（JavaScript）、649列の列選定・照合、当日傾向19列、速度状態22列の原本関数と依存モジュールを `ml_features/` にコピーした。

モデル（LambdaRank）、Correction Risk、ANCHOR_FULL、L2.1、L3 V3は移動・変更していない。KEIBA-MLの研究正本は未変更。

### 現段階で実行可能なこと
- `ml_features/research/build-yearly-superset-snapshots.mjs`: 移管前と同一の履歴特徴量生成処理（過去に結果があるレース）。出力はランナーの一時フォルダへ保存する。
- `--allow-unresulted-targets`: 発走前の結果がない出走馬を特徴量生成対象に含める。既存の履歴更新条件と計算式は維持。対象は `--source-end == --emit-start == --emit-end` の一日だけ。対象日に結果・払戻・オッズを含むパックは拒否する。
- `ml_features/research/phase3_20261010_all_24_unscored_inputs_v1.py`, `phase3_20261010_24_extra41_batch_v1.py`: オリジナルの10月10日24レース数値一致検証コードを移管（**24レース専用**、本番用汎用インターフェースではない）。
- `ml_features/tests/l1-feature-processing.test.mjs`: 当日未確定出走馬の処理、履歴計算の非回帰、元の特徴量フェーズのテスト。

## 649特徴量を過去データから生成する呼び出し例

```bash
node ml_features/research/build-yearly-superset-snapshots.mjs \
  --source-root . --out-dir "${RUNNER_TEMP}/keiba-features" \
  --source-start 2022-01-01 --source-end 2026-10-10 \
  --emit-start 2026-10-10 --emit-end 2026-10-10 \
  --prediction-phase FINAL \
  --feature-sets BASE,OPPONENT,NETWORK,LAP,STYLE,DISTANCE,BACKFILL,AUTO,ACTOR,TIME_PACE \
  --first-model-ready-year 2023 \
  --source-sha "<PINNED_BACKFILL_COMMIT>" \
  --ml-source-sha c782a7e0c6e2f09b2d0603b23336eab31ad5bc77
```

上の全ファミリーのスナップショットは**649列に絞る前**の出力。列選定は移管済み `audit_2026_generated_core4_v1.py` の `selected_columns` で行う。元の同日バイアス19・速度状態22を合わせて690列になる。これは **FINAL（体重や馬場が判明した段階）の元研究仕様** に限る。

## 本番接続前の残課題（重要）
1. **当日JRAライブJSONを日別BACKFILL形式へ正規化・結合**：現ライブ収集器は `data/live/2026-10-17/*.json` を生成しているが、そのまま日別パック形式ではない。実際のライブソースの不足列や発走前の時点保証を検証する必要がある。
2. **649→690の任意レースID汎用化**：19+22計算原本は移管したが、既存の検証エントリは2026-10-10の24レース限定。一般の開催日への汎用化と実数値一致検証はまだ。
3. **時点保証**：過去に生成した2026年スナップショットは `FINAL_PROJECTED_ASOF_UNVERIFIED`。発走前に得られた値だと独立に証明できるまで本番READYとしない。
4. **MLへの引き渡し**：BACKFILL側が `race_id`, `race_date`, 690列名/値, `source_observed_at`, `feature_version`, `readiness` を持つパッケージを返し、MLは純粋AIを実行する。GitHub ActionsのML→BACKFILL起動と出力の受け渡しは未接続。
5. **履歴スナップショット**：2019〜2025の元の状態履歴は元ML側Kaggleスナップショットに依存。検証時は一時的に取得する。BACKFILL側資格情報・ディスク無料枠を確認する前に大容量取得は行わない。

## 本番導入条件
過去レースと当日レースの双方で、①全頭、②元の649+19+22列、③数値一致、④発走前時点保証、⑤任意レースIDでの一気通貫入力受け渡しが確認できるまで本番READY/完了と報告しない。

**コストルール：無料標準CPUのみ。課金可能性のあるストレージ・Artifact・Cache・GPUは不可。** データ保存先の変更、研究仕様変更、本番mainの変更は行わない。
