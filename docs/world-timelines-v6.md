# World timelines and clocks — main workspace

The World workspace now owns four editable sections: **Overview**, **Places & atlas**, **People & relationships**, and **Worlds & timelines**. The last section replaces the old World Library form hidden inside the focused Detail Desk.

## What the timeline editor does

- Lists existing independent worlds with an explicit **Open World** action. Opening another world is a hard context switch; it is never a silent selector side effect.
- Creates a world, with name and description, through the existing world creation endpoint and safe browser switch.
- Creates a timeline only in the **currently open world**. The redundant world selector was removed; users must explicitly switch before altering another universe.
- Shows only this world's timelines in the timeline selection control, even while another browser tab is using a different world.
- Lets the creator explicitly assign a chosen timeline to the active scene, without changing a different world or importing another world's character knowledge.
- Sets the fictional timeline clock as a UTC reference and validates the IANA display time zone server-side. Creating or changing timeline selection resets the clock form to that selected timeline's explicit value (or blank if unset), avoiding accidental propagation of a different timeline's date.

These changes preserve independent SQLite world files and the preexisting timeline/clock endpoints. There is no automatic timeline merging or cross-world memory. The app still does **not** support destructive deletion of an entire world or timeline (Issue #38).

## Technical boundaries

The presentation/controller for world creation, timeline creation, clock and assignment is now isolated in `public/world-timelines.mjs`; the browser controller supplies explicit world-bound data, APIs and navigation callbacks. World editing lives in the main content canvas; the older inspector entry point redirects there instead of mounting a duplicate form.

The server remains authoritative: the module limits the visible options, but those client-side guards are additional to the server's validation. An NPC reply stays bound to its own scene/timeline/world mutation basis, unaffected by these controls unless an explicit valid edit is committed.

## Verification

- The real headless Chrome flow enters **Worlds & timelines** from World Overview, creates a timeline, verifies its SQLite catalog record, sets a UTC clock, verifies the committed instant/time zone, and returns to Overview.
- The two-tab test checks that the first world's timeline selector includes exactly the first world's timeline IDs after another independent world is created/opened elsewhere.
- `test/studio-experience.test.mjs` tests the browser module is served and its world-scoping guard remains present.
- Full Node 22/24 tests, storage/revision, fork, actor evidence, semantics, Chrome 390/720/900px layouts are required before merge.

## Next phases

Extract remaining character-source approval controller and complex actor-memory diagnostics under Issue #33, preserving exact evidence provenance and model-output approval gates. Keep whole-world/timeline deletion (Issue #38) as a separate backup- and crash-safety milestone rather than adding destructive shortcuts to the editor.
