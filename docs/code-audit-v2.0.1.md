# AI-RP-Program v2.0.1 — Whole-repository correctness and hardening audit

Baseline: `b76e29c2a5bad922fc32517c8bf0c10529a2b32e` (v2.0.0). This pass focused on persistence, world isolation, character/world coherence, generation boundaries, the optional ComfyUI adapter, the Node HTTP API, and browser integration. The original application and user data were not overwritten or used as test fixtures; new tests use temporary SQLite databases.

## Fixed findings (ranked by impact)

| Severity | Finding in v2.0.0 | Repair and verification |
| --- | --- | --- |
| Critical — availability | `/character/context.mjs` was mapped under `public/character` instead of the real `character` directory, breaking a normal browser module import. | Fixed the static allowlist path; HTTP regression test requests every new character module. |
| High — world integrity | The active world is selected process-wide. An older tab could unintentionally target data, portraits, generated jobs, or NPC retrieval from the other tab's newly selected world. | World-scoped query/body IDs for state reads, lore, event review, timeline operations, portrait upload/download, NPC inference, and ComfyUI jobs; stale requests return `409`. Browser warns and stops saving when another tab changes the world. Offline generation/UI state is cleared when switching. |
| High — state integrity | Character-derived world entities were written **after** the scene state had committed; an entity-insert failure left a committed story despite an API error. | Moved entity projection into the **same SQLite transaction** through a focused precommit hook. A failing trigger now proves rollback of the entire save and revision. |
| High — privacy/retrieval | Lore retrieval limited the top 100 FTS hits before applying character knowledge permissions, so private results could crowd out all visible lore. | The SQL query now intersects FTS results with permitted lore IDs **before** BM25 ranking/limiting. Regression with 160 private decoy entries. |
| High — attribution | World-local saves checked character home/workplace locations but not foreign scene speakers, casts, witnesses or encounter participants. | Reject foreign references before normalization can silently discard them. Preserve existing historical attribution and verified scene/timeline ownership. |
| High — history | Purging a branch's source scene could remove the ancestry needed to verify inherited, committed world events. | Prevent purge of parents with dependent branches; reject orphaned source-linked branches in the save transaction. |
| Medium — backup integrity | Raw `copyFileSync` backups could miss committed pages in SQLite WAL mode. | Pre-upgrade snapshots use SQLite `VACUUM INTO`, with historical backup filenames maintained. WAL consistency/integrity regression test. |
| Medium — API robustness | Streaming HTTP JSON used per-chunk UTF-8 decoding and UTF-16 length accounting. A split multibyte character could be corrupted. | Collect byte-counted chunks before decoding; split-UTF-8 HTTP regression. |
| Medium — world lifecycle | A failed registry insertion could leave an unlisted world directory on disk. | Remove staging/final directory after failed world creation; tested using a deliberately failing registry trigger. |
| Medium — authoring correctness | AI character drafts could survive changing their home/work/frequent-place links even though those links influence drafting context. | Include familiar-place assignments and world ID in the draft-version fingerprint; tests reject stale proposals. |
| Medium — media | ComfyUI job IDs, image previews and late asynchronous responses were not scoped to their originating world. | Bind jobs to world ID, reject cross-world image retrieval, clear stale browser results, and ignore responses after a world switch. |
| Low — consistency | A mixed ComfyUI prompt string containing both positive and negative placeholders replaced only the positive token. | Replace both placeholders in one pass, with a regression test. |
| Performance | Each save queried the entity table once per character; branch-lock verification repeatedly filtered all accepted events. | Load linked entities in one query per save and index accepted events by source scene once per validation. No behavior change intended. |
| Cleanup | Old encounter-scenario shaping lingered in actor context and header after the v2 migration. | Removed inactive scenario-copy logic and the obsolete character-scenario header fallback; encounter templates remain the authoritative scene opener. |

## Verification

- `node --test`: **102 passing**, zero failures. Original baseline: 91 passing.
- `node --check` for every JS/MJS source file: passed.
- Direct HTTP integration tested the actual static route, world-scoped request failures, world/data isolation and fragmented UTF-8 bodies.
- Offline Chromium browser integration: switch between two distinct worlds, create/edit characters, review/apply a contextual AI suggestion, add an encounter, and start it as a messaging scene; **zero JavaScript page errors**. This test simulates backend responses and is not an end-to-end live HTTP browser test.
- Node CI runs on Node 22 and 24 where supported by GitHub Actions.

## Remaining limitations / follow-up work

1. **Single process-wide active world.** This pass rejects stale-world calls and disables saves in old tabs, but a proper per-tab world-context service would eliminate the need for reloads when two tabs use different worlds concurrently. That requires a separate deliberate API redesign.
2. **Hybrid JSON snapshot.** Scenes and character state still live in a world-local snapshot with a 4 MB bound; normalized event, location, and relationship tables coexist. Large-world scaling and fully normalized character/scenes are separate migrations requiring backup and replay testing.
3. **Frontend monolith.** `public/app.js` remains large. Splitting it safely should follow browser integration coverage for real world switching, event review and ComfyUI; a broad untargeted rewrite now would add risk rather than reduce it.
4. **Local application threat model.** SQLite/portraits/browser backups are not encrypted; the server intentionally binds to loopback. Do not expose the service publicly without authentication, authorization and deployment review. Structural reply heuristics are not proof of language-model correctness.
5. **Model and media realism.** No actual Windows/KoboldCpp/LM Studio generation, or live ComfyUI workflow execution, was run here. Model compliance and GPU behavior still require an on-device test.
6. **ComfyUI jobs are ephemeral.** Job tracking is intentionally process-memory-only. Server restart discards known job IDs; persisting job metadata would require an explicit per-world asset lifecycle design.

## Upgrade and backups

No new on-disk schema version is introduced. Existing v2 world SQLite files and portraits remain in place. **Back up the entire `.data/` directory before pulling this release.** All audit tests create isolated temporary databases. The release source excludes `.data/`, model weights, images, and user stories.
