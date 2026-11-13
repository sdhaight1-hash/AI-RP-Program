import { randomUUID } from 'node:crypto';
import {
  LEGACY_WORLD_ID, LEGACY_CANON_ID, legacyTimelineId, playerActorId,
  newWorldRecord, newTimelineRecord, cleanTitle, assertActorAuthority,
} from './canon.mjs';

const now = () => Date.now();
const actorLookup = (db, timelineId, actorId) =>
  db.prepare('SELECT timeline_id AS timelineId, actor_id AS actorId, controller, character_id AS characterId FROM timeline_actors WHERE timeline_id = ? AND actor_id = ?').get(timelineId, actorId);

function registerActor(db, timelineId, actorId, controller, characterId = null) {
  if (controller === 'npc' && actorId.startsWith('player:')) throw new Error('NPC ID overlaps the reserved player namespace');
  const existing = actorLookup(db, timelineId, actorId);
  if (existing) {
    if (existing.controller !== controller || existing.characterId !== characterId) throw new Error('Conflicting actor authority');
    return;
  }
  db.prepare('INSERT INTO timeline_actors(timeline_id,actor_id,controller,character_id) VALUES (?,?,?,?)')
    .run(timelineId, actorId, controller, characterId);
}

function addLegacyWorld(db) {
  db.prepare(`INSERT OR IGNORE INTO worlds(id,name,description,created_at)
    VALUES (?,?,?,?)`).run(LEGACY_WORLD_ID, 'Imported local stories', 'Existing scenes imported as separate timelines', now());
  db.prepare(`INSERT OR IGNORE INTO world_revisions(id,world_id,version,label,created_at)
    VALUES (?,?,?,?,?)`).run(LEGACY_CANON_ID, LEGACY_WORLD_ID, 1, 'Imported original canon', now());
}

// Called INSIDE the same SQLite transaction as the original story save.
// New scenes without an explicit timeline receive isolated imported timelines.
export function synchronizeSceneTimelines(db, state) {
  const scenes = state?.sessions || [];
  if (!scenes.length) return;
  if (scenes.some(scene => !scene.timelineId || scene.timelineId === legacyTimelineId(scene.id))) addLegacyWorld(db);
  const validCharacters = new Set((state.characters || []).map(c => c.id));
  for (const scene of scenes) {
    const defaultId = legacyTimelineId(scene.id);
    const timelineId = scene.timelineId || defaultId;
    const timeline = db.prepare('SELECT id,world_id AS worldId FROM timelines WHERE id=?').get(timelineId);
    if (!timeline) {
      if (timelineId !== defaultId) throw new Error('Unknown timeline; create it in World Library first');
      db.prepare(`INSERT INTO timelines(id,world_id,canon_id,name,parent_timeline_id,created_at)
        VALUES (?,?,?,?,NULL,?)`).run(timelineId, LEGACY_WORLD_ID, LEGACY_CANON_ID, String(scene.title || 'Imported scene').slice(0,120), now());
    }
    registerActor(db, timelineId, playerActorId(timelineId), 'player');
    const actorIds = new Set([scene.characterId, ...(scene.castIds || [])]);
    for (const actorId of actorIds) {
      if (typeof actorId === 'string' && validCharacters.has(actorId)) registerActor(db, timelineId, actorId, 'npc', actorId);
    }
    scene.timelineId = timelineId;
  }
}

export function initializeWorldSchema(db, state) {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worlds (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS world_revisions (
      id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id), version INTEGER NOT NULL,
      label TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(world_id,version)
    );
    CREATE TABLE IF NOT EXISTS timelines (
      id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id),
      canon_id TEXT NOT NULL REFERENCES world_revisions(id), name TEXT NOT NULL,
      parent_timeline_id TEXT REFERENCES timelines(id), created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS timelines_world_idx ON timelines(world_id);
    CREATE TABLE IF NOT EXISTS timeline_actors (
      timeline_id TEXT NOT NULL REFERENCES timelines(id), actor_id TEXT NOT NULL,
      controller TEXT NOT NULL CHECK(controller IN ('player','npc','system')),
      character_id TEXT, PRIMARY KEY(timeline_id,actor_id)
    );`);
    synchronizeSceneTimelines(db,state);
    db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (?,?)').run(1,now());
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

export class WorldRepository {
  constructor(db) { this.db = db; }

  list() {
    const worlds = this.db.prepare('SELECT id,name,description,created_at AS createdAt FROM worlds ORDER BY created_at,id').all();
    const revisions = this.db.prepare('SELECT id,world_id AS worldId,version,label,created_at AS createdAt FROM world_revisions ORDER BY world_id,version').all();
    const timelines = this.db.prepare('SELECT id,world_id AS worldId,canon_id AS canonId,name,parent_timeline_id AS parentTimelineId,created_at AS createdAt FROM timelines ORDER BY created_at,id').all();
    return { worlds, revisions, timelines };
  }

  createWorld(input) {
    const record = newWorldRecord(input);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO worlds(id,name,description,created_at) VALUES (?,?,?,?)')
        .run(record.id,record.name,record.description,record.createdAt);
      this.db.prepare('INSERT INTO world_revisions(id,world_id,version,label,created_at) VALUES (?,?,?,?,?)')
        .run(record.revision.id,record.id,1,record.revision.label,record.createdAt);
      this.db.exec('COMMIT');
      return { ...record, revision: { ...record.revision, worldId: record.id } };
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  createTimeline({ worldId, name, parentTimelineId = null }) {
    if (typeof worldId !== 'string') throw new TypeError('World required');
    const canon = this.db.prepare('SELECT id FROM world_revisions WHERE world_id=? ORDER BY version DESC LIMIT 1').get(worldId);
    if (!canon) throw new Error('World does not exist');
    if (parentTimelineId !== null) {
      const parent = this.db.prepare('SELECT world_id AS worldId FROM timelines WHERE id=?').get(parentTimelineId);
      if (!parent || parent.worldId !== worldId) throw new Error('Parent timeline belongs to another world');
    }
    const record = newTimelineRecord({ worldId, canonId: canon.id, name, parentTimelineId });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO timelines(id,world_id,canon_id,name,parent_timeline_id,created_at)
        VALUES (?,?,?,?,?,?)`).run(record.id,record.worldId,record.canonId,record.name,record.parentTimelineId,record.createdAt);
      registerActor(this.db,record.id,playerActorId(record.id),'player');
      this.db.exec('COMMIT');
      return record;
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  actors(timelineId) {
    if (typeof timelineId !== 'string') throw new TypeError('Timeline required');
    return this.db.prepare('SELECT actor_id AS actorId,controller,character_id AS characterId FROM timeline_actors WHERE timeline_id=? ORDER BY controller,actor_id').all(timelineId);
  }

  authorize(timelineId, actorId, controller, action) {
    const actor = actorLookup(this.db,timelineId,actorId);
    return assertActorAuthority(actor,{controller,action});
  }
}
