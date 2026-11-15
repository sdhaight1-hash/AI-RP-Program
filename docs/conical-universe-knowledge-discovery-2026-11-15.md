# Conical Universe: content-aware canon graph and discovery architecture

Research and implementation checkpoint — 2026-11-15

## Product position

AI-RP-Program is both a **local AI roleplay engine** and an **AI-assisted worldbuilding studio**. A Conical Universe is the top-level *isolated continuity*, not necessarily a physical planet. Its creator may build cities, religions, planetary histories, clans, corporations, social circles, cultures, and interactive scene locations. Characters and scenes are consumers *and possible sources* of worldbuilding ideas, but not omniscient canon authorities.

**Research references**

- [World Anvil: article templates](https://www.worldanvil.com/learn/article-guides/article-templates) and [organization template](https://www.worldanvil.com/learn/article-templates/organization): families, guilds, schools, organizations and nations can share an organizational backbone with different attributes; cross-linked articles and structured types are important.
- [Campfire: modules](https://www.campfirewriting.com/apps) and [culture checklist](https://campfirewriting.com/learn/how-to-create-fictional-cultures): cultures, species, geography, languages, organizations and stories occupy different creative contexts but can cross-reference one another.
- [Microsoft GraphRAG indexing](https://microsoft.github.io/graphrag/index/default_dataflow/): distinguish source text units, extracted entities, relationships, time-scoped claims, and community summaries. Such techniques require prompt tuning and are computationally nontrivial for small local models.
- [SQLite FTS5](https://www.sqlite.org/fts5.html): `unicode61` token search, BM25 scores, source snippets, trigram matching and external-content indexing are available for a future incremental index.
- [ACL 2024 coreference work](https://aclanthology.org/2024.latechclfl-1.2/): resolving a person/organization name across long narrative documents is a separate challenge from simple name detection.
- [W3C PROV-DM](https://www.w3.org/TR/prov-dm/): quotations, derivations, revisions and attribution are distinct relations and must not be flattened into generic description text.

These sources inform design choices; the referenced products are not being copied internally.

## The minimal nonredundant object taxonomy

1. **Universe** — immutable ID; editable name and structured blueprint with separate version.
2. **Place** — region, settlement, neighborhood, building, room, outdoor area, etc; nested physical or virtual spatial identity.
3. **Person** — Character Studio owns personal psychology, memory, private knowledge and habits; the canon entity is a projection/link, not a second character profile.
4. **Collective / culture** — one shared `world_entities` table, differentiated by `kind`: organization, faction, family, community, culture and informal group. Do not build six separate tables with near-identical schemas.
5. **Thing / concept** — object, technology, religion, tradition, myth or idea; use current object/concept entries until there is a behavioral need to specialize.
6. **Relationship** — directed, typed, linked by IDs. Membership (person→group), kinship, governs, worships, inhabits, located-in, parent-of, allied-with, opposes, traded-with; the direction, time and confidence eventually matter.
7. **Claim / event** — a time-scoped statement, not an entity; distinguishes established historical facts from rumors, hypothetical plans, secrets, delusions or changes that have not happened.

A culture may transcend political groups; a family may function as a clan, merchant house or household. The subtype is an editorial view, not a separate database.

## Discovery pipeline

`Source → bounded scan → candidate extraction → existing-ID matching → evidence review → explicit commit/link`

**Source** carries `worldId`, `sourceType`, `sourceId`, `field`, `contentRevision/hash`, original contiguous quote and visibility. The source may be a universe blueprint, character biography, author lore, timeline event or scene utterance. A quote from NPC dialogue is evidence that the speaker *said something*, not that the thing exists.

**Candidate** contains name, proposed type, confidence signals, source excerpts and a tentative status. It may reference an existing ID. A candidate must never share its identity with canonical records before approval.

**Entity resolver** first matches exact known IDs and normalized names, then approved aliases; later can use context-sensitive fuzzy matching and local models. Ambiguous names must prompt link/create choice. “Lantern House” can be a building, family or organization depending on context, so suffix-only extraction is not authoritative.

**Ranker** combines source authority, consistency, multiple independent mentions, explicit naming, fit with the editor (Atlas vs People/Cultures) and contradiction risk. Do not rank raw repetition as certainty.

**Review surface** displays the extracted phrase and quote, source type, tentative kind and existing-match warning. Actions: “open existing,” “fill new draft,” “dismiss,” later “confirm claim,” “mark rumor,” “link relationship.” None is a silent canon write.

**Commit** validates world ID, source version and expected known-entry revision. Persist any approved source link in the same transaction as a new/updated entity. A stale or deleted quote invalidates the candidate; archive/retraction must not leave phantom canon.

## Implementation phases

### Phase 0 — completed initial checkpoint
- Enrich shared entity kinds for organization, faction, family, community, culture and informal group.
- Add editor-visible descriptions with atomic persistence, editing and stale-write protection.
- Read-only, world-scoped lexical scan across bounded available author text and dialogue.
- Atlas and Relationships suggestions show literal source excerpts; choosing a suggestion only fills an editor.
- Deduplicate exact established names; never let this phase write into timeline events or character memories.

**Limitations:** this scanner is not yet an exhaustive NLP extractor. It recognizes explicit named contexts conservatively, may miss names or misclassify context, and currently shows evidence in the proposal UI rather than durably recording a reviewed source link.

### Phase 1 — production-quality source index
- Keep an incremental per-universe SQLite source registry and FTS5 index; update only changed character/scene/lore fields, not all dialogue on every editor open.
- Version each source; de-index deleted/trashed/changed entries; recover from interrupted index builds.
- Store exact spans rather than merely displaying snippets; track duplicates and aliases.
- Provide phrase search, facets (source kind/type/visibility/status), source drill-down, sort and dismiss controls.
- New user-created records keep source provenance and review activity in a normalized ledger.

### Phase 2 — local-model augmentation
- Send small evidence chunks (not entire universe history) to a local model with strict per-type extraction prompts, JSON schema, optional relationship/temporal claims and full source spans.
- Verify every output name and quote exists in a source; drop inventions. Do not allow model-generated facts to become canon without a human action.
- Run independent resolver against existing IDs, with confidence explanations, and propose relationship links separately.
- Maintain a low-context fallback (lexical + relevance retrieval) for constrained local hardware.

### Phase 3 — bidirectional, contextual worldbuilding
- Present relevant pending place/group/culture candidates in Atlas, Character Studio, Scene setup and the World overview.
- Character creation can propose *new* world entries while retrieving existing world facts; once reviewed, linked IDs become available to future authors and actors according to authority.
- Scene prompts receive only location, nearby cultural rules, known organizations and actor-appropriate evidence; private unknown events remain inaccessible.
- Add change impact previews to see which scenes/characters/claims reference the entry before renaming, merging or deleting it.
- Integrate timeline-aware relationships: membership and alliances can change without rewriting the entire universe.

## Verification gates

- Cross-universe leakage: zero, including multiple browser tabs and parallel network requests.
- Candidate quote fidelity: exact substring in a retained source, with stable ID and revision.
- Duplicate candidate creation: zero for exact known names, with explicit handling for aliases and ambiguous names.
- False positives: prioritize precision; do not declare a family when “House” is a physical building.
- No automatic commitment from unreviewed dialogue or local-model extraction.
- Accurate duplicate, stale-review, deleted-source and conflicting-identity handling.
- Benchmark cold scan/index update/query over growing worlds (1k, 10k, 100k source passages), measuring latency, memory, index size and recall.
- Regression for character-source approvals inside existing SQLite transactions and deletions of referenced entities.
- Windows and Node 22/24 CI plus Chrome end-to-end browser coverage.

## Decision

Do **not** add a separate “Culture Database,” “Family Database,” “Organization Database” and “Community Database.” The shared entity graph is the stable identity system; section-specific editors and templates sit above it. Where a type truly needs specialized behavior (lineage graph, language dictionary, territorial ownership), add optional type-specific subrecords rather than duplicate identity.
