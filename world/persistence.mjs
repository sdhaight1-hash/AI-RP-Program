import { randomUUID } from 'node:crypto';
import {
  LEGACY_WORLD_ID, LEGACY_CANON_ID, legacyTimelineId, playerActorId,
  newWorldRecord, newTimelineRecord, cleanTitle, assertActorAuthority,
} from './canon.mjs';
import { bounded, worldZone, worldInstant, LOCATION_KINDS, ENTITY_KINDS } from './geography.mjs';

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
    db.prepare('INSERT OR IGNORE INTO timeline_clocks(timeline_id,instant_ms,time_zone) VALUES (?,?,?)').run(timelineId,now(),'UTC');
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
    );
    CREATE TABLE IF NOT EXISTS world_locations (
      id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id),
      parent_id TEXT REFERENCES world_locations(id), name TEXT NOT NULL,
      kind TEXT NOT NULL, description TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS world_locations_parent_idx ON world_locations(world_id,parent_id);
    CREATE TABLE IF NOT EXISTS location_connections (
      id TEXT PRIMARY KEY,world_id TEXT NOT NULL REFERENCES worlds(id),
      from_id TEXT NOT NULL REFERENCES world_locations(id),to_id TEXT NOT NULL REFERENCES world_locations(id),
      kind TEXT NOT NULL, travel_minutes INTEGER NOT NULL DEFAULT 0,
      UNIQUE(world_id,from_id,to_id,kind)
    );
    CREATE TABLE IF NOT EXISTS world_entities (
      id TEXT PRIMARY KEY,world_id TEXT NOT NULL REFERENCES worlds(id),
      name TEXT NOT NULL,kind TEXT NOT NULL,source_character_id TEXT,created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS world_relationships (
      id TEXT PRIMARY KEY,world_id TEXT NOT NULL REFERENCES worlds(id),
      from_id TEXT NOT NULL REFERENCES world_entities(id), to_id TEXT NOT NULL REFERENCES world_entities(id),
      kind TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS timeline_clocks (
      timeline_id TEXT PRIMARY KEY REFERENCES timelines(id), instant_ms INTEGER NOT NULL,time_zone TEXT NOT NULL, is_explicit INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS timeline_positions (
      timeline_id TEXT NOT NULL REFERENCES timelines(id),actor_id TEXT NOT NULL,
      location_id TEXT NOT NULL REFERENCES world_locations(id),updated_at INTEGER NOT NULL,
      PRIMARY KEY(timeline_id,actor_id),
      FOREIGN KEY(timeline_id,actor_id) REFERENCES timeline_actors(timeline_id,actor_id)
    );`);
    synchronizeSceneTimelines(db,state);
    db.prepare('INSERT OR IGNORE INTO timeline_clocks(timeline_id,instant_ms,time_zone) SELECT id, ?, ? FROM timelines').run(now(),'UTC');
    for(const version of [1,2])db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (?,?)').run(version,now());
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

export class WorldRepository {
  constructor(db) { this.db = db; }

  list() {
    const worlds = this.db.prepare('SELECT id,name,description,created_at AS createdAt FROM worlds ORDER BY created_at,id').all();
    const revisions = this.db.prepare('SELECT id,world_id AS worldId,version,label,created_at AS createdAt FROM world_revisions ORDER BY world_id,version').all();
    const timelines = this.db.prepare('SELECT id,world_id AS worldId,canon_id AS canonId,name,parent_timeline_id AS parentTimelineId,created_at AS createdAt FROM timelines ORDER BY created_at,id').all();
    const locations=this.db.prepare('SELECT id,world_id AS worldId,parent_id AS parentId,name,kind,description FROM world_locations ORDER BY name').all();
    const entities=this.db.prepare('SELECT id,world_id AS worldId,name,kind,source_character_id AS sourceCharacterId FROM world_entities ORDER BY name').all();
    const relationships=this.db.prepare('SELECT id,world_id AS worldId,from_id AS fromId,to_id AS toId,kind,notes FROM world_relationships ORDER BY created_at').all();
    const clocks=this.db.prepare('SELECT timeline_id AS timelineId,instant_ms AS instantMs,time_zone AS timeZone,is_explicit AS isExplicit FROM timeline_clocks').all();
    const connections=this.db.prepare('SELECT id,world_id AS worldId,from_id AS fromId,to_id AS toId,kind,travel_minutes AS travelMinutes FROM location_connections').all();
    return { worlds, revisions, timelines, locations, entities, relationships, connections, clocks };
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
      this.db.prepare('INSERT INTO timeline_clocks(timeline_id,instant_ms,time_zone) VALUES (?,?,?)').run(record.id,now(),'UTC');
      this.db.exec('COMMIT');
      return record;
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  createLocation({worldId,name,parentId=null,kind='other',description=''}) {
    if(!LOCATION_KINDS.includes(kind))throw new TypeError('Invalid location kind');
    const title=cleanTitle(name,'Location name');const detail=bounded(description,'description',4000);
    const world=this.db.prepare('SELECT id FROM worlds WHERE id=?').get(worldId);
    if(!world)throw new Error('World does not exist');
    if(parentId !== null) {
      const parent=this.db.prepare('SELECT world_id AS worldId FROM world_locations WHERE id=?').get(parentId);
      if(!parent||parent.worldId!==worldId)throw new Error('Location parent belongs to another world');
    }
    const value={id:randomUUID(),worldId,parentId,kind,name:title,description:detail};
    this.db.prepare('INSERT INTO world_locations(id,world_id,parent_id,name,kind,description,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(value.id,worldId,parentId,title,kind,detail,now());
    return value;
  }

  connectLocations({worldId,fromId,toId,kind='walk',travelMinutes=0}) {
    if(fromId===toId)throw new Error('Location cannot connect to itself');
    if(typeof kind!=='string'||!kind.trim()||kind.length>70||!Number.isInteger(travelMinutes)||travelMinutes<0||travelMinutes>100000)throw new TypeError('Invalid location connection');
    for(const id of [fromId,toId]) {
      const loc=this.db.prepare('SELECT world_id AS worldId FROM world_locations WHERE id=?').get(id);
      if(!loc||loc.worldId!==worldId)throw new Error('Locations must belong to the same world');
    }
    const value={id:randomUUID(),worldId,fromId,toId,kind:kind.trim(),travelMinutes};
    this.db.prepare('INSERT INTO location_connections(id,world_id,from_id,to_id,kind,travel_minutes) VALUES (?,?,?,?,?,?)')
      .run(value.id,worldId,fromId,toId,value.kind,travelMinutes);
    return value;
  }

  createEntity({worldId,name,kind='character',sourceCharacterId=null}) {
    if(!ENTITY_KINDS.includes(kind))throw new TypeError('Invalid entity kind');
    if(sourceCharacterId!==null&&(typeof sourceCharacterId!=='string'||sourceCharacterId.length>160))throw new TypeError('Invalid character reference');
    if(!this.db.prepare('SELECT id FROM worlds WHERE id=?').get(worldId))throw new Error('World does not exist');
    const value={id:randomUUID(),worldId,name:cleanTitle(name,'Entity name'),kind,sourceCharacterId};
    this.db.prepare('INSERT INTO world_entities(id,world_id,name,kind,source_character_id,created_at) VALUES (?,?,?,?,?,?)')
      .run(value.id,worldId,value.name,kind,sourceCharacterId,now());
    return value;
  }

  createRelationship({worldId,fromId,toId,kind='acquaintance',notes=''}) {
    if(fromId===toId)throw new Error('Relationship cannot reference itself');
    if(typeof kind!=='string'||!kind.trim()||kind.length>70)throw new TypeError('Invalid relationship kind');
    const comment=bounded(notes,'relationship notes',2000);
    for(const id of [fromId,toId]) {
      const entity=this.db.prepare('SELECT world_id AS worldId FROM world_entities WHERE id=?').get(id);
      if(!entity||entity.worldId!==worldId)throw new Error('Relationship entities must belong to the same world');
    }
    const value={id:randomUUID(),worldId,fromId,toId,kind:kind.trim(),notes:comment};
    this.db.prepare('INSERT INTO world_relationships(id,world_id,from_id,to_id,kind,notes,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(value.id,worldId,fromId,toId,value.kind,comment,now());
    return value;
  }

  setClock({timelineId,instant,timeZone='UTC'}) {
    if(!this.db.prepare('SELECT id FROM timelines WHERE id=?').get(timelineId))throw new Error('Timeline does not exist');
    const ms=worldInstant(instant),zone=worldZone(timeZone);
    this.db.prepare('INSERT INTO timeline_clocks(timeline_id,instant_ms,time_zone,is_explicit) VALUES (?,?,?,1) ON CONFLICT(timeline_id) DO UPDATE SET instant_ms=excluded.instant_ms,time_zone=excluded.time_zone,is_explicit=1')
      .run(timelineId,ms,zone);
    return {timelineId,instantMs:ms,timeZone:zone};
  }

  setActorLocation({timelineId,actorId,locationId}) {
    const timeline=this.db.prepare('SELECT world_id AS worldId FROM timelines WHERE id=?').get(timelineId);
    if(!timeline)throw new Error('Timeline does not exist');
    if(!actorLookup(this.db,timelineId,actorId))throw new Error('Actor is not in this timeline');
    const place=this.db.prepare('SELECT world_id AS worldId FROM world_locations WHERE id=?').get(locationId);
    if(!place||place.worldId!==timeline.worldId)throw new Error('Actor cannot move into a different world');
    this.db.prepare('INSERT INTO timeline_positions(timeline_id,actor_id,location_id,updated_at) VALUES (?,?,?,?) ON CONFLICT(timeline_id,actor_id) DO UPDATE SET location_id=excluded.location_id,updated_at=excluded.updated_at')
      .run(timelineId,actorId,locationId,now());
    return {timelineId,actorId,locationId};
  }

  actorLocations(timelineId) {
    return this.db.prepare('SELECT actor_id AS actorId,location_id AS locationId FROM timeline_positions WHERE timeline_id=?').all(timelineId);
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
