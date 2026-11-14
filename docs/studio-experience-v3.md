# Studio Experience v3 — Worlds, Characters, Story, Memory, Tools

## Why this redesign

The old interface was a three-column conversation app with thirteen unrelated horizontally scrolling inspector tabs. As the underlying program expanded into independently isolated worlds, authoring workflows, timeline governance, actor-owned memory, and local-model testing, the navigation no longer represented the architecture or users' tasks.

The v3 interface establishes a deliberately small number of **task-centered workspaces** without inventing a second state store or rewriting mature editing flows:

| Workspace | Primary purpose | Main editor routes |
| --- | --- | --- |
| World & canon | Establish the independent universe, locations, named entities, relationships, forks and timeline clock | World Library, Atlas, Relations |
| Characters | Build stable people in context, audit profile completeness, connect typical places and approved relationships | Character Studio, Cast, Emotion |
| Story room | Interact through in-person, phone and text channels; review model drafts and direct scenes | Scene, Journal, active conversation |
| Memory & review | Keep actor-owned evidence distinct from world fact; inspect provenance and narrative continuity | Recall trace, personal memory notebook, Lore, Scene event review |
| Models & lab | Configure inference, evaluate fidelity/semantic recall, manage art and backups | Local Setup, Fidelity Lab, Visuals, Library |

The conversation remains a persistent **Story room**, not a disabled/chat-forgotten feature. Other workspaces expose live world/cast counts, relevant descriptions, source boundaries and buttons to the existing editors.

## Interaction conventions

- **Persistent left navigation** gives five predictable destinations, a world selector, recent scenes and cast.
- **Selected world's identity** stays visible in a global breadcrumb; switching worlds remains a hard data boundary.
- **Detail desk** groups the existing 13 tools by World, People, Story and System instead of hiding them in a lateral scroll.
- **Focused editors** automatically open from workspace cards and command search in a wide panel, rather than forcing Atlas, Relations or complex memory review into a 338px inspector. The underlying forms, event handlers and persistence API remain the same.
- **Ctrl+K / Cmd+K quick navigation** searches workspaces, world editors, character authoring, memory review, and local model tools. Enter opens the highlighted result, arrows change selection, and Escape closes the palette.
- **Character Studio** retains distinct left-side field sections, editable center content, and the contextual AI writing partner on the right. It now shows completed field coverage and the selected world's linked places/relations.
- **World chooser** filters by setting/name and shows per-world timeline counts. No world switch auto-imports another world's fiction.
- **Creator approval remains explicit** for character profile drafts, named world additions, kinships, timeline events and personal actor memories.

## Responsive / accessibility

At 1100px and below, the detail desk becomes a dismissible overlay with a backdrop. At 760px and below, the left rail condenses into a horizontal workspace switcher and scene composer gains the space. At narrow phone widths, the layout preserves its own vertical scroll regions rather than extending the entire page horizontally.

Navigation uses real buttons, focus-visible outlines, pressed/selected states, semantic sections, a progressbar for authoring field coverage, keyboard controls and reduced-motion CSS. No CDN, icon font, external framework or new npm runtime dependency is required. Existing color-theme tokens (including a light parchment theme) are preserved by an additional stylesheet, `public/studio-shell.css`. The original `style.css` remains the base component compatibility layer; the new file owns the experience shell.

The WebGL stage remains atmospheric decoration, **not** a world simulation renderer.

## Testing and evidence

- `npm test` checks unique/static DOM targets, all five workspace routes, existing 13 editor tabs, new focused editor controls, command search, responsive CSS, and successful serving of the new stylesheet and JS.
- `npm run test:browser` is a standalone, optional **ChromeDriver** test. It runs real Chromium/Chrome navigation, desktop World and Story, a focused World editor, Ctrl+K jump, Character Workshop, and 900px/720px/390px layout checks.
- On GitHub-hosted Node 22 CI, headless screenshots are preserved in the workflow artifact named `ui-review-screenshots` for desktop world, story, focused editor, Character Studio and mobile. These are for visual review; passing a viewport overflow test alone does not guarantee perfect typography.
- Node 22 and 24 continue to run the entire existing unit/integration suite and the deterministic memory quality benchmark.

### Manual acceptance checklist

1. Switch worlds using the world chooser, return to the same world, and verify other-world character names never appear.
2. From Characters, open a profile, edit its origin and preferred environment, and confirm the co-author prompts still cite established world entities.
3. Approve a source-backed person in Character → World, then approve an explicit relationship and inspect its direction/provenance in Relations.
4. Start a scene, switch interaction media, continue/retry a draft, and check that the model request still uses the selected actor's allowed context.
5. Inspect recalled evidence and personal memory notebook in a focused desk; verify the source IDs and revocation controls remain available.
6. Run Fidelity Lab and export the synthetic real-model test report.
7. Check desktop, laptop, narrow and touch layouts, plus the light parchment theme.

## Known limitations

This is a front-end workflow redesign, **not** a claim that the program is a full world simulator or autonomous multi-agent society. Neither GitHub CI nor the assistant can directly evaluate how the UI feels on your Windows desktop or the response quality of your loaded local model. Browser smoke and screenshots reduce regression risk, but subjective visual review and live model testing are still useful.
