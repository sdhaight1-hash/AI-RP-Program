# Development hardening pass — independent worlds, memory horizons, recovery and diagnostics

Date: 2026-11-14. Base: `main` at `61d990f740da31b087b9e62bc1f19cab9d4dc517`. This pass extends the audited app without changing on-disk schemas, adopting a new UI framework or installing runtime dependencies.

## Changes

### 1. World-specific HTTP routing

Previously, world-scoped requests were only accepted when their world ID equaled the process-wide `activeWorldId`. That rejected stale writes but prevented truly independent tabs from simultaneously using different universes.

`WorldPartitionStore.forWorld(worldId)` now returns a bound facade over a cached SQLite `StudioStore` for that world. The HTTP handler resolves and captures this view for each world-bound request. Every `await` in actor context, embedding and reply paths retains that captured view. A legacy default-world selection remains for older clients, but is no longer the data router for modern world-scoped endpoints.

The frontend stores the selected world in `sessionStorage` (per tab), includes it in state reads and world catalog reads, verifies matching IDs through `public/world-client.mjs`, and guards against stale asynchronous catalog results and concurrent world-switch attempts. The static server explicitly allowlists the helper module.

**Verification:** independent world reads/writes/revisions, canon and timeline isolation, legacy default-world activation during an in-flight NPC context request, invalid world ID handling, and actual two-tab headless Chrome behavior. Empty and deleted world selections fail explicitly; cross-world writes remain disallowed by the existing validations.

**Compatibility:** `GET /api/state` without a world ID is retained for first-run/legacy clients. New browser paths use explicit IDs. The old `/api/worlds/activate` still updates the legacy default and is not needed to navigate the v3 browser.

### 2. Older semantic memory without expanding trust

The previous optional embedding retriever selected only the newest/pinned 96 candidates, systematically excluding early unpinned experiences after enough conversation. The candidate pool now reserves slots for lexical matches, pins, recent dialogue, and the oldest memories, and fills overlap vacancies from recent dialogue. Every source is constrained to the acting actor's timeline **before** any text is sent to the local embedding endpoint. Factual authorization, source-hash/revision revalidation, and final prompt packing are unchanged.

The new deterministic test places an unpinned pendant clue behind **230 intervening turns** and checks that semantic retrieval and the packed 2,048-token prompt include it, while another actor's hidden source never enters embedding inputs.

**Important limitation:** this is bounded coverage, not a permanent or complete semantic index. Middle-era memories without lexical or pin cues can still be missed. Genuine model false positives and performance must be measured on real local embeddings before changing thresholds or claiming high recall.

### 3. Read-only storage health and offline recovery snapshots

`npm run audit:storage -- .data` inspects the registry and every registered world in **read-only SQLite mode**. It checks integrity, foreign keys, catalog identity, partition separation, JSON story structure, and basic timeline references. It never updates the user's story, indexes or revisions.

`npm run backup:storage -- .data <new-backup-directory>` creates **non-overwriting** world backups. The tool makes SQLite-consistent `VACUUM INTO` copies (including committed WAL data), copies known world asset directories, verifies the staged world store, records SHA-256 checksums for the database files, and atomically renames the staging directory to the requested destination. It never overwrites an existing backup.

**Stop the application before a complete backup.** SQLite snapshots are individually consistent, but the registry and world databases are independent files and cannot be guaranteed to be one atomic cross-database snapshot while another process is changing them. Test restoring by copying the whole backup folder to an empty data directory and reopening it; do not overwrite the current `.data` as an experiment.

Temporary fixtures prove two-world restore, preserved assets, valid integrity checks, and rejection of deliberately broken foreign keys.

### 4. World UI module seam

`public/world-client.mjs` now owns the small scoped HTTP transport/response verification rules. `public/app.js` retains existing editor behavior, but its world selection no longer assumes process-global state. This is a safe first extraction from the browser monolith rather than an untested wholesale refactor.

### 5. Actual local-model diagnostic runner

`npm run eval:local -- "<loaded-model-id>" "http://127.0.0.1:5001/v1" "report.json"` runs the seven existing synthetic Fidelity Lab tasks against an **explicit local OpenAI-compatible chat endpoint**, recording response interpretation and elapsed time. The command refuses non-loopback endpoints; it does not read user worlds, load model files, or silently change application data.

This runner is not a substitute for human evaluation: its warnings are narrow heuristic checks, and no GPU-based accuracy/latency claims are made from GitHub CI. Node tests use deterministic stubs to verify the request/report plumbing and honest offline failures.

## Explicit next gates

1. **Long-session scalability:** benchmark 1K/10K turns, backup duration and FTS rebuild cost before replacing the 4 MB JSON snapshot. Use a versioned migration with replay/rollback tests and full on-device backup verification. Do not drop existing story state or rush a database normalization.
2. **Semantic recall:** evaluate intermediate-era unpinned clues, source conflicts, composed implicit cues, false positives and p50/p95 latency on the user's actual CPU/local embedding model; compare to lexical-only with identical evidence IDs and token windows.
3. **Frontend extraction:** move one stable feature controller at a time (world atlas, character editing, memory review) behind browser tests. Keep the v3 UX and avoid changing unrelated behavior.
4. **Windows end-to-end:** use Fidelity Lab and `eval:local` against loaded KoboldCpp/LM Studio chat models and, if configured, local embeddings; separately run ComfyUI render and restart tests. The CI suite cannot access the user's GPU, local model weights, or real ComfyUI process.
5. **Cross-database backup consistency:** offline-only backup is deliberate; any future live backup workflow must explicitly coordinate writers or record a global checkpoint/generation manifest.

## Baseline test commands

- `npm test` — Node domain, HTTP, memory, storage, UI module and failure-injection tests.
- `npm run eval:memory` — deterministic evidence-funnel benchmark, not a live model score.
- `npm run test:browser` — Chromium desktop/responsive/dual-tab world isolation smoke (ChromeDriver required).
- `npm run audit:storage -- .data` — read-only inspection of an existing offline/local database.

No data files, models, secrets or images were committed. All upgrade and recovery tests use temporary databases.
