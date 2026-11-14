// World-local deletion rules. The SQLite connection is intentionally supplied
// by the active world store: an operation can never reach another world's DB.
// Do not delete a creator-approved world entity merely because its original
// character biography was removed; it has independent world-canon status.
export function reconcileCharacterRecords(db, state, worldId,{
  repairOrphans=false,removedCharacterId=null
}={}) {
  if (!db.isTransaction) throw new Error('Character reconciliation requires a transaction');
  if (!state || !Array.isArray(state.characters)) throw new Error('A valid world snapshot is required');
  const present = new Set(state.characters.map(x => x.id));
  const known = new Set([
    ...db.prepare('SELECT source_character_id AS id FROM world_entities WHERE world_id=? AND source_character_id IS NOT NULL').all(worldId).map(x=>x.id),
    ...db.prepare(`SELECT DISTINCT a.character_id AS id FROM timeline_actors a
      JOIN timelines t ON t.id=a.timeline_id WHERE t.world_id=? AND a.character_id IS NOT NULL`).all(worldId).map(x=>x.id),
    ...db.prepare('SELECT DISTINCT character_id AS id FROM character_world_sources WHERE world_id=?').all(worldId).map(x=>x.id),
    ...db.prepare('SELECT DISTINCT character_id AS id FROM character_world_relationship_sources WHERE world_id=?').all(worldId).map(x=>x.id),
    ...(removedCharacterId?[removedCharacterId]:[])
  ]);
  if(repairOrphans) {
    // Legacy builds sometimes deleted the world-person mirror and timeline
    // membership independently, leaving orphaned memories or accepted events.
    // Only do this historical sweep when opening a world, not on every save.
    const reserved=db.prepare(`SELECT 1 FROM timeline_actors
      WHERE actor_id=? AND controller IN ('player','system') LIMIT 1`);
    // Actor-owned dialogue, facts and authored NPC events have a clear source
    // identity. Locations and observed events alone do not: an otherwise
    // unprofiled system actor is allowed to hold a position/observe an event.
    for(const table of ['actor_memories','actor_facts','event_proposals',
      'timeline_events']){
      const rows=db.prepare(`SELECT DISTINCT actor_id AS id FROM ${table}
        WHERE timeline_id IN (SELECT id FROM timelines WHERE world_id=?)`).all(worldId);
      for(const row of rows){
        if(!row.id.startsWith('player:')&&!reserved.get(row.id))known.add(row.id);
      }
    }
  }
  let deleted=0;
  for (const id of known) {
    if (present.has(id)) continue; // Archive keeps its profile, knowledge and projection.
    deleted++;
    // Remove reviewed quotes and relationships' source attribution. These
    // can contain sensitive biography from a permanently deleted character.
    db.prepare('DELETE FROM character_world_relationship_sources WHERE world_id=? AND character_id=?').run(worldId,id);
    db.prepare('DELETE FROM character_world_sources WHERE world_id=? AND character_id=?').run(worldId,id);
    const projections=db.prepare('SELECT id FROM world_entities WHERE world_id=? AND source_character_id=?').all(worldId,id);
    for (const entity of projections) {
      removeEntityRelations(db,worldId,entity.id);
      db.prepare('DELETE FROM character_world_sources WHERE world_id=? AND entry_type=? AND entry_id=?').run(worldId,'entity',entity.id);
      db.prepare('DELETE FROM world_entities WHERE id=? AND world_id=?').run(entity.id,worldId);
    }
    // Derived memories (including fork-inherited copies), reviewed facts,
    // observations and actor positions must never resurrect a deleted actor.
    db.prepare('DELETE FROM timeline_event_observers WHERE actor_id=?').run(id);
    db.prepare(`DELETE FROM timeline_event_observers WHERE event_id IN
      (SELECT e.id FROM timeline_events e JOIN timelines t ON t.id=e.timeline_id
       WHERE t.world_id=? AND e.actor_id=?)`).run(worldId,id);
    db.prepare(`DELETE FROM timeline_events WHERE actor_id=? AND timeline_id IN
      (SELECT id FROM timelines WHERE world_id=?)`).run(id,worldId);
    db.prepare(`DELETE FROM event_proposals WHERE actor_id=? AND timeline_id IN
      (SELECT id FROM timelines WHERE world_id=?)`).run(id,worldId);
    db.prepare(`DELETE FROM actor_memories WHERE actor_id=? AND timeline_id IN
      (SELECT id FROM timelines WHERE world_id=?)`).run(id,worldId);
    db.prepare(`DELETE FROM actor_facts WHERE actor_id=? AND timeline_id IN
      (SELECT id FROM timelines WHERE world_id=?)`).run(id,worldId);
    db.prepare(`DELETE FROM timeline_positions WHERE actor_id=? AND timeline_id IN
      (SELECT id FROM timelines WHERE world_id=?)`).run(id,worldId);
    db.prepare(`DELETE FROM timeline_actors WHERE actor_id=? AND character_id=?
      AND timeline_id IN (SELECT id FROM timelines WHERE world_id=?)`).run(id,id,worldId);
  }
  return {removedCharacters:deleted};
}

