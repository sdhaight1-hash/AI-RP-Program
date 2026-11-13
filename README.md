# AI RP Studio — local roleplay first

An early, self-contained roleplay web app. The design draws on Character.AI's character-first conversations, NovelAI's story settings and alternative generations, and SillyTavern's character/persona/lorebook workflow. It is original software, not a clone of those apps.

**Status: prototype v0.2.0.** A model server is required for AI replies. The WebGL panel is atmospheric decoration, **not** a world renderer. World simulation, automatic long-term memory, multi-NPC autonomy, and full Tavern PNG/V2 card support are **not** implemented yet. SQLite-backed local scene persistence and a first deterministic emotional-state simulation are implemented.

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

## RP workflow

1. **Characters:** Create a character, edit their identity, voice, story premise, and opening message. Import/export a simple JSON character card.
2. **Personas:** Set your player character under Setup. The actor prompt explicitly forbids the NPC from deciding your actions.
3. **World lore:** Create lore facts with keywords; only recent conversation activates those entries.
4. **Story tab:** Edit the permanent canon recap separately from the short **Author's Note** (immediate tone/pacing guidance).
5. **Pin:** Pin up to five significant user/NPC messages. Pinned moments are inserted into future prompts.
6. **Chat / Story view:** Use the top toggle to switch between character chat and a clean reading presentation of the same history.
7. **Retry / swipes:** Retry the last NPC answer, then cycle between saved alternatives without losing the earlier ones.
8. **Continue:** Allow the model to advance the narrative without a new player message. This adds a temporary continuation instruction to the inference request; it doesn't create a visible player action.
9. **Persistence:** Every story, character, lore entry, persona, and emotional state is stored in local SQLite at `.data/studio.sqlite`. The browser retains an emergency backup. Existing v0.1 `localStorage` stories are imported into the database automatically **only if the database is empty**.
10. **Emotion tab:** The selected character has a per-scene valence, arousal and trust simulation. Click an explicit *Warmth*, *Friction*, *Danger*, *Reassurance*, or *Quiet passage* story beat; undo or reset when needed. The model receives a human-readable interpretation of that state in its next prompt. Narrative intensity gradually settles after successful turns; trust does not decay automatically.
11. **Context tab:** Inspect and copy the actual system prompt and recent transcript assembled for a standard reply. It shows selected keyword lore and a rough **character-based** token estimate (not a true tokenizer count). The Continue action appends its own temporary instruction.

## Design and implementation principles

- **Local-first**: Node server only listens on `127.0.0.1`, rejects cross-origin requests, and proxies generation so the browser never talks directly to an external host.
- **Backend independent**: currently speaks OpenAI-compatible `/v1/models` and `/v1/chat/completions` (SSE). Tested with a mock implementation of that contract; actual GGUF output must be verified against a running model on the user's machine.
- **Prompt context is explicit**: character identity + persona + simulated emotion + established scene summary + selected pinned moments + keyword-matched lore + Author's Note + recent transcript. See the Context inspector for what is sent.
- **Player agency**: custom prompt and UI distinguish player actions from NPC output; a model can still make mistakes.
- **No third-party runtime dependencies**: vanilla JavaScript/CSS, browser WebGL shader, and the Node built-in HTTP/SQLite modules.
- **WebGL is optional**: atmospheric effect fails gracefully when WebGL is unavailable.
- **Privacy caveat**: SQLite and the local browser backup store **unencrypted** text. A person with access to your computer or browser profile may be able to read the local SQLite file or backup. Backup exports are ordinary unencrypted JSON.

## Tests

```sh
npm test
```

Includes prompt/backup tests, character import, lore activation, emotion transitions and settling, SQLite persistence/revision conflicts, API validation, streaming relay with a fake model server, and same-origin rejection. A successful test run confirms the HTTP contract and local logic, **not** that your selected GGUF generates good prose.

## Known limits / next milestones

- SQLite is currently a single atomic JSON document snapshot in a local database, not a fully normalized world-event schema. Add targeted SQLite indexes and tables when the simulation needs them.
- Add tokenizer-accurate prompt budgeting, explicit source tracing, controlled summary generation, and evidence-linked auto-memory proposals.
- Extend the manual emotion simulation into an appraisal engine driven by verified world events, bounded per-character traits, and separate relationship state. Do **not** infer player intent through keyword sentiment.
- Implement deterministic world state, world clock, locations, multi-NPC relationships and memories.
- Add full character card V2 and lorebook import/export compatibility, with validation.
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
