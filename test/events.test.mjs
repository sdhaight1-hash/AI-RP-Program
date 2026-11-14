import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StudioStore } from '../storage.mjs';
import { makeInitialState, createCharacter, buildMessages } from '../engine.mjs';
import { createActorContext } from '../harness.mjs';
import { playerActorId } from '../world/canon.mjs';
import { createApp } from '../server.mjs';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'ai-rp-events-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'studio.sqlite');
  const store=new StudioStore(path);t.after(()=>store.close());
  const state=makeInitialState();const npc=state.characters[0];const scene=state.sessions[0];
  scene.messages.push({id:'selected-npc-reply',role:'assistant',speakerId:npc.id,channelId:'text_message',content:'I will stay here.',witnessIds:[npc.id]});
  store.save(state,0);
  return {store,state,npc,scene,rev:1,path};
}
const draft=(f,extra={})=>({sceneId:f.scene.id,timelineId:f.store.load().state.sessions[0].timelineId,
  sourceMessageId:'selected-npc-reply',kind:'observation',description:'Mara decided to stay.',...extra});

test('event proposals cannot silently mutate canon and require a separate decision',t=>{
  const f=fixture(t);const timelineId=draft(f).timelineId;
  const p=f.store.events.propose(draft(f));
  assert.equal(f.store.events.list(f.scene.id)[0].status,'pending');
  assert.deepEqual(f.store.events.visible(timelineId,f.npc.id),[]);
  const accepted=f.store.events.decide({proposalId:p.id,decision:'accept'});
  assert.equal(accepted.status,'accepted');
  assert.equal(f.store.events.visible(timelineId,f.npc.id)[0].description,'Mara decided to stay.');
  assert.deepEqual(f.store.events.visible(timelineId,playerActorId(timelineId)),[]);
  assert.throws(()=>f.store.events.decide({proposalId:p.id,decision:'accept'}),/not pending/);
  assert.equal(f.store.load().revision,1,'event commits do not rewrite the story snapshot');
});

test('rejected proposals and stale Retry alternatives change no world state',t=>{
  const f=fixture(t);const timelineId=draft(f).timelineId;
  const rejected=f.store.events.propose(draft(f,{description:'Candidate A'}));
  assert.equal(f.store.events.decide({proposalId:rejected.id,decision:'reject'}).status,'rejected');
  assert.deepEqual(f.store.events.visible(timelineId,f.npc.id),[]);
  const stale=f.store.events.propose(draft(f,{description:'Based on old answer'}));
  const revised=f.store.load().state;revised.sessions[0].messages.at(-1).content='I changed my mind and left.';
  assert.equal(f.store.save(revised,1).revision,2);
  assert.throws(()=>f.store.events.decide({proposalId:stale.id,decision:'accept'}),/Source reply changed/);
  assert.deepEqual(f.store.events.visible(timelineId,f.npc.id),[]);
  assert.equal(f.store.events.list(f.scene.id).find(x=>x.id===stale.id).status,'pending');
  f.store.events.decide({proposalId:stale.id,decision:'reject'});
});

test('NPC movement commits atomically; cannot move player or actors across worlds',t=>{
  const f=fixture(t);const timelineId=draft(f).timelineId;
  const library=f.store.worlds.list();const w=library.timelines.find(x=>x.id===timelineId).worldId;
  const room=f.store.worlds.createLocation({worldId:w,name:'Mara apartment',kind:'room'});
  const other=f.store.worlds.createWorld({name:'Other canon'});
  const foreign=f.store.worlds.createLocation({worldId:other.id,name:'Foreign apartment',kind:'room'});
  assert.throws(()=>f.store.events.propose(draft(f,{kind:'npc_move',description:'Mara returned home',locationId:foreign.id})),/this world/);
  assert.throws(()=>f.store.events.propose(draft(f,{actorId:playerActorId(timelineId),kind:'npc_move',description:'Wrong authority',locationId:foreign.id})),/this world/);
  const p=f.store.events.propose(draft(f,{kind:'npc_move',description:'Mara returned home',locationId:room.id,actorId:playerActorId(timelineId)}));
  assert.equal(p.actorId,f.npc.id,'source reply determines actor, not untrusted user input');
  assert.equal(f.store.worlds.actorLocations(timelineId).length,0);
  f.store.events.decide({proposalId:p.id,decision:'accept'});
  assert.deepEqual(f.store.worlds.actorLocations(timelineId).map(x=>({...x})),[{actorId:f.npc.id,locationId:room.id}]);
  assert.equal(f.store.events.visible(timelineId,f.npc.id).length,1);
  assert.equal(f.store.events.visible(timelineId,playerActorId(timelineId)).length,0);
});

test('proposals reject player-authored messages and unaffiliated NPCs',t=>{
  const f=fixture(t);const timelineId=draft(f).timelineId;
  const modified=f.store.load().state;
  modified.sessions[0].messages.at(-1).role='user';
  f.store.save(modified,1);
  assert.throws(()=>f.store.events.propose(draft(f)),/NPC reply/);
  const state=f.store.load().state;
  state.sessions[0].messages.at(-1).role='assistant';
  state.sessions[0].messages.at(-1).speakerId=playerActorId(timelineId);
  f.store.save(state,2);
  assert.throws(()=>f.store.events.propose(draft(f)),/NPC is unavailable/);
});

