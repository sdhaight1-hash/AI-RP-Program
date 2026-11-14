# Actor-perspective memory and small-context generation (v2.1 development)

Status: dialogue memory and server-owned compact context are merged. A second incremental milestone adds evidence-linked, user-reviewed subjective actor facts. Automatic memory extraction and semantic consolidation remain separate work.

## Authority contract

- **World** remains the hard outer boundary: the registry never contains private memories.
- **Timeline** owns observations and mutable state. Forks copy remembered dialogue at fork time. Later parent observations cannot enter the child.
- **Actor** owns recollections of witnessed or spoken dialogue. Private exchanges are never indexed for nonparticipants.
- **Speech is not canon**. "Player said X" records hearing X, not that X happened. Accepted world events remain separately authorized and exposed through the existing event ledger.
- **Character definitions** are durable world canon and subject to topic-sensitive retrieval; ephemeral mood, current location, and clock are timeline state.
- **Browser** cannot construct the acting system prompt. The server resolves the saved scene, eligible acting NPC, witnessed history, role/medium rules, permitted lore, and memory evidence.
- **Reviewed character knowledge** (beliefs, promises, relationship memories, autobiographical details, observations) can be manually captured from witnessed messages. Corrections supersede earlier notes, preserving their history. No automatic LLM memory extraction is enabled yet.

## Files and data flow

- memory/store.mjs — SQLite actor_memories, FTS5, synchronization in the story save transaction, and immutable fork snapshots.
- character/relevance.mjs — authored Character Studio fields (biography, appearance, family, routines, etc.) activated by current conversation cues.
- context/assemble.mjs — per-turn actor-visible context, hybrid source selection (FTS, recent evidence, timeline events, permitted lore, structured character detail), prompt packing.
- context/backend.mjs — KoboldCpp context capacity and exact token counts when available; LM Studio loaded-instance context discovery; conservative estimated fallback.
- storage.mjs, world/persistence.mjs, world/partition-store.mjs — transactional memory updates and safe world migration.
- GET/POST /api/actor/facts and POST /api/actor/facts/revoke — inspect, add, supersede or revoke evidence-linked subjective actor knowledge within the active world and timeline.
- POST /api/actor/context — server-owned preview, selected memory IDs, actual/estimated prompt tokens.
- POST /api/actor/reply — server-owned prompt, streaming OpenAI-compatible local model response; client cannot supply arbitrary actor history.
- POST /api/chat remains available for explicitly stateless tools such as character authoring and the fidelity lab. Normal NPC turns no longer use this path.

The browser sends world/scene/actor/model/mode, current revision, output tokens, and intended context window. The server resolves all knowledge against its saved SQLite state.

## Context budgets

- Default configured acting context is 4096 tokens; supported user setting is 2048–32768.
- KoboldCpp's reported allocated context is a hard ceiling and its native /api/extra/tokencount provides a model-aware count.
- For LM Studio the native model list can provide the loaded instance's configured context length. Where native token counting is unavailable, the UI reports an estimate, never falsely labels it exact.
- The generation reserve and safety margin are excluded from the input prompt budget. Oldest dialogue is dropped before the latest message; lower-ranked evidence is skipped if it does not fit.
- The model backend may have a smaller capacity than configured. For backends without reliable capacity reporting, configure the actual loaded context window, not the model's theoretical maximum.
- The exact-token backend can remove previously packed source evidence. Context previews report **post-trim selected source IDs** (dialogue, reviewed facts, committed events, lore, character details), not candidates that merely matched retrieval. Each evidence item is removed atomically to avoid misleading half-memories.
- Native-token overflow sheds oldest unprotected history first, then lower-priority complete evidence. The latest real conversation turn (and continuation cue, where present) are preserved; impossible requests fail explicitly rather than silently dropping the current player input.
- When model capacity is undiscoverable, the player's explicitly configured local context value is used instead of silently capping all unknown backends at 4096. Token estimates remain estimates; configure the actual loaded allocation.

