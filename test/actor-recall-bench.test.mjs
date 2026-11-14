import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateActorRecall } from '../eval/actor-recall.mjs';
import { StudioStore } from '../storage.mjs';
import { makeInitialState } from '../engine.mjs';
import { buildActorContext } from '../context/assemble.mjs';

test('actor memory evidence funnel gates privacy, source validity, contextual recall and prompt budget',()=>{
  const report=evaluateActorRecall();
  assert.equal(report.schemaVersion,1);
  assert.deepEqual(report.windows,[2048,4096]);
  assert.equal(report.cases.length,6);
  assert.equal(report.negatives.length,6);
  assert.ok(report.cases.some(c=>c.style==='implicit'),
    'semantic misses remain visible as diagnostics even without an embedding model');
  const failures=report.gates.filter(x=>!x.pass).map(x=>x.id);
  assert.deepEqual(failures,[],JSON.stringify({scores:report.scores,
    missed:report.cases.flatMap(c=>c.located
      .filter(x=>!x.rank).map(x=>({case:c.id,missing:x.key}))),
    negatives:report.negatives,budgetFailures:report.budgetFailures},null,2));
});

test('evaluator is repeatable with a fresh isolated SQLite fixture on each invocation',()=>{
  const a=evaluateActorRecall(),b=evaluateActorRecall();
  assert.deepEqual(a.scores,b.scores);
  assert.deepEqual(a.negatives,b.negatives);
  assert.deepEqual(a.gates,b.gates);
  assert.equal(a.passing,b.passing);
});

test('continue prompt always retains the last real user turn alongside its synthetic cue',()=>{
  const store=new StudioStore(':memory:');
  try {
    const state=makeInitialState(),scene=state.sessions[0],actor=state.characters[0];
    scene.messages=Array.from({length:24},(_,i)=>({
      id:'older-'+i,role:'user',content:'The ordinary harbor shifted '+i+
        ' times through the evening without changing the agreement.',
      witnessIds:[actor.id],sentAt:1000+i
    }));
    scene.messages.push({id:'latest',role:'user',
      content:'LATEST_REAL_USER_TURN: I found the compass at last.',
      witnessIds:[actor.id],sentAt:2000});
    store.save(state,0);
    const saved=store.load().state.sessions[0];
    const worldId=store.worlds.list().timelines.find(t=>t.id===saved.timelineId).worldId;
    const prompt=buildActorContext({store,worldId,sceneId:saved.id,actorId:actor.id,
      mode:'continue',contextWindow:2048,maxOutput:400});
    assert.match(prompt.messages.at(-2).content,/LATEST_REAL_USER_TURN/);
    assert.match(prompt.messages.at(-1).content,/Continue naturally/);
  }finally{store.close();}
});

test('uncued continuity retains more recent dialogue than a topic-cued memory request',()=>{
  const store=new StudioStore(':memory:');
  try {
    const state=makeInitialState(),actor=state.characters[0],scene=state.sessions[0];
    scene.messages=Array.from({length:25},(_,i)=>({
      id:'inventory-'+i,role:'user',
      content:'Harbor inventory report '+i+' described the cargo manifest in careful detail. '+
        'Every crate was counted and checked against the shipping ledger twice. '+
        'The night shift compared supply routes before completing the written audit.',
      witnessIds:[actor.id],sentAt:1000+i
    }));
    scene.messages.push({id:'cue',role:'user',content:'How are you?',
      witnessIds:[actor.id],sentAt:2000});
    store.save(state,0);
    const saved=store.load().state.sessions[0];
    const worldId=store.worlds.list().timelines.find(t=>t.id===saved.timelineId).worldId;
    const build=()=>buildActorContext({store,worldId,sceneId:saved.id,
      actorId:actor.id,contextWindow:2048,maxOutput:400});
    const uncued=build();
    const next=store.load();
    next.state.sessions[0].messages.at(-1).content='What did the harbor inventory report say?';
    store.save(next.state,next.revision);
    const cued=build();
    assert.equal(uncued.metadata.evidenceHeadroomReserved,0,
      'ordinary small talk must not reserve memory headroom due to a Player: label');
    assert.ok(cued.metadata.evidenceHeadroomReserved>0,
      'cued older memories should receive space in the small context');
    assert.ok(uncued.metadata.recentMessages>cued.metadata.recentMessages,
      'uncued small talk should preserve more immediately recent context');
    assert.ok(cued.metadata.evidence.some(x=>x.kind==='dialogue'),
      'topic-cued history should make room for source-linked recall');
    assert.match(cued.messages.at(-1).content,/harbor inventory report/);
  }finally{store.close();}
});
