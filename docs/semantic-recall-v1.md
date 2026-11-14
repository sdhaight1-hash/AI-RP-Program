# Optional local semantic actor recall (experimental)

This supplements SQLite FTS5 with **meaning-based candidate retrieval** for implicit references and paraphrases. It does **not** replace actor memory, reviewed facts, timeline event authority, or the existing small-context packing algorithm.

## Enable

Semantic recall is **disabled by default**. To enable it, load a dedicated embedding model into a local LM Studio instance and configure the server process:

- `RP_EMBEDDING_MODEL` — the exact loaded embedding model ID (required to enable).
- `RP_EMBEDDING_URL` — OpenAI-compatible **loopback** base URL, default `http://127.0.0.1:1234/v1`.

For Windows CMD, for example, run `set RP_EMBEDDING_MODEL=<your loaded embedding model ID>` in the terminal that starts the app. The app's normal chat provider may remain KoboldCpp on port 5001. LM Studio supports `POST /v1/embeddings` for embedding models: [official LM Studio reference](https://lmstudio.ai/docs/developer/openai-compat).

Only `http://localhost`, `http://127.0.0.1` and `http://[::1]` endpoints are supported. No cloud vector database, separate npm library, automatic download, network externalization, or background task is required. Nothing is embedded or transmitted to a second model without the explicit setting. When the embedding service is missing, times out or returns malformed output, the server **falls back to lexical memory** and reports that status in the Context Inspector.

## Boundaries

1. Start with an authorized actor in a saved scene/timeline and the correct active world. Only that actor's `actor_memories` rows are considered. Subjective facts come through `listActorFacts`, which excludes revoked, superseded or source-invalid records.
2. Candidate generation is bounded to the most recent or pinned witnessed dialogue plus active reviewed facts. No hidden actor, world or timeline memories are sent to the embedding service.
3. Embed the current conversation cue plus up to **96** authorized candidates in bounded batches; never embed arbitrary browser-supplied documents. In-memory cache keys incorporate model, world, timeline, actor, source ID and source text. Vectors are derived and disappear on server restart; the SQLite database remains authoritative.
4. Normalize numeric embedding vectors, reject invalid dimensions and return at most **three** candidates over a conservative cosine-similarity threshold of **0.62**. This threshold is a preliminary heuristic, not a calibrated measure of truth.
5. Recheck the world and saved scene revision after network awaits. Recheck active/valid reviewed facts even if their status changed without revising the scene.
6. The acting prompt assembler never trusts returned text or IDs as authority. It reloads semantic candidate content from the actor's own timeline database and deduplicates candidates already selected by lexical retrieval.
7. Pack results under the same 2,048–32,768 local-model budget rules. The latest real user turn remains protected, and native token counting may trim whole evidence items if required. The Context Inspector reports **actual post-trim semantic evidence**.

## Why this is a companion, not a replacement

A vector match can be thematically plausible yet wrong. Reviewed personal facts are subjective, and a sentence remembered as speech does not mean the claim is true. Accepted events are still governed by their own reviewed event ledger. FTS5 retains fast literal name/code matching, and the semantic path can handle some phrasings without shared terms.

Candidate selection is intentionally conservative and limited. Very old unpinned conversations beyond the current candidate window may not be found by this first implementation. The initial embedding request creates vectors lazily; later requests can reuse the process-local cache, but CPU latency depends on model and hardware.

## Verification

`test/semantic-recall.test.mjs` uses deterministic **mock embedding vectors** to verify that an indirect jewelry/rain question can select a previously heard pendant memory that FTS5 misses. It also checks unauthorized private messages, invalid candidate injection, stale/disabled facts, asynchronous scene edits, invalid embedding data, and fallback. This demonstrates the pipeline, **not** a measured improvement from a real embedding model.

The existing `npm run eval:memory` benchmark remains the always-on lexical baseline with an implicit-reference diagnostic (expected to miss when embeddings are disabled). Real-model evaluation must compare lexical-only vs embedding-enabled quality, false positives, latency and final prompt coverage across larger annotated worlds before raising the embedding candidate cap or introducing permanent vector storage.

Architecture research: LM Studio embeddings API; [Harness the Memory (2026)](https://arxiv.org/abs/2608.15008), reporting that no single memory substrate consistently dominates and over-retrieval can harm sequential tasks.
