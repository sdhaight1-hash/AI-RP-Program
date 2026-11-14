# Storage scale baseline — 2026-11-14

Baseline benchmark: `eval/storage-scale.mjs`; tests use a brand-new **temporary disk-backed per-world SQLite database**, synthetic character/scene, actual `WorldPartitionStore` save/reload/FTS memory code, and an appended message followed by a second full save.

Runs: [Node 22/24 GitHub CI](https://github.com/sdhaight1-hash/AI-RP-Program/actions/runs/43643829423). Values are single-run observations on shared hosted runners; **do not treat them as statistically stable latency predictions**.

| Metric | Node 22, 1K turns | Node 22, 4K turns | Node 24, 1K turns | Node 24, 4K turns |
| --- | ---: | ---: | ---: | ---: |
| First save (ms) | 32.22 | 123.02 | 35.27 | 132.66 |
| Snapshot reload (ms) | 1.36 | 3.38 | 1.85 | 6.32 |
| Lexical actor recall (ms) | 2.11 | 3.55 | 2.22 | 3.77 |
| Save after one added message (ms) | 13.08 | 32.28 | 12.58 | 30.96 |
| World SQLite size (MiB) | 1.54 | 5.33 | 1.54 | 5.34 |
| Snapshot JSON bytes | 229,084 | 916,084 | 229,084 | 916,084 |
| Direct actor memory rows | 1,001 | 4,001 | 1,001 | 4,001 |

All benchmark worlds returned `PRAGMA integrity_check = ok`. One-turn resaves became roughly **2.4–2.6 times slower** between 1,000 and 4,000 turns even though the new content was one message.

## Interpretation and limits

- The synthetic snapshot stayed under the 4 MB JSON save limit at 4,000 turns; this is not evidence that a real 4,000-turn story fits. Longer messages, multiple characters and richer per-message metadata can reach the limit sooner.
- World SQLite files are much larger than the serialized JSON because they include FTS and timeline/memory metadata. The database-size growth is expected and must be budgeted separately.
- The test does not measure Windows antivirus, OneDrive-backed storage, busy game workloads, model generation, WAL checkpoints, multi-tab contention, migration overhead or human-scale memory quality.
- These numbers justify **profiling** the whole-snapshot write and memory-index synchronization, not directly choosing a premature replacement schema.

## Next engineering gate

For a normalized persistence migration (Issue #31), preserve message provenance, actor witness scopes, timeline forks, accepted-event source locks and the existing per-world catalog. Target a *per-turn* write path that does not rescan all historical messages, and validate it against this same benchmark at 1K, 4K, 10K and 25K turns. Do a dry-run migration and reversible parity tests before writing to existing worlds.

Run locally with `npm run eval:scale` to see a separate 1K/5K/10K baseline on that machine. It creates and deletes only temporary worlds, never the user's `.data` directory.
