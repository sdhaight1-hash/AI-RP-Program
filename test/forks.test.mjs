import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StudioStore } from '../storage.mjs';
import { makeInitialState } from '../engine.mjs';
import { duplicateSession } from '../harness.mjs';
import { playerActorId } from '../world/canon.mjs';
import { createApp } from '../server.mjs';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'ai-rp-fork-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const store=new StudioStore(join(dir,'studio.sqlite'));t.after(()=>store.close());
  const state=makeInitialState(), scene=state.sessions[0],npc=state.characters[0];
  scene.messages.push({id:'reply1',role:'assistant',content:'I am home',speakerId:npc.id,channelId:'text_message',witnessIds:[npc.id]});
  store.save(state,0);
  const timelineId=store.load().state.sessions[0].timelineId;
  const worldId=store.worlds.list().timelines.find(x=>x.id===timelineId).worldId;
  const room=store.worlds.createLocation({worldId,name:'The apartment',kind:'room'});
  const proposal=store.events.propose({sceneId:scene.id,timelineId,sourceMessageId:'reply1',description:'Mara stayed home.'});
  store.events.decide({proposalId:proposal.id,decision:'accept'});
  store.worlds.setActorLocation({timelineId,actorId:npc.id,locationId:room.id});
  store.worlds.setClock({timelineId,instant:'2001-02-03T04:05:00Z',timeZone:'America/Los_Angeles'});
  return {store,scene,npc,timelineId,worldId,room};
}

test('timeline fork snapshots inherit existing events, positions, controllers and fictional time',t=>{
  const f=fixture(t);
  const branch=f.store.worlds.forkTimeline({timelineId:f.timelineId,name:'Alternate story'});
  assert.equal(branch.parentTimelineId,f.timelineId);
  assert.equal(branch.worldId,f.worldId);
  const original=f.store.events.visible(f.timelineId,f.npc.id);
  const inherited=f.store.events.visible(branch.id,f.npc.id);
  assert.equal(original.length,1);
  assert.deepEqual(inherited,original);
  assert.deepEqual(f.store.worlds.actorLocations(branch.id).map(x=>({...x})),[{actorId:f.npc.id,locationId:f.room.id}]);
  const controller=f.store.worlds.actors(branch.id);
  assert.equal(controller.some(a=>a.actorId===f.npc.id&&a.controller==='npc'),true);
  assert.equal(controller.some(a=>a.actorId===playerActorId(branch.id)&&a.controller==='player'),true);
  assert.equal(controller.some(a=>a.actorId===playerActorId(f.timelineId)),false);
  const clocks=f.store.worlds.list().clocks;
  assert.equal(clocks.find(x=>x.timelineId===branch.id).instantMs,clocks.find(x=>x.timelineId===f.timelineId).instantMs);
  assert.equal(clocks.find(x=>x.timelineId===branch.id).timeZone,'America/Los_Angeles');
  assert.equal(clocks.find(x=>x.timelineId===branch.id).isExplicit,1);
});

