import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioStore } from '../storage.mjs';
import { createCharacter,makeInitialState } from '../engine.mjs';
import { createLocalSemanticRetriever } from '../memory/semantic.mjs';
import { buildActorContext } from '../context/assemble.mjs';

test('semantic recall still considers a relevant unpinned memory beyond 200 later observations',async()=>{
  const store=new StudioStore(':memory:');
  try{
    const state=makeInitialState(),actor=state.characters[0],other=createCharacter('Private witness');
    state.characters.push(other);
    const scene=state.sessions[0];scene.castIds=[actor.id,other.id];
    scene.messages=[
      {id:'very-old-pendant',role:'user',
        content:'I placed the silver pendant beneath the oak bench before the storm.',
        witnessIds:[actor.id],sentAt:100},
      {id:'private-secret',role:'user',content:'Hidden blue sapphire is in the locked cellar.',
        witnessIds:[other.id],sentAt:101},
      ...Array.from({length:230},(_,i)=>({
        id:'ordinary-'+i,role:'user',content:'Day '+i+' ordinary report from the waterfront.',
        witnessIds:[actor.id],sentAt:200+i})),
      {id:'cue',role:'user',content:'I worry that the rain might damage my jewelry.',
        witnessIds:[actor.id],sentAt:10000}
    ];
    store.save(state,0);
    const saved=store.load().state.sessions[0];
    const worldId=store.worlds.list().timelines.find(t=>t.id===saved.timelineId).worldId;
    const inputs=[];
    const semantic=createLocalSemanticRetriever({
      model:'deterministic-local',baseUrl:'http://127.0.0.1:1234/v1',threshold:0.8,
      fetchImpl:async(url,options)=>{
        assert.match(url,/\/v1\/embeddings$/);
        const batch=JSON.parse(options.body).input;
        inputs.push(...batch);
        assert.ok(!batch.some(x=>x.includes('blue sapphire')),
          'private witness evidence must never leave the actor boundary');
        return Response.json({data:batch.map((x,index)=>({
          index,embedding:/rain|jewelry|silver pendant/i.test(x)?[1,0]:[0,1]
        }))});
      }
    });
    const selected=await semantic.retrieve({store,worldId,sceneId:saved.id,
      actorId:actor.id,query:'Will the rain damage my jewelry?'});
    assert.ok(selected.some(x=>x.sourceMessageId==='very-old-pendant'),
      'an old, unpinned dialogue clue must not be discarded by a recency-only 96-row window');
    const packed=buildActorContext({store,worldId,sceneId:saved.id,actorId:actor.id,
      contextWindow:2048,maxOutput:350,semanticEvidence:selected});
    assert.ok(packed.metadata.evidence.some(x=>x.sourceMessageId==='very-old-pendant'),
      'evidence must survive to the final bounded prompt');
    assert.ok(inputs.some(x=>x.includes('silver pendant')));
  } finally {store.close();}
});
