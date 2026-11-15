import test from 'node:test';
import assert from 'node:assert/strict';
import {createCharacter} from '../engine.mjs';
import {AUTHORING_CONTRACTS,makeWorldAuthoringRequest,makeSceneAuthoringRequest,
  parseAuthoringSuggestions,selectReviewedSuggestions} from '../authoring/world-scene.mjs';
import {createApp} from '../server.mjs';
import {StudioStore} from '../storage.mjs';

const worldId='independent-world';
const character={...createCharacter('Nessa'),worldId,description:'A reserved harbor cartographer.',
  personality:'Wry, patient, privately stubborn',backstory:'Raised by the salt marshes'};
const library={activeWorldId:worldId,
  worlds:[{id:worldId,name:'Saltshore',description:'A damp coastal city without magic'}],
  locations:[{id:'quay',worldId,name:'South Quay',kind:'outdoor',description:'Busy fishing docks'},
    {id:'foreign',worldId:'another-world',name:'Forbidden Tower',kind:'building'}],
  entities:[],relationships:[]};

test('world draft asks only for permitted field and preserves the existing authored seed',()=>{
  const req=makeWorldAuthoringRequest({name:'Ashfall',description:'Cold volcanic peninsula',target:'description',guidance:'Ordinary daily life'});
  assert.deepEqual(req.fields,['description']);
  assert.match(req.messages[0].content,/NEW, isolated world/);
  assert.match(req.messages[1].content,/Cold volcanic peninsula/);
  assert.match(req.messages[1].content,/Ordinary daily life/);
  assert.deepEqual(parseAuthoringSuggestions('{"description":"Coastal trade towns"}',req),
    {description:'Coastal trade towns'});
  assert.throws(()=>parseAuthoringSuggestions('{"name":"Unauthorized","description":"Okay"}',req),
    /unrelated field/);
  assert.throws(()=>parseAuthoringSuggestions('{"description":7}',req),/Invalid suggested/);
  assert.equal(AUTHORING_CONTRACTS.world.description.max,4000);
});

test('scene prompts are world, cast, medium, and encounter grounded with compartmentalized fields',()=>{
  const req=makeSceneAuthoringRequest({worldId,library,characters:[character],characterId:character.id,
    channelId:'phone_call',target:'atmosphere',existing:{title:'First Call'},
    guidance:'Awkward first contact',lore:[{title:'Harbor tax',content:'Cargo tariffs increased'}]});
  assert.deepEqual(req.fields,['atmosphere']);
  assert.match(req.messages[0].content,/no unseen visual cues/i);
  assert.match(req.messages[1].content,/Saltshore/);
  assert.match(req.messages[1].content,/Nessa/);
  assert.match(req.messages[1].content,/phone_call/);
  assert.doesNotMatch(req.messages[1].content,/Forbidden Tower/);
  const reviewed=selectReviewedSuggestions({request:req,output:'{"atmosphere":"Rain rattles against the microphone."}',
    checked:{atmosphere:true},edits:{atmosphere:'Distant gulls bleed through the line.'}});
  assert.deepEqual(reviewed,{atmosphere:'Distant gulls bleed through the line.'});
  assert.deepEqual(selectReviewedSuggestions({request:req,output:'{"atmosphere":"A gull calls."}',
    checked:{atmosphere:false},edits:{}}),{});
});

test('scene suggestions cannot change the cast, medium, world, or fictional event history',()=>{
  const make=options=>makeSceneAuthoringRequest({worldId,library,characters:[character],
    characterId:character.id,channelId:'text_message',...options});
  const req=make();
  assert.deepEqual(req.fields,['title','direction','atmosphere','authorNote']);
  assert.throws(()=>parseAuthoringSuggestions('{"messages":[{"role":"assistant","content":"Hello"}]}',req),
    /unrelated field/);
  assert.throws(()=>parseAuthoringSuggestions('{"worldId":"other"}',req),/unrelated field/);
  assert.throws(()=>make({worldId:'other-world'}),/correct world/);
  assert.throws(()=>make({channelId:'not-a-channel'}),/Unknown communication/);
  assert.throws(()=>make({encounter:{characterIds:['missing'],channelId:'text_message'}}),/unavailable/);
  assert.throws(()=>make({encounter:{characterIds:[character.id],channelId:'phone_call'}}),/medium changed/);
  const baseline=make({existing:{direction:'A quiet visit'}}).basis;
  assert.notEqual(baseline,make({existing:{direction:'A loud visit'}}).basis);
  assert.notEqual(baseline,make({channelId:'phone_call',existing:{direction:'A quiet visit'}}).basis);
});

test('editable JSON, size limits and unchecked fields are isolated',()=>{
  const req=makeWorldAuthoringRequest();
  const result=selectReviewedSuggestions({request:req,
    output:'```json\n{"name":"Northlight","description":"A believable independent country."}\n```',
    checked:{name:true,description:false},edits:{name:'Northlight Reaches'}});
  assert.deepEqual(result,{name:'Northlight Reaches'});
  assert.throws(()=>selectReviewedSuggestions({request:req,output:'{"name":"Northlight"}',
    checked:{name:true},edits:{name:'x'.repeat(121)}}),/Invalid reviewed/);
  assert.throws(()=>parseAuthoringSuggestions('{"name":"","description":"Fine"}',req),/Invalid suggested/);
});

test('world and scene authoring JS modules are explicitly served over local HTTP',async()=>{
  const store=new StudioStore(':memory:');
  const app=createApp({store,fetchImpl:async()=>{throw Error('No model needed')}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  try{
    const base='http://127.0.0.1:'+app.address().port;
    for(const [path,symbol] of [['/authoring/world-scene.mjs','makeSceneAuthoringRequest'],
      ['/world-scene-assist.mjs','mountWorldSceneAssistant']]){
      const r=await fetch(base+path);
      assert.equal(r.status,200,path);
      assert.match(await r.text(),new RegExp(symbol));
    }
    assert.equal((await fetch(base+'/authoring/private.mjs')).status,404);
  }finally{await new Promise(resolve=>app.close(resolve));}
});
