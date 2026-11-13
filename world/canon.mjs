// World identity and player/NPC authority are independent of model responses.
import { createHash, randomUUID } from 'node:crypto';

export const LEGACY_WORLD_ID = 'imported-local-world';
export const LEGACY_CANON_ID = 'imported-local-world:canon:1';
const nameMax = 120;

export function cleanTitle(value, label = 'Name') {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > nameMax) {
    throw new TypeError(`${label} must contain 1–${nameMax} characters`);
  }
  return value.trim();
}

// Stable even on repeated migration and across Node restarts; avoid using untrusted
// or arbitrarily long old session IDs as SQLite foreign-key identifiers.
export function legacyTimelineId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('Session ID required');
  return `legacy-${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}`;
}

export function playerActorId(timelineId) {
  if (typeof timelineId !== 'string' || !timelineId) throw new TypeError('Timeline ID required');
  return `player:${timelineId}`;
}

export function newWorldRecord({ name, description = '' }) {
  if (typeof description !== 'string' || description.length > 4000) throw new TypeError('Invalid world description');
  const id = randomUUID();
  return {
    id, name: cleanTitle(name, 'World name'), description: description.trim(),
    createdAt: Date.now(),
    revision: { id: `${id}:canon:1`, version: 1, label: 'Original canon' },
  };
}

export function newTimelineRecord({ worldId, canonId, name, parentTimelineId = null }) {
  if (typeof worldId !== 'string' || !worldId || typeof canonId !== 'string' || !canonId) throw new TypeError('World revision required');
  return { id: randomUUID(), worldId, canonId, name: cleanTitle(name, 'Timeline name'), parentTimelineId, createdAt: Date.now() };
}

// No generated prose may ever authorize itself as player speech or world state.
// The future proposal/commit pipeline MUST call this at its commit boundary.
export function assertActorAuthority(actor, { controller, action }) {
  if (!actor || !['player', 'npc', 'system'].includes(actor.controller)) throw new Error('Unknown actor authority');
  if (controller !== actor.controller) throw new Error('Actor controller mismatch');
  const permitted = {
    player: new Set(['player-message', 'player-action']),
    npc: new Set(['npc-message', 'npc-action-proposal']),
    system: new Set(['world-event-commit']),
  };
  if (!permitted[controller].has(action)) throw new Error(`Controller ${controller} cannot perform ${action}`);
  return true;
}

export function bindTimelineIds(state) {
  for (const scene of state?.sessions || []) {
    if (!scene.timelineId) scene.timelineId = legacyTimelineId(scene.id);
  }
  return state;
}
