import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeInitialState } from '../engine.mjs';
import { WorldPartitionStore } from '../world/partition-store.mjs';
import { characterDraftVersion,worldDraftVersion } from '../character/authoring.mjs';
import { commitCharacterWorldEntry } from '../character/world-bridge.mjs';
import { approveCharacterWorldRelationship,proposedRelationshipKinds } from '../character/relationship-bridge.mjs';
import { createApp } from '../server.mjs';
import { buildActorContext } from '../context/assemble.mjs';

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'rp-reviewed-relationships-'));
  const store=new WorldPartitionStore(directory),worldId=store.activeWorldId;
  const state=makeInitialState(),actor=state.characters[0];
  actor.name='Mara';
  actor.familyHistory='Her aunt Nessa ran the Lantern House near Seabrook.';
  store.save(state,store.load().revision,{worldId});
  const actorId=actor.id;
  const basis=()=>{const current=store.load(),character=current.state.characters.find(c=>c.id===actorId);
    return {worldId,characterId:actorId,revision:current.revision,
      profileVersion:characterDraftVersion(character),
      worldVersion:worldDraftVersion(store.worlds.list())};
  };
  const entry=commitCharacterWorldEntry(store,{approval:'approve',...basis(),entry:{
    type:'entity',kind:'character',name:'Nessa',description:'Mara’s aunt',
    sourceField:'familyHistory',sourceQuote:'Her aunt Nessa ran the Lantern House near Seabrook.'
  }});
  const close=()=>{store.close();rmSync(directory,{recursive:true,force:true});};
  return {store,directory,worldId,actorId,entry,basis,close};
}
test('approved person relationship is directed, source-linked and changes no timeline position',()=>{
  const f=fixture();
  try {
    const entryId=f.entry.entry.id;
    assert.deepEqual(proposedRelationshipKinds('Her aunt Nessa worked with a mentor.'),['aunt','mentor']);
    const before=f.store.worlds.list().positions;
    const input={approval:'approve',...f.basis(),entryId,kind:'aunt'};
    assert.throws(()=>approveCharacterWorldRelationship(f.store,{...input,approval:'draft'}),/Explicit/);
    assert.throws(()=>approveCharacterWorldRelationship(f.store,{...input,kind:'friend'}),/explicit in the approved source/);
    const result=approveCharacterWorldRelationship(f.store,input);
    assert.equal(result.relationship.kind,'aunt');
    const library=f.store.worlds.list();
    const mara=library.entities.find(e=>e.sourceCharacterId===f.actorId);
    assert.equal(result.relationship.fromId,entryId);
    assert.equal(result.relationship.toId,mara.id);
    assert.deepEqual(library.positions,before);
    assert.match(result.relationship.notes,/familyHistory.*Her aunt Nessa/);
    assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM character_world_relationship_sources').get().count,1);
    assert.throws(()=>approveCharacterWorldRelationship(f.store,{...input,worldVersion:worldDraftVersion(library)}),/already established/);
  }finally{f.close();}
});
test('rejected relationship transactions roll back graph and source evidence together',()=>{
  const f=fixture();
  try {
    f.store.db.exec(`CREATE TRIGGER stop_character_relation BEFORE INSERT ON character_world_relationship_sources
      BEGIN SELECT RAISE(ABORT,'blocked audited relation'); END;`);
    assert.throws(()=>approveCharacterWorldRelationship(f.store,{approval:'approve',...f.basis(),
      entryId:f.entry.entry.id,kind:'aunt'}),/blocked audited relation/);
    assert.equal(f.store.worlds.list().relationships.length,0);
    assert.equal(f.store.db.prepare('SELECT count(*) AS total FROM character_world_relationship_sources').get().total,0);
  }finally{f.close();}
});
test('character edit and foreign-world reference cannot authorize relationship',()=>{
  const f=fixture();
  try{
    const input={approval:'approve',...f.basis(),entryId:f.entry.entry.id,kind:'aunt'};
    assert.throws(()=>approveCharacterWorldRelationship(f.store,{...input,worldId:'foreign'}),/Wrong world/);
    const next=f.store.load();
    next.state.characters.find(c=>c.id===f.actorId).familyHistory='Her work life was private.';
    f.store.save(next.state,next.revision,{worldId:f.worldId});
    assert.throws(()=>approveCharacterWorldRelationship(f.store,input),/changed/);
    const newer={...input,...f.basis()};
    assert.throws(()=>approveCharacterWorldRelationship(f.store,newer),/edited after approval/);
    assert.equal(f.store.worlds.list().relationships.length,0);
  }finally{f.close();}
});
test('relationship API persists directed graph and provenance across world switches',async()=>{
  const f=fixture();
  const app=createApp({store:f.store,fetchImpl:async()=>{throw Error('No model requests')}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+app.address().port;
  const post=(path,data)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  try{
    const input={approval:'approve',...f.basis(),entryId:f.entry.entry.id,kind:'aunt'};
    const first=await post('/api/character/world-relationships/approve',input);
    assert.equal(first.status,201,JSON.stringify(await first.clone().json()));
    const linked=await first.json();
    assert.equal(linked.sourceName,'Nessa');
    assert.equal(linked.characterName,'Mara');
    const sources=await(await fetch(base+'/api/character/world-entries/sources?worldId='+
      encodeURIComponent(f.worldId)+'&characterId='+encodeURIComponent(f.actorId))).json();
    assert.equal(sources.sources.find(x=>x.entryId===f.entry.entry.id).relationshipId,linked.relationship.id);
    const other=f.store.worlds.createWorld({name:'Separate world'});
    await post('/api/worlds/activate',{worldId:other.id});
    const denied=await post('/api/character/world-relationships/approve',input);
    assert.equal(denied.status,409);
    assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM character_world_relationship_sources').get().count,0);
    await post('/api/worlds/activate',{worldId:f.worldId});
    assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM character_world_relationship_sources').get().count,1);
  }finally{
    await new Promise(resolve=>app.close(resolve));
    rmSync(f.directory,{recursive:true,force:true});
  }
});

test('reviewed family relationships inform their own actor but unreviewed incoming feelings stay private',()=>{
  const f=fixture();
  try {
    const scene=f.store.load().state.sessions[0];
    const context=()=>buildActorContext({store:f.store,worldId:f.worldId,
      sceneId:scene.id,actorId:f.actorId,contextWindow:4096,maxOutput:400})
      .messages[0].content;
    assert.doesNotMatch(context(),/Known social ties: Nessa: aunt/);
    approveCharacterWorldRelationship(f.store,{approval:'approve',...f.basis(),
      entryId:f.entry.entry.id,kind:'aunt'});
    assert.match(context(),/Known social ties: Nessa: aunt/);
    const target=f.store.worlds.list().entities.find(e=>e.sourceCharacterId===f.actorId);
    const stranger=f.store.worlds.createEntity({worldId:f.worldId,
      name:'Unreviewed Admirer',kind:'character'});
    f.store.worlds.createRelationship({worldId:f.worldId,fromId:stranger.id,
      toId:target.id,kind:'admires'});
    assert.doesNotMatch(context(),/Unreviewed Admirer/,
      'another person\'s unreviewed incoming feelings are not actor knowledge');
  }finally{f.close();}
});
