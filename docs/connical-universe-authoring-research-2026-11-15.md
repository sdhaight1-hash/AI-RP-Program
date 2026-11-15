# Connical Universe authoring — research, domain boundaries and implementation plan

Reviewed November 15, 2026.

## Core concept

A Connical Universe is **the highest-level isolated continuity namespace**, not necessarily a planet. It may represent a city-sized setting, an inhabited planet, an interstellar civilization, an alternate history, or a multiverse. Its stable UUID is distinct from its mutable public name and introduction. Renaming must never create a new universe or change the IDs of its timelines, locations, characters, scene histories, memory sources or event-ledger records.

Research inputs:
- World Anvil, *Worldbuilder Workflow* (https://www.worldanvil.com/learn/workflows/worldbuilder-workflow): a worldbuilding project can be as small as a city or as broad as a multiverse; an established world's name can be edited later.
- World Anvil, *Articles and World Manager* (https://www.worldanvil.com/learn): categorization, linked articles, maps, relationships and timeline editing live in a persistent manager rather than requiring another universe.
- Campfire, *Writing Apps* (https://www.campfirewriting.com/apps): distinct modules for cultures, items, locations, systems, encyclopedia, maps, timelines, languages and relationships; supports custom templates and cross-references.
- W3C PROV Data Model and Primer (https://www.w3.org/TR/prov-dm/ and https://www.w3.org/TR/prov-primer/): separate evolving entities from versioned revisions, sources, derivations and attributed authoring acts.

These are design references, not proof of how any competitor stores its internal data.

## Structural hierarchy

1. **Connical Universe** — permanent world ID; mutable name and foundation; authoring controls and independent canon namespace.
2. **Universe blueprint** — explicit, individually editable facets: scope/scale, temporal and technological baseline, natural or supernatural rules, cultures and institutions, themes and tone, tensions and constraints.
3. **Canon graph** — location hierarchy, geography, named entities, relationships, provenance and human-reviewed lore. No automatic insertion from AI drafts.
4. **Timelines and branches** — canon baseline and immutable branch origins; world events and dated changes separated from the universe introduction.
5. **Characters and scenes** — character knowledge, witnessed source IDs, dynamic scene states and prose history; no cross-universe recall.

## Canon approval states

- **Draft:** author-entered or AI-suggested material, not exposed as verified canon to characters.
- **Reviewed:** user explicitly selected and edited the desired fields, but has not committed a world/entity write.
- **Established:** persisted, scoped factual record with provenance and a stable ID.
- **Superseded or disputed:** an explicit revision that preserves prior identity and source history rather than silently deleting contradictions.

Do not conflate a creative description with an objective witnessed event. A factual AI suggestion must still go through the relevant world/character/timeline authority boundary.

## Creation tool upgrades and gates

### Implemented in the current pass
- Editable universe name and foundation on existing records, via explicit guarded save.
- Optimistic stale-edit checks against expected previous identity, plus per-universe SQLite and registry recovery.
- Local-model co-author works on an existing universe using its actual established places, entities and timelines, separate from blank-universe drafting.
- Universe terminology updated in user-facing workspace and launcher while preserving wire-compatible `worldId` and existing data.

### Next priority: structured blueprint, not more prose
- Independent text fields and compact type selectors for scale, era, genre, physical/metaphysical constraints, cultural systems, power blocs, conflicts and themes.
- Every field gets its own purpose, constraints and context-aware AI prompt; provide a unified blueprint review with per-field approval.
- Persist a blueprint record inside the owning universe SQLite file, revisioned separately from transient UI state. Do not copy blueprints into the global universe registry.
- Incorporate committed blueprint context into scene generation and character prompts with a bounded token budget. Ensure entirely unrelated universe IDs never reach the model.
- Support revisions and explicit comparison/merge for contradictions rather than silently overwriting lore.

### Validation before closing
- Rename existing universe with scenes, characters and timelines; all IDs unchanged after restart.
- Concurrent editors: stale values produce HTTP 409 with no overwrites.
- Cross-world request handling always respects explicit request scope; a world switch in another tab cannot reroute a pending request.
- AI proposals never insert canon until reviewed and separately committed.
- Multi-world/fork retrieval tests prove the wrong universe never contributes facts.
- Node 22/24 and real Chrome browser tests pass. Large-world and Windows recovery tests remain important for longer-term closure.

### Things not to do
- Do not make a new world when the author only wants to revise a name.
- Do not use the universe name as a foreign key.
- Do not flatten structured geography, dated events and individual character memories into one ever-growing description string.
- Do not let generated draft prose silently rewrite established events or automatically seed omniscient NPC memories.
