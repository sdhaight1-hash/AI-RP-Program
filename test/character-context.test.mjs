import test from 'node:test';
import assert from 'node:assert/strict';
import { createCharacter, createSession, buildMessages, normalizeState } from '../engine.mjs';
import { createActorContext } from '../harness.mjs';
import { characterPlaceContext } from '../character/context.mjs';

const alpha = {activeWorldId:'a',locations:[
  {id:'home',worldId:'a',name:'Harbor Apartment'},
  {id:'shop',worldId:'a',name:'Bookshop'},
  {id:'cafe',worldId:'a',name:'Lantern Café'},
  {id:'secret',worldId:'b',name:'OTHER_WORLD_SECRET'}]};

test('world-scoped familiar places influence acting context without asserting present location',()=>{
  const c=createCharacter('Mara');
  Object.assign(c,{worldId:'a',homeLocationId:'home',workLocationId:'shop',frequentPlaces:[{locationId:'cafe',role:'favorite café',frequency:'weekends'}]});
  const notes=characterPlaceContext(c,alpha,'a');
  assert.match(notes,/Harbor Apartment/); assert.match(notes,/Bookshop/); assert.match(notes,/Lantern Café/);
  assert.doesNotMatch(notes,/OTHER_WORLD_SECRET/);
  const scene=createSession(c);scene.location='Library';
  const prompt=createActorContext({session:scene,characters:[c],actorId:c.id,persona:{name:'Player'},lore:[],buildMessages,worldPlaceNotes:notes}).messages[0].content;
  assert.match(prompt,/Established familiar places/); assert.match(prompt,/NOT current whereabouts/);
  assert.match(prompt,/Shared location: Library/);
  assert.doesNotMatch(prompt,/OTHER_WORLD_SECRET/);
});

test('foreign world and unavailable locations never enter character context',()=>{
  const c=createCharacter('Mara');c.worldId='a';c.homeLocationId='secret';
  assert.equal(characterPlaceContext(c,alpha,'b'),'');
  assert.equal(characterPlaceContext(c,alpha,'a'),'');
  assert.equal(characterPlaceContext(c,{...alpha,activeWorldId:'b'},'a'),'');
});

test('legacy encounter text becomes optional encounter canon, not recurring character narration',()=>{
  const c=createCharacter('Mara');
  c.scenario='OLD SCENARIO IN HARBOR';c.greeting='OLD GREETING AT DOOR';
  const scene=createSession(c);scene.messages=[];
  const state=normalizeState({characters:[c],sessions:[scene],lore:[],settings:{},persona:{name:'Player'}});
  const migrated=state.characters[0];
  assert.equal(migrated.scenario,undefined); assert.equal(migrated.greeting,undefined);
  assert.ok(state.encounters.some(e=>e.premise.includes('OLD SCENARIO')&&e.opening.includes('OLD GREETING')));
  const prompt=createActorContext({session:state.sessions[0],characters:state.characters,actorId:c.id,persona:state.persona,lore:[],buildMessages}).messages[0].content;
  assert.doesNotMatch(prompt,/OLD SCENARIO|OLD GREETING/);
});
