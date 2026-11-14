import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioStore } from '../storage.mjs';
import { createCharacter,makeInitialState } from '../engine.mjs';
import { addActorFact,listActorFacts,revokeActorFact,retrieveActorFacts } from '../memory/facts.mjs';
import { buildActorContext } from '../context/assemble.mjs';
import { createApp } from '../server.mjs';

function setup() {
  const store=new StudioStore(':memory:');
  const state=makeInitialState(),a=state.characters[0],b=createCharacter('Observer');
  state.characters.push(b);
  const scene=state.sessions[0];scene.castIds=[a.id,b.id];
  scene.messages=[
    {id:'heard',role:'user',content:'I promise to visit the bookstore tomorrow.',witnessIds:[a.id],sentAt:101},
    {id:'everyone',role:'user',content:'The garden opens Tuesday.',witnessIds:[a.id,b.id],sentAt:102}
  ];
  store.save(state,0);
  const saved=store.load().state.sessions[0];
  const worldId=store.worlds.list().timelines.find(x=>x.id===saved.timelineId).worldId;
  return {store,scene:saved,a,b,worldId};
}

test('reviewed promise is linked to an actual witnessed message and never becomes global knowledge',()=>{
  const f=setup();
  try{
    const fact=addActorFact(f.store,{sceneId:f.scene.id,actorId:f.a.id,sourceMessageId:'heard',
      kind:'promise',text:'The player promised to visit the bookstore tomorrow.'});
    assert.equal(fact.status,'active');
    assert.equal(listActorFacts(f.store,{timelineId:f.scene.timelineId,actorId:f.a.id}).length,1);
    assert.throws(()=>addActorFact(f.store,{sceneId:f.scene.id,actorId:f.b.id,sourceMessageId:'heard',
      kind:'promise',text:'Something forbidden'}),/did not witness/);
    const recalled=retrieveActorFacts(f.store,{timelineId:f.scene.timelineId,actorId:f.a.id,query:'bookstore'});
    assert.ok(recalled.some(x=>x.text.includes('bookstore')));
    const unseen=retrieveActorFacts(f.store,{timelineId:f.scene.timelineId,actorId:f.b.id,query:'bookstore'});
    assert.equal(unseen.length,0);
    const context=buildActorContext({store:f.store,worldId:f.worldId,sceneId:f.scene.id,actorId:f.a.id});
    assert.match(context.messages[0].content,/Reviewed personal promise/);
  }finally{f.store.close();}
});

test('stale source silently becomes ineligible; explicit revocation retains audit history',()=>{
  const f=setup();
  try{
    const fact=addActorFact(f.store,{sceneId:f.scene.id,actorId:f.a.id,sourceMessageId:'heard',text:'The player likes long walks.'});
    const edited=f.store.load().state;
    edited.sessions[0].messages[0].content='I have never said that.';
    f.store.save(edited,1);
    assert.equal(retrieveActorFacts(f.store,{timelineId:f.scene.timelineId,actorId:f.a.id,query:'walks'}).length,0);
    assert.equal(listActorFacts(f.store,{timelineId:f.scene.timelineId,actorId:f.a.id})[0].status,'active');
    revokeActorFact(f.store,{id:fact.id,actorId:f.a.id,timelineId:f.scene.timelineId});
    assert.equal(listActorFacts(f.store,{timelineId:f.scene.timelineId,actorId:f.a.id})[0].status,'revoked');
  }finally{f.store.close();}
});

test('superseded personal belief is retained historically but excluded from acting context',()=>{
  const f=setup();
  try{
    const original=addActorFact(f.store,{sceneId:f.scene.id,actorId:f.a.id,sourceMessageId:'heard',
      kind:'belief',text:'The bookstore is closed on Tuesday.'});
    const next=addActorFact(f.store,{sceneId:f.scene.id,actorId:f.a.id,sourceMessageId:'everyone',
      kind:'belief',text:'The bookstore is open on Tuesday.',supersedesId:original.id});
    const all=listActorFacts(f.store,{timelineId:f.scene.timelineId,actorId:f.a.id});
    assert.equal(all.find(x=>x.id===original.id).status,'superseded');
    assert.equal(all.find(x=>x.id===next.id).status,'active');
    const active=retrieveActorFacts(f.store,{timelineId:f.scene.timelineId,actorId:f.a.id,query:'bookstore'});
    assert.equal(active.some(x=>x.id===original.id),false);
    assert.ok(active.some(x=>x.id===next.id));
    assert.throws(()=>addActorFact(f.store,{sceneId:f.scene.id,actorId:f.b.id,sourceMessageId:'everyone',
      text:'Conflict',supersedesId:next.id}),/does not belong/);
  }finally{f.store.close();}
});

test('branch snapshots facts before later parent corrections',()=>{
  const f=setup();
  try{
    const fact=addActorFact(f.store,{sceneId:f.scene.id,actorId:f.a.id,sourceMessageId:'heard',
      kind:'belief',text:'Bookstore closes at 8.'});
    const child=f.store.worlds.forkTimeline({timelineId:f.scene.timelineId,name:'A different memory'});
    revokeActorFact(f.store,{id:fact.id,timelineId:f.scene.timelineId,actorId:f.a.id});
    const inherited=retrieveActorFacts(f.store,{timelineId:child.id,actorId:f.a.id,query:'bookstore'});
    assert.ok(inherited.some(x=>x.text==='Bookstore closes at 8.'));
    assert.equal(retrieveActorFacts(f.store,{timelineId:f.scene.timelineId,actorId:f.a.id,query:'bookstore'}).length,0);
  }finally{f.store.close();}
});

test('actor fact HTTP API rejects stale scene revisions and unobserved messages',async()=>{
  const f=setup();
  const app=createApp({store:f.store,fetchImpl:async()=>{throw Error('No inference needed')}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+app.address().port;
  const post=(path,value)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
  try{
    const payload={worldId:f.worldId,sceneId:f.scene.id,actorId:f.a.id,sourceMessageId:'heard',
      text:'The player offered to visit tomorrow.',kind:'promise',revision:1};
    assert.equal((await post('/api/actor/facts',{...payload,revision:0})).status,409);
    assert.equal((await post('/api/actor/facts',{...payload,actorId:f.b.id})).status,422);
    const made=await post('/api/actor/facts',payload);
    assert.equal(made.status,201);
    const record=await made.json();
    const list=await fetch(base+'/api/actor/facts?timelineId='+encodeURIComponent(f.scene.timelineId)+'&actorId='+encodeURIComponent(f.a.id));
    assert.equal(list.status,200);
    assert.equal((await list.json()).facts[0].id,record.id);
    assert.equal((await post('/api/actor/facts/revoke',{worldId:f.worldId,id:record.id,timelineId:f.scene.timelineId,actorId:f.a.id})).status,200);
  }finally{await new Promise(resolve=>app.close(resolve));}
});
