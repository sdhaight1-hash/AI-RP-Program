import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorldPartitionStore} from '../world/partition-store.mjs';
import {createApp} from '../server.mjs';
import {createCharacter} from '../engine.mjs';
import {emptyUniverseBlueprint,normalizeUniverseBlueprint} from '../world/blueprint.mjs';
import {makeBlueprintAuthoringRequest,makeSceneAuthoringRequest,
  parseAuthoringSuggestions} from '../authoring/world-scene.mjs';

test('universe blueprint is created, versioned, isolated, and survives SQLite restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-connical-blueprint-'));
  const store=new WorldPartitionStore(dir);
  const firstId=store.activeWorldId;
  const app=createApp({store,fetchImpl:async()=>{throw Error('Model not needed')}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  let newId;
  try {
    const base='http://127.0.0.1:'+app.address().port;
    const blueprint={...emptyUniverseBlueprint(),scope:'A coastal city and nearby archipelago',
      era:'Pre-industrial trade',rules:'Magic cannot reverse time',society:'Harbor guilds'};
    const create=await fetch(base+'/api/worlds',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name:'Bay Canon',description:'A grounded setting',blueprint})});
    assert.equal(create.status,201,await create.clone().text());
    const world=await create.json();newId=world.id;
    assert.equal(store.activeWorldId,firstId);
    const catalog=await(await fetch(base+'/api/worlds?worldId='+newId)).json();
    assert.equal(catalog.blueprint.worldId,newId);
    assert.equal(catalog.blueprint.revision,1);
    assert.deepEqual(catalog.blueprint.sections,blueprint);
    const patch=async input=>fetch(base+'/api/worlds/blueprint',{method:'PATCH',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    const update=await patch({worldId:newId,revision:1,
      sections:{...blueprint,conflicts:'Changing ocean currents'}});
    assert.equal(update.status,200,await update.clone().text());
    assert.equal((await update.json()).revision,2);
    const stale=await patch({worldId:newId,revision:1,sections:blueprint});
    assert.equal(stale.status,409);
    const malformed=await patch({worldId:newId,revision:2,
      sections:{...blueprint,fakeAdmin:'inject into canon'}});
    assert.equal(malformed.status,422);
    const authoritative=store.forWorld(newId).worlds.list().blueprint;
    assert.equal(authoritative.revision,2);
    assert.equal(authoritative.sections.conflicts,'Changing ocean currents');
    assert.equal(store.forWorld(firstId).worlds.list().blueprint.revision,0);
    assert.equal(store.activeWorldId,firstId);
    assert.equal(store.forWorld(newId).db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{await new Promise(resolve=>app.close(resolve));}
  const reopened=new WorldPartitionStore(dir);
  try {
    assert.equal(reopened.forWorld(newId).worlds.list().blueprint.sections.rules,
      'Magic cannot reverse time');
    assert.equal(reopened.forWorld(newId).worlds.list().blueprint.revision,2);
  }finally{reopened.close();rmSync(dir,{recursive:true,force:true});}
});

test('blueprint validator guards field limits and only permits explicit sections',()=>{
  assert.deepEqual(normalizeUniverseBlueprint(),emptyUniverseBlueprint());
  assert.throws(()=>normalizeUniverseBlueprint({arbitrary:'unsafe'}),/Unknown universe blueprint/);
  const extensiveRules='Detailed physical law. '.repeat(10000);
  assert.equal(normalizeUniverseBlueprint({rules:extensiveRules}).rules,extensiveRules.trim());
  assert.throws(()=>normalizeUniverseBlueprint({rules:'x'.repeat(1_000_001)}),/at most 1000000/);
  assert.throws(()=>normalizeUniverseBlueprint({rules:3}),/at most 1000000/);
});

test('scene and AI blueprint generation use only the correct Connical Universe',()=>{
  const worldId='universe-one',character=createCharacter('Iris');
  const blueprint={worldId,revision:4,sections:{...emptyUniverseBlueprint(),
    rules:'Time travel is impossible',society:'Guild-run harbors'}};
  const library={activeWorldId:worldId,
    worlds:[{id:worldId,name:'Harbor Canon',description:'An island city'}],
    locations:[{worldId,name:'West Harbor',kind:'settlement'},
      {worldId:'other-world',name:'Foreign Palace',kind:'palace'}],
    entities:[],relationships:[],timelines:[],blueprint};
  const req=makeBlueprintAuthoringRequest({worldId,library,
    name:'Harbor Canon',description:'An island city',
    sections:blueprint.sections,target:'rules'});
  assert.deepEqual(req.fields,['rules']);
  assert.match(req.messages[1].content,/West Harbor/);
  assert.doesNotMatch(req.messages[1].content,/Foreign Palace/);
  assert.throws(()=>parseAuthoringSuggestions('{"conflicts":"Unauthorized field"}',req),
    /unrelated field/);
  const scene=makeSceneAuthoringRequest({worldId,library,
    characters:[character],characterId:character.id,channelId:'in_person'});
  assert.match(scene.messages[1].content,/Time travel is impossible/);
  assert.doesNotMatch(scene.messages[1].content,/Foreign Palace/);
  assert.throws(()=>makeBlueprintAuthoringRequest({...req,worldId:'another',library}),
    /correct world/);
});
