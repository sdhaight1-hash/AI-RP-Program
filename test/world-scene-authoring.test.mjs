import test from 'node:test';
import assert from 'node:assert/strict';
import {createCharacter} from '../engine.mjs';
import {AUTHORING_CONTRACTS,makeWorldAuthoringRequest,makeSceneAuthoringRequest,makeLocationAuthoringRequest,
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

test('changing guidance, selected field, cast, or current chronology invalidates an unfinished review',()=>{
  assert.notEqual(
    makeWorldAuthoringRequest({name:'Harbor',guidance:'Grounded'}).basis,
    makeWorldAuthoringRequest({name:'Harbor',guidance:'Surreal'}).basis);
  assert.notEqual(
    makeWorldAuthoringRequest({name:'Harbor',target:'description'}).basis,
    makeWorldAuthoringRequest({name:'Harbor',target:'name'}).basis);
  const base={worldId,library,characters:[character],characterId:character.id,
    channelId:'text_message',scene:{id:'scene-1',recentDialogue:[{role:'user',content:'Hello'}]}};
  assert.notEqual(makeSceneAuthoringRequest({...base,guidance:'Calm'}).basis,
    makeSceneAuthoringRequest({...base,guidance:'Suspenseful'}).basis);
  assert.notEqual(makeSceneAuthoringRequest(base).basis,
    makeSceneAuthoringRequest({...base,scene:{id:'scene-1',recentDialogue:[{role:'user',content:'Goodbye'}]}}).basis);
  assert.throws(()=>makeSceneAuthoringRequest({...base,castIds:['foreign-actor',character.id]}),
    /unavailable or foreign-world/);
});

test('ongoing scene generator sees only active-world cast and existing scenes without rewriting old dialogue',()=>{
  const colleague={...createCharacter('Colleague'),worldId};
  const req=makeSceneAuthoringRequest({worldId,library,characters:[character,colleague],
    characterId:character.id,castIds:[character.id,colleague.id],
    channelId:'phone_call',target:'direction',scene:{id:'scene-1',
      recentDialogue:[{role:'user',content:'Where did the registry go?'}]},
    existing:{direction:'A call at sunset'}});
  assert.match(req.messages[0].content,/CURRENT direction of an ongoing/);
  assert.match(req.messages[0].content,/do not rewrite/i);
  assert.match(req.messages[1].content,/Colleague/);
  assert.match(req.messages[1].content,/Where did the registry go/);
  assert.match(req.messages[1].content,/A call at sunset/);
  assert.deepEqual(parseAuthoringSuggestions('{"direction":"The conversation stays tentative."}',req),
    {direction:'The conversation stays tentative.'});
});

test('World Atlas AI drafts are grounded in existing canon and typed location hierarchy',()=>{
  const req=makeLocationAuthoringRequest({worldId,library,parentId:'quay',kind:'building',
    name:'',description:'',target:'all',guidance:'Fishermen gather at first light.'});
  assert.deepEqual(req.fields,['name','description']);
  assert.match(req.messages[0].content,/ONE place inside an already established fictional world/);
  assert.match(req.messages[0].content,/belongs inside South Quay/);
  assert.match(req.messages[1].content,/Saltshore/);
  assert.match(req.messages[1].content,/Busy fishing docks/);
  assert.doesNotMatch(req.messages[1].content,/Forbidden Tower/);
  assert.deepEqual(selectReviewedSuggestions({request:req,
    output:'{"name":"Netmakers Hall","description":"A wooden net-weaving workshop."}',
    checked:{name:true,description:true},
    edits:{description:'A weathered workshop beside the docks.'}}),
    {name:'Netmakers Hall',description:'A weathered workshop beside the docks.'});
  assert.throws(()=>makeLocationAuthoringRequest({worldId,library,kind:'underwater castle'}),/Unknown location kind/);
  assert.throws(()=>makeLocationAuthoringRequest({worldId,library,kind:'room',parentId:'foreign'}),/does not belong/);
  assert.throws(()=>makeLocationAuthoringRequest({worldId:'another-world',library}),/correct world/);
});

test('Location generation rejects duplicate canon names and invalidates drafts on parent or kind changes',()=>{
  const req=makeLocationAuthoringRequest({worldId,library,kind:'building'});
  assert.throws(()=>parseAuthoringSuggestions('{"name":"South Quay"}',req),/already exists/);
  assert.throws(()=>selectReviewedSuggestions({request:req,
    output:'{"name":"New Quay"}',checked:{name:true},edits:{name:'South Quay'}}),
    /already exists/);
  assert.notEqual(req.basis,makeLocationAuthoringRequest({worldId,library,kind:'room'}).basis);
  assert.notEqual(req.basis,makeLocationAuthoringRequest({worldId,library,kind:'building',parentId:'quay'}).basis);
  assert.notEqual(req.basis,makeLocationAuthoringRequest({worldId,library,kind:'building',
    guidance:'Different creative direction'}).basis);
});
