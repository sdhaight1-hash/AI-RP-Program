# Normalized-primary append journal — verified storage foundation

**Status: opt-in internal storage primitive, not activated by normal startup or a user-facing command.** The current browser still saves story snapshots through the ordinary revision-checked path. Do not imply this alone solves end-to-end large-world latency.

## Why the v1 primary fingerprint cannot be bypassed

The existing normalized-primary projection stores a SHA-256 fingerprint of the complete reconstructed world. Appending a message directly to `story_projection_messages` without updating that fingerprint makes its next read refuse the world; recomputing the v1 fingerprint for every message defeats incremental write performance.

A safe transitional format instead keeps the entire verified v1 projection **sealed as a base**. Optional journal rows represent only later append-only player turns. The base fingerprint remains authoritative for all messages that were already present when the journal was activated.

## Journal schema and checks

`storage/append-journal.mjs` owns three sidecar tables, created only inside an explicitly requested SQLite transaction:

- `story_append_meta`: sealed base revision/fingerprint, most recent revision, and the terminal append-chain digest.
- `story_append_rows`: one appended message per story revision, with its scene, source identity, position, canonical JSON, chronology and chained SHA-256 digest. Unique scene/message and scene/position constraints prevent ambiguous provenance.
- `story_append_heads`: bounded per-scene message counts and update timestamps, allowing append at the next position without counting every old message.

The SHA-256 chain begins from the sealed primary fingerprint. Each row commits the prior chain, revision, scene, position, source ID, full canonical message and time. On reading, the program verifies the original v1 projection, contiguous revision and source positions, all append hashes, the terminal head and each scene count. Invalid identities or tampered records **fail closed** rather than being repaired by lossy normalization.

The low-level player-message append requires `BEGIN IMMEDIATE` and checks the expected story revision and scene medium. It updates the story revision, journal head, source row, actor-owned witnessed memory and FTS, and durable world epoch **in the same transaction**. Failed memory indexing, a constraint violation or deliberate fault injection rolls back the whole operation.

A conventional full-document save remains supported. It verifies the current journal on load, reconstructs the canonical story, and atomically merges the accumulated append rows back into the existing normalized-primary snapshot. A rollback restores the prior journal and all its source evidence.

**No world enables the journal automatically.** Activation is available only through `enableVerifiedAppendJournal` after the normalized-primary base passes the full existing projection verification. A future backup-gated offline CLI and server append authorization must be implemented and tested before this can be presented as a production mode.

## Critical remaining integration work

1. Expose a **server-owned player-only append API**. Compute cast, chosen speaker and recipients from authoritative scene metadata and the single communication-channel catalog. The browser must not supply arbitrary witness IDs, NPC messages or external world IDs.
2. Verify replay protection, two-tab revision conflicts, edits occurring during append, per-world routing, fork-inherited source locks, accepted-event authority and independent system actors. The fast path must not accidentally authorize deleting a scene or changing world canon.
3. Bind the real browser send action to the verified incremental path only when explicitly enabled. Keep the current full-world save as the default and tested fallback.
4. Extend server-issued NPC reply tickets to a corresponding verified incremental **assistant** append, including retried reply variants, witness-scoped recall and creator-approved event locks. A player-only fast append still leaves the NPC half of every roleplay turn on a full-state resave.
5. Run 1K/10K/25K whole-turn benchmarks, not only journal INSERTs. `--journal` mode of `eval/storage-scale.mjs` is expressly a low-level SQLite microbenchmark with real actor-memory/FTS writes and integrity verification, not proof of browser/model speed.

## Sample CI storage-operation measurements

On [one November 2026 Node 22/24 GitHub Actions run](https://github.com/sdhaight1-hash/AI-RP-Program/actions/runs/43664394113), the isolated one-message write samples were:

| Runner | 1K legacy snapshot | 4K legacy snapshot | 1K normalized-primary snapshot | 4K normalized-primary snapshot | 1K journal primitive | 4K journal primitive |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Node 22 | 12.55 ms | 31.99 ms | 20.48 ms | 61.77 ms | 1.65 ms | 1.44 ms |
| Node 24 | 15.79 ms | 52.41 ms | 21.79 ms | 71.70 ms | 1.63 ms | 1.82 ms |

These are **single-run synthetic diagnostics, not stable speedup ratios or user hardware measurements**. The journal numbers exclude network transfer, acting-context construction, model inference, browser state reconciliation, and the NPC response save; at present, those steps still use the full-history path. The tests prove the underlying SQLite journal + per-witness FTS write has nearly constant observed cost between 1K and 4K sources *on these particular CI runs*, not that an entire 4K-turn roleplay is faster.

## Verification

`test/primary-append-journal.test.mjs` verifies opt-in-only mode, existing v1 compatibility, story reconstruction and projection parity, scene and character scope, transaction rollback on FTS failure, tamper detection, source ID conflicts, chronology, safe compaction, close/reopen durability, cross-world isolation and bad cutover rejection.

`test/storage-scale.test.mjs` exercises the temporary-world journal benchmark; CI now runs `npm run eval:scale -- --ci --journal` on Node 22 and 24 as a separate measurement. Optional extended trial: `npm run eval:scale -- --lab --journal --samples=3`. No user `.data` files or local model are touched.

The existing old-world SQL schema is not rewritten, no automatic migration is shipped, and no unrelated character/world interface is changed by this storage groundwork.

## Server-owned player append and explicit activation

The journal now has a narrow **player-only** server endpoint: `POST /api/scene/player-append`. It accepts exactly `worldId`, `sceneId`, `revision`, `messageId` (UUID) and `content`. The server obtains the scene's communication medium, eligible cast, next speaker, timeline authority, witnesses and timestamp from verified world-local SQLite data. Callers cannot submit an assistant role, witness IDs, or a replacement communication channel. The append transaction updates the journal, scene head, witnessed actor memory and world epoch together. A mismatched revision is rejected; no full scene history is serialized on this write path.

Activation is still **offline and opt-in**, never automatic:

1. Stop Studio and create a verified offline backup.
2. Stage shadow projection with `npm run normalize:storage -- .data --apply <backup>`.
3. Create a **new** backup and explicitly enable normalized-primary using `--primary <new-backup>`.
4. Create another **new** verified backup of this primary-mode state, then run `npm run normalize:storage -- .data --journal <primary-backup>`.
5. Verify `npm run audit:storage -- .data`, restart Studio, and retain all pre-cutover backups.

**Important:** the normal web UI still uses full-document saves. This server endpoint is an internal foundation for a future opt-in browser incremental-send feature and is **not** a recommendation to manually call the API while another tab has unsaved edits. NPC replies, non-append edits, and concurrent browsers require a larger, coordinated message protocol. The append path remains disabled for worlds not explicitly journal-enabled. This does not close Issue #31.
