# Branch reconciliation and open-ticket audit — 14 November 2026

Baseline: `main` following Character Studio PR #47. This audit compares GitHub source content and branch divergence. It is **not** a claim that historical branches are safe to merge wholesale.

## Four open engineering issues

- **#31 (P1), incremental scene/message persistence:** normalized shadow storage, opt-in normalized primary, and verified append journal already exist. The journal is deliberately an internal opt-in primitive, not the browser's production message path. Large-scene incremental client/server synchronization and Windows recovery/latency evidence are still incomplete.
- **#32 (P1), middle-era actor memory evaluation:** deterministic funnel and provenance tests already exist; real local embedding p50/p95, false-positive rates and annotated multi-world/fork evaluation remain unverified.
- **#33 (P2), frontend domain extraction:** World Atlas, relationships, world timelines and encounter editing have dedicated modules; Character Studio and memory/fidelity controllers remain embedded in `public/app.js`. This pass fixes character AI stream lifecycle races, but does not complete extraction.
- **#38 (P2), whole-world/timeline deletion:** character/scene and individual world-entry deletion already have guarded paths. Crash-safe world/timeline tombstones, media reference accounting, and Windows lock recovery are NOT implemented. Do not add a raw filesystem-delete shortcut.

## Historical branches: content checks

Git history reports many old feature and work branches as `diverged` after squash merges. Ahead/behind counts do **not** indicate that their code should be reapplied.

Verified identical to current `main` on the cited canonical module:
- `work/normalized-storage-and-eval-20261114`: `eval/semantic-recall.mjs`
- `work/primary-append-journal-20261114`: `storage/append-journal.mjs`
- `audit/conflict-integrity-20261114`: `world/conflict-guards.mjs`
- `work/actor-memory-evidence-bench-v1`: `eval/actor-recall.mjs`
- `work/world-timeline-studio-20261114`: `public/world-timelines.mjs`

These per-file matches are **not** proof the entire branches are equivalent.

Branches needing explicit, selective comparison:
- `work/scene-delta-append-20261114` includes `scene/append.mjs` absent from main. The implementation validates world, revision, witness and role, but calls `store.save` with a full scene snapshot; it does not yet deliver genuinely incremental persistence. The branch's `public/app.js` and `server.mjs` predate newer deletion and world-editor protections. Do not merge wholesale.
- `work/normalized-primary-optin-20261114` has an older `storage/normalized.mjs` blob than main. A different blob is not evidence of an unmerged feature. Evaluate only targeted diff hunks.
- `fix/durable-deletion-and-ghost-entries-20261114` has an older `world/deletion.mjs` blob than main; later conflict-integrity fixes must remain authoritative.

## Safe merge policy

1. Compare a branch's *current behavior and files* to `main`, not only its number of commits ahead.
2. If an old branch's intended feature is already present, retain history without re-merging it.
3. Port genuinely missing changes onto a **fresh branch based on main**, preserving deletion, provenance, world ID, and revision guards.
4. Run Node 22/24, actor recall/semantic/storage gates, and Chrome two-tab tests before merging.
5. Never close #31, #32 or #38 on synthetic tests alone; the acceptance criteria explicitly require additional hardware, load, recovery or real-model evidence.

This repository audit could not inspect the user's Windows-local `.data` directory or real local model. It does not alter either. No world or timeline is deleted as part of reconciliation.
