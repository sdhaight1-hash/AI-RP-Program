# World editor simplification — inline Atlas & Relationships

## Problem

The World workspace previously showed static preview cards while the actual Places and Relationships forms lived in a separate focused "Detail Desk". Users had to traverse an overview card and an overlay just to edit places, and multiple paths could open two copies of the same form. The right-hand inspector also remained on screen beside the main World view.

## Implementation

- World now has three visible sections: **Overview**, **Places & atlas**, and **People & relationships**.
- Places and Relationships are full-width editors in the World workspace. Their cards and the Ctrl+K Atlas/Relationships commands lead to these same sections; legacy inspector-tab entry points are redirected so only **one** copy of the editor is mounted.
- Moved the original Atlas and relationship editors into the dedicated `public/world-editors.mjs`. The module receives a narrow set of world-scoped callbacks for reads, writes, confirmation/deletion and scene edits. No SQL or world state is directly mutated by the renderer.
- World identity, scene timeline constraints, permanent deletion guards and SQLite write endpoints are unchanged. The editor exposes the existing guarded delete actions, and setting a scene's location still checks that its timeline belongs to the same world.
- Active character-linked world identities now show **Edit character profile** and an explanation that permanent character deletion belongs in Characters → Trash, instead of a delete button that the backend would reject. Historic duplicate projections remain explicitly removable when there is another linked mirror.
- World editing takes the main canvas width at desktop sizes; mobile retains accessible, non-overflowing section navigation.
- Fixed an existing undeclared `loadingWorlds` guard that only failed when the Atlas was opened before the catalog finished loading.
- Separated page-level pane state from button `data-world-view` attributes, avoiding ambiguous selector matches.
- This changes navigation and presentation, **not** the world storage model. The external model cannot author or commit world canon through the editor.

## Verification

- Headless Chrome creates an Atlas location from the new main editor, verifies SQLite catalog persistence and refreshed UI, creates/deletes a world organization from the inline relationship editor, returns to Overview, and verifies Ctrl+K navigation opens that same inline Atlas.
- The existing UI coverage continues to exercise focused World Library, profiles, encounter deletion blockers, responsive navigation, world switching and independent browser tabs.
- `test/studio-experience.test.mjs` verifies editor routing and server allowlisting. The broader Node 22/24 suites cover SQLite foreign keys, sources/forks, event authority and memory/provenance constraints.

## Remaining UX work

World creation, timelines, and fictional clocks have now also moved into the main World workspace; see [World timelines & clocks](world-timelines-v6.md). Character authoring and memory/fidelity diagnostics still have complex dedicated editors. Continue extracting these incrementally under Issue #33 with browser and cross-world tests; do not rewrite their business logic just to simplify the surface.

No local Windows database is modified by this GitHub development pass. Updating the app serves the new editor while preserving existing world records.
