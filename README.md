# AI RP Studio — local roleplay first

An early, self-contained roleplay web app. The design draws on Character.AI's character-first conversations, NovelAI's story settings and alternative generations, and SillyTavern's character/persona/lorebook workflow. It is original software, not a clone of those apps.

**Status: prototype v1.2.0 (non-destructive NPC reply review).** A model server is required for AI replies. The WebGL panel is atmospheric decoration, **not** a world renderer. World simulation, automatic long-term memory, multi-NPC autonomy, and full Tavern PNG/V2 card support are **not** implemented yet. SQLite-backed story saves, the first cast-aware context harness, safe library Trash, indexed lore retrieval, and optional ComfyUI workflow execution are implemented. The character atelier, theme palettes, and portrait uploads are included in this version.

## Requirements

- Node.js **22.13 or later** (Node 24 recommended), on Windows/Linux/macOS. Uses built-in `node:sqlite`; some Node 22 releases print an experimental-feature warning.
- A local OpenAI-compatible inference server and a loaded GGUF model:
  - **KoboldCpp** default `http://127.0.0.1:5001/v1`
  - **LM Studio** `http://127.0.0.1:1234/v1`
- No npm package installation is required.

## Run it

Open a terminal **in the project folder** and run:

```sh
npm start
```

To stop the server from the same terminal, type **`quit`** or **`exit`** and press Enter (or use **Ctrl+C**). The app closes its HTTP server and SQLite database cleanly.

Then open **http://127.0.0.1:4173** in your browser. Start your local model server first (or start it later and click **Find local models** in the Setup tab). On Windows PowerShell, to use LM Studio instead of KoboldCpp:

```powershell
$env:INFERENCE_URL="http://127.0.0.1:1234/v1"
npm start
```

Windows Command Prompt (`cmd.exe`):

```bat
set INFERENCE_URL=http://127.0.0.1:1234/v1
npm start
```

Linux/macOS:

```sh
INFERENCE_URL=http://127.0.0.1:1234/v1 npm start
```

Select the model in **Setup**. The model must be loaded in the inference application; this studio doesn't download models itself. If you see "Model server offline", verify the inference server is running and its port matches `INFERENCE_URL`.

## v1.2: Provisional NPC replies and review gate

NPC responses now stream into a **provisional, unsaved preview**. Completed responses are checked for *likely* communication-format or player-agency issues before becoming story messages. Examples: text responses that include a narrator label or gesture markup; phone calls that narrate untransmitted visual gestures; or replies containing player-role dialogue or invented voluntary player actions.

- A reply without detected issues is saved normally after generation finishes. A flagged reply stays **outside the saved transcript, SQLite world events, and character mood updates** until you explicitly select **Keep reply anyway**.
- The review panel offers **Keep reply anyway**, **Regenerate draft**, or **Discard draft**. Regeneration uses the same original conversation basis and does not accumulate a rejected alternative in the story.
- On **Retry**, the old NPC reply and its variants remain unchanged until a reviewed or clean replacement is accepted. Existing committed-world-event locks still forbid Retry.
- While a draft is pending, you cannot send another message or switch its channel. Other scenes show a link back to the pending draft. Pending drafts are **in-memory only** and disappear on page reload. They do not appear in exports or SQLite snapshots.
- The draft is tied to its timeline, cast, channel, current turn, speaker and witnesses. A changed basis invalidates acceptance.

**Limitations:** The checks are conservative heuristics, not semantic validation or a safety/content filter. They can miss incorrect NPC behavior or flag legitimate writing; the author can keep a flagged response. Live GGUF generation and cross-model compliance must still be evaluated locally. This release does not automatically derive or apply fictional world events from prose.

## v1.1: Character-specific communication styles

Open **Character studio → Voice** to configure optional **in-person**, **phone-call**, and **messaging** styles independently. These supplement the durable shared personality and general voice rather than replacing them. Every channel prompt receives only the currently active style, preventing a texting example or an in-person gesture instruction from leaking into phone dialogue. These fields are included in native JSON character import/export and optional AI-assisted character drafting, and the Character Fidelity Lab uses them in its channel-specific probes. Existing characters default to empty overrides and keep their previous behavior.

## v1.0: Character Fidelity Lab (evaluation milestone)

