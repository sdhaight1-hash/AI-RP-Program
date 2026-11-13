# AI-RP-Program: Character Fidelity, World Canon & AI Harness Roadmap

**Status:** architectural decision record / phased implementation blueprint (13 November 2026)

## Product contract

A local-first, **slice-of-life, character-driven social roleplay simulation**, not a tabletop rules engine or literal television production tool. World-building, episodic continuity, romance and adult-themed fictional settings are optional modes of the same persistent simulation. Episodes are organizational bookmarks, not railroading.

Three separate authorities:

1. **Player:** controls voluntary speech, actions, intentions, and choices of their player character. Player account/user and fictional player persona are different entities.
2. **NPC actor:** model-controlled portrayal, private interpretations, dialogue and action **proposals** for NPCs only. NPCs retain their own beliefs, relationships, and schedules.
3. **World engine:** canonical facts, world time, locations, shared events, communication delivery, and validation of effects. Generated text is not a database transaction.

A character may experience a physical action by another participant; the NPC cannot author the player's subsequent reaction, consent, thoughts or voluntary behavior. Unknown/private information must never be passed to an unauthorized actor. All characters in intimate adult-focused settings must be adults; content/style preferences are locally controlled instead of copying proprietary third-party filters.

## Research: what makes Character.AI characters feel compelling?

**Sources (public evidence, not privileged internals):**

