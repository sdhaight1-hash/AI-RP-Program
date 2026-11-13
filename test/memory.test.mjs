import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioStore } from '../storage.mjs';
import { createCharacter, createSession, makeInitialState } from '../engine.mjs';

test('FTS returns semantically ranked lexical candidates but never private lore to unauthorized actors',()=>{
  const store=new StudioStore(':memory:');
  try{
    const state=makeInitialState();const mara=state.characters[0];const elise=createCharacter('Elise');state.characters.push(elise);
    state.sessions[0].castIds=[mara.id,elise.id];
    state.lore=[
      {id:'public',title:'Clocktower',keywords:['clock'],content:'The harbor clocktower rings every hour.',visibility:'public'},
      {id:'secret',title:'Clocktower',keywords:['clock'],content:'Beneath the clocktower lies a forbidden chamber.',visibility:'private',knownBy:[mara.id]},
    ];
    assert.equal(store.save(state,0).revision,1);
    const visible=store.searchLore('clocktower',{actorId:elise.id,sessionId:state.sessions[0].id});
    assert.deepEqual(visible.map(x=>x.id),['public']);
    assert.deepEqual(new Set(store.searchLore('clocktower',{actorId:mara.id}).map(x=>x.id)),new Set(['public','secret']));
    state.lore[0].content='The lighthouse rings every hour.';state.lore[0].title='Lighthouse';state.lore[0].keywords=['beacon'];
    assert.equal(store.save(state,1).revision,2);
    const newMatches=store.searchLore('lighthouse',{actorId:elise.id});
    assert.equal(newMatches[0].id,'public');
    assert.equal(store.searchLore('clocktower',{actorId:elise.id}).length,0);
    assert.equal(store.save(state,1),null); // stale write cannot corrupt index
    assert.equal(store.searchLore('lighthouse',{actorId:elise.id}).length,1);
  }finally{store.close();}
});