test('proposal and accepted-event log survive SQLite restarts and trigger v3 backup',t=>{
  const dir=mkdtempSync(join(tmpdir(),'ai-rp-events-restart-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'studio.sqlite');
  const s1=new StudioStore(path);
  const state=makeInitialState();const scene=state.sessions[0],npc=state.characters[0];
  scene.messages.push({id:'m1',role:'assistant',speakerId:npc.id,content:'Good morning',witnessIds:[npc.id]});
  s1.save(state,0);const timelineId=s1.load().state.sessions[0].timelineId;
  const p=s1.events.propose({sceneId:scene.id,timelineId,sourceMessageId:'m1',description:'Morning greeted'});
  s1.events.decide({proposalId:p.id,decision:'accept'});s1.close();
  const s2=new StudioStore(path);
  assert.equal(s2.events.visible(timelineId,npc.id)[0].description,'Morning greeted');
  assert.equal(s2.events.list(scene.id)[0].status,'accepted');
  assert.equal(existsSync(path+'.before-world-v3.bak'),true);
  s2.close();
});

test('HTTP event proposal / review / commit endpoints enforce lifecycle and cross-origin controls',async t=>{
  const store=new StudioStore(':memory:');const state=makeInitialState();const s=state.sessions[0],npc=state.characters[0];
  s.messages.push({id:'last',role:'assistant',speakerId:npc.id,content:'I found the key',witnessIds:[npc.id]});
  store.save(state,0);const timelineId=store.load().state.sessions[0].timelineId;
  const server=createApp({store,fetchImpl:async()=>{throw Error('inference not expected')}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(endpoint,input,headers={})=>fetch(base+endpoint,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(input)});
  const payload={sceneId:s.id,timelineId,sourceMessageId:'last',kind:'observation',description:'NPC found a key'};
  const cross=await post('/api/events/proposals',payload,{origin:'https://bad.invalid'});
  assert.equal(cross.status,403);
  const created=await post('/api/events/proposals',payload);assert.equal(created.status,201);
  const p=await created.json();
  const queue=await(await fetch(base+`/api/events/proposals?sceneId=${s.id}`)).json();
  assert.equal(queue.proposals[0].status,'pending');
  assert.equal((await(await fetch(base+`/api/events/visible?timelineId=${timelineId}&actorId=${npc.id}`)).json()).events.length,0);
  const accepted=await post('/api/events/decide',{proposalId:p.id,decision:'accept'});
  assert.equal(accepted.status,200);
  const visible=await(await fetch(base+`/api/events/visible?timelineId=${timelineId}&actorId=${npc.id}`)).json();
  assert.equal(visible.events[0].description,'NPC found a key');
  assert.equal((await post('/api/events/decide',{proposalId:p.id,decision:'accept'})).status,409);
});

test('accepted events remain isolated by timeline and by NPC witnessing',t=>{
  const f=fixture(t);const one=draft(f).timelineId;
  const world=f.store.worlds.list().timelines.find(x=>x.id===one).worldId;
  const second=f.store.worlds.createTimeline({worldId:world,name:'Different playthrough'});
  const another=createCharacter('Elise');
  const state=f.store.load().state;state.characters.push(another);
  state.sessions[0].castIds.push(another.id);
  const copy=structuredClone(state.sessions[0]);copy.id='independent-scene';copy.timelineId=second.id;
  copy.messages=copy.messages.map(m=>({...m,id:crypto.randomUUID()}));
  state.sessions.push(copy);f.store.save(state,1);
  const p=f.store.events.propose(draft(f));f.store.events.decide({proposalId:p.id,decision:'accept'});
  assert.equal(f.store.events.visible(one,f.npc.id).length,1);
  assert.deepEqual(f.store.events.visible(one,another.id),[], 'unwitnessing NPC should not learn it');
  assert.deepEqual(f.store.events.visible(second.id,f.npc.id),[], 'same NPC identity in alternate timeline should not inherit memory');
});

test('only explicitly visible committed memories enter the character context',t=>{
  const f=fixture(t);const timelineId=draft(f).timelineId;
  const p=f.store.events.propose(draft(f));f.store.events.decide({proposalId:p.id,decision:'accept'});
  const session=f.store.load().state.sessions[0];
  const memory=f.store.events.visible(timelineId,f.npc.id);
  session.channelId='phone_call';
  const args={session,characters:[f.npc],actorId:f.npc.id,persona:{name:'Player'},lore:[],buildMessages};
  const prompt=createActorContext({...args,rememberedEvents:memory}).messages.map(m=>m.content).join('\n');
  assert.match(prompt,/Previously committed events this character knows/);
  assert.match(prompt,/Mara decided to stay/);
  assert.match(prompt,/audio-only phone call/);
  assert.equal(createActorContext(args).messages.join('').includes('Mara decided to stay'),false);
});

test('accepted world events lock reply text, speaker, witness list and timeline through story saves',t=>{
  const f=fixture(t);const p=f.store.events.propose(draft(f));f.store.events.decide({proposalId:p.id,decision:'accept'});
  const before=f.store.load();
  const variants=[
    msg=>msg.content='This was an alternative reply',
    msg=>msg.speakerId='other-actor',
    msg=>msg.witnessIds=['another-witness'],
    msg=>msg.channelId='phone_call',
  ];
  for(const tamper of variants){
    const state=structuredClone(before.state);
    tamper(state.sessions[0].messages.at(-1));
    assert.throws(()=>f.store.save(state,before.revision),/Accepted world event locks/);
    assert.equal(f.store.load().revision,before.revision);
  }
  const state=structuredClone(before.state);state.sessions[0].timelineId='some-other-timeline';
  assert.throws(()=>f.store.save(state,before.revision),/Accepted world event locks/);
  assert.equal(f.store.load().revision,before.revision);
  assert.equal(f.store.events.visible(draft(f).timelineId,f.npc.id).length,1);
});
