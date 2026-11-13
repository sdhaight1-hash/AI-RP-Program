import test from 'node:test';
import assert from 'node:assert/strict';
import { createCharacter, createSession, buildMessages, normalizeState } from '../engine.mjs';
import { normalizeScene, chooseSpeaker, actorVisibleHistory, canKnowLore, createActorContext, createSceneEvent, actorVisibleEvents, archiveCharacter, archiveSession, duplicateSession, purgeArchived } from '../harness.mjs';

const setup=()=>{
  const mara=createCharacter('Mara Vale'), elise=createCharacter('Elise Stone');
  const scene=createSession(mara);
  scene.castIds=[mara.id,elise.id]; scene.speakerId=elise.id; scene.speakerMode='natural';
  scene.summary='SECRET: the mentor lives';scene.publicSummary='A storm outside';scene.location='bookshop';
  scene.messages=[];
  return {mara,elise,scene};
};

test('old scenes normalize as one actor; casting and speaker selection are deterministic',()=>{
  const {mara,elise,scene}=setup();
  assert.deepEqual(normalizeScene({characterId:mara.id},[mara,elise]).castIds,[mara.id]);
  scene.messages=[{role:'user',content:'@Elise, is the shop safe?'}];
  assert.equal(chooseSpeaker(scene,[mara,elise]),elise.id);
  scene.speakerMode='manual';scene.speakerId=mara.id;
  assert.equal(chooseSpeaker(scene,[mara,elise]),mara.id);
  scene.speakerMode='round-robin'; scene.messages.push({role:'assistant',speakerId:mara.id,content:'Wait.'});
  assert.equal(chooseSpeaker(scene,[mara,elise]),elise.id);
});

test('private lore and unseen dialogue never appear in another actor prompt',()=>{
  const {mara,elise,scene}=setup();
  scene.messages=[
    {role:'user',content:'The rain is heavy.',witnessIds:[mara.id,elise.id]},
    {role:'assistant',speakerId:mara.id,content:'My secret code is ECHO-902.',witnessIds:[mara.id]},
    {role:'assistant',speakerId:elise.id,content:'The doors are locked.',witnessIds:[mara.id,elise.id]},
  ];
  const lore=[
    {id:'p1',keywords:['rain'],content:'MARA_ONLY_SECRET_41',visibility:'private',knownBy:[mara.id]},
    {id:'p2',keywords:['rain'],content:'The harbor floods in storms.',visibility:'public'},
  ];
  const ctx=createActorContext({session:scene,characters:[mara,elise],actorId:elise.id,persona:{name:'Player',description:''},lore,buildMessages});
  const contents=ctx.messages.map(m=>m.content).join('\n');
  assert.ok(contents.includes('harbor floods'));
  assert.ok(contents.includes('bookshop'));
  assert.ok(contents.includes('Mara Vale') === true);
  assert.ok(!contents.includes('MARA_ONLY_SECRET_41'));
  assert.ok(!contents.includes('ECHO-902'));
  assert.ok(!contents.includes('mentor lives'));
  const maraCtx=createActorContext({session:scene,characters:[mara,elise],actorId:mara.id,persona:{name:'Player'},lore,buildMessages});
  assert.ok(maraCtx.messages[0].content.includes('MARA_ONLY_SECRET_41'));
});

test('assistant turns are attributed correctly, not all treated as actor',()=>{
  const {mara,elise,scene}=setup();
  scene.messages=[{role:'assistant',speakerId:mara.id,content:'Hello',witnessIds:[mara.id,elise.id]}];
  const observed=actorVisibleHistory(scene,elise.id,[mara,elise]);
  assert.equal(observed[0].role,'user');
  assert.match(observed[0].content,/Mara Vale/);
});

test('event visibility and archive preserve continuity; branching copies have unique IDs',()=>{
  const {mara,elise,scene}=setup();
  const e=createSceneEvent({description:'Mara found a key',witnessIds:[mara.id]});
  scene.sceneEvents=[e];
  assert.equal(actorVisibleEvents(scene,elise.id).length,0);
  assert.equal(actorVisibleEvents(scene,mara.id).length,1);
  scene.messages=[{id:crypto.randomUUID(),role:'assistant',content:'Hello',speakerId:mara.id}];
  const state={characters:[mara,elise],sessions:[scene],activeSessionId:scene.id};
  const copy=duplicateSession(state,scene.id);
  assert.notEqual(copy.id,scene.id);
  assert.notEqual(copy.messages[0].id,scene.messages[0].id);
  assert.notEqual(copy.sceneEvents[0].id,scene.sceneEvents[0].id);
  archiveCharacter(state,mara.id);
  assert.equal(state.characters.length,2);
  assert.equal(state.sessions[0].messages[0].speakerId,mara.id);
  archiveSession(state,copy.id);
  assert.equal(state.activeSessionId,scene.id);
  const roundtrip=normalizeState({...state,persona:{name:'Player'},lore:[],settings:{}});
  assert.equal(roundtrip.sessions.length,2);
  assert.equal(roundtrip.sessions[0].trashedAt !== null,true);
});

test('a scene with empty cast safely has no speaker',()=>{
  assert.equal(chooseSpeaker({castIds:[],messages:[]},[]),null);
  assert.equal(canKnowLore({visibility:'private',knownBy:['a']},'b'),false);
  assert.throws(()=>createSceneEvent({description:''}),/description/i);
});

test('permanent deletion refuses characters referenced by archived or active scenes',()=>{
  const {mara,elise,scene}=setup();
  const state={characters:[mara,elise],sessions:[scene],activeSessionId:scene.id};
  archiveCharacter(state,mara.id);
  assert.throws(()=>purgeArchived(state,'character',mara.id),/referenced/);
  archiveSession(state,scene.id);
  purgeArchived(state,'scene',scene.id);
  purgeArchived(state,'character',mara.id);
  assert.equal(state.characters.length,1);
  assert.equal(state.sessions.length,0);
});
