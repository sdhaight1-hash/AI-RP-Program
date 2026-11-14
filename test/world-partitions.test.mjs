import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StudioStore } from '../storage.mjs';
import { WorldPartitionStore } from '../world/partition-store.mjs';
import { createCharacter, createSession, makeEmptyWorldState } from '../engine.mjs';

const withTemp = async fn => { const dir=mkdtempSync(join(tmpdir(),'ai-rp-isolated-'));try{await fn(dir);}finally{rmSync(dir,{recursive:true,force:true});}};

test('worlds store independent state, lore, timeline clocks and assets across restarts', async () => withTemp(async dir=>{
  const store=new WorldPartitionStore(dir);
  const first=store.activeWorldId;
  const a=createCharacter('Dana'); a.personality='WORLD_ALPHA_SECRET';
  const sa=createSession(a);
  let state=makeEmptyWorldState();state.characters=[a];state.sessions=[sa];state.activeSessionId=sa.id;
  let revision=store.load().revision;
  store.save(state,revision,{worldId:first});
  assert.ok(store.load().state.characters.some(c=>c.personality==='WORLD_ALPHA_SECRET'));
  const second=store.worlds.createWorld({name:'World B'}).id;
  store.activateWorld(second);
  assert.deepEqual(store.load().state.characters,[]);
  assert.equal(store.load().state.sessions.length,0);
  assert.deepEqual(store.searchLore('WORLD_ALPHA_SECRET',{actorId:'any'}),[]);
  assert.throws(()=>store.save(state,store.load().revision,{worldId:first}),/World changed/);
  assert.throws(()=>store.worlds.createLocation({worldId:first,name:'Foreign'}),/Open that world/);
  const b=createCharacter('Dana');b.personality='WORLD_BETA_SECRET';
  state=makeEmptyWorldState();state.characters=[b];state.sessions=[createSession(b)];state.activeSessionId=state.sessions[0].id;
  store.save(state,store.load().revision,{worldId:second});
  assert.equal(store.load().state.characters[0].personality,'WORLD_BETA_SECRET');
  store.activateWorld(first);
  assert.equal(store.load().state.characters[0].personality,'WORLD_ALPHA_SECRET');
  assert.ok(existsSync(store.worldFile(first))&&existsSync(store.worldFile(second)));
  store.close();
  const again=new WorldPartitionStore(dir);
  assert.equal(again.activeWorldId,first);
  again.activateWorld(second);
  assert.equal(again.load().state.characters[0].personality,'WORLD_BETA_SECRET');
  again.close();
}));

test('migration partitions existing global state and quarantines unscoped lore',async()=>withTemp(async dir=>{
  const old=new StudioStore(join(dir,'studio.sqlite'));
  const a=old.worlds.createWorld({name:'A'});
  const b=old.worlds.createWorld({name:'B'});
  const ta=old.worlds.createTimeline({worldId:a.id,name:'Story A'});
  const tb=old.worlds.createTimeline({worldId:b.id,name:'Story B'});
  const ca=createCharacter('Same Name'),cb=createCharacter('Same Name'),orphan=createCharacter('Unassigned');
  ca.backstory='FACT_A';cb.backstory='FACT_B';
  const sa=createSession(ca),sb=createSession(cb);sa.timelineId=ta.id;sb.timelineId=tb.id;
  const state=makeEmptyWorldState();state.characters=[ca,cb,orphan];state.sessions=[sa,sb];state.activeSessionId=sa.id;
  state.lore=[
    {id:'a',title:'A',content:'secret A',keywords:['A'],sessionIds:[sa.id]},
    {id:'b',title:'B',content:'secret B',keywords:['B'],sessionIds:[sb.id]},
    {id:'legacy',title:'Unassigned',content:'must not leak',keywords:['Unassigned']},
  ];
  old.save(state,0);old.close();
  const manager=new WorldPartitionStore(dir);
  assert.ok(existsSync(join(dir,'studio.sqlite')),'original save must remain untouched');
  manager.activateWorld(a.id);
  assert.deepEqual(manager.load().state.characters.map(x=>x.backstory),['FACT_A']);
  assert.deepEqual(manager.load().state.lore.map(x=>x.id),['a']);
  assert.equal(manager.worlds.list().locations.length,0);
  manager.activateWorld(b.id);
  assert.deepEqual(manager.load().state.characters.map(x=>x.backstory),['FACT_B']);
  assert.deepEqual(manager.load().state.lore.map(x=>x.id),['b']);
  manager.activateWorld('imported-local-world');
  assert.deepEqual(manager.load().state.characters.map(x=>x.name),['Unassigned']);
  assert.deepEqual(manager.load().state.lore.map(x=>x.id),['legacy']);
  manager.close();
}));

