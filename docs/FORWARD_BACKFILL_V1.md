# FORWARD BACKFILL V1 — 2026-10-15

## Scope
Fill missing **finalized** JRA race days from `2026-09-01` through **yesterday in Japan Standard Time** using the exact production collectors of `KEIBA-BACKFILL`.
This is a one-shot forward catch-up, **not** the future pre-race/live collector, and does not modify L1/L2/L3 research contracts.

## Implementation
- Planner: `src/forward-backfill-plan.mjs`
- Workflow: `.github/workflows/forward-backfill-production.yml`
- Horse gap counting: `scripts/forward-horse-pending.mjs`
- Planner smoke: `scripts/forward-backfill-plan-smoke.mjs`
- One-time kick: `.backfill/forward-kick` (runs on push to main after merge).

## Invariants
- Read **manifest** states; do not guess new race pack names or re-download existing SUCCESS packs. A SUCCESS entry with a missing local file is a fatal metadata integrity error.
- Race packs: `node src/collect-day.mjs DATE`.
- Horse packs and 5-generation pedigrees: existing `repair-pedigree-v2` and `collect-horses` implementation, with a strict no-pending-horse check.
- Final odds: `node src/collect-historical-odds.mjs DATE`. `SOURCE_UNAVAILABLE` is **not success** and stays retryable; do not silently mark a race date complete.
- Non-meeting dates are only terminal if `CONFIRMED_NO_JRA` is verified via the existing collector; cancelled/rescheduled exceptions use `NO_RACES_HELD` and the existing schedule contract.
- `verify-range` runs for each day before committing.
- The planner **rejects any date newer than yesterday JST**, even if explicitly requested.
- End-to-end execution commits each verified day to main so a later retry is idempotent.
- Initial `max_dates=60`; cap is 90 pending calendar dates, conservative repository storage limit 3500 MiB. If the workflow exits before caught up, re-run it manually after checking the failure.
- **No recurring schedule** in V1; post-publication polling and pre-race snapshots belong to a separate phase.

## How to verify
```bash
node scripts/forward-backfill-plan-smoke.mjs
node src/forward-backfill-plan.mjs --from 2026-09-01 --max-dates 60
```
The planner returns pending dates and flags `needs_race`/`needs_odds` without fetching source data.

## One-shot run
Merging the PR containing `.backfill/forward-kick` triggers `Forward historical backfill` on main. Alternatively use Actions **Run workflow** with `start_date` and `max_dates`. Future one-shot reruns are safe because manifest SUCCESS files are reused. The workflow does not run a daily schedule until that separate requirement is implemented.

## Cost guard
Public repository on **standard ubuntu-latest CPU runner only**, without artifacts/caches/LFS/GPU/paid clouds. No paid storage may be created. Stop on the conservative Git size guard before adding a batch; do not work around it without explicit permission.
