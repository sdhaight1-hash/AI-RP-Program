import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioStore } from '../storage.mjs';
import { makeInitialState,createCharacter } from '../engine.mjs';
import { addActorFact,revokeActorFact } from '../memory/facts.mjs';
import { retrieveActorMemories } from '../memory/store.mjs';
import { buildActorContext,estimateTokens } from '../context/assemble.mjs';
import { createLocalSemanticRetriever,cosine } from '../memory/semantic.mjs';
import { createApp } from '../server.mjs';

function fixture(){
  const store=new StudioStore(':memory:');
  const state=makeInitialState(),actor=state.characters[0],other=createCharacter('Unrelated NPC');
  state.characters.push(other);
  const scene=state.sessions[0];scene.castIds=[actor.id,other.id];
  scene.messages=[
    {id:'pendant',role:'user',content:'My silver pendant is under the oak bench.',witnessIds:[actor.id],sentAt:10},
    {id:'private',role:'user',content:'The hidden vault code is indigo-falcon.',witnessIds:[other.id],sentAt:11},
    {id:'fact-source',role:'user',content:'I will repair the bronze telescope.',witnessIds:[actor.id],sentAt:12},
    ...Array.from({length:45},(_,i)=>({id:'weather-'+i,role:'user',
      content:'Unrelated harbor forecast '+i+' was uneventful.',
      witnessIds:[actor.id],sentAt:100+i})),
    {id:'cue',role:'user',content:'I worry that the rain might ruin my jewelry.',
      witnessIds:[actor.id],sentAt:1000}
  ];
  store.save(state,0);
  const saved=store.load().state.sessions[0];
  const timelineId=saved.timelineId,worldId=store.worlds.list().timelines.find(x=>x.id===timelineId).worldId;
  return {store,actor,other,sceneId:saved.id,timelineId,worldId};
}

function stubVectors(seen=[]){
  return async (url,options)=>{
    assert.match(url,/\/v1\/embeddings$/);
    const body=JSON.parse(options.body);assert.equal(body.model,'test-embeddings');
    const input=body.input;
    assert.ok(Array.isArray(input));
    seen.push(...input);
    assert.ok(!input.some(s=>s.includes('indigo-falcon')),'other actor private data must never reach embedding service');
    return Response.json({data:input.map((v,index)=>({
      index,embedding:/jewelry|rain|silver pendant|oak bench/i.test(v)?[1,0,0]:
        /telescope/i.test(v)?[0,0,1]:[0,1,0]
    }))});
  };
}

function retriever(fetchImpl){
  return createLocalSemanticRetriever({baseUrl:'http://127.0.0.1:1234/v1',
    model:'test-embeddings',fetchImpl});
}

test('meaning-based memory can enter small prompt when lexical recall misses implicit jewelry cue',async()=>{
  const f=fixture();const sent=[];
  try{
    const query='I worry that the rain might ruin my jewelry.';
    const lexical=retrieveActorMemories(f.store.db,{timelineId:f.timelineId,
      actorId:f.actor.id,query,limit:8,excludeMessageIds:['cue']});
    assert.equal(lexical.some(x=>x.sourceMessageId==='pendant'),false);
    const semantic=await retriever(stubVectors(sent)).retrieve({store:f.store,
      worldId:f.worldId,sceneId:f.sceneId,actorId:f.actor.id,query});
    const matched=semantic.find(x=>x.sourceMessageId==='pendant');
    assert.ok(matched,'embedding should find paraphrased pendant memory');
    assert.ok(matched.similarity>=0.62);
    const prompt=buildActorContext({store:f.store,worldId:f.worldId,sceneId:f.sceneId,
      actorId:f.actor.id,contextWindow:2048,maxOutput:350,semanticEvidence:semantic});
    assert.ok(prompt.metadata.evidence.some(x=>x.kind==='dialogue'&&x.sourceMessageId==='pendant'));
    assert.ok(prompt.messages[0].content.includes('silver pendant'));
    assert.ok(estimateTokens(prompt.messages)<=2048-350-128);
    assert.ok(sent.some(x=>x.includes('silver pendant')));
    assert.ok(!sent.some(x=>x.includes('indigo-falcon')));
  }finally{f.store.close();}
});

test('semantic candidates cannot forge another actor memory or text even if manually injected',()=>{
  const f=fixture();
  try{
    const hidden=f.store.db.prepare('SELECT id FROM actor_memories WHERE timeline_id=? AND actor_id=? AND source_message_id=?')
      .get(f.timelineId,f.other.id,'private');
    assert.ok(hidden);
    const prompt=buildActorContext({store:f.store,worldId:f.worldId,sceneId:f.sceneId,
      actorId:f.actor.id,semanticEvidence:[
        {kind:'dialogue',id:hidden.id,text:'FORGED LEAK',sourceMessageId:'private'},
        {kind:'fact',id:'unknown',text:'FORGED FACT'}
      ]});
    assert.equal(prompt.metadata.semanticEligible,0);
    assert.doesNotMatch(prompt.messages.map(x=>x.content).join(' '),/FORGED LEAK|FORGED FACT|indigo-falcon/);
  }finally{f.store.close();}
});