Open **Character studio → 05 · Character test lab**. Choose one of six controlled, repeatable scenarios: everyday texting, casual conversation, disagreement, personal boundaries, phone-only dialogue, and repair after a misunderstanding. Click **Generate test reply** to call the currently loaded local model with the character's real voice, values, examples, and channel-aware prompt. The probe uses a neutral simulated scene **without changing any live scene, relationships, memory, or world event**. First-encounter settings are intentionally excluded to keep probes comparable.

You can review the generated reply, see **heuristic warnings** about possible phone/text perspective and player-agency problems, and enter human ratings (1–5) for **voice, consistency, naturalness and agency**, with optional written notes. Only **Save reviewed result** persists it on the character profile, up to 15 recent reviews. Each record stores its probe, reply, model, profile version marker, manual ratings, and notes. If the profile changes, older results are marked as using a previous version.

The tests are **qualitative review aids, not automatic personality measurements**; warnings may miss mistakes or flag harmless text. The local GGUF still needs hands-on assessment. No real story event is accepted or generated by this panel. To reduce GPU contention the Lab runs one model request at a time, with a Stop button.

## v0.9: Genuine branch isolation (fifth milestone)

- **Branch scene (⎇)** now creates a **new independent timeline** through "/api/timelines/fork" before copying the scene. Unlike earlier versions, the alternate scene no longer shares its parent's future world events or actor locations.
- The fork records the precise last committed-event sequence at its creation. It **inherits only historical events up to that boundary**; later events in the original timeline are excluded. Events committed in the fork do not leak back to its parent, and nested forks honor all ancestor boundaries.
- Fork creation atomically copies registered NPC actor IDs, assigns a distinct player-controlled actor ID, and snapshots the fictional clock/time zone and actor locations. The scene duplication retains its chat history, established psychology and message provenance.
- **Accepted history remains locked** across nested scene forks: copying a scene cannot subsequently delete or rewrite an inherited NPC reply that supports a committed event. To explore a contradictory history, create a new unrelated timeline from canon rather than branching after the event.
- SQLite adds a `timeline_fork_snapshots` table and a one-time `.data/studio.sqlite.before-world-v4.bak` backup for existing databases. The API accepts `POST /api/timelines/fork` and `POST /api/timelines` with a parent creates a frozen fork, not a live link.
- **Limits:** This copies the current scene and timeline-level positions/clock/event-history *view*. It does not yet snapshot a normalized collection of all other conversation threads, world inventory, or background NPC schedules; those subsystems are not implemented. Branching a scene from the beginning or selecting an arbitrary event cutoff requires future UI work. The previous versions' duplicate-scene feature had no independent event history; older duplicated scenes retain their previously shared timeline until explicitly migrated or re-branched.

## v0.8: Reviewed NPC events and timeline provenance (fourth milestone)

