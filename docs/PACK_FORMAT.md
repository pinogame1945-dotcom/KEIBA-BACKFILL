# Cloud pack contract v1

KEIBA-BACKFILL publishes only normalized structured data. Raw source HTML is not a public pack format.

## Manifest

Path: `data/manifest.json`

```json
{
  "schema_version": 1,
  "updated_at": "ISO-8601",
  "days": {
    "YYYY-MM-DD": {
      "status": "SUCCESS",
      "races_discovered": 24,
      "races_parsed": 24,
      "file": "data/daily/YYYY-MM-DD.jsonl.gz"
    }
  },
  "horse_packs": {
    "pack-name": {
      "status": "SUCCESS",
      "records": 250,
      "file": "data/horses/pack-name.jsonl.gz"
    }
  }
}
```

Only `SUCCESS` packs are importable.

## Race pack

gzip-compressed JSON Lines. One race per line.

Required top-level fields:

```json
{
  "schema_version": 1,
  "race": {},
  "entries": [],
  "results": [],
  "payouts": [],
  "laps": [],
  "corners": []
}
```

The app imports by stable `race_id` and `horse_id` and uses UPSERT/replacement semantics.
Re-importing the identical gzip is skipped by the device ledger.

## Horse pack

gzip-compressed JSON Lines. One horse per line.

```json
{
  "schema_version": 1,
  "kind": "horse",
  "horse_id": "stable-netkeiba-id",
  "profile": {
    "horse_name": "...",
    "birth_date": "YYYY-MM-DD",
    "sex": "牡",
    "coat_color": "...",
    "status": "...",
    "trainer_id": "...",
    "owner_id": "...",
    "breeder_id": "...",
    "birthplace": "...",
    "profile_raw_json": "{}",
    "source_url": "...",
    "fetched_at": "ISO-8601",
    "parser_version": 1
  },
  "pedigree": [
    {
      "generation": 1,
      "slot": 0,
      "ancestor_id": "...",
      "ancestor_name": "...",
      "raw_text": "..."
    }
  ]
}
```

Pedigree positions use the existing KEIBA-DATA-CORE convention:
generation 1 has slots 0=SIRE and 1=DAM; each following generation doubles slots.

## Import guarantees

The Android app must:

1. gunzip and parse the complete pack before marking it imported;
2. validate the manifest record count;
3. UPSERT canonical rows by stable IDs;
4. rebuild `horse_parent_edges` from imported pedigree nodes;
5. refresh affected sire/race projections;
6. record the pack hash only after all canonical writes succeed;
7. allow a changed pack to be imported again;
8. never require raw HTML to reconstruct canonical data.

This contract is append-only within schema v1. Breaking changes require a new schema version.


## App database independence

This pack schema is a logical interchange contract, not a mirror of the Android SQLite schema.

The Android app owns a canonical ingestion adapter that maps pack v1 into its current database layout. Therefore:

- app DB migrations do not require changing BACKFILL when the logical fields are unchanged;
- analysis/projection changes stay inside the app ingestion layer;
- physical table splits or renames stay inside the app;
- BACKFILL changes only when the logical data being transported changes.

A new app DB schema version and a new pack schema version are independent decisions.


## Schedule integrity contract

Race packs created with schedule integrity enabled use `race_pack_version: 3` and
`schedule_contract_version: 1`.

The calendar date owning a daily race pack is the race's actual execution date.
A race MUST NOT be stored in a daily pack whose date differs from
`race.actual_date`.

For a normally held race:

```json
{
  "race_pack_version": 3,
  "schedule_contract_version": 1,
  "race": {
    "race_id": "202609040711",
    "scheduled_date": "2026-09-21",
    "actual_date": "2026-09-21",
    "schedule_status": "ACTIVE"
  }
}
```

For a postponed/rescheduled race, the canonical race ID remains unchanged and the
record belongs only to the actual execution day's pack:

```json
{
  "race_pack_version": 3,
  "schedule_contract_version": 1,
  "race": {
    "race_id": "202606040701",
    "scheduled_date": "2026-09-21",
    "actual_date": "2026-09-22",
    "schedule_status": "RESCHEDULED"
  }
}
```

The manifest keeps meeting-level history under `rescheduled_meetings`. This is
meeting-level rather than day-level because one venue may be postponed while
another venue runs normally on the same calendar date.

If every scheduled meeting on a calendar date is moved away or cancelled and
therefore no race pack is owned by that date,
`schedule_exception_days[date]` marks the date as `NO_RACES_HELD`.
Meeting-level history remains authoritative in `rescheduled_meetings` and
`cancelled_meetings`. A partial cancellation/postponement does not turn the
whole calendar date into a no-race day; normally held venues remain in the
date's SUCCESS pack.

Historical final-odds packs keep `odds_pack_version: 1` for app compatibility,
but schedule-aware odds records and manifest entries add
`schedule_contract_version: 1`, `actual_date`, and `scheduled_date`.

A schedule-contract race pack requires a schedule-contract odds pack before that
odds day is considered complete.
