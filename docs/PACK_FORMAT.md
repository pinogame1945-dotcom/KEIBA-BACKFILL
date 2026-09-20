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
