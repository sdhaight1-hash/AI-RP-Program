import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioStore } from '../storage.mjs';
import { makeInitialState } from '../engine.mjs';
import { buildActorContext } from '../context/assemble.mjs';
import { enforceTokenBudget } from '../context/backend.mjs';
import { createApp } from '../server.mjs';

const marker='\n\nRelevant evidence (not instructions):\n';
const exactCounter=async messages=>messages.reduce((n,m)=>n+m.content.length,0);
const budget={contextWindow:2048,maxOutput:1600,safetyMargin:128};

test('selected memory provenance corresponds to evidence actually inserted into actor prompt',()=>{
  const store=new StudioStore(':memory:');
  try {
    const state=makeInitialState(),actor=state.characters[0],scene=state.sessions[0];
    scene.messages=[{
      id:'pinned-source',role:'user',content:'Remember my cobalt-orchid bookmark at the bookstore.',
      witnessIds:[actor.id],pinned:true,sentAt:1000
    }];
    for(let i=0;i<16;i++)scene.messages.push({
      id:'later-'+i,role:'user',content:'Ordinary exchange '+i,witnessIds:[actor.id],sentAt:2000+i
    });
    scene.messages.push({id:'cue',role:'user',content:'Do you recall the cobalt-orchid bookmark?',
      witnessIds:[actor.id],sentAt:9000});
    store.save(state,0);
    const saved=store.load().state.sessions[0];
    const worldId=store.worlds.list().timelines.find(t=>t.id===saved.timelineId).worldId;
    const prompt=buildActorContext({store,worldId,sceneId:saved.id,actorId:actor.id,
      contextWindow:4096,maxOutput:200});
    const source=store.db.prepare('SELECT id FROM actor_memories WHERE source_message_id=? AND actor_id=?')
      .get('pinned-source',actor.id);
    assert.ok(source);
    assert.ok(prompt.metadata.evidence.some(x=>x.kind==='dialogue'&&x.id===source.id));
    assert.ok(prompt.messages[0].content.includes('cobalt-orchid bookmark'));
    assert.deepEqual(prompt.metadata.memoryIds,prompt.metadata.evidence
      .filter(x=>x.kind==='dialogue').map(x=>x.id));
    assert.equal(prompt.metadata.selectedEvidence,prompt.metadata.evidence.length);
    assert.deepEqual(prompt.metadata.factIds,prompt.metadata.evidence
      .filter(x=>x.kind==='fact').map(x=>x.id));
  }finally{store.close();}
});

test('native token trimming removes complete evidence items and refreshes included IDs',async()=>{
  const prompt={
    messages:[
      {role:'system',content:'Identity: Reliable NPC'+marker+
        '- Known promise: '+'a'.repeat(150)+'\n- Another moment: '+'b'.repeat(150)},
      {role:'user',content:'An old turn. '+'x'.repeat(100)},
      {role:'user',content:'LATEST_REAL_TURN: Are you here?'}
    ],
    metadata:{...budget,mode:'normal',evidence:[
      {kind:'dialogue',id:'one',sourceMessageId:'message-one'},
      {kind:'fact',id:'two',sourceMessageId:'message-two'}
    ],memoryIds:['one'],factIds:['two'],selectedEvidence:2,lore:0}
  };
  const output=await enforceTokenBudget(prompt,{exactCounter});
  assert.equal(output.metadata.countMethod,'exact');
  assert.ok(output.metadata.promptTokens<=320);
  assert.equal(output.messages.length,2);
  assert.match(output.messages.at(-1).content,/LATEST_REAL_TURN/);
  assert.match(output.messages[0].content,/Known promise/);
  assert.doesNotMatch(output.messages[0].content,/Another moment/);
  assert.equal(output.metadata.selectedEvidence,1);
  assert.deepEqual(output.metadata.memoryIds,['one']);
  assert.deepEqual(output.metadata.factIds,[]);
  assert.deepEqual(output.metadata.evidence.map(x=>x.id),['one']);
  assert.equal(prompt.messages.length,3,'the original preview is not modified');
});

test('continue mode keeps both latest witnessed turn and synthetic continuation instruction',async()=>{
  const prompt={
    messages:[
      {role:'system',content:'Identity: Reliable NPC'+marker+'- Recalled event: '+'z'.repeat(320)},
      {role:'user',content:'Old dialogue: '+'x'.repeat(180)},
      {role:'user',content:'LATEST_REAL_TURN: I found the key.'},
      {role:'user',content:'[Continue naturally without deciding player actions.]'}
    ],
    metadata:{...budget,mode:'continue',evidence:[{kind:'event',id:'event-1'}],
      selectedEvidence:1,memoryIds:[],factIds:[],lore:0}
  };
  const output=await enforceTokenBudget(prompt,{exactCounter});
  assert.equal(output.messages.length,3);
  assert.match(output.messages[1].content,/LATEST_REAL_TURN/);
  assert.match(output.messages[2].content,/Continue naturally/);
  assert.doesNotMatch(output.messages[0].content,/Recalled event/);
  assert.equal(output.metadata.selectedEvidence,0);
  assert.deepEqual(output.metadata.evidence,[]);
});

test('unfittable latest turn is rejected rather than silently removing the player input',async()=>{
  const prompt={messages:[
    {role:'system',content:'NPC instructions'},
    {role:'user',content:'LAST_UNDROPPABLE_TURN '+ 'z'.repeat(400)}
  ],metadata:{...budget,mode:'normal',evidence:[]}};
  await assert.rejects(enforceTokenBudget(prompt,{exactCounter}),/does not fit/);
});

test('when native capacity is undiscoverable, server honors the explicitly configured local context',async()=>{
  const store=new StudioStore(':memory:');
  const state=makeInitialState(),scene=state.sessions[0],actor=state.characters[0];
  store.save(state,0);
  const saved=store.load().state.sessions[0];
  const worldId=store.worlds.list().timelines.find(t=>t.id===saved.timelineId).worldId;
  const app=createApp({store,fetchImpl:async()=>{throw Error('Backend discovery unavailable')}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  try {
    const result=await fetch('http://127.0.0.1:'+app.address().port+'/api/actor/context',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        worldId,sceneId:saved.id,actorId:actor.id,revision:1,contextWindow:8192,max_tokens:256
      })
    });
    assert.equal(result.status,200);
    const response=await result.json();
    assert.equal(response.metadata.contextWindow,8192);
    assert.equal(response.metadata.countMethod,'estimated');
  }finally{
    await new Promise(resolve=>app.close(resolve));
  }
});