export function purgeSceneSourceRecords(db,sceneId) {
  if(!db.isTransaction)throw new Error('Scene purge requires a transaction');
  if(typeof sceneId!=='string'||!sceneId)throw new Error('Scene ID required');
  db.prepare('DELETE FROM actor_memories WHERE scene_id=?').run(sceneId);
  db.prepare('DELETE FROM actor_facts WHERE scene_id=?').run(sceneId);
  // Accepted events are separately committed world canon and retain their
  // own timeline semantics. A full actor purge explicitly erases its events.
  db.prepare("DELETE FROM event_proposals WHERE scene_id=? AND status!='accepted'").run(sceneId);
}

export function reconcileRemovedSceneSources(db,state) {
  if(!db.isTransaction)throw new Error('Scene reconciliation requires a transaction');
  if(!state||!Array.isArray(state.sessions))throw new Error('A valid scene snapshot is required');
  const present=new Set(state.sessions.map(scene=>scene.id));
  const prior=new Set([
    ...db.prepare('SELECT DISTINCT scene_id FROM actor_memories').all().map(x=>x.scene_id),
    ...db.prepare('SELECT DISTINCT scene_id FROM actor_facts').all().map(x=>x.scene_id),
    ...db.prepare('SELECT DISTINCT scene_id FROM event_proposals').all().map(x=>x.scene_id)
  ]);
  let removed=0;
  for(const sceneId of prior){
    if(present.has(sceneId))continue;
    removed++;
    // Only forgotten sources are removed. Forks with a live descendant scene
    // are blocked from parent removal by purgeArchived. Accepted events are
    // still independently committed world canon, not dialogue memories.
    purgeSceneSourceRecords(db,sceneId);
  }
  return {removedScenes:removed};
}

function removeEntityRelations(db,worldId,entityId) {
  db.prepare(`DELETE FROM character_world_relationship_sources WHERE world_id=?
    AND (source_entry_id=? OR relationship_id IN
      (SELECT id FROM world_relationships WHERE world_id=? AND (from_id=? OR to_id=?)))`)
    .run(worldId,entityId,worldId,entityId,entityId);
  db.prepare('DELETE FROM world_relationships WHERE world_id=? AND (from_id=? OR to_id=?)')
    .run(worldId,entityId,entityId);
}

export function deleteWorldRecord(store,{worldId,kind,id}) {
  if(typeof worldId!=='string'||!worldId||typeof id!=='string'||!id||id.length>160 ||
    !['entity','relationship','location'].includes(kind)) throw new Error('Invalid world deletion request');
  if(store.scopeWorldId && store.scopeWorldId!==worldId ||
     store.activeWorldId && store.activeWorldId!==worldId)
    throw new Error('Wrong world');
  const db=store.db;
  // Every operation is scoped by the owning world even though world databases
  // already have separate storage.
  const table=kind==='entity'?'world_entities':kind==='location'?'world_locations':'world_relationships';
  db.exec('BEGIN IMMEDIATE');
  try {
    const record=db.prepare(`SELECT * FROM ${table} WHERE id=? AND world_id=?`).get(id,worldId);
    if(!record)throw new Error('World entry not found');
    if(kind==='entity') {
      if(record.source_character_id &&
        store.load().state?.characters?.some(x=>x.id===record.source_character_id)) {
        const copies=db.prepare(`SELECT count(*) AS n FROM world_entities
          WHERE world_id=? AND source_character_id=?`)
          .get(worldId,record.source_character_id).n;
        if(copies<2)
          throw new Error('This is the only world entity for a character profile. Archive and permanently delete the character first.');
        // An old legacy duplicate can be removed explicitly, with its own
        // relationship dependencies, while a valid mirror still remains.
      }
      removeEntityRelations(db,worldId,id);
      db.prepare("DELETE FROM character_world_sources WHERE world_id=? AND entry_type='entity' AND entry_id=?").run(worldId,id);
    }
    if(kind==='relationship')
      db.prepare('DELETE FROM character_world_relationship_sources WHERE world_id=? AND relationship_id=?').run(worldId,id);
    if(kind==='location') {
      const state=store.load().state;
      if(db.prepare('SELECT 1 FROM world_locations WHERE parent_id=? LIMIT 1').get(id))
        throw new Error('Remove child places first');
      if(db.prepare('SELECT 1 FROM timeline_positions WHERE location_id=? LIMIT 1').get(id) ||
        db.prepare('SELECT 1 FROM event_proposals WHERE location_id=? LIMIT 1').get(id) ||
        db.prepare('SELECT 1 FROM timeline_events WHERE location_id=? LIMIT 1').get(id))
        throw new Error('This place is referenced by a timeline position or world event; update those records first');
      if(state?.characters?.some(c=>c.homeLocationId===id||c.workLocationId===id||
        c.frequentPlaces?.some(x=>x.locationId===id)) ||
        state?.encounters?.some(e=>e.locationId===id) ||
        state?.sessions?.some(s=>s.locationId===id))
        throw new Error('This place is used by a character, scene or encounter; unlink it first');
      db.prepare('DELETE FROM location_connections WHERE world_id=? AND (from_id=? OR to_id=?)')
        .run(worldId,id,id);
      db.prepare("DELETE FROM character_world_sources WHERE world_id=? AND entry_type='location' AND entry_id=?")
        .run(worldId,id);
    }
    db.prepare(`DELETE FROM ${table} WHERE id=? AND world_id=?`).run(id,worldId);
    const remaining=db.prepare('PRAGMA foreign_key_check').all();
    if(remaining.length)throw new Error('World entry deletion would break a database reference');
    db.exec('COMMIT');
    return {deleted:true,worldId,kind,id};
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}
