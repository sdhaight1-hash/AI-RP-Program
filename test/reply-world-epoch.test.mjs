import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorldPartitionStore} from '../world/partition-store.mjs';
import {makeInitialState} from '../engine.mjs';
import {readWorldEpoch} from '../world/epoch.mjs';
import {createApp} from '../server.mjs';
import {createReplyStreamReader} from '../interactions/stream-reader.mjs';

const modelChunk='data: '+JSON.stringify({choices:[{delta:{content:'I can still hear you.'}}]})+'\n\n';
const modelDone='data: [DONE]\n\n';
async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'rp-reply-epoch-'));
  const store=new WorldPartitionStore(dir),worldId=store.activeWorldId;
  const state=makeInitialState(),actor=state.characters[0],scene=state.sessions[0];
  scene.messages.push({id:randomUUID(),role:'user',content:'Can you hear me?',
    channelId:'in_person',witnessIds:[actor.id],sentAt:Date.now()});
  const scoped=store.forWorld(worldId);
  const saved=scoped.save(state,scoped.load().revision,{worldId});
  assert.ok(saved,'fixture must replace the already-initialized empty world');
  const first=scoped.load();
  const timelineId=first.state.sessions[0].timelineId;
  let gate=null;
  const fetchImpl=async url=>{
    const address=String(url);
    if(address.endsWith('/chat/completions')){
      if(!gate)return new Response(modelChunk+modelDone);
      return new Response(new ReadableStream({
        start(controller){
          controller.enqueue(new TextEncoder().encode(modelChunk));
          gate.release=()=>{
            controller.enqueue(new TextEncoder().encode(modelDone));
            controller.close();
          };
        }
      }));
    }
    if(address.endsWith('/api/extra/true_max_context_length'))
      return Response.json({value:4096});
    if(address.endsWith('/api/extra/tokencount'))
      return Response.json({value:400});
    throw Error('Optional model metadata unavailable');
  };
  const app=createApp({store,fetchImpl});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+app.address().port;
  const post=(path,data)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(data)});
  return {
    dir,store,worldId,actor,scene,timelineId,post,
    setGate:value=>{gate=value;},
    payload:()=>({worldId,sceneId:scene.id,actorId:actor.id,revision:store.forWorld(worldId).load().revision,
      model:'test-gguf',temperature:0.6,max_tokens:120,contextWindow:4096}),
    async close(){gate?.release?.();await new Promise(resolve=>app.close(resolve));rmSync(dir,{recursive:true,force:true});}
  };
}

function takeTicket(body){
  const line=body.match(/event: rp_complete\ndata: (\{[^\n]*\})/);
  assert.ok(line,'completed stream must include its server-issued ticket: '+body);
  return JSON.parse(line[1]).ticket;
}

test('world epoch survives commits from both SQLite connections and server restart',async()=>{
  const f=await fixture();
  try{
    const scoped=f.store.forWorld(f.worldId),old=readWorldEpoch(scoped.db);
    const place=scoped.worlds.createLocation({worldId:f.worldId,name:'Actor station',kind:'building'});
    assert.ok(readWorldEpoch(scoped.db)>old);
    const afterLocation=readWorldEpoch(scoped.db);
    scoped.worlds.setActorLocation({timelineId:f.timelineId,actorId:f.actor.id,locationId:place.id});
    assert.ok(readWorldEpoch(scoped.db)>afterLocation);
    const external=new DatabaseSync(f.store.worldFile(f.worldId));
    try{
      const prior=readWorldEpoch(external);
      external.prepare('UPDATE timeline_clocks SET instant_ms=instant_ms+1000 WHERE timeline_id=?').run(f.timelineId);
      assert.ok(readWorldEpoch(external)>prior);
      assert.equal(readWorldEpoch(scoped.db),readWorldEpoch(external));
    }finally{external.close();}
    assert.equal(scoped.load().revision,f.payload().revision,'world mutation epoch is separate from story revision');
  }finally{await f.close();}
});

