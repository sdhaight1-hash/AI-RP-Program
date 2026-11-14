# Durable deletion and old test-entry cleanup

## Problem found

The Character roster's **×** control deliberately archived the character rather than removing their saved profile. Library & Trash had a second permanent-delete control, but it edited the browser state and queued an asynchronous save. The world entity mirror (`ensureCharacterEntities`) only **created and renamed** `world_entities`: it never removed rows for characters that had been permanently purged. Per-timeline actors, inherited memory records, reviewed facts, accepted event sources, and character-origin citations could also persist.

That means old test people could remain in the World Codex even after disappearing from the Character Library.

## New behavior

- **Archive** remains reversible. It retains the character, scenes, identity and database evidence, but the archived person's projected entity is hidden from the *active* relationship/World overview until restored.
- **Permanently delete a character:** open **Library & Trash**, then select **Permanently delete** for an archived character. The browser waits for previous saves and sends a world-scoped, revision-checked server request. Server-side `purgeArchived` refuses to delete a person still referenced by a scene or encounter; remove those dependencies first. Successful deletion commits removal of the profile and its mirror, authored character-origin source quotes, relationships *involving the removed mirror*, actor-owned direct/inherited memories, reviewed facts, positions, proposals, committed events authored by that actor, event observations, and timeline actor memberships in the **same SQLite transaction**. Independently accepted world entries (such as a person described in the character's biography) remain creator-owned canon and can be separately deleted.
- **Permanently delete a scene:** archive, then purge it in Library. Delete scene-specific memories, reviewed facts, pending/rejected event proposals and lore limited to that scene. Other committed world events remain independent world canon unless their originating character is permanently purged. A scene that has descendant branches cannot be purged while those branches depend on its history.
- **Delete other entries:** **Relationship Codex** has explicit Delete options for manually authored entities and directed relationships; **World Atlas** has Delete for places and a way to clear the current scene's location. Entity deletion also removes its related relationships and relationship-source links. Place deletion removes connections but refuses to proceed while a child place, character, scene, encounter, timeline position, or world event still refers to it. World lore and encounter templates retain their existing delete controls.
- **Existing old ghosts:** opening each world checks for source-character IDs missing from canonical character state and removes their leftover world mirrors and actor derivatives. The read-only storage audit reports orphaned character projections as warnings before repair. Maintenance runs once on world-open; regular saves use narrow, transactional reconciliation and **do not rescan every historical dialogue memory for removed scenes**.

Permanent deletion is checked with SQLite foreign-key integrity and rollback/fault-injection regression tests. Cross-world requests and cross-origin attempts are rejected. Duplicate ID, failed cleanup and stale browser revision cannot silently publish a partial deletion.

## Where data may still exist

Deletion is logical removal from the application's current SQLite records and derived FTS indexes; it is **not a forensic disk wipe**. SQLite journal/WAL data, system snapshots, browser storage, exported backups, image files, ComfyUI generated media and other manual copies may still contain old bytes. Remove those separately if you require physical erasure. The current feature does not delete entire worlds or timelines; their own destructive lifecycle and backup checks need separate handling.

## Regression gates

`test/durable-deletion.test.mjs` verifies archived vs purged characters, stale world projection repair, source/FTS cleanup, world entity and relationship deletion, dependency rejection, transactional rollback, stale HTTP revisions, cross-origin/cross-world isolation. `scripts/browser-smoke.mjs` creates and deletes an entity through the actual UI and checks it is gone from the server world catalog.

Use `npm run audit:storage -- .data` (read-only) to view any orphan warnings before opening a world with the revised app. Make a current **offline backup before permanent deletions** and verify the intended world; the UI cannot reverse them afterward.