test('scoped HTTP routes switch worlds without permitting stale saves or foreign-world canon edits',async()=>withTemp(async dir=>{
  const {createApp}=await import('../server.mjs');
  const store=new WorldPartitionStore(dir);
  const app=createApp({store});
  const srv=await new Promise(resolve=>app.listen(0,'127.0.0.1',()=>resolve(app)));
  const base=`http://127.0.0.1:${srv.address().port}`;
  try{
    const get=path=>fetch(base+path).then(r=>r.json());
    const post=async(path,body)=>{const res=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:res.status,json:await res.json()};};
    const a=(await get('/api/worlds')).activeWorldId;
    const char=createCharacter('Town A NPC');char.personality='Only WORLD_A';
    const state=makeEmptyWorldState();state.characters=[char];state.sessions=[createSession(char)];state.activeSessionId=state.sessions[0].id;
    const write=await fetch(base+'/api/state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:1,worldId:a,state})});
    assert.equal(write.status,200);
    const b=(await post('/api/worlds',{name:'Town B'})).json.id;
    assert.equal((await post('/api/worlds/activate',{worldId:b})).status,200);
    assert.deepEqual((await get('/api/state')).state.characters,[]);
    const wrong=await fetch(base+'/api/state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:1,worldId:a,state})});
    assert.equal(wrong.status,409); // A stale tab must not write into the newly opened world.
    assert.deepEqual((await get('/api/state')).state.characters,[]);
    assert.equal((await post('/api/worlds/locations',{worldId:a,name:'Foreign street',kind:'town'})).status,400);
    assert.equal((await post('/api/worlds/activate',{worldId:a})).status,200);
    assert.equal((await get('/api/state')).state.characters[0].personality,'Only WORLD_A');
    const list=await get('/api/worlds');assert.deepEqual(list.worlds.map(x=>x.name),['My First World','Town B']);
  }finally{await new Promise(resolve=>srv.close(resolve));}
}));

test('character location links must resolve only inside the active world',async()=>withTemp(async dir=>{
  const store=new WorldPartitionStore(dir);const first=store.activeWorldId;
  const home=store.worlds.createLocation({worldId:first,name:'Shared home',kind:'building'});
  const char=createCharacter('Resident');char.homeLocationId=home.id;
  const state=makeEmptyWorldState();state.characters=[char];state.sessions=[createSession(char)];
  store.save(state,store.load().revision,{worldId:first});
  assert.equal(store.load().state.characters[0].homeLocationId,home.id);
  const b=store.worlds.createWorld({name:'Another'}).id;store.activateWorld(b);
  const other=makeEmptyWorldState();other.characters=[{...char,id:'different'}];other.sessions=[createSession(other.characters[0])];
  assert.throws(()=>store.save(other,store.load().revision,{worldId:b}),/homeLocationId/);
  store.close();
}));

test('world migration retains scoped locations, character ties and accepted event provenance',async()=>withTemp(async dir=>{
  const source=new StudioStore(join(dir,'studio.sqlite'));
  const a=source.worlds.createWorld({name:'Coastal A'});
  const b=source.worlds.createWorld({name:'Coastal B'});
  const ta=source.worlds.createTimeline({worldId:a.id,name:'A timeline'});
  const tb=source.worlds.createTimeline({worldId:b.id,name:'B timeline'});
  const ca=createCharacter('Local A'),cb=createCharacter('Local B');
  const sa=createSession(ca),sb=createSession(cb);sa.timelineId=ta.id;sb.timelineId=tb.id;
  sa.messages.push({id:'npc-speech-a',role:'assistant',speakerId:ca.id,channelId:'in_person',witnessIds:[ca.id],content:'I came here yesterday.'});
  const state=makeEmptyWorldState();state.characters=[ca,cb];state.sessions=[sa,sb];state.activeSessionId=sa.id;
  source.save(state,0);
  const pa=source.worlds.createLocation({worldId:a.id,name:'A bookshop',kind:'building'});
  const pb=source.worlds.createLocation({worldId:b.id,name:'B pier',kind:'outdoor'});
  source.worlds.setActorLocation({timelineId:ta.id,actorId:ca.id,locationId:pa.id});
  source.worlds.setActorLocation({timelineId:tb.id,actorId:cb.id,locationId:pb.id});
  const proposed=source.events.propose({sceneId:sa.id,timelineId:ta.id,sourceMessageId:'npc-speech-a',kind:'observation',description:'A had visited the shop'});
  source.events.decide({proposalId:proposed.id,decision:'accept'});
  source.close();
  const manager=new WorldPartitionStore(dir);
  manager.activateWorld(a.id);
  assert.deepEqual(manager.worlds.list().locations.map(x=>x.name),['A bookshop']);
  assert.deepEqual(manager.worlds.actorLocations(ta.id).map(x=>x.locationId),[pa.id]);
  assert.equal(manager.events.visible(ta.id,ca.id).length,1);
  assert.equal(manager.events.list(sa.id)[0].status,'accepted');
  manager.activateWorld(b.id);
  assert.deepEqual(manager.worlds.list().locations.map(x=>x.name),['B pier']);
  assert.deepEqual(manager.worlds.actorLocations(tb.id).map(x=>x.locationId),[pb.id]);
  assert.throws(()=>manager.events.visible(ta.id,ca.id),/not in this timeline/);
  assert.deepEqual(manager.events.list(sa.id),[]);
  assert.throws(()=>manager.worlds.setActorLocation({timelineId:tb.id,actorId:cb.id,locationId:pa.id}),/different world/);
  manager.close();
}));
