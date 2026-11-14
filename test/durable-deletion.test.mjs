import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorldPartitionStore} from '../world/partition-store.mjs';
import {makeEmptyWorldState,createCharacter,createSession} from '../engine.mjs';
import {archiveCharacter,archiveSession,purgeArchived} from '../harness.mjs';
import {createApp} from '../server.mjs';
import {inspectWorldStorage} from '../scripts/storage-health.mjs';

const fixture=()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-delete-'));
  const store=new WorldPartitionStore(dir),worldId=store.activeWorldId,scoped=store.forWorld(worldId);
  return {dir,store,worldId,scoped,close(){
    store.close();rmSync(dir,{recursive:true,force:true});
  }};
};
function save(scoped,worldId,state){
  const revision=scoped.load().revision;
  const result=scoped.save(state,revision,{worldId});
  assert.equal(result.revision,revision+1);
  return scoped.load();
}
const count=(db,table,where='',args=[])=>db.prepare(
  'SELECT count(*) AS n FROM '+table+(where?' WHERE '+where:'')
).get(...args).n;

test('archive preserves a person, but permanent purge removes projected entity and relationship rows',()=>{
  const f=fixture();
  try{
    const character=createCharacter('Obsolete Test Person'),state=makeEmptyWorldState();
    state.characters=[character];
    save(f.scoped,f.worldId,state);
    const entity=f.scoped.worlds.list().entities.find(x=>x.sourceCharacterId===character.id);
    assert.ok(entity);
    const other=f.scoped.worlds.createEntity({worldId:f.worldId,name:'Accepted independent person'});
    const relation=f.scoped.worlds.createRelationship({worldId:f.worldId,fromId:entity.id,toId:other.id,kind:'friend'});
    // Reviewed source records have no FK to the character snapshot.
    f.scoped.db.prepare(`INSERT INTO character_world_sources
      (world_id,character_id,entry_type,entry_id,source_field,source_quote,source_version,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(f.worldId,character.id,'entity',other.id,'backstory',
        'A carefully approved friend','profile-digest',100);
    f.scoped.db.prepare(`INSERT INTO character_world_relationship_sources
      (world_id,character_id,source_entry_id,relationship_id,source_field,source_quote,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(f.worldId,character.id,other.id,relation.id,'backstory',
        'A carefully approved friend',100);
    const archived=f.scoped.load().state;
    archiveCharacter(archived,character.id);
    save(f.scoped,f.worldId,archived);
    assert.ok(f.scoped.worlds.list().entities.some(x=>x.id===entity.id));
    const purge=f.scoped.load().state;
    purgeArchived(purge,'character',character.id);
    save(f.scoped,f.worldId,purge);
    const library=f.scoped.worlds.list();
    assert.ok(!library.entities.some(x=>x.id===entity.id));
    assert.ok(library.entities.some(x=>x.id===other.id),
      'independently authored world canon must not be deleted');
    assert.ok(!library.relationships.some(x=>x.id===relation.id));
    assert.equal(count(f.scoped.db,'character_world_sources','character_id=?',[character.id]),0);
    assert.equal(count(f.scoped.db,'character_world_relationship_sources','character_id=?',[character.id]),0);
    assert.equal(f.scoped.db.prepare('PRAGMA foreign_key_check').all().length,0);
    assert.equal(inspectWorldStorage(f.dir).ok,true);
  }finally{f.close();}
});

test('opening an existing world repairs old orphaned test characters and derived actor rows',()=>{
  const f=fixture(),{dir,worldId}=f;
  try{
    const actor=createCharacter('Old Test Ghost'),state=makeEmptyWorldState();
    const scene=createSession(actor);
    scene.messages.push({id:'ghost-source',role:'user',content:'An obsolete confidential conversation',
      witnessIds:[actor.id]});
    state.characters=[actor];state.sessions=[scene];state.activeSessionId=scene.id;
    save(f.scoped,worldId,state);
    const timeline=f.scoped.load().state.sessions[0].timelineId;
    const ghostEntity=f.scoped.worlds.list().entities.find(e=>e.sourceCharacterId===actor.id);
    assert.ok(count(f.scoped.db,'actor_memories','actor_id=?',[actor.id])>0);
    // Simulate the old bug: snapshot was purged, but identity/projection rows
    // were left in the world database by an older version.
    const raw=f.scoped.db.prepare('SELECT document FROM studio_state WHERE id=1').get();
    const doc=JSON.parse(raw.document);doc.characters=[];doc.sessions=[];doc.activeSessionId=null;
    f.scoped.db.prepare('UPDATE studio_state SET document=?').run(JSON.stringify(doc));
    f.store.close();
    const reopened=new WorldPartitionStore(dir);
    try {
      const scoped=reopened.forWorld(worldId),db=scoped.db;
      assert.equal(scoped.load().state.characters.length,0);
      assert.equal(count(db,'world_entities','source_character_id=?',[actor.id]),0);
      assert.equal(count(db,'timeline_actors','character_id=?',[actor.id]),0);
      assert.equal(count(db,'actor_memories','actor_id=?',[actor.id]),0);
      assert.equal(count(db,'actor_facts','actor_id=?',[actor.id]),0);
      assert.equal(count(db,'timeline_positions','actor_id=?',[actor.id]),0);
      assert.ok(!scoped.worlds.list().entities.some(e=>e.id===ghostEntity.id));
      assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
      assert.ok(db.prepare('SELECT id FROM timelines WHERE id=?').get(timeline),
        'world timeline must survive identity cleanup');
    }finally{reopened.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('reconciliation failure rolls back both story revision and actor-derived cleanup',()=>{
  const f=fixture();
  try{
    const actor=createCharacter('Trigger Test'),state=makeEmptyWorldState();
    state.characters=[actor];save(f.scoped,f.worldId,state);
    const original=f.scoped.load(),entity=f.scoped.worlds.list().entities.find(x=>x.sourceCharacterId===actor.id);
    f.scoped.db.exec(`CREATE TRIGGER block_actor_purge BEFORE DELETE ON world_entities
      BEGIN SELECT RAISE(ABORT,'simulated cleanup disk failure'); END;`);
    const modified=structuredClone(original.state);
    archiveCharacter(modified,actor.id);
    purgeArchived(modified,'character',actor.id);
    assert.throws(()=>f.scoped.save(modified,original.revision,{worldId:f.worldId}),
      /simulated cleanup disk failure/);
    assert.equal(f.scoped.load().revision,original.revision);
    assert.ok(f.scoped.load().state.characters.some(x=>x.id===actor.id));
    assert.ok(f.scoped.worlds.list().entities.some(x=>x.id===entity.id));
  }finally{f.close();}
});

test('manual canon entry deletion removes relation provenance but refuses still-referenced locations',()=>{
  const f=fixture();
  try{
    const a=f.scoped.worlds.createEntity({worldId:f.worldId,name:'Unused Entity'});
    const b=f.scoped.worlds.createEntity({worldId:f.worldId,name:'Independent Entity'});
    const rel=f.scoped.worlds.createRelationship({worldId:f.worldId,fromId:a.id,toId:b.id,kind:'neighbor'});
    const result=f.scoped.worlds.deleteEntry({worldId:f.worldId,kind:'entity',id:a.id});
    assert.equal(result.deleted,true);
    assert.equal(count(f.scoped.db,'world_entities','id=?',[a.id]),0);
    assert.equal(count(f.scoped.db,'world_relationships','id=?',[rel.id]),0);
    assert.equal(count(f.scoped.db,'world_entities','id=?',[b.id]),1);
    const loc=f.scoped.worlds.createLocation({worldId:f.worldId,name:'Source location'});
    const child=f.scoped.worlds.createLocation({worldId:f.worldId,name:'Nested location',parentId:loc.id});
    assert.throws(()=>f.scoped.worlds.deleteEntry({worldId:f.worldId,kind:'location',id:loc.id}),/child places/);
    f.scoped.worlds.deleteEntry({worldId:f.worldId,kind:'location',id:child.id});
    const actor=createCharacter('Resident'),state=makeEmptyWorldState();actor.homeLocationId=loc.id;
    state.characters=[actor];save(f.scoped,f.worldId,state);
    assert.throws(()=>f.scoped.worlds.deleteEntry({worldId:f.worldId,kind:'location',id:loc.id}),/character or encounter/);
    const saved=f.scoped.load();saved.state.characters[0].homeLocationId=null;
    save(f.scoped,f.worldId,saved.state);
    f.scoped.worlds.deleteEntry({worldId:f.worldId,kind:'location',id:loc.id});
    assert.equal(count(f.scoped.db,'world_locations','id=?',[loc.id]),0);
    assert.equal(f.scoped.db.prepare('PRAGMA foreign_key_check').all().length,0);
  }finally{f.close();}
});

test('synchronous HTTP purge enforces archives, rejects stale revisions and cleans world projections',async()=>{
  const f=fixture();
  const actor=createCharacter('HTTP Deleted'),state=makeEmptyWorldState();
  const scene=createSession(actor);
  scene.messages.push({id:'history',role:'assistant',content:'A quote',
    speakerId:actor.id,witnessIds:[actor.id]});
  state.characters=[actor];state.sessions=[scene];state.activeSessionId=scene.id;
  save(f.scoped,f.worldId,state);
  const archive=f.scoped.load().state;
  archiveCharacter(archive,actor.id);archiveSession(archive,scene.id);
  save(f.scoped,f.worldId,archive);
  const app=createApp({store:f.store,fetchImpl:async()=>{throw Error('No inference')}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+app.address().port;
  const post=async(body,path='/api/library/purge')=>{
    const response=await fetch(base+path,{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  try{
    const revision=f.scoped.load().revision;
    const required={worldId:f.worldId,revision};
    assert.equal((await post({...required,kind:'character',id:actor.id})).status,422);
    assert.equal((await post({...required,kind:'scene',id:scene.id})).status,200);
    assert.equal((await post({...required,kind:'character',id:actor.id})).status,409);
    const next=f.scoped.load().revision;
    const removed=await post({worldId:f.worldId,revision:next,kind:'character',id:actor.id});
    assert.equal(removed.status,200,JSON.stringify(removed.data));
    assert.ok(!removed.data.state.characters.some(x=>x.id===actor.id));
    assert.equal(count(f.scoped.db,'world_entities','source_character_id=?',[actor.id]),0);
    assert.equal(count(f.scoped.db,'actor_memories','actor_id=?',[actor.id]),0);
    assert.equal(count(f.scoped.db,'timeline_actors','actor_id=?',[actor.id]),0);
    const foreign=f.store.worlds.createWorld({name:'Other Universe'});
    assert.equal((await post({worldId:foreign.id,revision:next,kind:'character',id:actor.id})).status,409);
    assert.equal(f.scoped.db.prepare('PRAGMA foreign_key_check').all().length,0);
  }finally{
    await new Promise(resolve=>app.close(resolve));f.close();
  }
});
