import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioStore } from '../storage.mjs';
import { createCharacter,createSession,makeEmptyWorldState } from '../engine.mjs';
import { selectSemanticDialogueCandidates } from '../memory/candidates.mjs';
import { createLocalSemanticRetriever } from '../memory/semantic.mjs';
import { buildActorContext } from '../context/assemble.mjs';

test('mid-history uncued evidence remains eligible for actor-only embeddings and final prompt',async()=>{
  const store=new StudioStore(':memory:');
  try{
    const a=createCharacter('Acting NPC'),b=createCharacter('Private NPC');
    const state=makeEmptyWorldState(),scene=createSession(a);
    state.characters=[a,b];scene.castIds=[a.id,b.id];
    scene.messages=Array.from({length:241},(_,i)=>({
      id:'history-'+i,role:'user',witnessIds:[a.id],sentAt:i+100,
      content:i===113?'My opal locket is inside the wool wrapping.' :
        i===240?'Will the rain spoil my jewelry?':'Ordinary harbor record number '+i+'.'
    }));
    scene.messages.push({id:'private',role:'user',witnessIds:[b.id],sentAt:9000,
      content:'Hidden private message contains a black comet key.'});
    state.sessions=[scene];state.activeSessionId=scene.id;
    store.save(state,0);
    const saved=store.load().state.sessions[0],world=store.worlds.list().timelines
      .find(t=>t.id===saved.timelineId).worldId;
    const candidates=selectSemanticDialogueCandidates(store.db,{
      timelineId:saved.timelineId,actorId:a.id,query:'rain jewelry',limit:96});
    assert.ok(candidates.length<=96);
    assert.ok(candidates.some(x=>x.sourceMessageId==='history-113'),
      'temporal sampling must not erase the middle period entirely');
    assert.ok(!candidates.some(x=>x.sourceMessageId==='private'));
    assert.throws(()=>selectSemanticDialogueCandidates(store.db,{
      timelineId:saved.timelineId,actorId:'unknown',query:'secret',limit:96
    }),/not in this timeline/);
    const embedded=[];
    const semantic=createLocalSemanticRetriever({model:'local-test-vectors',
      baseUrl:'http://127.0.0.1:1234/v1',threshold:0.9,
      fetchImpl:async(url,options)=>{
        const input=JSON.parse(options.body).input;
        embedded.push(...input);
        assert.ok(input.every(x=>!x.includes('black comet key')));
        return Response.json({data:input.map((value,index)=>({
          index,embedding:/rain|jewelry|opal locket/i.test(value)?[1,0]:[0,1]
        }))});
      }});
    const evidence=await semantic.retrieve({store,worldId:world,sceneId:saved.id,
      actorId:a.id,query:'rain jewelry'});
    assert.ok(evidence.some(x=>x.sourceMessageId==='history-113'));
    const prompt=buildActorContext({store,worldId:world,sceneId:saved.id,
      actorId:a.id,contextWindow:2048,maxOutput:300,semanticEvidence:evidence});
    assert.ok(prompt.metadata.evidence.some(x=>x.sourceMessageId==='history-113'),
      'semantic clue must survive final context packing');
    assert.doesNotMatch(prompt.messages.map(x=>x.content).join(' '),/black comet key/);
    assert.ok(embedded.some(x=>x.includes('opal locket')));
  }finally{store.close();}
});
