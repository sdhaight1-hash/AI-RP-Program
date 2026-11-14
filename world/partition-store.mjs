// One durable SQLite database per fictional world. The registry contains only
// world labels and selection state: no lore, character data or story history.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readdirSync, renameSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { StudioStore } from '../storage.mjs';
import { legacyTimelineId, LEGACY_WORLD_ID, LEGACY_CANON_ID } from './canon.mjs';
import { makeEmptyWorldState } from '../engine.mjs';

const now = () => Date.now();
const worldIdPattern = /^(?:[0-9a-f]{8}-[0-9a-f-]{27,40}|imported-local-world)$/i;
const sqlLiteral = path => `'${path.replaceAll("'", "''")}'`;
const catalogRows = db => db.prepare('SELECT id,name,description,created_at AS createdAt FROM world_catalog ORDER BY created_at,id').all();

function partitionState(state, meta, worldId) {
  const timelineIds = new Set(meta.timelines.filter(t => t.worldId === worldId).map(t => t.id));
  const scenes = (state.sessions || []).filter(s => timelineIds.has(s.timelineId || legacyTimelineId(s.id)));
  const used = new Set();
  for (const scene of scenes) {
    used.add(scene.characterId);
    for (const id of scene.castIds || []) used.add(id);
    for (const msg of scene.messages || []) {
      if (msg.speakerId) used.add(msg.speakerId);
      for (const id of msg.witnessIds || []) used.add(id);
    }
  }
  for (const entity of meta.entities.filter(e => e.worldId === worldId)) if (entity.sourceCharacterId) used.add(entity.sourceCharacterId);
  if (worldId === LEGACY_WORLD_ID) {
    const referenced = new Set();
    for (const scene of state.sessions || []) {
      referenced.add(scene.characterId);
      for (const id of scene.castIds || []) referenced.add(id);
    }
    for (const entity of meta.entities) if (entity.sourceCharacterId) referenced.add(entity.sourceCharacterId);
    for (const c of state.characters || []) if (!referenced.has(c.id)) used.add(c.id);
  }
  const lore = (state.lore || []).filter(entry => {
    if (entry.sessionIds?.length) return entry.sessionIds.some(id => scenes.some(s => s.id === id));
    // Unscoped legacy lore has no proven world owner. Quarantine in imported world.
    return worldId === LEGACY_WORLD_ID;
  }).map(entry => ({...entry, sessionIds: entry.sessionIds?.filter(id => scenes.some(s => s.id === id))}));
  return {
    ...state,
    characters: (state.characters || []).filter(c => used.has(c.id)).map(c => ({...c,worldId})),
    sessions: scenes,
    encounters:(state.encounters||[]).filter(e=>e.characterIds?.some(id=>used.has(id))).map(e=>({...e,characterIds:e.characterIds.filter(id=>used.has(id))})),
    lore,
    activeSessionId: scenes.some(s => s.id === state.activeSessionId) ? state.activeSessionId : (scenes.find(s => !s.trashedAt)?.id || null),
  };
}

