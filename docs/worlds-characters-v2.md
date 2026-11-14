# World Architecture & Character Studio 2.0 — implementation notes

## Invariants

- **World is the outermost fictional boundary.** The registry lists worlds but never owns their canon, characters, memories, scenes or lore.
- A world has an independent SQLite database, assets directory, entity graph and all its timelines. API writes include/resolve the active world. Saving a stale cross-world state fails.
- **Player control and NPC control remain separate.** Character identity is durable world canon. Location, memories, and psychological state evolve in the selected timeline.
- A character's home, workplace, preferred environments and regular destinations represent familiarity and habit. They do **not** represent current physical location or cause automatic teleportation.
- Acting prompts must never treat a world encounter greeting/scenario as a permanent NPC characteristic. Encounter templates are optional and can be reused independently.
- AI co-author output is a *proposal*, not a canon mutation. Proposals are limited to requested fields and checked against the character/world/lore versions at acceptance.

## Storage layout

```text
.data/
  registry.sqlite                      # world catalog + active ID only
  studio.sqlite                        # preserved pre-v2 legacy database, if any
  worlds/<world-id>/world.sqlite       # isolated world + timelines + story data
  worlds/<world-id>/portraits/         # world-local character portraits
```

Internal world `studio_state` still stores a JSON snapshot **per world**, alongside normalized world/location/actor/event tables. This is an incremental migration; further normalization can follow independently. SQLite's `VACUUM INTO` creates consistent partitions from the legacy database. The original is deliberately not deleted. Repeated boots should not reimport it. Back up the entire `.data/` directory before upgrading.

Unassigned legacy content is quarantined in a separate imported world. Explicitly assigned scene/timeline data is distributed to the corresponding world. Original archives, messages and event provenance are retained. Cross-world sharing is not automatic.

## Character and encounter schema

A durable character has world membership, identity and appearance, behavior/values/psychology, history, social habits, occupation, voice variants, and everyday environment preferences. `homeLocationId`, `workLocationId`, and `frequentPlaces[]` refer to authored **same-world** locations. The present whereabouts remain in timeline positions.

`encounters[]` belongs to a world state and has participating character IDs, optional location, channel, premise and optional opening. Historical `scenario`, `greeting`, `alternateGreetings` properties migrate into an encounter attached to the original character, not into a permanent scene prompt. New scenes can also be unscripted.

## AI authoring / acting separation

Authoring: world, relevant people/places/direct relationships and approved lore, character draft and targeted guidance → reviewed field suggestions. No automatic rewriting unrelated fields.

Acting: only the selected NPC's stable identity, resolved familiar places in its own world, actor-specific memories/lore, the current channel and witnessed scene → NPC reply. Location habits cannot override a timeline's current location.

## Verification targets

1. Existing global stories and lore migrate without loss or cross-world sharing.
2. Scene branching, world clocks, locations and accepted event sources remain isolated.
3. Foreign-world character, home, destination or old browser-state writes fail.
4. World-switching changes the entire visible cast/scene/lore context and cancels provisional AI drafts.
5. Character details can be authored, linked to actual locations, and used as **habits** without asserting current position.
6. AI suggestions contain no foreign-world facts and cannot update unrelated or changed fields.
7. Legacy greetings survive as optional encounters without leaking into every later NPC reply.
8. World assets and portrait responses cannot be reused across world contexts through an HTTP cache.

## Scope deferred

Deep off-screen autonomous simulation, schedules, location movement reducers, full multimedia social applications, general cross-world content import, multiplayer/security sandboxing, encrypted backups and model training are not provided by this migration.
