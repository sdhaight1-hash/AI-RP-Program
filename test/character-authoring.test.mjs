import test from 'node:test';import assert from 'node:assert/strict';
import { createCharacter } from '../engine.mjs';
import { makeCharacterDraftRequest,parseCharacterSuggestions,selectCharacterChanges,gatherCharacterWorldContext } from '../character/authoring.mjs';
const library={activeWorldId:'alpha',worlds:[{id:'alpha',name:'Alpha Harbor',description:'Modern coastal city'},{id:'beta',name:'Beta Empire',description:'SPOILER_BETA'}],
  locations:[{id:'shop',worldId:'alpha',name:'Old Bookshop',kind:'building'},{id:'alien',worldId:'beta',name:'SECRET_BETA_LOCATION',kind:'town'}],
  entities:[{id:'mara',worldId:'alpha',name:'Mara',kind:'character',sourceCharacterId:'mara-char'},{id:'friend',worldId:'alpha',name:'Elise',kind:'character'},{id:'foreign',worldId:'beta',name:'SECRET_BETA_CHARACTER'}],
  relationships:[{id:'r1',worldId:'alpha',fromId:'mara',toId:'friend',kind:'sister',notes:'Old friends'},{id:'r2',worldId:'beta',fromId:'foreign',toId:'foreign',kind:'secret',notes:'SECRET_BETA_RELATION'}]};

test('authoring context is scoped to an opened world and grounded people/places',()=>{
  const c=createCharacter('Mara');c.id='mara-char';c.worldId='alpha';c.homeLocationId='shop';
  const context=gatherCharacterWorldContext({character:c,worldLibrary:library,worldId:'alpha',lore:[{id:'l1',title:'Harbor',content:'Alpha lore'}]});
  assert.match(context.context,/Old Bookshop/);assert.match(context.context,/Elise/);assert.match(context.context,/Alpha lore/);
  assert.doesNotMatch(context.context,/SECRET_BETA/);
  assert.throws(()=>gatherCharacterWorldContext({character:c,worldLibrary:library,worldId:'beta'}),/Open/);
});

test('co-author focuses on missing fields and never accepts unrelated AI keys',()=>{
  const c=createCharacter('Mara');c.id='mara-char';c.worldId='alpha';c.personality='Quiet and wry';
  const request=makeCharacterDraftRequest({character:c,target:'full',worldLibrary:library,worldId:'alpha'});
  assert.ok(!request.fields.includes('personality'));
  assert.ok(request.fields.length<=4);
  const first=request.fields[0];
  const proposal=parseCharacterSuggestions(JSON.stringify({[first]:'Writes notes in old books',name:'BAD RENAME',occupation:'BAD OOC'}),request);
  assert.deepEqual(proposal,{[first]:'Writes notes in old books'});
  assert.deepEqual(selectCharacterChanges({character:c,worldLibrary:library,worldId:'alpha',request,changes:proposal}),proposal);
  c.personality='Changed';
  assert.throws(()=>selectCharacterChanges({character:c,worldLibrary:library,worldId:'alpha',request,changes:proposal}),/changed/);
});

test('single-target AI edits are permitted only for the named field',()=>{
  const c=createCharacter('Mara');c.worldId='alpha';c.textStyle='long paragraphs';
  const request=makeCharacterDraftRequest({character:c,target:'textStyle',guidance:'short texts',worldLibrary:library,worldId:'alpha'});
  assert.deepEqual(parseCharacterSuggestions('short lower-case texts',request),{textStyle:'short lower-case texts'});
  assert.throws(()=>selectCharacterChanges({character:c,worldLibrary:library,worldId:'alpha',request,changes:{name:'Wrong'}}),/Unrequested/);
  const changed={...library,locations:[...library.locations,{id:'new',worldId:'alpha',name:'New cafe'}]};
  assert.throws(()=>selectCharacterChanges({character:c,worldLibrary:changed,worldId:'alpha',request,changes:{textStyle:'yes'}}),/changed/);
});


test('co-author drafts become stale when familiar-place assignments change',()=>{
  const c=createCharacter('Mara');c.worldId='alpha';
  const request=makeCharacterDraftRequest({character:c,target:'personality',worldLibrary:library,worldId:'alpha'});
  c.homeLocationId='shop';
  assert.throws(()=>selectCharacterChanges({character:c,worldLibrary:library,worldId:'alpha',request,changes:{personality:'Kind but guarded'}}),/changed/);
  const next=makeCharacterDraftRequest({character:c,target:'personality',worldLibrary:library,worldId:'alpha'});
  c.frequentPlaces=[{locationId:'shop',reason:'Reads here'}];
  assert.throws(()=>selectCharacterChanges({character:c,worldLibrary:library,worldId:'alpha',request:next,changes:{personality:'Calm'}}),/changed/);
});
