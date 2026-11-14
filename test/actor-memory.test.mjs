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


test('topic-aware retrieval exposes family detail without bloating permanent identity',()=>{
  const f=makeFixture();
  try{
    const state=f.store.load().state;
    const character=state.characters.find(c=>c.id===f.a.id);
    character.familyHistory='She was raised by her aunt in a mountain village.';
    state.sessions[0].messages.push({id:'family-cue',role:'user',content:'What was your family like growing up?',witnessIds:[f.a.id],sentAt:4000});
    f.store.save(state,1);
    const worldId=f.store.worlds.list().timelines.find(t=>t.id===f.scene.timelineId).worldId;
    const remembered=buildActorContext({store:f.store,worldId,sceneId:f.scene.id,actorId:f.a.id,contextWindow:2048,maxOutput:200});
    assert.match(remembered.messages[0].content,/mountain village/);
    assert.ok(remembered.metadata.promptTokensEstimated<2048-200-128);
    assert.match(remembered.messages.at(-1).content,/family like growing up/);
  }finally{f.store.close();}
});

test('current timeline clock and actor location override stale scene hints',()=>{
  const f=makeFixture();
  try{
    const worldId=f.store.worlds.list().timelines.find(t=>t.id===f.scene.timelineId).worldId;
    const place=f.store.worlds.createLocation({worldId,name:'City Library',kind:'building'});
    f.store.worlds.setActorLocation({timelineId:f.scene.timelineId,actorId:f.a.id,locationId:place.id});
    f.store.worlds.setClock({timelineId:f.scene.timelineId,instant:'2004-01-02T03:04:00Z',timeZone:'UTC'});
    const built=buildActorContext({store:f.store,worldId,sceneId:f.scene.id,actorId:f.a.id});
    assert.match(built.messages[0].content,/City Library/);
    assert.match(built.messages[0].content,/2004-01-02T03:04:00/);
  }finally{f.store.close();}
});

test('backend context discovery honors allocated KoboldCpp context and native token counter',async()=>{
  const { discoverBackendContext,enforceTokenBudget }=await import('../context/backend.mjs');
  const backend=await discoverBackendContext('http://127.0.0.1:5001/v1','test',async url=>{
    if(url.endsWith('/true_max_context_length'))return Response.json({value:2048});
    if(url.endsWith('/tokencount'))return Response.json({value:123});
    throw Error('Unexpected local backend URL');
  });
  assert.equal(backend.contextWindow,2048);
  const prompt={messages:[{role:'system',content:'An actor.'},{role:'user',content:'Hello'}],
    metadata:{contextWindow:2048,maxOutput:400,safetyMargin:128}};
  const counted=await enforceTokenBudget(prompt,backend);
  assert.equal(counted.metadata.promptTokens,123);
  assert.equal(counted.metadata.countMethod,'exact');
});


test('incoming secret social relationships are not inferred as actor knowledge',()=>{
  const f=makeFixture();
  try {
    const worldId=f.store.worlds.list().timelines.find(t=>t.id===f.scene.timelineId).worldId;
    const a=f.store.worlds.createEntity({worldId,name:f.a.name,kind:'character',sourceCharacterId:f.a.id});
    const b=f.store.worlds.createEntity({worldId,name:f.b.name,kind:'character',sourceCharacterId:f.b.id});
    f.store.worlds.createRelationship({worldId,fromId:b.id,toId:a.id,kind:'secretly_admires'});
    const result=buildActorContext({store:f.store,worldId,sceneId:f.scene.id,actorId:f.a.id});
    assert.doesNotMatch(result.messages.map(m=>m.content).join(' '),/secretly_admires/);
    f.store.worlds.createRelationship({worldId,fromId:a.id,toId:b.id,kind:'trusted_colleague'});
    const updated=buildActorContext({store:f.store,worldId,sceneId:f.scene.id,actorId:f.a.id});
    assert.match(updated.messages[0].content,/trusted_colleague/);
  }finally{f.store.close();}
});


test('pinned moments remain retrievable after many later turns without leaking to non-witnesses',()=>{
  const f=makeFixture();
  try{
    const state=f.store.load().state;
    state.sessions[0].messages[0].pinned=true;
    for(let i=0;i<30;i++)state.sessions[0].messages.push({
      id:'later-'+i,role:'user',content:'Ordinary small talk '+i,witnessIds:[f.a.id],sentAt:5000+i
    });
    f.store.save(state,1);
    const a=retrieveActorMemories(f.store.db,{timelineId:f.scene.timelineId,actorId:f.a.id,query:'unrelated topic',limit:8});
    const b=retrieveActorMemories(f.store.db,{timelineId:f.scene.timelineId,actorId:f.b.id,query:'unrelated topic',limit:8});
    assert.ok(a.some(m=>m.text.includes('violet-cinder') && m.pinned));
    assert.equal(b.some(m=>m.text.includes('violet-cinder')),false);
  }finally{f.store.close();}
});


test('compact acting context preserves messaging rules and emotional state',()=>{
  const f=makeFixture();
  try{
    const state=f.store.load().state;
    state.sessions[0].channelId='text_message';
    state.sessions[0].emotion={valence:-0.6,arousal:0.8,trust:-0.8};
    delete state.sessions[0].psychologyByActor[f.a.id]; // exercise legacy emotion fallback
    f.store.save(state,1);
    const worldId=f.store.worlds.list().timelines.find(t=>t.id===f.scene.timelineId).worldId;
    const built=buildActorContext({store:f.store,worldId,sceneId:f.scene.id,actorId:f.a.id,contextWindow:2048,maxOutput:300});
    assert.match(built.messages[0].content,/Write ONLY the exact message text/);
    assert.match(built.messages[0].content,/guarded toward the player/);
    assert.match(built.messages[0].content,/highly alert/);
  }finally{f.store.close();}
});
