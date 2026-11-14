import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { StudioStore } from '../storage.mjs';
import { createCharacter,makeInitialState } from '../engine.mjs';
import { witnessedSourceMessages,validateMemorySuggestions,buildMemorySuggestionMessages } from '../memory/suggestions.mjs';
import { listActorFacts } from '../memory/facts.mjs';

function fixture() {
  const store=new StudioStore(':memory:');
  const state=makeInitialState(),actor=state.characters[0],other=createCharacter('Someone else');
  state.characters.push(other);
  const scene=state.sessions[0];scene.castIds=[actor.id,other.id];
  scene.messages=[
    {id:'visible',role:'user',content:'I promise to visit your bookstore tomorrow.',witnessIds:[actor.id],sentAt:1000},
    {id:'hidden',role:'user',content:'The secret vault opens at midnight.',witnessIds:[other.id],sentAt:2000},
  ];
  store.save(state,0);
  const saved=store.load().state.sessions[0];
  const worldId=store.worlds.list().timelines.find(t=>t.id===saved.timelineId).worldId;
  return {store,actor,other,scene:saved,worldId};
}

test('suggestion inputs include only messages witnessed by the acting NPC',()=>{
  const f=fixture();
  try {
    const sources=witnessedSourceMessages(f.scene,f.actor.id);
    assert.deepEqual(sources.map(x=>x.id),['visible']);
    const system=buildMemorySuggestionMessages({scene:f.scene,actor:f.actor,sourceMessages:sources});
    assert.match(system[1].content,/visit your bookstore tomorrow/);
    assert.doesNotMatch(system[1].content,/secret vault/);
    assert.throws(()=>witnessedSourceMessages(f.scene,'outsider'),/does not belong/);
  }finally{f.store.close();}
});

test('malformed, off-evidence, non-witness, and duplicate model memories are discarded',()=>{
  const f=fixture();
  try {
    const visible=witnessedSourceMessages(f.scene,f.actor.id);
    const raw={memories:[
      {sourceMessageId:'visible',kind:'promise',quote:'promise to visit your bookstore',text:'The player promised to visit the bookstore.'},
      {sourceMessageId:'hidden',kind:'observation',quote:'secret vault',text:'The vault opens at midnight.'},
      {sourceMessageId:'visible',kind:'belief',quote:'not actually said',text:'Fabricated belief.'},
      {sourceMessageId:'visible',kind:'promise',quote:'promise to visit your bookstore',text:'The player promised to visit the bookstore.'}
    ]};
    const result=validateMemorySuggestions(JSON.stringify(raw),visible);
    assert.equal(result.length,1);
    assert.equal(result[0].kind,'promise');
    assert.equal(validateMemorySuggestions('{broken JSON',visible).length,0);
  }finally{f.store.close();}
});

test('suggestion route returns evidence-validated proposals without writing memories',async()=>{
  const f=fixture();
  const app=createApp({store:f.store,fetchImpl:async (url,options)=>{
    if(!url.endsWith('/chat/completions'))throw Error('Only local model inference expected');
    const request=JSON.parse(options.body);
    assert.equal(request.stream,false);
    assert.doesNotMatch(JSON.stringify(request.messages),/secret vault/);
    return Response.json({choices:[{message:{content:JSON.stringify({memories:[
      {sourceMessageId:'visible',kind:'promise',quote:'I promise to visit your bookstore',text:'The player promised to visit the bookstore.'},
      {sourceMessageId:'hidden',kind:'observation',quote:'secret vault',text:'A secret vault opens at midnight.'}
    ]})}}]});
  }});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+app.address().port;
  try {
    const post=body=>fetch(url+'/api/actor/facts/suggest',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const payload={worldId:f.worldId,sceneId:f.scene.id,actorId:f.actor.id,model:'local-model',revision:1};
    assert.equal((await post({...payload,revision:0})).status,409);
    const res=await post(payload);
    assert.equal(res.status,200);
    const result=await res.json();
    assert.equal(result.suggestions.length,1);
    assert.equal(result.suggestions[0].sourceMessageId,'visible');
    assert.deepEqual(listActorFacts(f.store,{timelineId:f.scene.timelineId,actorId:f.actor.id}),[]);
  }finally{await new Promise(resolve=>app.close(resolve));}
});
