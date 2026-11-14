import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorldPartitionStore } from '../world/partition-store.mjs';
import { createCharacter,createSession,makeEmptyWorldState } from '../engine.mjs';
import { createApp } from '../server.mjs';

const story = (name, secret) => {
  const character=createCharacter(name);
  character.personality=secret;
  const state=makeEmptyWorldState();
  state.characters=[character];
  state.sessions=[createSession(character)];
  state.activeSessionId=state.sessions[0].id;
  state.sessions[0].messages=[{id:'latest',role:'user',content:'How is your day?',
    witnessIds:[character.id],sentAt:1000}];
  return {state,character,scene:state.sessions[0]};
};
const get=(base,path)=>fetch(base+path).then(async r=>({status:r.status,data:await r.json()}));
const put=(base,worldId,revision,state)=>fetch(base+'/api/state',{
  method:'PUT',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({worldId,revision,state})
}).then(async r=>({status:r.status,data:await r.json()}));

test('two browser world IDs can read, edit, and query without changing global selection',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'rp-world-concurrent-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const store=new WorldPartitionStore(directory);
  const a=store.activeWorldId;
  const b=store.worlds.createWorld({name:'Independent B'}).id;
  const app=createApp({store,fetchImpl:async()=>{throw Error('No model service')}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>app.close(resolve)));
  const base='http://127.0.0.1:'+app.address().port;
  const A=story('A NPC','A_WORLD_KNOWLEDGE'),B=story('B NPC','B_WORLD_KNOWLEDGE');
  const unscoped=await fetch(base+'/api/state',{method:'PUT',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({revision:1,state:A.state})});
  assert.equal(unscoped.status,400,'partitioned world saves require an explicit world ID');
  assert.equal((await fetch(base+'/api/events/proposals?sceneId=x')).status,400,
    'world-bound history reads require an explicit world ID');
  const initialA=await get(base,'/api/state?worldId='+a);
  const initialB=await get(base,'/api/state?worldId='+b);
  assert.equal(initialA.data.worldId,a);
  assert.equal(initialB.data.worldId,b);
  assert.equal((await put(base,a,initialA.data.revision,A.state)).status,200);
  assert.equal((await put(base,b,initialB.data.revision,B.state)).status,200);
  // A legacy client may change the process default; scoped clients must not
  // be invalidated or silently routed into that world.
  assert.equal((await fetch(base+'/api/worlds/activate',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({worldId:b})})).status,200);
  const [first,second]=await Promise.all([
    get(base,'/api/state?worldId='+a),get(base,'/api/state?worldId='+b)]);
  assert.equal(first.data.state.characters[0].personality,'A_WORLD_KNOWLEDGE');
  assert.equal(second.data.state.characters[0].personality,'B_WORLD_KNOWLEDGE');
  assert.equal((await get(base,'/api/worlds?worldId='+a)).data.activeWorldId,a);
  assert.equal((await get(base,'/api/worlds?worldId='+b)).data.activeWorldId,b);
  const revisedA=first.data.state;
  revisedA.characters[0].personality='A_WORLD_UPDATED';
  assert.equal((await put(base,a,first.data.revision,revisedA)).status,200);
  const stale=await put(base,a,first.data.revision,revisedA);
  assert.equal(stale.status,409,'revision conflicts remain world-specific');
  assert.equal((await get(base,'/api/state?worldId='+b)).data.revision,second.data.revision);
  const location=await fetch(base+'/api/worlds/locations',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({worldId:a,name:'A-only hall',kind:'room'})});
  assert.equal(location.status,201);
  assert.equal((await get(base,'/api/worlds?worldId='+b)).data.locations.length,0);
  assert.equal((await get(base,'/api/worlds?worldId='+a)).data.locations.length,1);
  assert.equal((await get(base,'/api/state?worldId=missing-world')).status,404);
});

test('in-flight context assembly retains its original world even after default activation',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'rp-world-inflight-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const store=new WorldPartitionStore(directory);
  const a=store.activeWorldId;
  const b=store.worlds.createWorld({name:'Other world'}).id;
  const A=story('First NPC','FIRST_WORLD_SECRET'),B=story('Other NPC','SECOND_WORLD_SECRET');
  store.forWorld(a).save(A.state,store.forWorld(a).load().revision,{worldId:a});
  store.forWorld(b).save(B.state,store.forWorld(b).load().revision,{worldId:b});
  let notify,release;
  const started=new Promise(resolve=>notify=resolve);
  const waiting=new Promise(resolve=>release=resolve);
  const app=createApp({store,fetchImpl:async url=>{
    if(url.endsWith('/api/extra/true_max_context_length')){
      notify();await waiting;
      return new Response(JSON.stringify({value:4096}),{headers:{'Content-Type':'application/json'}});
    }
    if(url.endsWith('/api/extra/tokencount'))
      return new Response(JSON.stringify({value:300}),{headers:{'Content-Type':'application/json'}});
    throw Error('No backend');
  }});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>app.close(resolve)));
  const base='http://127.0.0.1:'+app.address().port;
  const original=store.forWorld(a).load();
  const contextPromise=fetch(base+'/api/actor/context',{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({worldId:a,sceneId:A.scene.id,actorId:A.character.id,
      revision:original.revision,contextWindow:4096,max_tokens:200})});
  await started;
  try {
    const switched=await fetch(base+'/api/worlds/activate',{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({worldId:b})});
    assert.equal(switched.status,200);
  } finally {release();}
  const response=await contextPromise;
  assert.equal(response.status,200,await response.clone().text());
  const result=await response.json();
  assert.equal(result.metadata.worldId,a);
  assert.match(result.messages[0].content,/FIRST_WORLD_SECRET/);
  assert.doesNotMatch(result.messages.map(x=>x.content).join(' '),/SECOND_WORLD_SECRET/);
});
