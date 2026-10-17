# 7王 血統 V4 凍結実装の原本復元（独立ブランチ）

**正本:** `pinogame1945-dotcom/KEIBA-ML-` の `research/l1-council-rebuild-v1-20261004:src/pedigree-feature-builder.mjs`
Git blob `e22df9ec79f9c02c773e519f4dc6b187d2889f83`。

本ブランチの `ml_features/src/pedigree-feature-builder.mjs` は、同正本 **V4のバイト列を無変更でコピー**する。

これまでBACKFILLへ転送されたV3との差分は **(1) version 3→4、(2) conditionValuesへ `race_class: text(race.race_class_normalized ?? race.grade)` を追加** のみ。他の関数や計算式は同一。

- V3: 204 `ped_` 列
- 正本V4: 238 `ped_` 列（追加34列は父/母父 × 17件のレースクラス統計）
- `small-sample-feature-utils.mjs` はML正本とバイト同一であることを確認済み。
- 元のMLの7王2025年版のスキーマ照合Run #38999630032 で3モデルの入力要件を確認済み。
- 2026実馬の血統統計値はこの変更だけでは生成されない。状態の計算には履歴と祖先情報が必要。
- 2026成績の学習・評価、モデル再学習、全690数値一致検証、販売時点保証は未実施。
- main・handoff納品・既存690入力は不変更。課金保存・GPUは使用しない。
