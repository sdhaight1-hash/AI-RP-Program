// Place names for one NPC's ordinary life, resolved only inside its world.
// These are habits, never an assertion of where the NPC currently is.
export function characterPlaceContext(character, worldLibrary, worldId) {
  if (!character || !worldLibrary || !worldId || worldLibrary.activeWorldId !== worldId ||
      (character.worldId && character.worldId !== worldId)) return '';
  const locations = new Map((worldLibrary.locations || [])
    .filter(loc => loc.worldId === worldId).map(loc => [loc.id, loc]));
  const notes = [];
  const add = (id, label, extra = '') => {
    const place = locations.get(id);
    if (place) notes.push(`${label}: ${place.name}${extra ? ` (${extra})` : ''}`);
  };
  add(character.homeLocationId, 'Usual home');
  add(character.workLocationId, 'Usual workplace');
  for (const item of (character.frequentPlaces || []).slice(0, 12)) {
    if (!item || typeof item.locationId !== 'string') continue;
    const extra = [item.role, item.frequency, item.reason].filter(x => typeof x === 'string' && x.trim()).join('; ').slice(0, 270);
    add(item.locationId, 'Regular destination', extra);
  }
  return notes.join('\n').slice(0, 1300);
}
