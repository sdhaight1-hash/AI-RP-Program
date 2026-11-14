import test from 'node:test';
import assert from 'node:assert/strict';
import { createCharacter } from '../engine.mjs';
import { CHARACTER_V2_FIELDS } from '../character/schema.mjs';
import { CHARACTER_FIELD_CONTRACTS,fieldInstruction } from '../character/field-contracts.mjs';
import { makeCharacterDraftRequest,parseCharacterSuggestions,selectCharacterChanges } from '../character/authoring.mjs';

const world={activeWorldId:'harbor',worlds:[{id:'harbor',name:'Harbor City',description:'Contemporary coastal town'}],
  locations:[{id:'bookshop',worldId:'harbor',name:'The Old Bookshop',kind:'shop'}],entities:[],relationships:[]};
const actor=()=>Object.assign(createCharacter('Mara'),{
  worldId:'harbor',personality:'Guarded with strangers but gently playful with familiar people.',
  values:'Keeps promises and values honesty even when inconvenient.',
  familyHistory:'Her grandmother taught her to repair antique clocks.',
  occupation:'Restores clocks at a small workshop.',
  speechStyle:'Deliberate pauses and wry humor.',
  homeLocationId:'bookshop'
});

test('every durable field has its own precise objective, adjacent context and exclusion boundary',()=>{
  assert.deepEqual(Object.keys(CHARACTER_FIELD_CONTRACTS).sort(),[...CHARACTER_V2_FIELDS].sort());
  for(const key of CHARACTER_V2_FIELDS){
    const item=CHARACTER_FIELD_CONTRACTS[key];
    assert.ok(item.purpose.length>35,key+' missing meaningful purpose');
    assert.ok(item.boundary.length>20,key+' missing exclusion boundary');
    assert.ok(Array.isArray(item.related),key+' must declare relevant source fields');
    assert.ok(item.related.every(k=>CHARACTER_V2_FIELDS.includes(k)),key+' refers to nonexistent field');
    assert.match(fieldInstruction(key),new RegExp('^'+key+':'));
  }
});

test('single-field generation is compartmentalized but grounded in already filled related fields',()=>{
  const c=actor();
  const req=makeCharacterDraftRequest({character:c,target:'phoneStyle',worldLibrary:world,worldId:'harbor',
    guidance:'Use subtle tone changes.'});
  assert.deepEqual(req.fields,['phoneStyle']);
  assert.match(req.messages[0].content,/only the prose content for the single field "phoneStyle"/);
  assert.match(req.messages[1].content,/Audible voice, timing, pauses/);
  assert.match(req.messages[1].content,/No eye contact, clothing/);
  assert.match(req.messages[1].content,/Deliberate pauses and wry humor/);
  assert.match(req.messages[1].content,/Guarded with strangers/);
  assert.match(req.messages[1].content,/Keeps promises/);
  assert.match(req.messages[1].content,/Selected world/);
  assert.match(req.messages[1].content,/The Old Bookshop/);
  assert.equal(req.referenceSummary.focusedFields>0,true);
  assert.equal(req.referenceSummary.filledFields>=5,true);
  assert.deepEqual(parseCharacterSuggestions('She grows quieter during phone calls.',req),
    {phoneStyle:'She grows quieter during phone calls.'});
  assert.throws(()=>selectCharacterChanges({character:c,worldLibrary:world,worldId:'harbor',
    request:req,changes:{personality:'Suddenly outgoing'}}),/Unrequested/);
});

test('every field can be explicitly targeted except protected actor name',()=>{
  const c=actor();
  for(const key of CHARACTER_V2_FIELDS.filter(k=>k!=='name')){
    const req=makeCharacterDraftRequest({character:c,target:key,worldLibrary:world,worldId:'harbor'});
    assert.deepEqual(req.fields,[key]);
    assert.ok(req.messages[1].content.includes(fieldInstruction(key)));
  }
  assert.throws(()=>makeCharacterDraftRequest({character:c,target:'name',worldLibrary:world,worldId:'harbor'}),/Invalid character field/);
});

test('multi-field generation gives distinct contracts and cannot overwrite established fields',()=>{
  const c=actor();
  const req=makeCharacterDraftRequest({character:c,target:'full',worldLibrary:world,worldId:'harbor'});
  assert.equal(req.fields.length,4);
  assert.ok(!req.fields.includes('personality'));
  assert.ok(!req.fields.includes('values'));
  assert.equal(req.fields.every(x=>req.messages[1].content.includes(fieldInstruction(x))),true);
  const proposal=parseCharacterSuggestions(JSON.stringify(Object.fromEntries(req.fields.map(f=>[f,f+' draft']))),req);
  assert.deepEqual(Object.keys(proposal),req.fields);
  assert.deepEqual(selectCharacterChanges({character:c,worldLibrary:world,worldId:'harbor',request:req,changes:proposal}),proposal);
  c.values='Changed during generation';
  assert.throws(()=>selectCharacterChanges({character:c,worldLibrary:world,worldId:'harbor',request:req,changes:proposal}),/changed/);
});

test('phonestyle and usual environment never acquire another world or a current position',()=>{
  const c=actor();
  const withOther={...world,locations:[...world.locations,
    {id:'other',worldId:'alien',name:'SECRET_FOREIGN_CASTLE',kind:'castle'}]};
  const req=makeCharacterDraftRequest({character:c,target:'preferredEnvironment',
    worldLibrary:withOther,worldId:'harbor'});
  assert.match(req.messages[1].content,/not current position/i);
  assert.match(req.messages[1].content,/Typical surroundings/);
  assert.doesNotMatch(JSON.stringify(req.messages),/SECRET_FOREIGN_CASTLE/);
});