## Persistence and upgrades

Memory records are derived from existing saved messages. A source change updates its direct memory, a source deletion removes that direct memory, and a rejected story revision does not change memory. Inherited fork snapshots are immutable. FTS5 is an index, not authority. Legacy multiworld migration removes foreign timeline memory records before removing their parent timeline rows.

No external vector server or npm package is needed for the first milestone. Existing per-world database backups remain essential.

## Test gates

The test suite covers actor witness restrictions, no cross-world memory, frozen fork snapshots, stale write rollback, source replacement, topic-driven biography recall, timeline clock/location, configured prompt budget, native KoboldCpp counting, server streaming, and refusal of fabricated actor context.
Additional native-budget regression checks verify source-ID provenance after trimming, latest-turn preservation in continuation mode, and explicit errors when a current turn is too large. These are deterministic tests, not claims that a particular local model obeys its instructions.

The existing event-ledger and world-isolation regression suite must remain green.

## Known limitations / next milestones

1. **Semantic paraphrases**: FTS5 matches lexical terms, not general concepts. An optional CPU-friendly embedding index is the next experiment, only if recall tests prove an improvement.
2. **AI-assisted suggestions**: the optional local-model button proposes up to four memories from a character's recent witnessed messages, each tied to an exact quotation. Suggestions remain inert until the player reviews and saves them through the evidence-linked memory notebook. Automatic acceptance, fully autonomous consolidation, and confidence-calibrated extraction are not implemented.
3. **Summarization**: long histories are indexed, not semantically consolidated. Structured and reversible consolidation is still needed.
4. **Corpus scale**: the original JSON snapshot still has its 4 MB limit. Large-world normalized transcript migration is a separate change.
5. **Multi-tab concurrency**: the process-wide active world remains in v2.0.1; stale-world protection survives but a future per-request scoped store would allow simultaneous worlds.
6. **Fallback token counts**: exact Kobold counting is used when available; other local servers use a conservative estimator. No estimator can guarantee a model's tokenizer-specific fit.
7. **Memory UI**: the context inspector previews the server-generated actor prompt and budget and supports an actor-scoped reviewed memory notebook. A dedicated cross-scene memory explorer, broader editing and retrieval-ranking diagnostics remain planned.

Do not promote any AI-authored summary or unreviewed speech to authoritative event state.

## Subjective actor facts (second milestone)

The Memory Notebook (Context tab) lets a player review a witnessed message and write an NPC-owned recollection: belief, promise, relationship, autobiography, or observation. The backend validates that the source exists, that the actor was a speaker or witness, and that the source is in the acting timeline. Stored notes are separate from canonical world events. Changes to or removal of source dialogue invalidate direct memories for retrieval; the notebook displays `source changed (not recalled)` rather than silently trusting them. Explicit corrections supersede old active notes and revocations preserve an audit trail. Forks freeze only active memories whose source evidence was valid at fork time. Actor knowledge must not leak across worlds or to other actors.

The local model can propose memory summaries from actor-visible messages when asked. Every proposal must cite an exact source quote and pass strict source visibility and format checks; unsupported suggestions are discarded. Even validated suggestions are not persisted until the player reviews and saves one. No automatic world-canon changes or autonomous memory acceptance.

## Optional AI-assisted suggestions

From the Context Inspector memory notebook, click **Ask local AI to suggest memories** with a local model loaded. The server sends only the selected NPC's latest 18 witnessed or self-spoken source messages, capped per message, to the model. Candidates must return JSON with a source message ID, kind, exact substring quote, and a concise subjective summary. The server drops invalid JSON, nonexistent/unseen sources, nonmatching quotes, unsupported kinds, duplicates and excess entries. Source text is treated as untrusted data; quoted evidence verifies attribution, **not** the accuracy of the proposed interpretation. The generated suggestions never enter the database themselves. Use **Review this suggestion** to place one into the normal editable memory notebook form, then review/save it explicitly. The server verifies the original source again before writing.
