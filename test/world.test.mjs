import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioStore } from '../storage.mjs';
import { createCharacter, createSession, makeInitialState } from '../engine.mjs';
import { legacyTimelineId, playerActorId, assertActorAuthority } from '../world/canon.mjs';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'rp-world-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  return join(dir,'studio.sqlite');
}

test('world migration creates a distinct timeline per legacy session and is idempotent',t=>{
  const path=fixture(t);
  // Genuine v0.4-style database: one studio_state document, no world tables.
  const old=new DatabaseSync(path);
  old.exec('CREATE TABLE studio_state(id INTEGER PRIMARY KEY,revision INTEGER,updated_at INTEGER,document TEXT)');
  const state=makeInitialState();
  state.sessions[0].summary='First story alone';
  const second=createSession(state.characters[0]);
  second.summary='Independent story';
  state.sessions.push(second);
  old.prepare('INSERT INTO studio_state VALUES (1,?,?,?)').run(7,1000,JSON.stringify(state));
  old.close();
  const first=new StudioStore(path);
  assert.ok(existsSync(path+'.before-world-v1.bak'));
  const migrated=first.load();
  assert.equal(migrated.revision,7);
  assert.equal(migrated.state.sessions.length,2);
  const t1=migrated.state.sessions[0].timelineId;
  const t2=migrated.state.sessions[1].timelineId;
  assert.equal(t1,legacyTimelineId(state.sessions[0].id));
  assert.notEqual(t1,t2);
  assert.equal(first.worlds.list().timelines.length,2);
  assert.equal(first.worlds.actors(t1).filter(a=>a.controller==='player').length,1);
  assert.equal(first.worlds.actors(t1).filter(a=>a.controller==='npc').length,1);
  first.close();
  const secondPass=new StudioStore(path);
  assert.equal(secondPass.worlds.list().timelines.length,2);
  assert.deepEqual(secondPass.load().state.sessions.map(s=>s.timelineId),[t1,t2]);
  assert.equal(secondPass.load().state.sessions[1].summary,'Independent story');
  secondPass.close();
  const previous=new DatabaseSync(path+'.before-world-v1.bak');
  assert.equal(previous.prepare('SELECT revision FROM studio_state').get().revision,7);
  previous.close();
});

test('new canon worlds and their playthroughs remain distinct; branch parent must share world',t=>{
  const store=new StudioStore(fixture(t));t.after(()=>store.close());
  const a=store.worlds.createWorld({name:'Coastal Town',description:'Contemporary slice of life'});
  const b=store.worlds.createWorld({name:'Another Town',description:'Different canon'});
  const x=store.worlds.createTimeline({worldId:a.id,name:'First playthrough'});
  const y=store.worlds.createTimeline({worldId:a.id,name:'Alternative',parentTimelineId:x.id});
  const z=store.worlds.createTimeline({worldId:b.id,name:'Other world'});
  assert.equal(x.worldId,y.worldId);
  assert.notEqual(x.worldId,z.worldId);
  assert.equal(y.parentTimelineId,x.id);
  assert.equal(store.worlds.list().worlds.length,2);
  assert.throws(()=>store.worlds.createTimeline({worldId:b.id,name:'Wrong branch',parentTimelineId:x.id}),/another world/);
  assert.throws(()=>store.worlds.createWorld({name:' '}),/name/i);
  assert.equal(store.worlds.actors(x.id)[0].actorId,playerActorId(x.id));
});

test('player/NPC/system controllers cannot impersonate each other',t=>{
  const store=new StudioStore(fixture(t));t.after(()=>store.close());
  const state=makeInitialState();
  store.save(state,0);
  const timelineId=store.load().state.sessions[0].timelineId;
  const npcId=state.characters[0].id;
  assert.equal(store.worlds.authorize(timelineId,npcId,'npc','npc-message'),true);
  assert.equal(store.worlds.authorize(timelineId,playerActorId(timelineId),'player','player-message'),true);
  assert.throws(()=>store.worlds.authorize(timelineId,playerActorId(timelineId),'npc','npc-message'),/mismatch/);
  assert.throws(()=>store.worlds.authorize(timelineId,npcId,'npc','player-action'),/cannot perform/);
  assert.throws(()=>store.worlds.authorize('nonexistent',npcId,'npc','npc-message'),/Unknown actor/);
  assert.throws(()=>assertActorAuthority({controller:'npc'},{controller:'npc',action:'world-event-commit'}),/cannot perform/);
});

test('scene joins an authored timeline without changing another timeline',t=>{
  const store=new StudioStore(fixture(t));t.after(()=>store.close());
  const w=store.worlds.createWorld({name:'Harbor City'});
  const t1=store.worlds.createTimeline({worldId:w.id,name:'One'});
  const t2=store.worlds.createTimeline({worldId:w.id,name:'Two'});
  const state=makeInitialState();
  state.sessions[0].timelineId=t1.id;
  const scene2=createSession(state.characters[0]);scene2.timelineId=t2.id;
  state.sessions.push(scene2);
  assert.equal(store.save(state,0).revision,1);
  const saved=store.load().state;
  assert.deepEqual(saved.sessions.map(s=>s.timelineId),[t1.id,t2.id]);
  assert.equal(store.worlds.actors(t1.id).filter(a=>a.controller==='npc').length,1);
  assert.equal(store.worlds.actors(t2.id).filter(a=>a.controller==='npc').length,1);
  const extra=createSession(state.characters[0]);extra.timelineId='missing-id';state.sessions.push(extra);
  assert.throws(()=>store.save(state,1),/Unknown timeline/);
  assert.equal(store.load().revision,1);
  assert.equal(store.worlds.list().timelines.length,2);
});
