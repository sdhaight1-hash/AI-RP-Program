# Storage performance after opt-in normalized-primary cutover

This report compares the **existing full-snapshot save path** and the optional **normalized-primary** save path using the same synthetic scenes, memory index, world store, Node version and CI runner class. It does **not** compare truly incremental message appends: the browser still transfers a full story document and the server still validates full history.

The benchmark runner is `eval/storage-scale.mjs`. Both modes are exercised on Node 22 and 24 in CI:

- `npm run eval:scale -- --ci` — legacy full-document snapshot.
- `npm run eval:scale -- --ci --primary` — explicit primary-mode conversion in a temporary world before testing a one-turn resave.
- `npm run eval:scale -- --primary` — optional local 1K/5K/10K trial, **never touches the user's data folder**.

## Observed Node 24 runner examples (November 14, 2026)

| Measurement | 1K turns | 4K turns |
| --- | ---: | ---: |
| Legacy one-turn resave, run [43647081762](https://github.com/sdhaight1-hash/AI-RP-Program/actions/runs/43647081762) | ~13 ms | ~31 ms |
| Initial normalized-primary one-turn resave, same run | ~32 ms | ~132 ms |
| Normalized-primary after skipping unchanged message UPSERTs, run [43647177936](https://github.com/sdhaight1-hash/AI-RP-Program/actions/runs/43647177936) | ~23 ms | ~88 ms |

The runner is shared and single-trial measurements vary significantly, including some unrelated legacy timings. These numbers are diagnostic examples, **not a robust speedup claim**. Normalized primary remains slower on the sampled long-world workloads, despite reducing unnecessary SQLite writes.

## What the result means

The optional primary format increases guarded story capacity (up to a 16 MB serialized world document in the current application) and supports parity/rollback validation. It does **not** establish scalable, constant-cost saves. The current bottlenecks include rebuilding the full character/scene document on load, full-story network payloads, revision fingerprint validation, world event-lock scanning and actor-memory source synchronization. Skipping identical message UPSERT statements is a surgical optimization; it does not change those broader costs.

A faster and more scalable future milestone is a versioned **scene/message delta API**, with per-message append/edit preconditions, permission checks, per-world revision conflicts, event source locks and atomic actor-memory indexing. That must be developed behind independent tests and measured against the legacy/primary benchmarks before replacing browser-wide saves. For now, **do not enable primary mode expecting faster 4K+ turn saves**.

User worlds are never converted automatically. Follow the exact backed-up offline procedure in `docs/normalized-primary-optin.md`, and preserve pre-conversion backups.
