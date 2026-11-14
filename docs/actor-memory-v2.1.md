# Actor-perspective memory and small-context generation (v2.1 development)

Status: implemented first milestone (world-scoped dialogue memory + context assembly). Code and tests are on the feature branch; this is not a fully autonomous semantic/episodic consolidation system.

## Authority contract

- **World** remains the hard outer boundary: the registry never contains private memories.
- **Timeline** owns observations and mutable state. Forks copy remembered dialogue at fork time. Later parent observations cannot enter the child.
- **Actor** owns recollections of witnessed or spoken dialogue. Private exchanges are never indexed for nonparticipants.
- **Speech is not canon**. "Player said X" records hearing X, not that X happened. Accepted world events remain separately authorized and exposed through the existing event ledger.
- **Character definitions** are durable world canon and subject to topic-sensitive retrieval; ephemeral mood, current location, and clock are timeline state.
- **Browser** cannot construct the acting system prompt. The server resolves the saved scene, eligible acting NPC, witnessed history, role/medium rules, permitted lore, and memory evidence.
- **No automatic LLM memory extraction** is enabled yet. The current system indexes witnessed dialogue deterministically and reads already accepted world events.

## Files and data flow

- memory/store.mjs — SQLite actor_memories, FTS5, synchronization in the story save transaction, and immutable fork snapshots.
- character/relevance.mjs — authored Character Studio fields (biography, appearance, family, routines, etc.) activated by current conversation cues.
- context/assemble.mjs — per-turn actor-visible context, hybrid source selection (FTS, recent evidence, timeline events, permitted lore, structured character detail), prompt packing.
- context/backend.mjs — KoboldCpp context capacity and exact token counts when available; LM Studio loaded-instance context discovery; conservative estimated fallback.
- storage.mjs, world/persistence.mjs, world/partition-store.mjs — transactional memory updates and safe world migration.
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

## Persistence and upgrades

Memory records are derived from existing saved messages. A source change updates its direct memory, a source deletion removes that direct memory, and a rejected story revision does not change memory. Inherited fork snapshots are immutable. FTS5 is an index, not authority. Legacy multiworld migration removes foreign timeline memory records before removing their parent timeline rows.

No external vector server or npm package is needed for the first milestone. Existing per-world database backups remain essential.

## Test gates

The test suite covers actor witness restrictions, no cross-world memory, frozen fork snapshots, stale write rollback, source replacement, topic-driven biography recall, timeline clock/location, configured prompt budget, native KoboldCpp counting, server streaming, and refusal of fabricated actor context.

The existing event-ledger and world-isolation regression suite must remain green.

## Known limitations / next milestones

1. **Semantic paraphrases**: FTS5 matches lexical terms, not general concepts. An optional CPU-friendly embedding index is the next experiment, only if recall tests prove an improvement.
2. **Belief/subjective state**: dialogue memory distinguishes "said" from "true" but does not yet extract enduring beliefs, promises, intentions, and relationship episodes into reviewed structured facts. That requires evidence-backed proposals, conflict resolution, and explicit actor ownership.
3. **Summarization**: long histories are indexed, not semantically consolidated. Structured and reversible consolidation is still needed.
4. **Corpus scale**: the original JSON snapshot still has its 4 MB limit. Large-world normalized transcript migration is a separate change.
5. **Multi-tab concurrency**: the process-wide active world remains in v2.0.1; stale-world protection survives but a future per-request scoped store would allow simultaneous worlds.
6. **Fallback token counts**: exact Kobold counting is used when available; other local servers use a conservative estimator. No estimator can guarantee a model's tokenizer-specific fit.
7. **Memory UI**: the context inspector now previews the real server-generated actor prompt and budget. A dedicated memory explorer/editor and retrieval-ranking diagnostics remain planned.

Do not promote any AI-authored summary or unreviewed speech to authoritative event state.
