# Normalized-primary storage — explicitly opted-in, backup-gated

The default AI-RP storage remains the existing per-world JSON snapshot. The optional normalized projection is a prerequisite for an **additional** primary conversion; nothing converts automatically at startup, on updates, or merely because a world is opened.

## Safe conversion procedure

**The AI RP Studio process must be stopped** while making the backup or converting the worlds.

1. Inspect the current files: `npm run audit:storage -- .data`.
2. Create a **new** offline backup: `npm run backup:storage -- .data path/to/backup`. Preserve it unchanged.
3. Preview: `npm run normalize:storage -- .data`. This is read-only.
4. Stage normalized shadow tables (if not already done): `npm run normalize:storage -- .data --apply path/to/backup`.
5. Opt in to primary mode: `npm run normalize:storage -- .data --primary path/to/backup`. The backup must match the source stories and world revisions. Each SQLite world cutover is transactionally atomic.
6. Verify: `npm run audit:storage -- .data`. Inspect that `projection` is `matched` for each world. Test reloading real worlds and their timelines before removing any old backup.

Paths with spaces must be quoted in the shell. Never use an unverified backup or edit the database with a generic SQLite browser while AI RP Studio is running.

## How it works

The per-world `studio_state` row continues to hold the monotonic revision and now stores only compact world/story settings and empty character/scene arrays. `story_projection_characters`, `story_projection_scenes` and `story_projection_messages` become the authoritative complete character and scene documents. `story_projection_meta.primary_mode` marks this change explicitly and retains a fingerprint, revision and reconstructed non-scene data for parity checks.

The application reconstructs the full story at load time and verifies it matches the compact row. A missing projection, damaged source or mismatched revision **fails closed** rather than replacing characters or story with empty arrays. Saves write both the compact metadata and normalized rows in the same SQLite transaction as actor-memory synchronization, event validation, lore indexing and the revision. A failure rolls back the entire write.

Existing event locks, witness IDs, fork boundaries, per-world isolation and creator approvals retain their original authority. Verified backups continue to include all normalized tables and assets.

## Limits and unresolved work

This removes the *SQLite snapshot's* 4 MB full-story limit for opted-in worlds; a larger total story (up to a guarded **16 MB full-document transfer limit**) can be saved while the compact metadata is under 4 MB. Non-opted-in worlds still have the original 4 MB limit. The HTTP server accepts bodies up to 17 MB for the state endpoint, with stricter limits enforced inside the store.

**Do not enable normalized-primary expecting faster saves.** Hosted-runner benchmarks found slower one-turn resaves for long worlds, despite avoiding unchanged message UPSERTs. See `docs/storage-primary-benchmark.md` for the measurements and caveats.

**This is not incremental browser synchronization.** The browser still sends and receives complete story documents; normalization and actor-memory synchronization still scan the history on writes, and browser localStorage backups may exceed their quota for large histories. A future revision must use scene/message delta endpoints, state pagination and browser history virtualization to make 10K–25K+ turn stories genuinely efficient. Do not infer performance improvements from the larger size limit.

The conversion is not reversible simply by clearing the mode flag: the compact snapshot does not contain full history. Roll back by stopping Studio, preserving the current data directory for investigation, and restoring the **whole pre-conversion backup** into an empty data directory, with its registry, world SQLite files and assets. Cross-world conversion is one transaction **per world**, not globally atomic. Partial application can leave a mixture of old and new worlds, but each remains internally consistent and the backup remains the recovery point.

Relevant tests: `test/normalized-primary.test.mjs`, `test/normalized-storage.test.mjs`, `test/normalize-storage-migration.test.mjs`, world/memory/event regression suite and the headless Chrome smoke. Hardware-specific timing and realistic large-world data still require measurement.
