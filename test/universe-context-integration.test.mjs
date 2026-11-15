import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorldPartitionStore} from '../world/partition-store.mjs';
import {createCharacter,createSession,makeEmptyWorldState} from '../engine.mjs';
import {buildActorContext} from '../context/assemble.mjs';
import {gatherCharacterWorldContext,worldDraftVersion} from '../character/authoring.mjs';

test('character authoring sees only selected universe blueprint, canon entities and version changes',()=>{
  const character=createCharacter('Nova');
  const worldId='alpha';
  const base={activeWorldId:worldId,
    worlds:[{id:worldId,name:'Aether Haven',description:'Offshore archipelago'}],
    blueprint:{worldId,revision:1,sections:{rules:'Magic consumes heat',era:'Early steam',
      society:'Harbor guilds, not monarchy'}},
    locations:[{id:'dock',worldId,name:'Foundry Harbor',kind:'town'}],
    entities:[{id:'club',worldId,name:'Salt Guild',kind:'organization',
      description:'A public guild of shipwrights'},
      {id:'foreign',worldId:'beta',name:'Foreign Court',kind:'organization',
        description:'Their secret future plot'}],
    relationships:[]};
  const context=gatherCharacterWorldContext({worldLibrary:base,worldId,character});
  assert.match(context.context,/Magic consumes heat/);
  assert.match(context.context,/Early steam/);
  assert.match(context.context,/shipwrights/);
  assert.doesNotMatch(context.context,/Foreign Court/);
  assert.doesNotMatch(context.context,/secret future plot/);
  assert.notEqual(worldDraftVersion(base),worldDraftVersion({...base,
    blueprint:{...base.blueprint,revision:2,sections:{...base.blueprint.sections,
      rules:'Magic requires moonlight'}}}),
    'changes to reviewed world laws must invalidate unfinished character suggestions');
});

test('live NPC context respects objective universe constraints without importing foreign universe secrets',()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-universe-prompt-'));
  const store=new WorldPartitionStore(dir);
  try{
    const worldId=store.activeWorldId;
    store.worlds.saveBlueprint({worldId,revision:0,sections:{
      scope:'Three nearby islands',
      era:'Mechanical clocks and steam engines',
      rules:'Teleportation cannot exist here.'
    }});
    const character=createCharacter('Celia');
    const scene=createSession(character);
    scene.messages.push({id:'player-world-question',role:'user',
      content:'Can you instantly teleport us to another island?',witnessIds:[character.id]});
    const state=makeEmptyWorldState();
    state.characters=[character];state.sessions=[scene];
    store.forWorld(worldId).save(state,store.forWorld(worldId).load().revision,{worldId});
    const foreign=store.worlds.createWorld({name:'Magical realm',
      blueprint:{rules:'Teleportation is commonplace in every city'}});
    const prompt=buildActorContext({store:store.forWorld(worldId),worldId,sceneId:scene.id,
      actorId:character.id,contextWindow:4096,maxOutput:300});
    assert.match(prompt.messages[0].content,/Teleportation cannot exist here/);
    assert.match(prompt.messages[0].content,/steam engines/);
    assert.match(prompt.messages[0].content,/not necessarily knowledge the NPC can cite/);
    assert.doesNotMatch(prompt.messages[0].content,/Teleportation is commonplace/);
    assert.equal(prompt.metadata.worldId,worldId);
    assert.notEqual(prompt.metadata.worldId,foreign.id);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
