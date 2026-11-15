# Issue #31 — scene persistence profiling and incremental write gate

**Status:** measurement infrastructure, not an incremental-storage migration or a fast append feature. There is deliberately no new endpoint accepting unverified scene JSON.

## Repeatable experiment

The existing `eval/storage-scale.mjs` uses fresh temporary SQLite worlds, creates deterministic witnessed player messages, verifies FTS actor memory and SQLite integrity, and deletes the temporary worlds afterward.

This pass adds repeatable **sequential one-message resaves** with latency samples, p50, p95, point-in-time heap/RSS observations, and an optional longer 25,000-turn trial.

| Invocation | Scope |
| --- | --- |
| `npm run eval:scale -- --ci` | Existing fast 1K/4K legacy checks, one sample |
| `npm run eval:scale -- --ci --primary` | Same checks, opt-in normalized-primary snapshot |
| `npm run eval:scale -- --lab --samples=3` | 1K/10K/25K messages, three sequential one-turn saves each |
| `npm run eval:scale -- --lab --primary --samples=3` | Equivalent long-world run in opted-in normalized-primary mode |
| `npm run eval:scale -- --samples=5 --primary` | 1K/5K/10K local calibration |

These numbers come from **this machine**, not the user's Windows desktop. The lab does not load a GGUF model or call the network. Memory figures are point-in-time readings, **not** actual peak RSS/heap. Sequential samples are useful for spotting history-size scaling and warm-state variation but are not independent full-process latency samples. Benchmark runtimes and absolute timings are not a shipping guarantee.

## Why an append endpoint alone is not the answer

The existing `work/scene-delta-append-20261114` prototype is deliberately **not** merged into the current app. It appends one message to an in-memory world and calls `store.save` for the *entire* normalized full-state document. It retains full-story serialization, transcript scan, global fingerprint, lore index, timeline checks and actor memory synchronization; its cost still grows with history.

It also predates the seven communication channels. An in-person-only witness calculation is now wrong for explicitly cast-visible webcam and social threads. It predates the durable world mutation epoch and the one-use server-owned NPC completion ticket. Reusing the prototype without reconciling those invariants would reintroduce the bugs fixed in PRs #40–#42.

## Minimum correct genuinely incremental architecture

1. **Maintain legacy and normalized-primary v1 unchanged for existing installations.** New acceleration must be optional, versioned, backup-gated, offline-migrated and reversible from a verified backup. No automatic primary upgrade on a normal world open.
2. Introduce **versioned normalized-primary v2 scene/message checkpoints** (or an equivalently verifiable per-scene integrity scheme). The present v1 projection fingerprint hashes the entire reconstructed world. A purported O(1) append cannot recompute that old fingerprint without reading all messages; skipping integrity verification would break the storage contract.
3. Authorize a **player-only append** on the server: world ID, scene ID, expected revision, new source ID, bounded text, timestamp and selected medium. Load only that scene's metadata and last relevant speaking turn. Compute witness recipients from the current `CHANNELS` catalog, including webcam/social-thread cast visibility. Do not trust browser-supplied witnesses, NPC roles or speaker IDs.
4. In **one `BEGIN IMMEDIATE` transaction**: verify revision, world association, scene/cast identity, reply/ticket state, no duplicate source ID, fork dependency and accepted-event constraints; append only the new message and per-scene integrity checkpoint; update a bounded metadata record, story revision and world epoch; write only affected actor-owned memory/FTS rows. A failure must roll back all of it.
5. Perform an equally strict **server-generated NPC completion** without importing model text from the browser. Preserve source fingerprints, accepted event locks, retry variants and per-channel witness authority. No second untracked save may slip between append and context assembly.
6. **Measure the whole turn**, not only the SQLite INSERT: browser request bytes, world snapshot serialization, actor-context assembly, memory retrieval, native token counting, one message write, NPC commit and eventual UI response. If `GET /api/state` or every context build still rehydrates the 25K transcript, the full-turn workload may remain history-dependent even when a single INSERT is cheap.

## Promotion gates

- Complete backup + verified offline dry-run, rollback on migration failure, WAL integrity across server restart and cross-world contamination testing.
- 1K, 10K and 25K message parity (timestamps, IDs, witnesses, pin flags, speaker, chronology, lore permissions, accepted locks, fork lineage and revoked facts).
- Fail-injected rollback of message insert, projection integrity update, FTS insert and revision write; replay and cross-tab conflicts; world clock and actor move mid-generation.
- Real browser new player message → local model → one-use NPC ticket → authoritative SQLite reply commit. No duplicate messages or lost unsent text.
- Measured p50/p95 append latency grows far more slowly with transcript size than the current full-snapshot baseline **and** whole-turn latency improves materially. No performance claim before actual comparative results.

**Next code checkpoint:** implement and verify the v2 per-scene integrity/checkpoint format on fresh temporary worlds; only after that passes a backed-up migration dry run should the app expose a true incremental endpoint. Keep `main` on its existing fully tested storage until both consistency and speed gates are met.