test('later parent and child events never cross a fork boundary, including nested forks',t=>{
  const f=fixture(t),branch=f.store.worlds.forkTimeline({timelineId:f.timelineId,name:'Alternative'});
  const state=f.store.load().state;
  // A new scene can keep the old transcript without sharing the original timeline.
  state.activeSessionId=f.scene.id;
  const copy=duplicateSession(state,f.scene.id);copy.timelineId=branch.id;
  const next=structuredClone(f.store.load().state.sessions[0].messages.at(-1));
  next.id='reply2';next.content='I decided to go outside.';
  const parentState=f.store.load().state;parentState.sessions[0].messages.push(next);
  parentState.sessions.push(copy);
  f.store.save(parentState,1);
  // Original timeline gains a new event after the fork. Children must not see it.
  const parentP=f.store.events.propose({sceneId:f.scene.id,timelineId:f.timelineId,sourceMessageId:'reply2',description:'Mara went outside in original timeline.'});
  f.store.events.decide({proposalId:parentP.id,decision:'accept'});
  assert.equal(f.store.events.visible(f.timelineId,f.npc.id).length,2);
  assert.equal(f.store.events.visible(branch.id,f.npc.id).length,1);
  // Child has a new event from its own new reply.
  const childState=f.store.load().state;
  const child=childState.sessions.find(x=>x.id===copy.id);
  child.messages.push({id:'child-reply',role:'assistant',speakerId:f.npc.id,content:'I stayed inside.',witnessIds:[f.npc.id]});
  f.store.save(childState,2);
  const childP=f.store.events.propose({sceneId:copy.id,timelineId:branch.id,sourceMessageId:'child-reply',description:'Mara stayed inside in the branch.'});
  f.store.events.decide({proposalId:childP.id,decision:'accept'});
  const grandchild=f.store.worlds.forkTimeline({timelineId:branch.id,name:'Grandchild'});
  assert.deepEqual(f.store.events.visible(grandchild.id,f.npc.id).map(x=>x.description),['Mara stayed home.','Mara stayed inside in the branch.']);
  assert.equal(f.store.events.visible(f.timelineId,f.npc.id).some(x=>x.description.includes('inside in the branch')),false);
  assert.equal(f.store.events.visible(branch.id,f.npc.id).some(x=>x.description.includes('outside in original')),false);
});

test('copied scenes preserve source fingerprint locks for events inherited by the new branch',t=>{
  const f=fixture(t),branch=f.store.worlds.forkTimeline({timelineId:f.timelineId,name:'Branch'});
  const state=f.store.load().state;
  const copy=duplicateSession(state,f.scene.id);copy.timelineId=branch.id;
  f.store.save(state,1);
  const original=f.store.load();
  const bad=structuredClone(original.state);
  bad.sessions.find(x=>x.id===copy.id).messages.at(-1).content='In this branch, she leaves instead.';
  assert.throws(()=>f.store.save(bad,2),/inherits a committed event/);
  assert.equal(f.store.load().revision,2);
});

test('fork HTTP route validates timeline and name',async t=>{
  const store=new StudioStore(':memory:');const state=makeInitialState();store.save(state,0);
  const timelineId=store.load().state.sessions[0].timelineId;
  const server=createApp({store,fetchImpl:async()=>{throw Error('not used')}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>await new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=obj=>fetch(base+'/api/timelines/fork',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(obj)});
  assert.equal((await post({timelineId:'unknown',name:'Bad'})).status,400);
  assert.equal((await post({timelineId,name:' '})).status,400);
  const result=await post({timelineId,name:'Fork'});assert.equal(result.status,201);
  const fork=await result.json();assert.equal(fork.parentTimelineId,timelineId);
  assert.equal((await(await fetch(base+'/api/worlds')).json()).timelines.some(x=>x.id===fork.id),true);
});

test('grandchild branches cannot rewrite or remove events inherited from an ancestor',t=>{
  const f=fixture(t);
  const a=f.store.worlds.forkTimeline({timelineId:f.timelineId,name:'Child'});
  const state=f.store.load().state;
  const first=duplicateSession(state,f.scene.id);first.timelineId=a.id;
  f.store.save(state,1);
  const b=f.store.worlds.forkTimeline({timelineId:a.id,name:'Grandchild'});
  const next=f.store.load().state;
  const second=duplicateSession(next,first.id);second.timelineId=b.id;
  f.store.save(next,2);
  const original=f.store.load().state;
  const wrong=structuredClone(original);
  wrong.sessions.find(s=>s.id===second.id).messages.find(m=>m.originMessageId===first.messages.at(-1).id).content='Changed original past';
  assert.throws(()=>f.store.save(wrong,3),/inherits a committed event/);
  const deleted=structuredClone(original);
  deleted.sessions.find(s=>s.id===second.id).messages=[];
  assert.throws(()=>f.store.save(deleted,3),/inherits a committed event/);
  assert.equal(f.store.load().revision,3);
});
