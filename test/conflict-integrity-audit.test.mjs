import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {StudioStore} from '../storage.mjs';
import {WorldPartitionStore} from '../world/partition-store.mjs';
import {makeInitialState,makeEmptyWorldState,createCharacter} from '../engine.mjs';
import {archiveCharacter,archiveSession,purgeArchived} from '../harness.mjs';
import {addActorFact,listActorFacts} from '../memory/facts.mjs';
import {writeStoryProjection,enablePrimaryProjection} from '../storage/normalized.mjs';
import {createApp} from '../server.mjs';

const total=(db,table,field,id)=>db.prepare('SELECT count(*) AS n FROM '+table+' WHERE '+field+'=?').get(id).n;

test('reviewed source facts are copied into a fork after normalized-primary cutover',()=>{
  const store=new StudioStore(':memory:');
  try{
    const state=makeInitialState(),actor=state.characters[0],scene=state.sessions[0];
    scene.messages.push({id:'original-observation',role:'user',
      witnessIds:[actor.id],content:'The lighthouse keeps an old bronze key.'});
    store.save(state,0);
    const timeline=store.load().state.sessions[0].timelineId;
    const source=addActorFact(store,{sceneId:scene.id,actorId:actor.id,
      sourceMessageId:'original-observation',kind:'observation',text:'The lighthouse keeps a bronze key.'});
    const before=store.load();
    store.db.exec('BEGIN IMMEDIATE');
    try{
      writeStoryProjection(store.db,before.state,before.revision);
      enablePrimaryProjection(store.db,before);
      store.db.exec('COMMIT');
    }catch(error){if(store.db.isTransaction)store.db.exec('ROLLBACK');throw error;}
    const child=store.worlds.forkTimeline({timelineId:timeline,name:'Knowledge continuity'});
    const inherited=listActorFacts(store,{timelineId:child.id,actorId:actor.id});
    assert.equal(inherited.length,1,'fork must inherit this actor-owned reviewed fact');
    assert.equal(inherited[0].origin,'inherited');
    assert.equal(inherited[0].text,source.text);
    assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length,0);
  }finally{store.close();}
});

test('normal HTTP state PUT cannot silently purge a deleted character or scene',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'rp-conflict-audit-'));
  const store=new WorldPartitionStore(dataDir),worldId=store.activeWorldId;
  const scoped=store.forWorld(worldId);
  const actor=createCharacter('Must Confirm Removal'),state=makeEmptyWorldState();
  state.characters=[actor];
  const scene={...makeInitialState().sessions[0],id:'fresh-scene',characterId:actor.id,
    castIds:[actor.id],speakerId:actor.id,messages:[]};
  state.sessions=[scene];state.activeSessionId=scene.id;
  scoped.save(state,scoped.load().revision,{worldId});
  const app=createApp({store,fetchImpl:async()=>{throw Error('No inference')}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+app.address().port;
  try{
    const before=scoped.load(),modified=structuredClone(before.state);
    modified.sessions=[];modified.activeSessionId=null;
    const put=async(next,revision=before.revision)=>{
      const response=await fetch(base+'/api/state',{method:'PUT',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({worldId,revision,state:next})});
      return {status:response.status,body:await response.json()};
    };
    const removedScene=await put(modified);
    assert.notEqual(removedScene.status,200,'the generic save path must not be a scene purge');
    modified.characters=[];
    const removedCharacter=await put(modified);
    assert.notEqual(removedCharacter.status,200,'the generic save path must not be a character purge');
    assert.equal(scoped.load().revision,before.revision);
    assert.equal(scoped.load().state.characters[0].id,actor.id);
    assert.equal(scoped.load().state.sessions[0].id,scene.id);
    const archived=structuredClone(before.state);
    archiveSceneAndCharacter(archived,scene.id,actor.id);
    const ok=await put(archived);
    assert.equal(ok.status,200,JSON.stringify(ok.body));
    const archivedPayload=structuredClone(scoped.load().state);
    purgeArchived(archivedPayload,'scene',scene.id);
    const unauthorized=await put(archivedPayload,scoped.load().revision);
    assert.notEqual(unauthorized.status,200,'even archived records require the explicit purge route');
    assert.equal(scoped.load().state.sessions.length,1);
    const purgeResponse=await fetch(base+'/api/library/purge',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({
        worldId,revision:scoped.load().revision,kind:'scene',id:scene.id
      })});
    assert.equal(purgeResponse.status,200,await purgeResponse.clone().text());
    assert.equal(scoped.load().state.sessions.length,0);
    const charPurge=await fetch(base+'/api/library/purge',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({
        worldId,revision:scoped.load().revision,kind:'character',id:actor.id
      })});
    assert.equal(charPurge.status,200,await charPurge.clone().text());
    assert.equal(scoped.load().state.characters.length,0);
  }finally{
    await new Promise(resolve=>app.close(resolve));
    rmSync(dataDir,{recursive:true,force:true});
  }
});