- [Character.AI Creator Guide / Character Definition (updated 2026-06-22)](https://support.character.ai/hc/en-us/articles/50609183646875-5-Character-Definition): specific behavior and emotional logic, identity, multi-register dialogue examples, concision, and prioritization of foundational information. Provides a freeform definition up to 32,000 characters; this is an authoring limit, **not** evidence every character consumes that many tokens on every turn.
- [Character.AI Templates and Examples (2026)](https://support.character.ai/hc/en-us/articles/50609592926235-9-Templates-and-Examples): mixed structured identity + dialogue examples, contradictory tendencies, voice, relationships, and opening greetings.
- [Character.AI Refining and Testing (2026)](https://support.character.ai/hc/en-us/articles/50609303987099-6-Refining-and-Testing-your-Character): systematic fresh-chat testing, swipes as diagnostics rather than direct individual-character training, model-wide response ratings.
- [Smarter Memory for Smarter Chats (2026-05-21)](https://blog.character.ai/memory/): persistent Story Memory, pinned moments, editable/extracted Facts, usage budgets, and compacting conversation history.
- [Lorebooks (2026)](https://support.character.ai/hc/en-us/articles/52739596326811-Lorebooks): reusable cross-character keyword-activated knowledge, kept distinct from identity-critical definition.
- [PipSqueak 3 and ShortSqueak (2026-09-28)](https://blog.character.ai/new-styles-new-plan/): distinct general-roleplay vs concise casual-message styles; conversational presentation affects perceived character quality.
- [Optimizing AI Inference at Character.AI](https://research.character.ai/optimizing-inference/): public historical serving details such as caching for long sessions. Serving optimizations are **not** proof of any particular current model weights/training recipe.
- [Generative Agents (UIST 2023)](https://doi.org/10.1145/3586183.3606763): stored observations, reflections and planning support simulated social behavior (research evidence, not a guarantee).
- [CharacterBench (AAAI 2025)](https://ojs.aaai.org/index.php/AAAI/article/view/34806): multi-aspect, character-specific benchmark rather than generic chatbot quality.
- [EmoCharacter (NAACL 2025)](https://aclanthology.org/2025.naacl-long.316/): emotionally faithful portrayal isn't guaranteed by stronger general LMs or conventional roleplaying prompts; varied example dialogue and measured evaluations matter.
- [INCHARACTER (ACL 2024)](https://aclanthology.org/2024.acl-long.102/): distinguishes agreeable, humanlike talk from fidelity to a specific target personality; reported weaknesses in historic Character.AI roleplayers should not be generalized to the company's 2026 models.

**What is reasonably supported:** character-specific definitions, examples, memory management, lore retrieval, differentiated chat styles, feedback-driven evaluation, a dialogue-capable foundational model. **What is proprietary/unknown:** complete current training mixtures, the exact RL/preference-learning objective, system prompt, private routing layers and all serving settings. Do not claim to replicate its exact model or attribute model quality to one trick.

**Our differentiator:** observable world state and permissions, continuity across communication channels, independent NPC identity and player agency, human-editable canon, and user-selected local inference; no third-party platform-level content filter imposed by the app. Model weights still have their own learned behaviors; do not advertise guaranteed unrestricted output.

## Character-fidelity authoring and testing contract

- Identity core: who this person is now, three distinctive behaviors, two formative events, values, desires, fears, avoidances and flaws. Prefer **behavioral examples** over adjective piles.
- Demonstrate **registers**: mundane small talk, disagreement, tenderness, embarrassment, professional/stranger interaction, remote text and voice. **Example dialogues** are instruction examples, not actual history or memories; never treat them as witnessed canon events.
- Communication habits are per-character and per-channel. A concise texting profile must not corrupt the person's in-person speech style.
- Use lightweight, context-aware actor briefing; always-on identity, locale and social ties, relevant memory and only visible observations. Recent transcript must be attributable to actual speaker and medium.
- Keep separate factual truth, actor belief, and presentation; an expressive response does not prove character fidelity.
- Use alternate replies, targeted test cases and model comparison, with user-acceptance selections as review signals. Do not silently fine-tune local weights from swipes/ratings.
- A useful later experiment: paired blind evaluation of candidate actor models, matching context/token budgets, covering: voice, non-sycophancy, ordinary conversation naturalness, memory, knowledge secrecy, in-person/phone/DM perception, player autonomy, varied emotional responses and latency. Record seeds, quantizations and samples. Score human review separately from deterministic policy tests.

## Durable data boundaries

World (reusable canon) -> World revision -> independent Timeline/playthrough -> local scenes and interaction threads -> events/messages.

**World**: immutable identity, authored setting, references to locations and characters, public and private rules. **World revision**: version of canonical source for a new playthrough. **Timeline**: own clock and evolving changes; never mutates base canon by default. **Scene**: simultaneous encounter. **Interaction**: in-person, phone, video, DM, group chat, letter, anonymous chat. **Character**: world-authored identity, separate timeline-state, actor controller. **Event**: typed, validated, time-stamped occurrence with participants, witnesses, and source/revision. **Knowledge**: what an actor knows/believes and why; knowledge is not global search permission.

Canonical entities and relationships will use SQLite tables with foreign keys, stable IDs and migration versions. Flexible metadata can remain JSON inside those tables until it must be indexed; FTS5 for words, optional sqlite-vec when justified and filtered by knowledge/timeline **before ranking**. Avoid a standalone vector service, autonomous LLM fleet, or speculative complex frameworks.

## Incremental migration from v0.4/v0.5

- Never overwrite the existing `.data/studio.sqlite` or browser backup. Pre-migration backup, versioned migration, idempotent operations and dry-run state inspection.
- Phase 1: add `worlds`, `world_revisions`, `timelines`, `timeline_actors` beside existing `studio_state`, with declarative authority validation. Legacy scenes each adopt an independent imported timeline by default so unrelated chats don't share a reality. `timelineId` must be stable on repeated migrations.
- Migrate **only** after validation; existing user sessions and characters are preserved, including archived records, portraits, speakerIds and witnessIds. Read-only/fallback if schema is newer than the app.
- Phase 2: locations / directional relationships / clock, then perception-aware events.
- Phase 3: typed interactions and renderer boundary, then event proposals and transaction-safe Retry/branches.
- Phase 4: NPC goals, scheduled off-screen events, factual memory and appraisal, then AI-assisted world creation and optional vector/ComfyUI enhancement.
- The current studio snapshot must remain readable until a tested full conversion exists. No silent changes to previous story provenance.

## Implementation checkpoints and gates

### PR 1 — World foundation and explicit player/NPC authority

- Add `world/` core and `schema_migrations` under SQLite; minimally add world/timeline metadata and provide methods to list/create/fork without changing existing chat-generation behavior.
- Default new world supports arbitrary genre; default migration creates a legacy world and independent timeline per prior session (not a shared timeline for all archived sessions).
- Define player actor separately from the player persona. Reject `npc` attempts to speak for or change player-controlled actor. Worlds and timelines must not accept foreign actor IDs.
- Validate cross-world and cross-timeline links, duplicate migration reruns, and actor control.
- Deliver GitHub CI passing with original tests + new world/authority tests.

### PR 2 — Canon entities, locations, relationships and world clock

- Typed world entity records and hierarchical locations; graph links for travel, friendship, family, work, cohabitation, etc.; relationships directional when appropriate.
- Per-timeline character location and world clock with selected IANA time zone, narrative advancement and idempotent event identifiers.
- Tests: moving actor doesn't teleport another; remote interaction retains independent physical locations; second timeline diverges without changing first; world rules prevent invalid movement.

### PR 3 — Channel-aware interaction engine

- Define `in_person`, `phone`, `video`, `dm` and `group_dm` with explicit observable signals. Store message author, recipient(s), channel, account handle, fictional time, delivery/read state, and attachments.
- Context privacy is determined by channel events and knowledge, not by a generic `witnessIds` union. Remote audio cannot expose untransmitted video; DM cannot expose offscreen body language.
- Use application-created UI metadata, not model hallucinated timestamps or usernames. Add channel renderers after passing backend constraints.
- Tests: cross-channel continuity, no player output in NPC stream, no unseen details in phone/DM contexts.

### PR 4 — Proposal/commit harness

- Separate generated **draft** messages and proposed NPC actions from world commits. Explicit commit only after validation and chosen reply. Retry uses unchanged pre-generation state; rejected alternatives have no effects. Atomic event append and projections.
- Evidence log for why a character knows/does something; context-budget trace.

### PR 5 — Fidelity + social autonomy

- Actor brief compiler with prioritized identity, multiple channel-specific dialogue examples, values/goals, relationships and scoped memory. No enormous prompt dumps.
- Event-based emotion appraisal influenced by dispositions and remembered stakes, separate slow relationship updates, multiple emotions, expression control.
- Scheduled routine/offscreen action processing only on fictional time advance (no always-running NPC worker). Always permit quiet mundane scenes, avoid forced drama.
- In-app fidelity test workbench and model A/B evaluations with reproducibility metadata.

### PR 6 — World Studio and optional services

- World Library, setting and character editors, location tree, directed relation graph, world rules, timeline selection, archive/restore, and preview.
- AI world-building as reviewable proposals, conflict checks and source provenance. Local inference via existing KoboldCpp/LM Studio adapters.
- Optional ComfyUI attachment generation with trusted templates, accepted assets and GPU job coordination. Optional embedded vector retrieval; disable safely when unavailable.

## Nonnegotiable tests

1. Player-controlled actors cannot be addressed as AI-authored speaker/action in normal play.
2. Private or unwitnessed facts are absent from NPC prompts and retrieval results.
3. Phone / messaging / video channels strictly gate what the actor/player can observe.
4. Two timelines started from one world revision diverge without touching base canon.
5. Retry/cancel/unselected alternatives commit no events or appraisal.
6. Existing archives and stories survive migration, including rerun and rollback scenarios.
7. Model/ComfyUI/embedding service outages do not corrupt world or lose user-authored state.
8. Context inspector reports reasons/IDs for selected memories and lore.
9. Live-model qualitative benchmarks track human-rated fidelity, not just schema conformance.

## Hardware and scope

Target Windows PC: RTX 2060-class 6 GB GPU, 16 GB RAM, i5-class CPU. Use one text model at a time, compact actor briefs, cached retrieval; defer heavy ComfyUI and embedding jobs rather than competing for VRAM. Keep the current zero-runtime-dependency Node/UI architecture until demonstrably inadequate. Use local-only endpoints and validate all imported templates/assets. Protect user data, allow export/restore, do not introduce cloud inference by default.