- **Scene → NPC event review** stages an objective NPC development from the latest **selected assistant reply**. Stage manually or use **AI suggest from reply**, which only fills an editable draft; AI output never directly commits canon. Choose **Accept into world** or **Reject**.
- **Two supported event kinds:** `observation` (the NPC's observed development) and `npc_move` (a validated NPC destination within its world). A move changes the NPC's timeline-specific location in the same SQLite transaction as the accepted event; it does **not** simulate travel or permit moving the player character. Other NPC action types will be added only with specific validated reducers.
- **Scoped memory:** accepted events are stored in normalized `timeline_events`, associated with actor and explicit observers; only observed events are retrieved for an NPC's later prompts in that timeline. The player's authoring UI can inspect the ledger, but that does not automatically grant the player character knowledge.
- **Safe retries and swipes:** a proposal captures a fingerprint of the selected reply, including speaker, interaction channel, witnesses, and content. Switching variants or changing the source makes it stale. After an event is accepted, the source reply is **locked** against edits, Retry, and swipes; the SQLite save path also enforces this invariant. Rejected proposals do not mutate timeline state.
- **Local migration:** existing databases receive a one-time `.data/studio.sqlite.before-world-v3.bak` before the new event tables are added. Existing scenes and legacy manually appraised events remain intact. A first-run browser now immediately reloads server-assigned timeline IDs, without requiring a page refresh.
- **Limits:** the model's suggested event text is untrusted and should be reviewed for correctness. No automatic event extraction occurs during normal chat. Earlier manual scene events still live in the legacy scene snapshot. In v0.9 and later, the Branch action creates a frozen event-snapshot timeline fork; older imported branches may still share an original timeline until explicitly re-branched.

## v0.7: Interaction channels (third foundation milestone)

- **Medium selection**: Switch an existing scene between **In person**, **Phone call**, and **Messaging** using the visible Interaction selector above the composer. Previous messages retain their original channel and presentation; switching the medium does not move or teleport characters.
- **Channel-aware NPC context**: Phone generation receives audio-only instructions, suppresses unrelated physical scene descriptions, and receives only explicitly audio-transmitted current observations. Text generation asks the same character for concise message content without stage directions and only receives explicitly delivered current-message observations. In-person scenes retain full local sensory context.
- **Actor separation**: Remote calls/messages are one-to-one with the selected NPC for this milestone, while in-person scenes retain the full cast. Player messages record recipient/witness IDs. NPC prompts remain scoped to character knowledge and witnessed history.
- **Distinct UI**: Conversation messages retain their channel identifiers. Text renders as message bubbles and supports a character's optional social handle; phone replies use a dialogue/transcript treatment. The dynamic header identifies remote communication rather than showing an implied shared room.
- **No new runtime dependencies**. Existing SQLite JSON snapshots keep using the compatible scene schema. Unknown old channels normalize to in-person; earlier saved messages retain their original content.
- **Verification**: 51 passing automated Node tests including perception filtering, phone/text prompt redaction, channel migration, and local channel-module HTTP serving. Offline Chromium interaction confirmed selector changes, persistence, and preservation of text-message formatting without JavaScript errors.
- **Not yet guaranteed**: Natural-language models can still violate style instructions. Strong structured-output validation, real phone audio, delivery/read states, social-media group chats, video calling, NPC schedules, phone contact identities, and multi-channel media attachments are later milestones. The current "Phone call" is text-based, not live voice streaming.

## v0.6: World Atlas, relationships, and fictional clock (second foundation milestone)

- **Atlas**: Build an authored world hierarchy of regions, towns, neighborhoods, buildings and rooms. A location can be nested under a parent from the same world. The backend also supports typed connections with travel minutes; travel/pathfinding simulation is not yet implemented.
- **Relations**: Create world entities (characters, organizations, factions, objects, concepts) and **directed** relationships with notes. Connections remain world-scoped. These are canon-world relationships, not the timeline-specific emotional/relationship model yet; automatic NPC appraisal is a later milestone.
- **Fictional time**: Independently set a timeline's ISO 8601 instant and IANA time zone from the Worlds tab. The active world's date/time appears dynamically in the scene header and context. **Legacy free-text scene dates remain unchanged until you explicitly set the timeline clock**; new clocks start in an unconfirmed state.
- **Actor locations**: SQLite supports independent per-timeline actor location positions, rejects cross-world locations, and verifies that actors belong to the timeline. UI management of every character's position is a subsequent feature.
- **Database upgrade**: Adds SQLite tables for locations, connections, entities, directed relationships, timeline clocks, and positions. An existing database gets a one-time backup at `.data/studio.sqlite.before-world-v2.bak` before this migration.
- **HTTP and test coverage**: Local endpoints for adding locations, connecting places, creating entities/relationships, setting timeline clocks and actor positions. Existing 41 tests plus five new geography and world-API scenarios pass (46 tests total). UI was verified in an offline browser harness, not a live GGUF run.
- **Not yet implemented**: An interactive visual graph editor, nested map drawing, per-channel phone/text/in-person perception, NPC schedules, transactional story-event commits, or real-time clock ticking. These remain separately testable milestones in `docs/architecture-character-fidelity-world-harness.md`.

## v0.5: Canon World Library and timeline migration (first foundation milestone)

- The **Worlds** tab now creates reusable canon-world containers and separately named playthrough timelines. Assign an existing scene to a timeline in the same panel. World data and actor controllers live in normalized SQLite tables; existing chat and model behavior stays unchanged.
- Older scenes receive **one stable imported timeline each** on startup instead of being merged into one fictional reality. Existing titles, dialogue, portraits, psychology and knowledge records remain intact.
- A one-time backup is written to `.data/studio.sqlite.before-world-v1.bak` before opening an existing database with the new schema. `schema_migrations` tracks schema v1; startup and repeated migration preserve existing timeline IDs.
- Player actors and NPC actors have distinct controller identities. The new authority validator rejects role impersonation in structured operations; a future proposal/commit pipeline will enforce this on all world-mutating AI actions.
- New API endpoints: `GET/POST /api/worlds`, `POST /api/timelines`, and `GET /api/timelines/actors?timelineId=...`. Returned world records never include model-generated changes unless you explicitly created/assigned them.
- **Not yet implemented at v0.5:** complete world editor, world-scoped characters/lore, locations, clock, relationship graph, autonomous NPC lives, communication channels, canon revision publishing, or server-side event commit transactions. Those remain separate milestones in `docs/architecture-character-fidelity-world-harness.md`.
- This milestone retains the original JSON snapshot chat state for backward compatibility; newly introduced world/timeline identity is stored in SQLite tables and referenced from sessions.

## v0.4: Multi-character worlds and harness groundwork

- **Accessible library management**: × beside a scene or character moves it to Trash. Find archived items under **Library** to restore or permanently delete. A character still referenced by any scene cannot be permanently purged; its historical dialogue remains attributed correctly. Rename scenes using ✎, and create a story branch using ⎇.
- **Multi-character scenes**: The **Cast** tab selects multiple present characters. Choose **Natural**, **Round-robin**, or **Manual** speaking order. In Natural mode, type `@Mara` or another character's name to explicitly address them. Each assistant message records its speaker ID and the cast who witnessed it.
- **Scene direction and event records**: The **Scene** tab stores the shared location, fictional time, atmosphere, public story summary, narrative direction, and explicitly witnessed events. World events are not inferred automatically from arbitrary prose.
- **Knowledge and privacy**: Lore can be public or private; private lore requires a *Known by* list. Actor-specific context excludes facts and dialogue that actor did not witness. Old single-character messages migrate with only their original speaker as a witness, preventing instant mind-reading when someone is added to the cast later.
- **SQLite lore search**: FTS5 index rebuilt atomically with each story write, filtered by acting character and scene. Text-generation can augment keyword-triggered lore with filtered FTS hits. This is **lexical retrieval**, not vector embeddings yet.
- **ComfyUI Visuals**: Start local ComfyUI on port 8188 and open the **Visuals** tab. Import a trusted API JSON workflow with `__RP_PROMPT__` in a text node and optional `__RP_NEGATIVE__`; choose it, enter prompt, Generate, and Refresh job. Completed images can be opened or explicitly assigned as a character portrait. Template files live in `.data/comfy-workflows/`. Only reviewed local templates are submitted; no arbitrary browser-supplied node graph is executed.
- **Themes and portraits**: Ten color palettes and customizable accents, a full-page character atelier with AI suggestion review, and compressed local portrait uploads are included from the earlier local v0.3 prototype.

**Hardware note:** An RTX 2060 may not fit both an 8B LLM and a large ComfyUI generation workflow concurrently. Start ComfyUI separately and run image jobs when text inference is idle; this version does not automatically unload model servers or arbitrate GPU memory.

**Data note:** The old state stays in an atomically updated SQLite snapshot. The `lore_fts` virtual table is a derived index and can be rebuilt from stored canon. Portraits and workflow templates are files; copy the `.data/` directory when migrating computers. Never import unknown ComfyUI custom-node workflows without reviewing them.

## RP workflow

1. **Characters:** Create a character, edit their identity, voice, story premise, and opening message. Import/export a simple JSON character card.
2. **Personas:** Set your player character under Setup. The actor prompt explicitly forbids the NPC from deciding your actions.
3. **World lore:** Create lore facts with keywords; only recent conversation activates those entries.
4. **Story tab:** Edit the permanent canon recap separately from the short **Author's Note** (immediate tone/pacing guidance).
5. **Pin:** Pin up to five significant user/NPC messages. Pinned moments are inserted into future prompts.
6. **Chat / Story view:** Use the top toggle to switch between character chat and a clean reading presentation of the same history.
7. **Retry / swipes:** Retry the last NPC answer, then cycle between saved alternatives without losing the earlier ones.
8. **Continue:** Allow the model to advance the narrative without a new player message. This adds a temporary continuation instruction to the inference request; it doesn't create a visible player action.
9. **Persistence:** Every story, character, lore entry, persona, and emotional state is stored in local SQLite at `.data/studio.sqlite`. The browser retains an emergency backup. Existing v0.1 `localStorage` stories are imported into the database automatically **only if the database is empty**. Edits interrupted during a save can be recovered from the browser copy; conflicting newer database edits are **not** overwritten automatically.
10. **Emotion tab:** The selected character has a per-scene valence, arousal and trust simulation. Click an explicit *Warmth*, *Friction*, *Danger*, *Reassurance*, or *Quiet passage* story beat; undo or reset when needed. The model receives a human-readable interpretation of that state in its next prompt. Narrative intensity gradually settles after successful turns; trust does not decay automatically.
11. **Context tab:** Inspect and copy the actual system prompt and recent transcript assembled for a standard reply. It shows selected keyword lore and a rough **character-based** token estimate (not a true tokenizer count). The Continue action appends its own temporary instruction.

## Design and implementation principles

- **Local-first**: Node server only listens on `127.0.0.1`, rejects cross-origin requests, and proxies generation so the browser never talks directly to an external host.
- **Backend independent**: currently speaks OpenAI-compatible `/v1/models` and `/v1/chat/completions` (SSE). Tested with a mock implementation of that contract; actual GGUF output must be verified against a running model on the user's machine.
- **Prompt context is explicit**: acting character identity + persona + individual scene emotion + appropriately scoped canon/memories + pinned moments + FTS/keyword lore + Author's Note + witnessed transcript. See the Context inspector for what is sent.
- **Player agency**: custom prompt and UI distinguish player actions from NPC output; a model can still make mistakes.
- **No third-party runtime dependencies**: vanilla JavaScript/CSS, browser WebGL shader, and the Node built-in HTTP/SQLite modules.
- **WebGL is optional**: atmospheric effect fails gracefully when WebGL is unavailable.
- **Privacy caveat**: SQLite and the local browser backup store **unencrypted** text. A person with access to your computer or browser profile may be able to read the local SQLite file or backup. Backup exports are ordinary unencrypted JSON.

## Tests

```sh
npm test
```

Includes prompt/backup tests, character import, multi-cast privacy and turn selection, reversible archive/branch operations, lore indexing and authorization, ComfyUI workflow parsing/job outputs, emotional transitions, SQLite revision conflicts, API validation, mock streaming and same-origin rejection. A successful test run confirms the HTTP contract and local logic, **not** that your selected GGUF generates good prose.

## Known limits / next milestones

- SQLite state is currently a single atomic JSON snapshot plus a real FTS5 lore index, not a normalized world/entity/event schema. Split out durable indexed records when simulation needs them.
- Add tokenizer-accurate prompt budgeting, explicit source tracing, controlled summary generation, and evidence-linked auto-memory proposals.
- Extend the manual emotion simulation into character-specific appraisal driven by verified events, bounded traits, individual beliefs, and separate relationships. Do **not** infer player intent through keyword sentiment.
- Build on the new authored world clock and location/relationship tables with multi-NPC offscreen goals, scene perception and verified event proposal/commit operations.
- Add full Tavern Card V2 and lorebook import/export compatibility, with validation. Add optional local embeddings and sqlite-vec after scoping tests and memory quality evaluation.
- Improve scene presentation with optional character artwork and 3D world viewer only when it serves the roleplay.
- Avoid coupling the application to any one model family, prompt format, or inference backend.

## Reference documentation

- [NovelAI Editor](https://docs.novelai.net/en/text/editor/) and [Story Settings](https://docs.novelai.net/en/text/editor/storysettings/)
- [Character.AI character testing and swipes](https://support.character.ai/hc/en-us/articles/50609303987099-6-Refining-and-Testing-your-Character) and [Pinned Memories](https://support.character.ai/hc/en-us/articles/24327914463003-Pinned-Memories)
- [SillyTavern World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)
- [Perchance AI Character Chat](https://perchance.org/ai-character-chat) — inspiration for approachable character tools and narrative controls.
- [AnythingLLM memories](https://docs.anythingllm.com/features/memories) and [document pinning](https://docs.anythingllm.com/chatting-with-documents/introduction) — future per-character/world scoped memory inspiration.
- [Appraisal-based chain-of-emotion agents research](https://pmc.ncbi.nlm.nih.gov/articles/PMC11086867/) — conceptual reference, not a claim that the prototype scientifically models emotions.
- [KoboldCpp OpenAI-compatible endpoints](https://koboldcpp.net/docs/api/endpoints/) and [streaming](https://koboldcpp.net/docs/api/streaming/)
