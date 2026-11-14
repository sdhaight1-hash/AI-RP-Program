# Context-aware, field-compartmentalized Character Studio AI co-author

Each durable Character Studio field has an explicit **purpose**, **related established references**, and **boundary** in `character/field-contracts.mjs`. These contracts apply to individual field suggestions and the four-field missing-details workflow; no separate generator is required.

## Generation contract

- **Overall identity remains present:** the prompt includes an abbreviated snapshot of the character's established fields and the world/places/relationship reference.
- **Relevant details get more space:** for each target, the authoring module expands its declared dependencies. A phone voice suggestion gets the established speech/personality/behavior rather than a generic life history; family history or backstory receives the corresponding context.
- **Compartmentalization:** model output is instructed to fill only the requested field(s). Personality is not a second backstory; routines are not exact current positions; text/phone/in-person voices have different perceptual affordances; example dialogue is not a committed event.
- **Whole-person consistency:** already authored motivations, values, physical characteristics and life circumstances remain protected reference. Missing facts are not automatically asserted as canonical: drafts remain proposals until creator review.
- **World grounding:** linked residence/work/frequent places are identified as customary associations, never present timeline whereabouts. Foreign-world locations are filtered. Existing creator-visible lore does not automatically become NPC knowledge.
- **Scope security:** only requested string keys can be applied; the world, lore and character profile fingerprints must still match at approval time. The name remains manual to avoid unintended identity/relationship breakage. The library tagline is now available for focused AI assistance.

The UI exposes each selected field's purpose and boundary and reports how many established fields supplied context. A user can continue editing any source field by hand and regenerate the draft; stale proposals are rejected.

## Testing

`npm test` covers all contract keys against `CHARACTER_V2_FIELDS`, the required objective/exclusion definition, relevant context, one-target output, selected keys only, full four-field generation, refusal of cross-world material, and regeneration after established facts change.

Limits: instructions are *constraints* for a local model, not a deterministic semantic validator for the generated prose. The acceptance screen lets the creator edit and select individual proposed values. Do not automatically accept generated character details or promote character drafts to world history.

## Next practical quality evaluations

Prepare fixed partial profiles with deliberately overlapping attributes, then measure whether local models differentiate stress, comfort, conflicts, history, and media-specific voice. Evaluate contradictions against filled fields and against the selected world's setting; report independently for each target field.