function pruneDatabase(db, worldId, state, priorRevision) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    const keep = 'SELECT id FROM timelines WHERE world_id = ?';
    const scope = `(${keep})`;
    // Dialogue memories are timeline-scoped derived rows: partition before
    // removing their owning timelines, and let FTS triggers prune the index.
    db.prepare('DELETE FROM actor_memories WHERE timeline_id NOT IN '+scope).run(worldId);
    db.prepare('DELETE FROM actor_facts WHERE timeline_id NOT IN '+scope).run(worldId);
    for (const table of ['timeline_event_observers'])
      db.prepare(`DELETE FROM ${table} WHERE event_id NOT IN (SELECT id FROM timeline_events WHERE timeline_id IN ${scope})`).run(worldId);
    for (const table of ['timeline_events', 'event_proposals']) db.prepare(`DELETE FROM ${table} WHERE timeline_id NOT IN ${scope}`).run(worldId);
    for (const table of ['timeline_fork_snapshots', 'timeline_positions', 'timeline_clocks', 'timeline_actors'])
      db.prepare(`DELETE FROM ${table} WHERE timeline_id NOT IN ${scope}`).run(worldId);
    db.prepare('DELETE FROM timelines WHERE world_id != ?').run(worldId);
    db.prepare('DELETE FROM character_world_relationship_sources WHERE world_id != ?').run(worldId);
    db.prepare('DELETE FROM character_world_sources WHERE world_id != ?').run(worldId);
    db.prepare('DELETE FROM world_relationships WHERE world_id != ?').run(worldId);
    db.prepare('DELETE FROM world_entities WHERE world_id != ?').run(worldId);
    db.prepare('DELETE FROM location_connections WHERE world_id != ?').run(worldId);
    db.prepare('DELETE FROM world_locations WHERE world_id != ?').run(worldId);
    db.prepare('DELETE FROM world_revisions WHERE world_id != ?').run(worldId);
    db.prepare('DELETE FROM worlds WHERE id != ?').run(worldId);
    if(worldId === LEGACY_WORLD_ID && !db.prepare('SELECT id FROM worlds WHERE id=?').get(worldId)) {
      db.prepare('INSERT INTO worlds(id,name,description,created_at) VALUES (?,?,?,?)').run(worldId,'Imported unassigned content','Legacy records without a proven world assignment',now());
      db.prepare('INSERT INTO world_revisions(id,world_id,version,label,created_at) VALUES (?,?,?,?,?)').run(LEGACY_CANON_ID,worldId,1,'Imported original canon',now());
    }
    db.prepare(`INSERT INTO studio_state(id,revision,updated_at,document) VALUES (1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,document=excluded.document`)
      .run(Math.max(1,priorRevision),now(),JSON.stringify(state));
    db.prepare('DELETE FROM lore_fts').run();
    const insert=db.prepare('INSERT INTO lore_fts(id,title,body,keywords) VALUES (?,?,?,?)');
    for (const entry of state.lore) insert.run(entry.id,String(entry.title||''),String(entry.content||''),(entry.keywords||[]).join(' '));
    db.exec('COMMIT');
  } catch(error) {db.exec('ROLLBACK');throw error;}
  db.exec('PRAGMA foreign_keys = ON');
  const problems=db.prepare('PRAGMA foreign_key_check').all();
  if(problems.length)throw new Error(`World partition has ${problems.length} invalid references`);
}

export class WorldPartitionStore {
  constructor(dataDir = join(process.cwd(), '.data')) {
    this.dataDir = dataDir;
    mkdirSync(join(dataDir,'worlds'),{recursive:true});
    this.registry = new DatabaseSync(join(dataDir,'registry.sqlite'));
    this.registry.exec(`CREATE TABLE IF NOT EXISTS world_catalog (
      id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,created_at INTEGER NOT NULL
    ); CREATE TABLE IF NOT EXISTS registry_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)`);
    if (!catalogRows(this.registry).length) {
      if (existsSync(join(dataDir,'studio.sqlite'))) this.migrateLegacy();
      else this.createWorld({name:'My First World',description:'An empty fictional world'});
    }
    const selected = this.registry.prepare("SELECT value FROM registry_settings WHERE key='active_world'").get()?.value;
    this.activateWorld(catalogRows(this.registry).some(w=>w.id===selected) ? selected : catalogRows(this.registry)[0].id);
    // Compatibility with the existing HTTP world API; only the active world
    // exposes details such as people, locations, timelines and relationships.
    this.worlds = {
      list: () => ({...this.current.worlds.list(),worlds:catalogRows(this.registry),activeWorldId:this.activeWorldId}),
      createWorld: input => this.createWorld(input),
      createTimeline: input => {this.assertWorld(input.worldId);return this.current.worlds.createTimeline(input);},
      forkTimeline: input => this.current.worlds.forkTimeline(input),
      createLocation: input => {this.assertWorld(input.worldId);return this.current.worlds.createLocation(input);},
      connectLocations: input => {this.assertWorld(input.worldId);return this.current.worlds.connectLocations(input);},
      createEntity: input => {
        this.assertWorld(input.worldId);
        if(input.sourceCharacterId && !this.current.load().state?.characters?.some(c=>c.id===input.sourceCharacterId))throw new Error('Linked character is not in this world');
        return this.current.worlds.createEntity(input);
      },
      createRelationship: input => {this.assertWorld(input.worldId);return this.current.worlds.createRelationship(input);},
      setClock: input => this.current.worlds.setClock(input),
      setActorLocation: input => this.current.worlds.setActorLocation(input),
      actors: timelineId => this.current.worlds.actors(timelineId),
      actorLocations: timelineId => this.current.worlds.actorLocations(timelineId),
      authorize: (...args) => this.current.worlds.authorize(...args),
    };
  }

