// Pre-deletion impact inventory. This module performs NO destructive operation.
// Reports are advisory snapshots; future deletion must revalidate under a lock.
export function previewWorldDeletion(store,{worldId,timelineId=null}={}) {
  if(typeof worldId!=='string'||!worldId||worldId.length>160)
    throw new Error('A scoped world ID is required');
  if(store?.activeWorldId!==worldId||!store?.db||!store?.worlds?.list)
    throw new Error('Open the requested world before inspecting deletion impact');
  if(timelineId!==null&&(typeof timelineId!=='string'||!timelineId||timelineId.length>160))
    throw new Error('Invalid timeline ID');
  const catalog=store.worlds.list();
  const world=catalog.worlds.find(w=>w.id===worldId);
  if(!world)throw new Error('World not found');
  const allTimelines=catalog.timelines.filter(t=>t.worldId===worldId);
  if(timelineId&&!allTimelines.some(t=>t.id===timelineId))
    throw new Error('Timeline does not belong to this world');

  const timelineIds=timelineId?[timelineId]:allTimelines.map(t=>t.id);
  const ids=new Set(timelineIds);
  const descendants=timelineId?allTimelines.filter(t=>{
    let parent=t.parentTimelineId;
    const visited=new Set([t.id]);
    while(parent&&!visited.has(parent)){
      if(parent===timelineId)return true;
      visited.add(parent);
      parent=allTimelines.find(candidate=>candidate.id===parent)?.parentTimelineId;
    }
    return false;
  }):[];
  const snapshot=store.load();
  const sessions=snapshot.state.sessions.filter(s=>ids.has(s.timelineId));
  const allCharacters=snapshot.state.characters;
  const referenced=new Set();
  for(const s of sessions){
    referenced.add(s.characterId);
    for(const id of s.castIds||[])referenced.add(id);
    for(const m of s.messages||[]){
      if(m.speakerId)referenced.add(m.speakerId);
      for(const id of m.witnessIds||[])referenced.add(id);
    }
  }
  const affectedCharacters=timelineId
    ?allCharacters.filter(c=>referenced.has(c.id))
    :allCharacters;
  const db=store.db;
  // All table identifiers here are hardcoded, never accepted from callers.
  const countTimelineRows=table=>{
    const query='SELECT count(*) AS n FROM '+table+
      ' WHERE timeline_id IN (SELECT id FROM timelines WHERE world_id=?'+
      (timelineId?' AND id=?':'')+')';
    return db.prepare(query).get(...(timelineId?[worldId,timelineId]:[worldId])).n;
  };
  const countWorldRows=table=>db.prepare('SELECT count(*) AS n FROM '+table+
    ' WHERE world_id=?').get(worldId).n;
  const countObservers=()=>{
    const query='SELECT count(*) AS n FROM timeline_event_observers WHERE event_id IN '+
      '(SELECT id FROM timeline_events WHERE timeline_id IN '+
      '(SELECT id FROM timelines WHERE world_id=?'+(timelineId?' AND id=?':'')+'))';
    return db.prepare(query).get(...(timelineId?[worldId,timelineId]:[worldId])).n;
  };
  const records={
    scenes:sessions.length,
    messages:sessions.reduce((n,s)=>n+(s.messages||[]).length,0),
    actorMemories:countTimelineRows('actor_memories'),
    actorFacts:countTimelineRows('actor_facts'),
    timelineEvents:countTimelineRows('timeline_events'),
    eventProposals:countTimelineRows('event_proposals'),
    eventObservers:countObservers(),
    timelineActors:countTimelineRows('timeline_actors'),
    positions:countTimelineRows('timeline_positions'),
    forkSnapshots:countTimelineRows('timeline_fork_snapshots'),
    ...(timelineId?{}:{
      locations:countWorldRows('world_locations'),
      entities:countWorldRows('world_entities'),
      relationships:countWorldRows('world_relationships'),
      sourceQuotes:countWorldRows('character_world_sources'),
      relationshipSources:countWorldRows('character_world_relationship_sources')
    })
  };
  const locations=timelineId?[]:catalog.locations.filter(p=>p.worldId===worldId).map(p=>p.id);
  const entities=timelineId?[]:catalog.entities.filter(p=>p.worldId===worldId).map(p=>p.id);
  const relationships=timelineId?[]:catalog.relationships.filter(p=>p.worldId===worldId).map(p=>p.id);
  const portraits=timelineId?[]:[...new Set(allCharacters.map(c=>c.portrait).filter(p=>
    typeof p==='string'&&p.startsWith('/portraits/')))];
  return {
    mode:timelineId?'timeline':'world',worldId,worldName:world.name,
    timelineId,revision:snapshot.revision,
    timelineIds,sceneIds:sessions.map(s=>s.id),
    characterIds:affectedCharacters.map(c=>c.id),
    characterDisposition:timelineId?'referenced-only (profiles not owned by timeline)':'world-owned',
    locationIds:locations,entityIds:entities,relationshipIds:relationships,
    descendantTimelineIds:descendants.map(t=>t.id),
    records,portraitReferences:portraits,
    // Reference count is not a media garbage-collection guarantee.
    unindexedMediaMayExist:true,
    backupVerified:false,destructiveOperationEnabled:false,
    blockers: [
      ...(descendants.length?['Child fork timelines must be resolved first']:[]),
      'No verified offline backup was supplied',
      'Crash-safe tombstone and cross-tab deletion protocol are not implemented',
      'Physical media reference audit is incomplete'
    ]
  };
}
