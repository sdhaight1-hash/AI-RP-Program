# Normalized story projection — opt-in migration gate

Status: **shadow/dual-write only, not a primary storage cutover**. The existing per-world `studio_state` JSON snapshot remains authoritative for reads and writes. The projection is additive, per-world, and reversible by restoring the full backup. This stage is designed to prove parity and failure recovery before replacing the snapshot or removing the existing roughly 4 MB save limit.

## Safety and preparation

1. Stop AI RP Studio; do not open other tabs, scripts, or processes that can write to `.data` while creating a cross-database backup or applying this migration.
2. Run `npm run audit:storage -- .data`. Investigate any failure instead of forcing a migration.
3. Make an **offline** non-overwriting backup at a new destination: `npm run backup:storage -- .data path/to/new-backup`. Preserve the entire backup, including assets and manifest.
4. Preview without writing: `npm run normalize:storage -- .data`. This reports each world's status, revision, and projected character/scene/message counts.
5. If the dry-run is valid, opt in explicitly: `npm run normalize:storage -- .data --apply path/to/new-backup`. The exact backup must still match all world snapshots and revisions. Never use an unrelated or stale backup.
6. Re-run `npm run audit:storage -- .data` afterward. Each opted-in world should report `projection: "matched"`.

Paths containing spaces need shell quoting. The command never connects to external inference servers or changes model configurations.

## Data model

- `story_projection_meta`: per-world format version, snapshot revision, canonical SHA-256 fingerprint, non-scene state.
- `story_projection_characters`: ordered durable character documents with unique IDs.
- `story_projection_scenes`: ordered scene documents with messages excluded.
- `story_projection_messages`: ordered, source-preserving message documents keyed by scene and position; includes witnesses, channels, speaker, variants, origin and time from the canonical JSON.

Duplicate source IDs or malformed input fail before projection. Stable UUIDs are required: a legacy document that generates random message IDs on each normalization is refused instead of silently selecting one arbitrary history.

All projection writes during ordinary `StudioStore.save` happen in the **same SQLite transaction** as the canonical snapshot, timeline synchronization, FTS updates, actor memories and world projections. Before and after a save the projection's revision and fingerprint are checked. If a trigger, disk error, duplicate identifier or tampering causes divergence, the entire story save is rolled back instead of leaving two different histories.

## Recovery

Stop the application, retain the current damaged directory for investigation, and restore the entire verified backup into a separate empty data directory. Test loading that copy before replacing the installation's `.data`. Avoid copying individual live SQLite files without their related world registry, assets and canonical databases. A failed `--apply` may stage some independent worlds before another world fails; canonical snapshots remain unchanged, and the operation is idempotent after investigating the failure.

The migration's one-world-at-a-time commits are **not** atomic across all world databases. The backup is the cross-world recovery point.

## Limitations, benchmarks, next gate

This projection introduces a second, testable representation and makes future incremental storage possible, **but it does not yet reduce full-JSON network payloads or eliminate the 4 MB snapshot limit**. Source event locks, forks and actor visibility still read their original authoritative tables. Enabling dual-write may increase write time until a proven primary cutover removes redundant work. The baseline at 1K/4K turns is in `docs/storage-scale-baseline.md`.

Issue #31 remains open until a separately tested normalized-primary/partial-write API can load, edit and save large worlds without serializing the entire transcript each turn. Acceptance requires 1K/4K/10K/25K load/save/restore benchmarks, crash injection, multi-tab conflict testing and exact authority/provenance parity. Never delete the canonical snapshot before that gate passes.

Tests: `test/normalized-storage.test.mjs`, `test/normalize-storage-migration.test.mjs`, plus existing world/actor/event/backup tests.
