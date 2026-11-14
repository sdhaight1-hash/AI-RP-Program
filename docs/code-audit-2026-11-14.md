# AI-RP Program — targeted correctness audit (2026-11-14)

**Baseline:** `main` at `dc7e660c049b843e74ef5face214c814024397e3` (Studio Experience v3).  
**Implementation:** PR #28, `audit/character-kinship-context-20261114`.  
**Scope:** review of repository structure, tests/CI, `server.mjs`, `storage.mjs`, `world/persistence.mjs`, `world/partition-store.mjs`, character authoring and bridge modules, memory stores and semantic retrieval, and actor context assembly. This is a targeted static and CI-backed audit—not a claim that every UI/model path was manually exercised.

## Fixes and reproduced failure paths

### 1. Character-origin relationships were invisible to the character (functional correctness)

An approved relationship is intentionally directed from the newly approved world person toward the originating character (example: Nessa **aunt** → Mara). The acting-prompt builder only read *outgoing* edges from Mara, so approval did not make the family relationship available in Mara's runtime social context. Naively reading all incoming edges would be unsafe: an unrelated NPC might privately admire, dislike or suspect Mara.

**Fix:** retrieve incoming edges only when `character_world_relationship_sources` proves the edge was explicitly reviewed from *the acting character's own* source. Validate source entry, direction, world and actor IDs in the join. Preserve normal outgoing-relationship handling. No approval or database schema semantics changed.

**Regression:** approve Nessa as an aunt, assert Mara's assembled prompt includes the approved tie; add a separate unreviewed incoming admirer edge and assert that it does not appear.

### 2. Failed world switch could desynchronize registry and open world (state integrity)

`WorldPartitionStore.activateWorld` previously closed and replaced the active store before it attempted the registry write. A failing trigger/SQLite error would leave the old registry ID and a different in-memory active-world ID even though the switch reported failure. Derived entity creation also happened after publication.

**Fix:** open the destination world without closing the source; begin a destination SQLite transaction, perform character-entity projection, commit, then write the active-world registry setting. Only after all steps succeed do we publish the new in-memory world and close the old connection. Errors close the unused destination connection and roll back any open destination transaction.

**Regressions:** inject a registry update failure and prove the previous world is still readable and writable; inject a destination entity-projection failure and prove the active world, registry, and destination entity table remain unchanged.

**Limitation:** the registry and world are separate SQLite databases, not one cross-database atomic commit. The fix makes the failed activation paths consistent without a database redesign, but is not a crash-consistent, multi-database transaction guarantee.

## Audit assessment and next implementation priorities

### P0 — Remove process-global selected-world data routing

`WorldPartitionStore` still exposes one process-wide `current` connection. The existing HTTP worldId checks prevent many stale writes, but switching tabs still replaces the backend for all clients, while a `GET /api/state` without a worldId remains a compatibility path. Do **not** simply remove checks or auto-switch on requests.

**Next milestone:** introduce an explicit world-specific store resolver for every stateful request and async job, without making an active-world switch implicit. Keep world selection as a browser/workspace preference. First add dual-tab tests: world A and B may simultaneously read, edit, save, generate and retrieve only their own resources; failures in one must not alter the other; stale revisions remain 409 within that world. Preserve legacy upgrade/export paths. This is the next architectural change worth making.

### P1 — Establish a real recall-quality and latency gate

The opt-in dense retriever currently embeds at most 96 authorized recent/pinned candidates and returns at most three matches. This is privacy-preserving but cannot retrieve arbitrary older unpinned evidence outside its candidate window. FTS5 and semantic cues are not substitutes for full long-running memory evaluation. The current deterministic fixture is small and the actual local-model impact is unmeasured.

**Next milestone:** expand the evidence-funnel dataset across actors, forks, paraphrases, composed questions and benign negatives; measure stored / retrieved / final-packed source IDs, false positives, p50/p95 CPU retrieval latency, and prompt token costs. Only change cache/index or candidate selection after comparing against the lexical-only baseline. Continue failing closed across world, actor and timeline boundaries.

### P1 — Data growth and recovery

The main story document remains an approximately 4 MB world-local snapshot. Normalize independently versioned scenes, messages and references only after a tested migration and restore procedure. Test multi-thousand-turn worlds, process restarts, interrupted writes, FTS rebuilds and full `.data/` backup/restore, including legacy migration. Never introduce a silent truncation or destructive migration.

### P2 — Break up the browser controller behind integration tests

`public/app.js` is approximately 172 KB and couples many workspaces. Do not do a blind rewrite. Extract one stable domain controller at a time (world navigation, character authoring, story interactions, memory review), with real HTTP/browser tests for switching, stale drafts, source approvals and history. Retain the v3 navigation and design.

### P2 — Verify live Windows local-model and ComfyUI behavior

CI uses deterministic mocks and synthetic evaluation; it cannot prove live KoboldCpp/LM Studio generation quality, model-native token limits, GPU latency, or real ComfyUI jobs. Run the in-app Fidelity Lab and a repeatable Windows smoke scenario on the user's machine before claiming model-level fidelity.

## Verification and safeguards

PR #28 was run through the configured GitHub Node 22/24 `npm test` matrix, `npm run eval:memory`, syntax checks and Node 22 headless Chromium smoke. No non-test user data was used as a fixture. No dependencies, network exposure, model settings, or on-disk schema were changed.

**Do not infer:** CI success is not a full security audit, native-tokenizer evaluation, desktop UX approval, or evidence of high-fidelity NPC roleplay. Before any later storage migration, back up the entire `.data/` directory.
