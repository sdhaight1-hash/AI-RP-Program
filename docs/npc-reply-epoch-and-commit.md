# NPC reply validity — durable world epoch and transactional commit

## Problem

A story revision alone is not a valid concurrency token for this program. Clock changes, NPC movement, reviewed character facts, scene-observer events, atlas relationships, and independent world canon can commit without changing `studio_state.revision`. The earlier actor-context API compared the local SQLite connection's `total_changes()` and `PRAGMA data_version` before the model request, but forwarded the upstream stream afterward without verifying that the world was still current. The old browser eventually inserted responses through a debounced full-story PUT, with no atomic link back to the original world state.

A model response grounded in yesterday's location could therefore become a permanent scene event after the world's clock or witness knowledge changed while generating.

## New contract

1. Each world SQLite database stores a durable monotonically increasing `world_epoch.version` counter. SQLite AFTER INSERT/UPDATE/DELETE triggers increment it **in the same transaction** as changes to timelines, actor registration, clocks, positions, world entities/relations/places, provenance, accepted events, actor facts, and dialogue memories. A rollback also restores the previous version. The story snapshot retains its separate `studio_state.revision` CAS.
2. The server assembles the acting NPC prompt from its **authoritative** world snapshot. Before exposing context it verifies story revision and the world mutation stamp. The model stream captures the source scene basis and world epoch.
3. While the local model streams, the server checks **only small SQLite revision/epoch rows and the existing connection/version stamp per chunk**. It does not deserialize the entire world per generated token. If anything relevant changes, it aborts upstream and emits an SSE error; partial text cannot become story history.
4. Only after an OpenAI-compatible model stream ends with `[DONE]`, contains nonempty text, has no parsing errors and passes a final world-version check does the server append `event: rp_complete` with an unpredictable one-use ticket. Tokens are held server-side for up to **15 minutes** and are discarded on server restart.
5. The browser displays provisional streaming content but does not put it in story history. Completed normal replies are sent to `POST /api/actor/reply/commit` with `{worldId,ticket,reviewed:false}`. A flagged format/agency reply remains unsaved until its owner chooses **Keep reply anyway**, using the same one-use endpoint with `reviewed:true`.
6. The server looks up the exact model text and source binding from that ticket. It rechecks world ID, story revision, actor/source scene basis and durable epoch **inside the same BEGIN IMMEDIATE transaction as the story save**. It creates the NPC message ID, witness list, medium, retry variant, mood settling, and source metadata on the server; the browser does not supply arbitrary model text or scene edits through this commit API.
7. Existing story/fork source fingerprint locks, creator-approved world event decisions, world isolation and SQLite projection parity still run on this save. On success, the browser adopts the returned authoritative world state and revision. If local browser edits race the acknowledgement, it retains those edits for export rather than silently overwriting them.

A world change after completion but before review invalidates the ticket. A stale rejected response does not erase the player's preceding turn; the user can retry generation from current canon.

## Boundaries

- This is concurrency protection for **NPC replies generated through the server-owned** `/api/actor/reply` pipeline. Normal manual edits/imports still use `PUT /api/state` with existing revision/CAS, approval, and source-fingerprint safeguards; localhost clients can deliberately author fictional dialogue as users.
- Legacy stateless `/api/chat` remains a general-purpose local text-generation path for character drafts and creator-reviewed suggestions; it does not itself commit world canon or actor events.
- Events inferred from NPC text still require separate creator review; a valid completion ticket never authorizes the model to mutate the world.
- The epoch watches the explicitly registered SQLite source tables. Adding a new persistent world-knowledge source requires adding it to `world/epoch.mjs` or documenting why it is already covered by a story revision. Direct manual edits outside SQLite or externally copied assets are not observed.
- The world epoch is **durable** but reply tickets are intentionally **ephemeral**; a server restart invalidates any uncommitted draft, preventing the old process's in-memory verification state from being trusted.
- Existing backups and WAL content may still retain deleted data. This is not a secure-erasure feature, and the user's actual Windows `.data` directory was not opened in development.

## Verification

New automated regression tests in `test/reply-world-epoch.test.mjs` cover trigger commits from same/external SQLite connection, durable reopen, transaction rollback, valid one-use commit, cross-world ticket rejection, delayed review after time changes, invalid model stream, UTF-8 and CRLF chunk splits, a mid-SSE world mutation, accepted-event Retry source locks, and normalized-primary projection parity.

The headless Chrome smoke also enables a temporary loopback mock local model, sends an ordinary player turn, consumes the completion event, and verifies that the NPC response is truly committed to its world SQLite record—not only drawn as temporary chat bubbles. Normal memory evaluation, Node 22/24, scale checks, fork tests, browser responsive layouts, and deletion safety tests remain required.

**Follow-up:** If roleplay users need safe cross-process model execution (multiple application servers, shared databases, workers), replace process-local one-use ticket storage with an expiring SQLite lease table and an explicit ownership protocol. A single loopback application server is the current deployment model.
