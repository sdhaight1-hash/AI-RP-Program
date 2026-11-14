import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioStore } from '../storage.mjs';
import { WorldPartitionStore } from '../world/partition-store.mjs';
import { createCharacter,makeInitialState,makeEmptyWorldState,createSession } from '../engine.mjs';
import { retrieveActorMemories } from '../memory/store.mjs';
import { buildActorContext,estimateTokens } from '../context/assemble.mjs';
import { createApp } from '../server.mjs';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeFixture() {
  const store=new StudioStore(':memory:');
  const state=makeInitialState();
  const a=state.characters[0],b=createCharacter('Other NPC');
  state.characters.push(b);
  const scene=state.sessions[0];scene.castIds=[a.id,b.id];
  scene.messages=[
    {id:'private',role:'user',content:'The lantern password is violet-cinder.',witnessIds:[a.id],sentAt:1000},
    {id:'shared',role:'user',content:'The gallery opens on Friday.',witnessIds:[a.id,b.id],sentAt:2000},
    {id:'reply',role:'assistant',speakerId:a.id,content:'I will attend the gallery.',witnessIds:[a.id],sentAt:3000}
  ];
  store.save(state,0);
  return {store,scene:store.load().state.sessions[0],a,b};
}

test('recollection index limits observed dialogue to witnesses and speaker',()=>{
  const f=makeFixture();
  try{
    const a=retrieveActorMemories(f.store.db,{timelineId:f.scene.timelineId,actorId:f.a.id,query:'lantern password',limit:10});
    const b=retrieveActorMemories(f.store.db,{timelineId:f.scene.timelineId,actorId:f.b.id,query:'lantern password',limit:10});
    assert.ok(a.some(m=>m.text.includes('violet-cinder')));
    assert.equal(b.some(m=>m.text.includes('violet-cinder')),false);
    assert.ok(b.some(m=>m.text.includes('gallery')));
    assert.equal(b.some(m=>m.text.includes('I will attend')),false);
    assert.throws(()=>retrieveActorMemories(f.store.db,{timelineId:f.scene.timelineId,actorId:'not-an-actor',query:'lantern'}),/not in this timeline/);
  }finally{f.store.close();}
});

test('rejected save rolls back associated memories and later changes update source',()=>{
  const f=makeFixture();
  try{
    const wrong=f.store.load().state;wrong.sessions[0].messages[0].content='Different password, wrong revision.';
    assert.equal(f.store.save(wrong,0),null);
    const still=retrieveActorMemories(f.store.db,{timelineId:f.scene.timelineId,actorId:f.a.id,query:'violet'});
    assert.ok(still.some(m=>m.text.includes('violet-cinder')));
    wrong.sessions[0].messages[0].content='A newly witnessed secret is cobalt-willow.';
    f.store.save(wrong,1);
    const updated=retrieveActorMemories(f.store.db,{timelineId:f.scene.timelineId,actorId:f.a.id,query:'cobalt'});
    assert.ok(updated.some(m=>m.text.includes('cobalt-willow')));
    assert.equal(updated.some(m=>m.text.includes('violet-cinder')),false);
  }finally{f.store.close();}
});

test('fork inherits a frozen memory snapshot, not later parent dialogue',()=>{
  const f=makeFixture();
  try{
    const fork=f.store.worlds.forkTimeline({timelineId:f.scene.timelineId,name:'Alternate'});
    const initial=retrieveActorMemories(f.store.db,{timelineId:fork.id,actorId:f.a.id,query:'lantern'});
    assert.ok(initial.some(m=>m.text.includes('violet-cinder')));
    const updated=f.store.load().state;
    updated.sessions[0].messages.push({id:'late',role:'user',content:'New parent-only knowledge: silver-orchid.',witnessIds:[f.a.id],sentAt:5000});
    f.store.save(updated,1);
    const inherited=retrieveActorMemories(f.store.db,{timelineId:fork.id,actorId:f.a.id,query:'silver orchid'});
    assert.equal(inherited.some(m=>m.text.includes('silver-orchid')),false);
    const parent=retrieveActorMemories(f.store.db,{timelineId:f.scene.timelineId,actorId:f.a.id,query:'silver orchid'});
    assert.ok(parent.some(m=>m.text.includes('silver-orchid')));
  }finally{f.store.close();}
});

test('actor context budget retains last turn and cannot see another actor private memory',()=>{
  const f=makeFixture();
  try{
    f.a.personality='Careful, observant, dislikes exaggeration.';
    const state=f.store.load().state;
    state.characters.find(c=>c.id===f.a.id).personality=f.a.personality;
    f.store.save(state,1);
    const worldId=f.store.worlds.list().timelines.find(t=>t.id===f.scene.timelineId).worldId;
    const result=buildActorContext({store:f.store,worldId,sceneId:f.scene.id,actorId:f.b.id,contextWindow:2048,maxOutput:250});
    const text=result.messages.map(m=>m.content).join('\n');
    assert.doesNotMatch(text,/violet-cinder/);
    assert.ok(text.includes('gallery'));
    assert.ok(estimateTokens(result.messages)<2048-250-128);
    assert.equal(result.metadata.actorId,f.b.id);
  }finally{f.store.close();}
});

test('server-owned reply ignores supplied fabricated memory and streams authorized context',async()=>{
  const f=makeFixture();let upstreamPrompt;
  const worldId=f.store.worlds.list().timelines.find(t=>t.id===f.scene.timelineId).worldId;
  const app=createApp({store:f.store,fetchImpl:async(url,options)=>{
    if(url.endsWith('/chat/completions')) {
      upstreamPrompt=JSON.parse(options.body).messages;
      return new Response('data: {"choices":[{"delta":{"content":"Sure."}}]}\n\ndata: [DONE]\n\n');
    }
    throw Error('Optional backend discovery unavailable');
  }});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  try{
    const url='http://127.0.0.1:'+app.address().port;
    const payload={worldId,sceneId:f.scene.id,actorId:f.b.id,model:'test',
      temperature:0.7,max_tokens:100,contextWindow:2048,revision:1,
      messages:[{role:'system',content:'FAKE PRIVATE SECRET SHOULD NOT APPEAR'}]};
    const result=await fetch(url+'/api/actor/reply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    assert.equal(result.status,200);
    assert.match(await result.text(),/Sure/);
    const assembled=upstreamPrompt.map(m=>m.content).join(' ');
    assert.doesNotMatch(assembled,/violet-cinder|FAKE PRIVATE SECRET/);
    const stale=await fetch(url+'/api/actor/context',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...payload,revision:0})});
    assert.equal(stale.status,409);
    const invalid=await fetch(url+'/api/actor/context',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...payload,actorId:'stranger'})});
    assert.equal(invalid.status,422);
  }finally{await new Promise(resolve=>app.close(resolve));}
});

test('world change keeps memory queries confined to the selected database',()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-memory-isolation-'));
  const store=new WorldPartitionStore(dir);
  try{
    const first=store.activeWorldId;
    const a=createCharacter('Isolated NPC'),scene=createSession(a);
    scene.messages=[{id:'first',role:'user',content:'WORLD_ONE_PASSPHRASE',witnessIds:[a.id]}];
    const state=makeEmptyWorldState();state.characters=[a];state.sessions=[scene];
    store.save(state,store.load().revision,{worldId:first});
    const second=store.worlds.createWorld({name:'Second memory world'}).id;
    store.activateWorld(second);
    assert.throws(()=>store.searchLore('secret',{worldId:first,actorId:a.id}),/Open that world/);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM actor_memories').get().n,0);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