  worldFile(id) {
    if (typeof id !== 'string' || !worldIdPattern.test(id) || id.includes('..')) throw new Error('Invalid world ID');
    return join(this.dataDir,'worlds',id,'world.sqlite');
  }
  assertWorld(worldId) {
    if (worldId !== this.activeWorldId) throw new Error('Open that world before editing it');
  }
  assetDir(category) {
    if (!['portraits','locations','maps','generated-images'].includes(category)) throw new Error('Unknown asset category');
    return join(dirname(this.worldFile(this.activeWorldId)),category);
  }
  get events() {return this.current.events;}
  get db() {return this.current.db;}
  load() {return {...this.current.load(),worldId:this.activeWorldId};}
  searchLore(query, options = {}) {
    this.assertWorld(options.worldId);
    return this.current.searchLore(query, options);
  }
  save(state,revision,{worldId}={}) {
    if (worldId !== this.activeWorldId) throw new Error('World changed; this save belongs to another world');
    const scoped=structuredClone(state);
    const locations=new Set(this.current.worlds.list().locations.map(x=>x.id));
    for(const c of scoped.characters||[]){
      if(typeof c.name !== 'string' || !c.name.trim() || c.name.length > 100) throw new Error('Character name must contain 1–100 characters');
      if(c.worldId && c.worldId !== worldId)throw new Error('Character belongs to another world; import as an independent copy instead');
      c.worldId=worldId;
      for(const key of ['homeLocationId','workLocationId'])if(c[key] && !locations.has(c[key]))throw new Error(`${key} is not a location in this world`);
      for(const place of c.frequentPlaces||[])if(!locations.has(place.locationId))throw new Error('Frequent place is not a location in this world');
    }
    // A world-local snapshot must not accept foreign actors in scene transcripts,
    // witness lists, or encounter participants. Normalization alone can silently
    // drop invalid cast IDs; reject the malformed save before that happens.
    const characterIds = new Set((scoped.characters || []).map(c => c.id));
    for (const scene of scoped.sessions || []) {
      if (!characterIds.has(scene.characterId) || (scene.castIds || []).some(id => !characterIds.has(id)))
        throw new Error('Scene references a character outside this world');
      for (const message of scene.messages || []) {
        if (message.role === 'assistant' && !characterIds.has(message.speakerId || scene.characterId))
          throw new Error('NPC reply references a character outside this world');
        if ((message.witnessIds || []).some(id => !characterIds.has(id)))
          throw new Error('Message witness is not a character in this world');
      }
    }
    for(const encounter of scoped.encounters||[]) {
      if(encounter.locationId && !locations.has(encounter.locationId))throw new Error('Encounter location is not in this world');
      if((encounter.characterIds||[]).some(id => !characterIds.has(id)))throw new Error('Encounter references a character outside this world');
    }
    return this.current.save(scoped, revision, {
      beforeCommit: validated => this.ensureCharacterEntities(validated.characters),
    });
  }
  ensureCharacterEntities(characters = this.current.load().state?.characters || []) {
    // One lookup for the cast rather than a query per character on every
    // debounced save/streamed reply. Stable character IDs remain authoritative.
    const knownByCharacter = new Map(this.current.db.prepare(`SELECT id,name,source_character_id AS characterId
      FROM world_entities WHERE world_id=? AND source_character_id IS NOT NULL`).all(this.activeWorldId)
      .map(entity => [entity.characterId, entity]));
    const update=this.current.db.prepare('UPDATE world_entities SET name=? WHERE id=?');
    for(const character of characters) {
      const known=knownByCharacter.get(character.id);
      if(known) {if(known.name!==character.name)update.run(character.name,known.id);}
      else this.current.worlds.createEntity({worldId:this.activeWorldId,name:character.name,kind:'character',sourceCharacterId:character.id});
    }
  }
  activateWorld(id) {
    if (!catalogRows(this.registry).some(w=>w.id===id)) throw new Error('World not found');
    if (this.activeWorldId === id && this.current) return this.load();
    const next=new StudioStore(this.worldFile(id),{scopeWorldId:id});
    if (this.current) this.current.close();
    this.current=next;
    this.activeWorldId=id;
    this.registry.prepare("INSERT INTO registry_settings(key,value) VALUES('active_world',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(id);
    this.ensureCharacterEntities();
    return this.load();
  }
  createWorld(input) {
    const tempDir=join(this.dataDir,'worlds',`.new-${randomUUID()}`);
    mkdirSync(tempDir,{recursive:true});
    const temporary=new StudioStore(join(tempDir,'world.sqlite'));
    let record;
    try {
      record=temporary.worlds.createWorld(input);
      temporary.save(makeEmptyWorldState(),0);
    } catch(error) {temporary.close();rmSync(tempDir,{recursive:true,force:true});throw error;}
    temporary.close();
    const finalDir=dirname(this.worldFile(record.id));
    let moved=false;
    try {
      renameSync(tempDir,finalDir);
      moved=true;
      this.registry.prepare('INSERT INTO world_catalog(id,name,description,created_at) VALUES (?,?,?,?)')
        .run(record.id,record.name,record.description,record.createdAt);
      return record;
    } catch (error) {
      // Registry failure must not leave a seemingly valid but unlisted world.
      rmSync(moved ? finalDir : tempDir,{recursive:true,force:true});
      throw error;
    }
  }

  migrateLegacy() {
    const source=new StudioStore(join(this.dataDir,'studio.sqlite'));
    try {
      const meta=source.worlds.list();
      const existing=source.load();
      const state=existing.state || makeEmptyWorldState();
      const worlds=meta.worlds.length ? [...meta.worlds] : [{id:LEGACY_WORLD_ID,name:'Imported local stories',description:'Existing scenes',createdAt:now()}];
      const referenced=new Set();
      for(const scene of state.sessions || []){referenced.add(scene.characterId);for(const id of scene.castIds||[])referenced.add(id);}
      for(const entity of meta.entities||[])if(entity.sourceCharacterId)referenced.add(entity.sourceCharacterId);
      const hasOrphans=(state.characters||[]).some(c=>!referenced.has(c.id)) || (state.lore||[]).some(l=>!l.sessionIds?.length);
      if(hasOrphans && !worlds.some(w=>w.id===LEGACY_WORLD_ID))worlds.push({id:LEGACY_WORLD_ID,name:'Imported unassigned content',description:'Legacy records requiring an explicit world assignment',createdAt:now()});
      const staged=[];
      for(const world of worlds) {
        const file=this.worldFile(world.id);
        if(existsSync(file)) throw new Error('World migration found existing destination; refusing to overwrite it');
        mkdirSync(dirname(file),{recursive:true});
        const tempFile=`${file}.migrating`;
        if(existsSync(tempFile))throw new Error('Incomplete previous migration; inspect the preserved files before retrying');
        source.db.exec(`VACUUM INTO ${sqlLiteral(tempFile)}`);
        const db=new DatabaseSync(tempFile);
        try {pruneDatabase(db,world.id,partitionState(state,meta,world.id),existing.revision);}
        finally {db.close();}
        staged.push({world,file,tempFile});
      }
      for(const {world,file,tempFile} of staged) {
        renameSync(tempFile,file);
        const scoped=partitionState(state,meta,world.id);
        for(const char of scoped.characters) {
          const name=typeof char.portrait==='string' ? basename(char.portrait) : '';
          if(!/^[0-9a-f-]{36}\.(?:webp|jpg)$/i.test(name))continue;
          const origin=join(this.dataDir,'portraits',name);
          if(existsSync(origin)) {mkdirSync(join(dirname(file),'portraits'),{recursive:true});copyFileSync(origin,join(dirname(file),'portraits',name));}
        }
      }
      this.registry.exec('BEGIN IMMEDIATE');
      try {
        const insert=this.registry.prepare('INSERT INTO world_catalog(id,name,description,created_at) VALUES (?,?,?,?)');
        for(const {world} of staged)insert.run(world.id,world.name,world.description,world.createdAt);
        const activeTimeline=meta.timelines.find(t=>state.sessions.some(s=>s.id===state.activeSessionId && s.timelineId===t.id));
        const active=activeTimeline?.worldId || worlds[0].id;
        this.registry.prepare("INSERT INTO registry_settings(key,value) VALUES('active_world',?)").run(active);
        this.registry.exec('COMMIT');
      }catch(error){this.registry.exec('ROLLBACK');throw error;}
    }finally{source.close();}
  }
  close() {this.current?.close();this.registry.close();}
}
