# Deep bug and architecture-conflict audit — 14 November 2026

**Baseline:** `main` commit `18601adf4b995102ab48689373ec31fab8c6d414` (deletion repair PR #37). **Scope:** story replacement, archive/purge, world catalogs and mirrors, normalized-primary/shadow storage, SQLite provenance/forks, actor memory, synthetic local-inference context, browser save/world-switch concurrency, storage diagnostics, and divergent development branches.

This is a code-level and hosted-runner verification pass on a *public repository*. The user's real Windows `.data` worlds, model server, media assets and hardware were **not accessed or modified**. Passing CI does not substitute for application-level trials with real large worlds.

## Reproduced bugs and targeted fixes

| Priority | Conflict | Reproduction / effect | Remedy |
| --- | --- | --- | --- |
| **P0** | General `PUT /api/state` versus confirmed Library purge | Omit a character or scene from the replacement snapshot: the old path could accept the write and trigger irreversible actor/entity cleanup without archive or dependency checks | A dedicated `assertExplicitPurges` checks prior saved IDs **inside the same SQLite write transaction**, requires the archived source and an explicit matching purge grant, and re-runs `purgeArchived` dependencies. Normal HTTP saves also reject unconfirmed removals with 409, including legacy backend |
| **P0** | Timeline fork fact inheritance versus normalized-primary | `snapshotFactsForFork` parsed the compact `studio_state.document`, where primary-mode scenes are deliberately empty; source-verified direct facts disappeared from fork snapshots | Read and verify normalized-primary scene records during fact inheritance. Real parent-to-child reviewed-fact test |
| **P0** | Permissive browser normalization versus corrupt durable snapshot | Bad persisted `studio_state` shape could invoke `makeInitialState` and show demo characters, or silently omit malformed stored characters/scenes | Durable reads validate shape before normalization, reject malformed records rather than saving replacement fiction, and close the SQLite connection on initial read failure |
| **P1** | Old ghost deletion versus missing mirror and timeline membership | Old rows could survive in accepted events and actor memory even after linked `world_entities` and `timeline_actors` were removed | Historical one-time ghost sweep over actor-owned memory/fact/proposal/event sources on world connection opening, and explicit purge support during regular saves. No full historical scan per save |
| **P1** | Ghost repair versus non-character world actors | A generic position/observer sweep could misclassify legitimate `system` actors and remove their locations or observations | Limit orphan discovery to actor-owned NPC records; retain system/player actors and their observed events |
| **P1** | Legacy snapshot IDs versus memory/event provenance | Duplicate character, scene or within-scene message IDs were accepted without shadow/primary projection, making source lookup ambiguous | Shared source-ID validation on every durable save/load, regardless of storage mode, with rollback and memory-row count regression checks |
| **P1** | Character projection versus manually created duplicate mirror | Multiple atlas persons could claim one `source_character_id`; UI and actor context might select different records | Reject new duplicate profile-linked entities, warn about existing duplicates, permit explicit deletion of a redundant mirror only when another remains |
| **P1** | Async UI deletion versus world switch and pending edit | Target world was captured *after* an await; a concurrent switch or edit could be misrouted or overwritten by a purge response | Capture original world ID, lock interactions and world switching while permanent deletion runs, and preserve/export a racing browser draft rather than silently replacing it |
| **P1** | Async prompt assembly versus independent world mutation | A clock, position, actor fact or canon edit does not necessarily increment the story revision, so native-token or semantic awaits could produce a stale prompt with unchanged `studio_state.revision` | Also snapshot SQLite connection `total_changes()` and `PRAGMA data_version` before model-dependent awaits, rechecking before context exposure or beginning reply streaming. Covers same-connection and external-connection commits |
| **P2** | Read-only audit versus hidden ghosts | Old missing scene/actor data and duplicate identities could be invisible to the existing integrity report | Add warning counts for orphaned actor records, source-scene rows and duplicate linked persons; do not count intentionally retained **accepted** world events as orphaned scene memories |

The tests use fresh temporary worlds, real SQLite foreign keys and FTS triggers, manual fault injection and HTTP requests. They check that source authority, world separation, accepted-event locks and intentionally retained canon are not changed without a creator action.

## Source-of-truth contract

1. **One world = one SQLite file**; a request's world ID binds its state, actor authority, facts, timeline and assets. The catalog is not a combined fictional reality.
2. A story's `studio_state.revision` protects normal replacement concurrency, but independently committed world facts and locations need an *additional* mutation check across inference awaits.
3. **Archive is reversible; purge is not.** Dropping a record from an arbitrary client JSON object is not authorization to erase it.
4. Character biography and model text do not create canon without explicit creator approval. Permanent character deletion removes its owned actor data; separately authored world canon remains independently deletable.
5. Normalized-primary scenes are authoritative once explicitly activated. Code must never assume the compact `studio_state.document.sessions` is a complete history in that mode.
6. Actor memories are witness/timeline-scoped. Reviewed facts must retain their immutable source identity, including at a branch fork boundary. Neither retrieval scores nor an LLM response confer world-event authority.
7. Invalid or duplicate source IDs fail closed. No fallback to sample characters should occur for an existing SQLite revision.

## Remaining engineering conflicts — not claimed solved

**P1: A world edit during an already-started model stream** remains a race. The current patch rejects changes while *assembling* a context or waiting on model-counting, but once streaming has started it may deliver partial text under an old clock/position. A future server-owned response/commit basis must bind both the story revision and a durable world mutation version. This needs a real streaming concurrency regression test.

**P1: Scene-delta branch is not integrated.** `work/scene-delta-append-20261114` was green at head `0b9254351d99e5ab0c896b1df1e8edcb3507af4c` but has diverged from `main` after PR #37 (9 commits ahead and 1 behind as reviewed). It must be rebased and rerun the new purge/integrity gates before review. Its append endpoint still reconstructs and saves the *entire* story snapshot; it is not a constant-cost normalized message append.

**P1: Storage scaling** remains incomplete (Issue #31). Optional normalized-primary increases guarded capacity but on CI it was **slower** at 4K-turn one-message resaves than the original full-snapshot format. Browser state transfers and actor-memory source scanning remain history-dependent. Do not automatically convert existing worlds or advertise it as a performance improvement.

**P1/P2: Timeline/world lifecycle** (Issue #38). Branch creation and browser scene duplication are separate operations and can leave an empty fork if the second save fails. Destructive whole-world/timeline delete, media reference counting, cross-DB crash recovery and filesystem tombstones need explicit design before implementation.

**P2: Character mirror uniqueness at the database constraint layer.** New links are blocked by application validation, but old duplicate rows cannot simply be constrained by a new unconditional UNIQUE index. First remove/merge intentional older duplicates with provenance-aware review, then consider a partial unique index and an offline reversible schema migration.

**P2: Frontend complexity** (Issue #33). `public/app.js` is still a large integrated module; broad refactoring would be riskier than extracting tested domain boundaries incrementally.

**P2: Local embedding/model realism** (Issue #32). CI uses transparent mock vectors and synthetic latency; it has not benchmarked the user's Windows GPU, real GGUF model, LM Studio/KoboldCpp, or ComfyUI outputs.

**Backup/privacy limitations:** logical SQLite deletion does not wipe old backup exports, WAL pages, system snapshots, images or manually copied files. The read-only storage audit reports internal consistency, not secure erasure.

## Verification and next gates

Run `npm test`, `npm run eval:memory`, `npm run eval:semantic`, and `npm run eval:scale -- --ci` plus the Node 22 headless Chrome smoke. CI runs Node 22 and Node 24. New cases are `test/conflict-integrity-audit.test.mjs` and `test/world-mutation-stamp.test.mjs`; retained previous gates include `test/durable-deletion.test.mjs`, `test/forks.test.mjs`, `test/normalized-primary.test.mjs`, and `test/multiworld-concurrency.test.mjs`.

**Recommended order:** finish this conflict audit and merge only after green CI; then implement durable world mutation epochs through final NPC reply commit; rebase/validate the scene-delta branch against deletion locks and primary worlds; measure incremental write costs before migration; then continue P2 frontend/domain separation and real-model hardware checks.

The storage inspection command (`npm run audit:storage -- .data`) is **read-only**. An actual copy of user data would need that user's offline backup and explicit choice; this audit never opens it.
