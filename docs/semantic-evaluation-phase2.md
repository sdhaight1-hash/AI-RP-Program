# Phase 2 semantic memory evaluation — deterministic evidence funnel

This test uses the *real* per-actor SQLite memory tables, source scope enforcement, locally bounded candidate selection, semantic retriever, and final context packer with transparent fake vectors. It does not run the user's embedding model or prove production recall quality.

## Audit findings and fixes

1. The prior bounded candidate pool chose lexical, pinned, early, and recent memories. Intermediate uncued dialogue could be unreachable. A deterministic actor-only **middle-period stratum** now complements the existing pools, without increasing the maximum embedding count or changing source visibility rules.
2. A newly discovered false positive: the semantic retriever could re-embed the **current user's own question**, then return that same question as a highly similar past memory. It now excludes the latest eight witnessed scene messages already represented directly in the prompt. The existing tiny synthetic smoke fixture was extended with later observed turns to test actual recall rather than current dialogue.
3. The database still decides actor authorization. Embedding scores and caller text cannot confer authority. Revoked personal facts and changing revisions are revalidated after network waits.

## Reproducible results

In GitHub Node 24 CI on Nov 14, 2026 ([run](https://github.com/sdhaight1-hash/AI-RP-Program/actions/runs/43646198608)):

| Synthetic check | Result |
| --- | --- |
| Correctly selected gold sources | 4 / 4 |
| Lexical-only gold sources | 2 / 4 |
| Unrelated negative questions with a semantic memory match | 0 / 2 |
| Unauthorized other-actor source in embeddings or prompts | None |
| Middle-era paraphrase in a 2,048-token prompt | Present |
| 2,048 / 4,096 / 8,192 token budgets | Passed |

Mock-vector retrieval p50/p95 timings were roughly 3.5/24.5 ms on this particular CI run. **These do not measure inference latency** of any actual embedding model, nor are four positives and two negatives statistically meaningful accuracy estimates.

## Next evidence gate (Issue #32)

Evaluate the optional real local embedding model against annotated larger corpora across multiple characters, worlds, forks, temporal positions, contradictions and irrelevant negatives, using the *same stored → retrieved → post-trim IDs* trace.

Measure separate p50/p95 times for candidate SQL, embedding API, similarity ranking, token packing and full NPC reply. The current middle-era sample is bounded and cannot guarantee finding an arbitrary old memory. Persistent privacy-aware vectors should be considered only if the measured recall and CPU cost justify their extra storage and synchronization.

Run `npm run eval:semantic` for deterministic regression. Use the in-app synthetic real-model assessment or `npm run eval:local` for local chat model behavior on the actual target machine.
