import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioStore } from '../storage.mjs';
import { makeInitialState } from '../engine.mjs';
import { addActorFact } from '../memory/facts.mjs';
import { buildActorContext } from '../context/assemble.mjs';

test('small-context NPC recall keeps relevant accepted events without flooding personally cued memory',()=>{
  const store=new StudioStore(':memory:');
  try {
    const state=makeInitialState(),actor=state.characters[0],scene=state.sessions[0];
    scene.messages=[{id:'promise-source',role:'user',
      content:'I will bring the copper lantern to your workshop.',
      witnessIds:[actor.id],sentAt:1000}];
    store.save(state,0);
    const saved=store.load().state.sessions[0];
    const timelineId=saved.timelineId,sceneId=saved.id;
    const worldId=store.worlds.list().timelines.find(x=>x.id===timelineId).worldId;
    const fact=addActorFact(store,{sceneId,actorId:actor.id,sourceMessageId:'promise-source',
      kind:'promise',text:'The player promised to bring the copper lantern to the workshop.'});

    const accepted=[];
    for(let i=0;i<7;i++){
      const revision=store.load().revision,current=store.load().state;
      current.sessions[0].messages.push({id:'npc-event-'+i,role:'assistant',
        speakerId:actor.id,witnessIds:[actor.id],content:'Daily report '+i,sentAt:2000+i});
      store.save(current,revision);
      const proposal=store.events.propose({sceneId,timelineId,sourceMessageId:'npc-event-'+i,
        description:i===2?'A copper lantern was placed on the workshop table.':'The harbor remained calm on day '+i+'.'});
      store.events.decide({proposalId:proposal.id,decision:'accept'});
    }
    assert.equal(store.events.visible(timelineId,actor.id).length,7);
    const current=store.load().state;
    current.sessions[0].messages.push({id:'topic',role:'user',content:'Do you remember the copper lantern promise?',
      witnessIds:[actor.id],sentAt:9000});
    store.save(current,store.load().revision);

    const prompt=buildActorContext({store,worldId,sceneId,actorId:actor.id,contextWindow:4096,maxOutput:400});
    const selected=prompt.metadata.evidence;
    assert.ok(selected.some(x=>x.kind==='fact'&&x.id===fact.id),
      'topic-matched personal promise should enter the actual prompt');
    assert.ok(selected.filter(x=>x.kind==='event').length<=2,
      'only the cued accepted event and newest event should compete for budget');
    assert.match(prompt.messages[0].content,/copper lantern/);

    const neutral=store.load().state;
    for(let i=0;i<2;i++)neutral.sessions[0].messages.push({
      id:'neutral-'+i,role:'user',content:'How has your morning been?',
      witnessIds:[actor.id],sentAt:10000+i
    });
    store.save(neutral,store.load().revision);
    const relaxed=buildActorContext({store,worldId,sceneId,actorId:actor.id,contextWindow:4096,maxOutput:400});
    assert.ok(relaxed.metadata.evidence.filter(x=>x.kind==='event').length<=1,
      'uncued historical events should not crowd the prompt');
  }finally{store.close();}
});