function archiveSceneAndCharacter(state,sceneId,characterId){
  archiveSession(state,sceneId);
  archiveCharacter(state,characterId);
}

test('old orphan actor-owned memories and accepted events are removed even if mirror and actor membership were lost',()=>{
  const temp=mkdtempSync(join(tmpdir(),'rp-ghost-actor-audit-'));
  try{
    let store=new WorldPartitionStore(temp);
    const id=store.activeWorldId,scoped=store.forWorld(id),state=makeInitialState(),actor=state.characters[0];
    scoped.save(state,scoped.load().revision,{worldId:id});
    const timelineId=scoped.load().state.sessions[0].timelineId;
    const messageId=state.sessions[0].messages[0].id;
    const proposal=scoped.events.propose({sceneId:state.sessions[0].id,
      timelineId,sourceMessageId:messageId,description:'An old NPC signed a ledger.'});
    scoped.events.decide({proposalId:proposal.id,decision:'accept'});
    assert.equal(total(scoped.db,'timeline_events','actor_id',actor.id),1);
    assert.ok(total(scoped.db,'actor_memories','actor_id',actor.id)>0);
    const raw=JSON.parse(scoped.db.prepare('SELECT document FROM studio_state WHERE id=1').get().document);
    raw.characters=[];raw.sessions=[];raw.activeSessionId=null;
    // Simulate the incomplete rows left by old deletion/migration workflows.
    scoped.db.prepare('UPDATE studio_state SET document=? WHERE id=1').run(JSON.stringify(raw));
    scoped.db.prepare('DELETE FROM timeline_event_observers WHERE actor_id=?').run(actor.id);
    scoped.db.prepare('DELETE FROM timeline_actors WHERE actor_id=?').run(actor.id);
    const entityIds=scoped.db.prepare('SELECT id FROM world_entities WHERE source_character_id=?').all(actor.id);
    for(const entity of entityIds){
      scoped.db.prepare('DELETE FROM character_world_relationship_sources WHERE source_entry_id=?').run(entity.id);
      scoped.db.prepare('DELETE FROM world_relationships WHERE from_id=? OR to_id=?').run(entity.id,entity.id);
      scoped.db.prepare('DELETE FROM world_entities WHERE id=?').run(entity.id);
    }
    store.close();
    store=new WorldPartitionStore(temp);
    try{
      const fresh=store.forWorld(id);
      assert.equal(total(fresh.db,'actor_memories','actor_id',actor.id),0);
      assert.equal(total(fresh.db,'timeline_events','actor_id',actor.id),0);
      assert.equal(total(fresh.db,'event_proposals','actor_id',actor.id),0);
      assert.equal(fresh.db.prepare('PRAGMA foreign_key_check').all().length,0);
    }finally{store.close();}
  }finally{rmSync(temp,{recursive:true,force:true});}
});


