# Conical Universe visual reference galleries

A Conical Universe is a creator-authored continuity, including visual references that help readers and players experience the setting.

## Where photos are available

- **Universe identity editor:** add photos establishing the universe's appearance, mood, maps, architecture or other reference material
- **World Atlas:** add multiple images to any saved place; photos remain linked to its stable place ID if the name is revised
- **Relationship Codex:** add multiple photographs, symbolic imagery, artifacts or other references to cultures, families, communities, groups, organizations and person-identity mirrors
- **Live Story Room:** when a scene has a saved location ID (or an unambiguous matching location name), show up to four local setting photos. If no known location is assigned, universe-level photographs can appear as general visual context

Photos are distinct from written canon descriptions and source excerpts. The model does not receive photo bytes, captions as implicit world facts, or image analysis unless a separate, deliberately designed vision-capable workflow is added and the author reviews its proposed canon.

## Storage and ownership

Photo bytes and metadata are held in the **owning universe's SQLite database**, in `universe_entry_photos`. Each photo has a random ID, the original entry type and stable ID, a MIME type, a caption, and a timestamp. The catalog endpoint returns only metadata; the image stream is fetched separately and scoped by world ID.

The same per-universe SQLite snapshot or consistent SQLite backup preserves images and their links. **The story-only JSON export does not currently export photo bytes.** Use a complete application/world SQLite backup when preserving visual references. Future archive/export workflows should explicitly include media and verify completeness.

Deleting a photo removes its BLOB immediately. Permanent deletion of a location, group or universe also deletes its linked photo records through SQLite triggers, in the same transaction. Photo retrieval for another universe cannot read the owning SQLite database.

## Formats and upload considerations

PNG, JPEG and WebP are supported. Each photo is limited to 12 MB to avoid unbounded binary requests and SQLite memory spikes; this is a **photo-file size safety limit**, not the long-form prose restriction. Invalid MIME/signature combinations are rejected; SVG and remote web addresses are not accepted as uploads.

Images may contain personally identifying information or copyrighted content, so the creator should select files intentionally. Avoid uploading images containing sensitive details or information players should not see. The first implementation has one shared visible gallery per entry; private/spoiler visibility controls are a separate future feature.

## Integration and verification

- The full byte array is retrieved over a separate scoped endpoint; authors and players can enlarge images without loading all bytes in world metadata
- Image previews are lazy-loaded in gallery cards
- Photo captions are user-editable; deletion asks for explicit confirmation
- Node tests exercise supported/forged formats, upload/retrieve/delete, revisions, permanent canon deletion, cross-universe isolation, and persistence after restart
- Chrome browser tests exercise upload and the refreshed Atlas gallery, plus the presence of galleries for the universe and social entries

## Next refinements

Per-image sorting, cover-photo choice, responsive lightbox, alternative image descriptions, drag-and-drop uploads, spoiler/private visibility, scene-specific image selection, visual asset extraction from ComfyUI, and complete media-aware JSON/zip export are worthwhile future developments. They must reuse the existing world IDs and scope boundaries, not create another conflicting storage system.
