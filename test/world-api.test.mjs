import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { StudioStore } from '../storage.mjs';
import { makeInitialState } from '../engine.mjs';

async function runServer(fn) {
  const store=new StudioStore(':memory:');
  const server=createApp({store,fetchImpl:async()=>{throw Error('No inference needed')}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve=>server.close(resolve)); }
}
const post=(base,path,data)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});

test('world library HTTP endpoints create independent canon and timelines',async()=>runServer(async base=>{
  const blank=await(await fetch(base+'/api/worlds')).json();
  assert.equal(blank.worlds.length,0);
  const created=await post(base,'/api/worlds',{name:'Greyhaven',description:'Slice of life'});
  assert.equal(created.status,201);
  const world=await created.json();
  const timelineRes=await post(base,'/api/timelines',{worldId:world.id,name:'Main story'});
  assert.equal(timelineRes.status,201);
  const timeline=await timelineRes.json();
  const library=await(await fetch(base+'/api/worlds')).json();
  assert.equal(library.worlds.length,1);
  assert.equal(library.timelines[0].worldId,world.id);
  assert.equal(library.revisions[0].id,world.revision.id);
  const actors=await(await fetch(base+`/api/timelines/actors?timelineId=${encodeURIComponent(timeline.id)}`)).json();
  assert.equal(actors.actors[0].controller,'player');
  const invalid=await post(base,'/api/timelines',{worldId:'unknown',name:'Bad'});
  assert.equal(invalid.status,400);
  const badName=await post(base,'/api/worlds',{name:'  '});
  assert.equal(badName.status,400);
  const crossOrigin=await fetch(base+'/api/worlds',{method:'POST',headers:{origin:'https://other.invalid','Content-Type':'application/json'},body:'{}'});
  assert.equal(crossOrigin.status,403);
}));

test('world HTTP metadata remains consistent with persisted scene binding',async()=>runServer(async base=>{
  const world=await(await post(base,'/api/worlds',{name:'New world'})).json();
  const timeline=await(await post(base,'/api/timelines',{worldId:world.id,name:'Branch A'})).json();
  const story=makeInitialState();
  story.sessions[0].timelineId=timeline.id;
  const save=await fetch(base+'/api/state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:0,state:story})});
  assert.equal(save.status,200);
  const load=await(await fetch(base+'/api/state')).json();
  assert.equal(load.state.sessions[0].timelineId,timeline.id);
  assert.equal(load.state.sessions[0].title,story.sessions[0].title);
  const actors=await(await fetch(base+`/api/timelines/actors?timelineId=${timeline.id}`)).json();
  assert.equal(actors.actors.some(a=>a.controller==='npc'&&a.characterId===story.characters[0].id),true);
}));
