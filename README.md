# AI RP Studio — local roleplay first

An early, self-contained roleplay web app. The design draws on Character.AI's character-first conversations, NovelAI's story settings and alternative generations, and SillyTavern's character/persona/lorebook workflow. It is original software, not a clone of those apps.

**Status: prototype v0.1.0.** A model server is required for AI replies. The WebGL panel is atmospheric decoration, **not** a world renderer. World simulation, automatic long-term memory, multi-NPC autonomy, full Tavern PNG/V2 card support, and server-side database saves are **not** implemented yet.

## Requirements

- Node.js 20 or later (Windows/Linux/macOS)
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
9. **Backups:** Export/import all local stories and settings as JSON. Data is stored in this browser's localStorage, not a server database.

## Design and implementation principles

- **Local-first**: Node server only listens on `127.0.0.1`, rejects cross-origin requests, and proxies generation so the browser never talks directly to an external host.
- **Backend independent**: currently speaks OpenAI-compatible `/v1/models` and `/v1/chat/completions` (SSE). Tested with a mock implementation of that contract; actual GGUF output must be verified against a running model on the user's machine.
- **Prompt context is explicit**: character identity + persona + established scene summary + selected pinned moments + keyword-matched lore + Author's Note + recent transcript.
- **Player agency**: custom prompt and UI distinguish player actions from NPC output; a model can still make mistakes.
- **No dependencies**: vanilla JavaScript/CSS, browser WebGL shader, and the Node built-in HTTP server.
- **WebGL is optional**: atmospheric effect fails gracefully when WebGL is unavailable.
- **Privacy caveat**: the local browser stores **unencrypted** text. A person with access to the browser profile may be able to read it. Backup exports are ordinary unencrypted JSON.

## Tests

```sh
npm test
```

Includes prompt/backup tests, character import, lore activation, streaming relay with a fake model server, HTTP validation, and same-origin rejection. A successful test run confirms the HTTP contract and local logic, **not** that your selected GGUF generates good prose.

## Known limits / next milestones

- Replace localStorage with user-controlled SQLite saves plus backups.
- Add explicit token budgeting, context inspection, and summary management.
- Implement deterministic world state, world clock, locations, NPC relationships and memories.
- Add full character card V2 and lorebook import/export compatibility, with validation.
- Improve scene presentation with optional character artwork and 3D world viewer only when it serves the roleplay.
- Avoid coupling the application to any one model family, prompt format, or inference backend.

## Reference documentation

- [NovelAI Editor](https://docs.novelai.net/en/text/editor/) and [Story Settings](https://docs.novelai.net/en/text/editor/storysettings/)
- [Character.AI character testing and swipes](https://support.character.ai/hc/en-us/articles/50609303987099-6-Refining-and-Testing-your-Character) and [Pinned Memories](https://support.character.ai/hc/en-us/articles/24327914463003-Pinned-Memories)
- [SillyTavern World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/)
- [KoboldCpp OpenAI-compatible endpoints](https://koboldcpp.net/docs/api/endpoints/) and [streaming](https://koboldcpp.net/docs/api/streaming/)