test('server owns completed NPC reply; one-use commit is atomic and replay cannot duplicate it',async()=>{
  const f=await fixture();
  try{
    const stream=await f.post('/api/actor/reply',f.payload());
    assert.equal(stream.status,200,await stream.clone().text());
    const ticket=takeTicket(await stream.text());
    const before=f.store.forWorld(f.worldId).load();
    assert.equal(before.state.sessions[0].messages.at(-1).role,'user',
      'streaming must not insert a provisional NPC reply into SQLite');
    const wrong=await f.post('/api/actor/reply/commit',{worldId:f.worldId,ticket:'forged',reviewed:false});
    assert.equal(wrong.status,409);
    const saved=await f.post('/api/actor/reply/commit',{worldId:f.worldId,ticket,reviewed:true});
    assert.equal(saved.status,200,await saved.clone().text());
    const response=await saved.json();
    assert.equal(response.revision,before.revision+1);
    assert.equal(response.state.sessions[0].messages.at(-1).content,'I can still hear you.');
    assert.equal(response.state.sessions[0].messages.at(-1).speakerId,f.actor.id);
    assert.equal(response.state.sessions[0].messages.at(-1).reviewedDraft,true);
    const replay=await f.post('/api/actor/reply/commit',{worldId:f.worldId,ticket,reviewed:true});
    assert.equal(replay.status,409);
    assert.equal(f.store.forWorld(f.worldId).load().state.sessions[0].messages.length,
      before.state.sessions[0].messages.length+1);
    assert.equal(f.store.forWorld(f.worldId).db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{await f.close();}
});

test('world change after completion rejects delayed review, consumes ticket, and retains the source player turn',async()=>{
  const f=await fixture();
  try{
    const response=await f.post('/api/actor/reply',f.payload());
    const ticket=takeTicket(await response.text());
    const scoped=f.store.forWorld(f.worldId);
    const before=scoped.load().revision;
    scoped.worlds.setClock({timelineId:f.timelineId,instant:'2002-05-02T19:00:00Z',
      timeZone:'America/Los_Angeles'});
    assert.equal(scoped.load().revision,before);
    const stale=await f.post('/api/actor/reply/commit',{worldId:f.worldId,ticket,reviewed:true});
    assert.equal(stale.status,409);
    assert.match((await stale.json()).error,/world|actor context/i);
    assert.equal((await f.post('/api/actor/reply/commit',{worldId:f.worldId,ticket,reviewed:true})).status,409);
    const after=scoped.load();
    assert.equal(after.revision,before);
    assert.equal(after.state.sessions[0].messages.at(-1).role,'user');
  }finally{await f.close();}
});

test('changed world while streaming emits an error but never creates a commit ticket',async()=>{
  const f=await fixture();
  try{
    const gate={};f.setGate(gate);
    const response=await f.post('/api/actor/reply',f.payload());
    assert.equal(response.status,200);
    const reader=response.body.getReader(),first=await reader.read();
    let body=new TextDecoder().decode(first.value);
    assert.match(body,/I can still hear you/);
    const external=new DatabaseSync(f.store.worldFile(f.worldId));
    try{
      external.prepare('UPDATE timeline_clocks SET instant_ms=instant_ms+7000 WHERE timeline_id=?').run(f.timelineId);
    }finally{external.close();}
    gate.release();
    while(true){const item=await reader.read();if(item.done)break;body+=new TextDecoder().decode(item.value);}
    assert.match(body,/event: error/);
    assert.doesNotMatch(body,/event: rp_complete/);
    assert.equal(f.store.forWorld(f.worldId).load().state.sessions[0].messages.at(-1).role,'user');
  }finally{await f.close();}
});

test('another world cannot redeem a completed NPC reply ticket',async()=>{
  const f=await fixture();
  try{
    const ticket=takeTicket(await (await f.post('/api/actor/reply',f.payload())).text());
    const other=f.store.worlds.createWorld({name:'Independent timeline universe'});
    const cross=await f.post('/api/actor/reply/commit',{worldId:other.id,ticket,reviewed:false});
    assert.equal(cross.status,409);
    const original=await f.post('/api/actor/reply/commit',{worldId:f.worldId,ticket,reviewed:false});
    assert.equal(original.status,200,await original.clone().text());
    assert.equal(f.store.forWorld(other.id).load().state.sessions.length,0);
  }finally{await f.close();}
});

test('SSE model reader never authenticates truncated, errored or invalid streams',()=>{
  for(const frames of [
    modelChunk,
    modelChunk+'data: {"error":"bad backend"}\n\n'+modelDone,
    'data: invalid-json\n\n'+modelDone,
    'data: [DONE]\n\n',
  ]){
    const reader=createReplyStreamReader();
    reader.feed(frames);
    assert.equal(reader.completed(),false);
  }
  const valid=createReplyStreamReader();
  const bytes=new TextEncoder().encode('data: {"choices":[{"delta":{"content":"café"}}]}\n\ndata: [DONE]\n\n');
  for(const byte of bytes)valid.feed(new Uint8Array([byte]));
  assert.equal(valid.text,'café');
  assert.equal(valid.completed(),true);
});