test('revoked and invalid-source reviewed facts are excluded before embeddings, including after cache warming',async()=>{
  const f=fixture(),sent=[];const sem=retriever(stubVectors(sent));
  try{
    const fact=addActorFact(f.store,{sceneId:f.sceneId,actorId:f.actor.id,
      sourceMessageId:'fact-source',kind:'promise',
      text:'The player promised to repair the bronze telescope.'});
    await sem.retrieve({store:f.store,worldId:f.worldId,sceneId:f.sceneId,
      actorId:f.actor.id,query:'bronze telescope'});
    const atFirst=sent.filter(x=>x.includes('bronze telescope')).length;
    assert.ok(atFirst>0);
    revokeActorFact(f.store,{id:fact.id,actorId:f.actor.id,timelineId:f.timelineId});
    sent.length=0;
    const found=await sem.retrieve({store:f.store,worldId:f.worldId,sceneId:f.sceneId,
      actorId:f.actor.id,query:'bronze telescope'});
    assert.equal(found.some(x=>x.kind==='fact'&&x.id===fact.id),false);
    assert.equal(sent.some(x=>x.includes('The player promised to repair')),false,
      'revoked text is excluded even when its embedding was previously cached');
  }finally{f.store.close();}
});

test('semantic candidate embedding never includes post-fork parent memories',async()=>{
  const f=fixture(),sent=[];const sem=retriever(stubVectors(sent));
  try{
    const child=f.store.worlds.forkTimeline({timelineId:f.timelineId,name:'Alternate'});
    const base=f.store.load();
    const childScene=structuredClone(base.state.sessions[0]);
    childScene.id='child-scene';childScene.timelineId=child.id;childScene.messages=[];
    base.state.sessions.push(childScene);
    f.store.save(base.state,base.revision);
    const parent=f.store.load();
    parent.state.sessions.find(s=>s.id===f.sceneId).messages.splice(-1,0,{
      id:'parent-secret',role:'user',content:'A golden statue is buried by the lighthouse.',
      witnessIds:[f.actor.id],sentAt:999
    });
    f.store.save(parent.state,parent.revision);
    const fromChild=await sem.retrieve({store:f.store,worldId:f.worldId,
      sceneId:'child-scene',actorId:f.actor.id,query:'golden statue lighthouse'});
    assert.ok(!sent.some(x=>x.includes('A golden statue is buried')),
      'parent-only source content must not be sent as a candidate (the query itself is allowed)');
    assert.ok(!fromChild.some(x=>x.sourceMessageId==='parent-secret'));
    const inherited=f.store.db.prepare(
      'SELECT id FROM actor_memories WHERE timeline_id=? AND actor_id=? AND source_message_id=?'
    ).get(child.id,f.actor.id,'pendant');
    assert.ok(inherited,'child retains its authorized pre-fork snapshot');
  }finally{f.store.close();}
});

test('invalid embedding service configuration and malformed vectors fail safely',async()=>{
  assert.throws(()=>createLocalSemanticRetriever({model:'test',baseUrl:'https://example.org/v1'}),/loopback/);
  assert.equal(cosine([1,0],[0,1]),0);
  const f=fixture();
  try{
    const broken=retriever(async()=>Response.json({data:[{index:0,embedding:[1,NaN]}]}));
    await assert.rejects(broken.retrieve({store:f.store,worldId:f.worldId,
      sceneId:f.sceneId,actorId:f.actor.id,query:'jewelry'}),/Unexpected|invalid/);
  }finally{f.store.close();}
});

async function callContext(f,{semanticFetchImpl,revision=1}={}){
  const app=createApp({store:f.store,
    fetchImpl:async()=>{throw Error('No chat backend used in context preview');},
    semanticModel:'test-embeddings',semanticUrl:'http://127.0.0.1:1234/v1',
    semanticFetchImpl});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  try{
    const response=await fetch('http://127.0.0.1:'+app.address().port+'/api/actor/context',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({worldId:f.worldId,sceneId:f.sceneId,actorId:f.actor.id,
        revision,contextWindow:2048,max_tokens:350})
    });
    return {status:response.status,result:await response.json()};
  }finally{await new Promise(resolve=>app.close(resolve));}
}

test('server uses local embedding only when configured and gracefully falls back on service errors',async()=>{
  const f=fixture();
  const success=await callContext(f,{semanticFetchImpl:stubVectors()});
  assert.equal(success.status,200);
  assert.equal(success.result.metadata.semantic.status,'available');
  assert.ok(success.result.metadata.semantic.selected>=1);
  assert.ok(success.result.metadata.evidence.some(x=>x.sourceMessageId==='pendant'));
  // createApp owns and closes its test store; use a new fixture for fallback.
  const g=fixture();
  const fallback=await callContext(g,{semanticFetchImpl:async()=>new Response('unavailable',{status:503})});
  assert.equal(fallback.status,200);
  assert.equal(fallback.result.metadata.semantic.status,'fallback');
  assert.ok(fallback.result.messages.length>=2);
});

test('async embedding cannot return a prompt from an edited scene',async()=>{
  const f=fixture();let changed=false;
  const result=await callContext(f,{semanticFetchImpl:async (url,options)=>{
    if(!changed){
      changed=true;
      const current=f.store.load();
      current.state.sessions[0].messages.at(-1).content='The topic has changed.';
      f.store.save(current.state,current.revision);
    }
    return stubVectors()(url,options);
  }});
  assert.equal(result.status,409);
});
