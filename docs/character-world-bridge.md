# Character ↔ World Atlas: reviewed source-backed curation

## Intent

Characters **inhabit an established world**, but a creator should also be able to establish places, people, groups, and objects while writing a character. This implementation makes the flow two-way without confusing draft generation, persistent world canon, NPC knowledge, and live timeline events.

- **World → character:** character co-authoring receives the active world's definition, already-known entities, linked home/work/frequent places, and directly established relationships. The character's own links and relationships appear before generic world catalogs, because a small local-model prompt may truncate the end. Every field still follows its dedicated contract in [field contracts](character-authoring-field-contracts.md).
- **Character → world:** choose **Character → World Atlas > Find world entries** after saving a character's history, family, routine, hobbies, occupation, or social habits. The local chat model may suggest up to **five** named entries, each with the *exact* author-written source quotation and field. Suggestions are uncommitted.
- **Creator approval:** edit the candidate's name, kind and description, then explicitly confirm **Add reviewed entry to World Atlas**. The server rechecks the saved character, source quote, active world, revision, and existing world graph. An approved entry becomes a real world **place or entity**; a provenance record retains the source character, source field, exact quote and profile version.
- **No unrelated mutations:** world entries do **not** automatically move the character, assign a home/workplace, create a new NPC card, set relationship status, or change story/timeline events. New entries become available to the World Atlas and to future character prompting. A familiar place may be linked using the Life tab's normal place controls.
- **No automatic canon:** generated proposals, including user-edited model output, are not authoritative until an explicit confirmation succeeds. A generated name must already appear in its exact supporting character quote, so the model cannot silently establish a new named place absent from source text.

## Supported sources and world kinds

The bridge reads established `backstory`, `familyHistory`, `formativeEvents`, `occupation`, `preferredEnvironment`, `dailyRoutine`, `socialHabits`, and `hobbies`. It intentionally excludes example dialogue, future motivations, current mood, and all live scene/timeline content.

Place kinds reuse `region`, `town`, `neighborhood`, `building`, `room`, `outdoor`, `other`. World entity kinds reuse `character`, `faction`, `organization`, `object`, `concept`. Creating a named world entity of kind `character` does not automatically create a playable Character Studio card or make it a known witness.

Duplicate names (Unicode-normalized, case-insensitive, whitespace-folded) are rejected **within each world/type**. Existing entries should be linked rather than duplicated. For now, the bridge does not automatically merge aliases or infer relationships; use the established World Atlas Relations controls to create a reviewed link.

## Security and persistence

`POST /api/character/world-entries/approve` requires `approval:"approve"`, `worldId`, `characterId`, the current saved story `revision`, `profileVersion`, `worldVersion`, and one candidate. Its single SQLite transaction creates the atlas entry plus its provenance in `character_world_sources`, or rolls back both. No LLM text can bypass server-side verification by calling this endpoint directly.

The provenance table is world-scoped, included in the existing per-world migration/pruning, and remains after later source edits. Editing an old biography does **not** silently delete approved world canon; the audit trail records which earlier text motivated its creation. `GET /api/character/world-entries/sources` exposes provenance for the selected character and active world.

The UI invalidates its remaining staged candidates after one approval, since the world graph has changed and duplicate-resolution must be repeated. Its authoring draft and approval checks both fail closed if another tab changes the world.

## Verification

`test/character-world-bridge.test.mjs` and `test/character-world-api.test.mjs` exercise pure JSON drafts, quote and name authentication, cross-world rejection, stale source edits, duplicate names, atomic rollback, context inclusion of accepted entries, and API/restart/world-partition boundaries.

These tests do not evaluate the **creative quality of a real local model**. A source quote proves attribution, not that a character's authored statement is objectively true. Human approval remains a distinct authoring decision. No external vector database, model provider, or new npm dependency is added.

Relevant design research includes [Guiding Generative Storytelling with Knowledge Graphs](https://www.tandfonline.com/doi/full/10.1080/10447318.2025.2603634) and [Lost in Stories / ConStory-Bench](https://aclanthology.org/2026.findings-acl.410/), both emphasizing explicit narrative constraints and consistency checks rather than assuming model prose is self-validating.