test('world-open ghost reconciliation preserves system actor positions and event observations',()=>{
  const temp=mkdtempSync(join(tmpdir(),'rp-system-actor-audit-'));
  try {
    let store=new WorldPartitionStore(temp),id=store.activeWorldId,scoped=store.forWorld(id);
    scoped.save(makeInitialState(),scoped.load().revision,{worldId:id});
    const scene=scoped.load().state.sessions[0],timelineId=scene.timelineId;
    const source=scoped.events.propose({sceneId:scene.id,timelineId,
      sourceMessageId:scene.messages.at(-1).id,description:'The NPC greeted the visitor.'});
    scoped.events.decide({proposalId:source.id,decision:'accept'});
    const event=scoped.db.prepare('SELECT id FROM timeline_events WHERE actor_id=?')
      .get(scoped.load().state.characters[0].id);
    const location=scoped.worlds.createLocation({worldId:id,name:'Clock Observatory',kind:'building'});
    const system='system:world-clock';
    scoped.db.prepare(`INSERT INTO timeline_actors(timeline_id,actor_id,controller,character_id)
      VALUES(?,?,?,NULL)`).run(timelineId,system,'system');
    scoped.worlds.setActorLocation({timelineId,actorId:system,locationId:location.id});
    scoped.db.prepare('INSERT INTO timeline_event_observers(event_id,actor_id) VALUES (?,?)')
      .run(event.id,system);
    store.close();
    store=new WorldPartitionStore(temp);
    try{
      const reopened=store.forWorld(id);
      assert.equal(total(reopened.db,'timeline_positions','actor_id',system),1);
      assert.equal(total(reopened.db,'timeline_event_observers','actor_id',system),1);
      assert.equal(reopened.worlds.actors(timelineId).find(x=>x.actorId===system)?.controller,'system');
      assert.equal(reopened.db.prepare('PRAGMA foreign_key_check').all().length,0);
    }finally{store.close();}
  }finally{rmSync(temp,{recursive:true,force:true});}
});

test('damaged SQLite story refuses demo fallback and does not mutate the original revision',()=>{
  const store=new StudioStore(':memory:');
  try{
    store.save(makeInitialState(),0);
    const original=store.db.prepare('SELECT document,revision FROM studio_state WHERE id=1').get();
    for(const corrupt of [
      {characters:[],persona:{name:'Wrong'}},
      {characters:[{id:'invalid-person'}],sessions:[]},
      {characters:[],sessions:[{id:'broken-scene',characterId:'ghost',messages:[{role:'system',content:'Invisible'}]}]}
    ]){
      store.db.prepare('UPDATE studio_state SET document=? WHERE id=1')
        .run(JSON.stringify(corrupt));
      assert.throws(()=>store.load(),/Stored story/);
      assert.equal(store.db.prepare('SELECT revision FROM studio_state WHERE id=1').get().revision,original.revision);
    }
    store.db.prepare('UPDATE studio_state SET document=? WHERE id=1').run(original.document);
    assert.equal(store.load().state.characters[0].name,'Mara Vale');
  }finally{store.close();}
});


test('duplicate character, scene and per-scene message IDs fail atomically before contaminating memory',()=>{
  const store=new StudioStore(':memory:');
  try{
    store.save(makeInitialState(),0);
    const before=store.load(),source=before.state,baseCount=store.db.prepare(
      'SELECT count(*) AS n FROM actor_memories').get().n;
    const variants=[
      {kind:'character',build:()=>{
        const draft=structuredClone(source);
        draft.characters.push({...draft.characters[0]});
        return draft;
      }},
      {kind:'scene',build:()=>{
        const draft=structuredClone(source);
        draft.sessions.push(structuredClone(draft.sessions[0]));
        return draft;
      }},
      {kind:'message',build:()=>{
        const draft=structuredClone(source);
        draft.sessions[0].messages.push({...draft.sessions[0].messages[0]});
        return draft;
      }}
    ];
    for(const item of variants){
      assert.throws(()=>store.save(item.build(),before.revision),
        /Duplicate or invalid/,'legacy snapshots must reject duplicate '+item.kind+' IDs');
      assert.equal(store.load().revision,before.revision);
      assert.equal(store.db.prepare('SELECT count(*) AS n FROM actor_memories').get().n,baseCount);
    }
    const corrupt=structuredClone(source);
    corrupt.sessions[0].messages.push({...corrupt.sessions[0].messages[0]});
    store.db.prepare('UPDATE studio_state SET document=? WHERE id=1')
      .run(JSON.stringify(corrupt));
    assert.throws(()=>store.load(),/Duplicate or invalid message ID/);
  }finally{store.close();}
});

test('legacy direct HTTP story saves also refuse unconfirmed deletion',async()=>{
  const store=new StudioStore(':memory:');
  store.save(makeInitialState(),0);
  const app=createApp({store,fetchImpl:async()=>{throw Error('No inference')}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+app.address().port;
  try{
    const before=store.load(),state=structuredClone(before.state);
    state.sessions=[];state.activeSessionId=null;
    const res=await fetch(base+'/api/state',{method:'PUT',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({revision:before.revision,state})});
    assert.equal(res.status,409,await res.clone().text());
    assert.equal(store.load().revision,before.revision);
    assert.equal(store.load().state.sessions.length,1);
  }finally{await new Promise(resolve=>app.close(resolve));}
});
