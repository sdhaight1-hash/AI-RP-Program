# Studio navigation and encounter workflow (UX v4)

## The old deletion blocker

Previously, **encounter templates were hidden under World Library in the right-side Detail Desk**. Character removal correctly refused to delete any profile still referenced by an encounter, but the error gave no names, and the templates had no visible top-level management path.

The improved flow is explicit:

1. **Characters → Trash** (or Settings & tools → Library) displays archived profiles and scenes.
2. If a character is referenced by encounters, the Trash row names the **exact blocking templates** and has **Manage linked encounters**.
3. This opens the **Encounters** workspace with the relevant template selected. Delete it (or edit/reassign active participants). Existing played scenes retain their messages and starting notes; any deleted template link is cleared.
4. Use **Back to Trash**. Purge dependent scenes before finally permanently deleting the character.

Deleting a template is deliberate and undoable only from a prior backup. It does not destroy independently authored world canon. Existing historical scenes are not deleted automatically. Ordinary story saves cannot bypass the confirmed character/scene deletion workflow.

## New primary navigation

| Destination | What it owns | Main actions |
| --- | --- | --- |
| **World** | Independent universe, setting, maps, people, timelines | Open World Library / Atlas / Relationships |
| **Characters** | Stable people, biographies, voices, portraits, archive | Create or edit characters; open Trash; link to Encounters |
| **Encounters** | Reusable scene starters and communication modes | Create, edit, delete templates; start a scene |
| **Play** | Current scene, messages, cast, fictional time | Start, change medium, continue, retry and review replies |
| **Knowledge** | Actor memory, reviewed facts, world lore and event provenance | Inspect evidence and author lore |
| **Settings & tools** | Local models, image workflows, exports and Trash | Configure, evaluate, back up |

Desktop: the left navigation shows **Create your world** and **Play & manage** sections. The detail desk shows only a small context-relevant set of tools instead of thirteen unrelated tabs; the command palette (`Ctrl+K`) still links to every tool. Mobile: three readable columns in two rows keep all six destinations visible without horizontal scrolling.

**Character creation is no longer scene creation.** Creating a profile opens the character editor; clicking a character in the left roster edits that profile. A separate **▶ Start scene** action begins a new conversation. This prevents accidental extra playthroughs and duplicate test conversations.

## Communication media

All seven modes use one central `interactions/channels.mjs` registry; the new-scene dialog, encounter templates, live composer, persisted scenes, prompt instructions, actor voice and reply diagnostics derive from it.

| Medium | Perceived information | Who receives a new player turn |
| --- | --- | --- |
| In person | Speech, observed action, shared environment | Entire scene cast |
| Phone call | Speech and audible sounds only | Selected speaking actor |
| **Webcam / video call** | Speech, audio, explicitly camera-visible activity and shared media—not off-camera rooms | Scene cast |
| Text messages | Directly delivered text | Selected speaking actor |
| **Social media DM** | Private text and explicitly shared media | Selected speaking actor |
| **Social feed / thread** | Posts and explicitly shared media; not omniscient social activity | Scene cast, as explicitly witnessed |
| **Email** | Delivered written correspondence and explicitly shared media | Selected speaking actor |

Webcam and social media are **fictional communication modes inside the text roleplay simulation**. They do not activate a real camera, upload posts, access actual social accounts, or implement WebRTC/video transmission. Their primary purpose is to tell a local model exactly what the character can see, hear or read and how to write the reply. Privacy/witness visibility remains world- and timeline-scoped.

A template can define a multi-character cast, its medium, place association, premise and optional opening message. For remote media, the place association is background rather than proof everyone is physically together. Opening text is a scene utterance, **not** new world canon.

## Validation gates

- `test/encounter-channels.test.mjs`: all seven modes, camera-only observations, private DM vs thread witness rules, prompt and voice restrictions, template normalization, blocker names and transcript-safe template deletion.
- `test/studio-experience.test.mjs`: all six workspaces, relevant-only detail tabs, editor discoverability, responsive layout and server-allowlisted browser modules.
- `scripts/browser-smoke.mjs`: real Chrome navigation, create/start a social-media template, create a character **without** creating a scene, blocked character's Trash row → exact encounter → Delete → Back to Trash → permanent character purge, plus cross-world and mobile-width verification.
- Existing event, actor-memory, normalized-primary, storage-backup, multiworld and fork tests remain in the CI matrix.

**Known remaining interface limitations:** World Atlas, some timeline tools, knowledge editing and model setup still use focused Detail Desk panels. This pass removes a major hidden domain and reduces tab overload without unreviewed broad refactoring of the large `public/app.js`. Follow up through Issue #33 to extract remaining domain editors one at a time with browser tests.
