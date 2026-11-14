import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorldPartitionStore } from '../world/partition-store.mjs';
import { makeInitialState } from '../engine.mjs';
import { appendPlayerMessage } from '../scene/append.mjs';
import { createApp } from '../server.mjs';
import { retrieveActorMemories } from '../memory/store.mjs';

const fixture=()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-append-'));
  const store=new WorldPartitionStore(dir),worldId=store.activeWorldId;
  const initial=makeInitialState();
  store.forWorld(worldId).save(initial,store.forWorld(worldId).load().revision,{worldId});
  const other=store.worlds.createWorld({name:'Foreign world'});
  const snapshot=store.forWorld(worldId).load();
  const scene=snapshot.state.sessions[0],actor=snapshot.state.characters[0];
  const make=()=>({worldId,sceneId:scene.id,revision:snapshot.revision,
    message:{id:randomUUID(),role:'user',content:'The blue lantern remains inside the cabinet.',
      channelId:scene.channelId,witnessIds:[actor.id],sentAt:Date.now()}});
  const close=()=>{store.close();rmSync(dir,{recursive:true,force:true});};
  return {store,worldId,otherId:other.id,scene,actor,snapshot,make,close};
};

test('actor-owned player append indexes witnessed dialogue without rewriting a different world',()=>{
  const f=fixture();
  try{
    const basis=f.make();
    const result=appendPlayerMessage(f.store.forWorld(f.worldId),basis);
    assert.equal(result.revision,basis.revision+1);
    assert.equal(result.message.id,basis.message.id);
    const saved=f.store.forWorld(f.worldId).load();
    assert.equal(saved.state.sessions[0].messages.at(-1).content,basis.message.content);
    const remembered=retrieveActorMemories(f.store.forWorld(f.worldId).db,{
      timelineId:saved.state.sessions[0].timelineId,actorId:f.actor.id,query:'blue lantern',limit:6});
    assert.ok(remembered.some(x=>x.sourceMessageId===basis.message.id));
    assert.equal(f.store.forWorld(f.otherId).load().state.sessions.length,0);
    assert.equal(f.store.forWorld(f.otherId).load().state.characters.length,0);
    assert.throws(()=>appendPlayerMessage(f.store.forWorld(f.worldId),basis),
      /revision changed/,'a second tab cannot replay the same revision');
  }finally{f.close();}
});

test('append fails closed on forged NPC, world, channel and witness provenance',()=>{
  const f=fixture();
  try{
    const good=f.make();
    const invalid=[
      {...good,message:{...good.message,role:'assistant'}},
      {...good,message:{...good.message,provisional:true}},
      {...good,message:{...good.message,channelId:'phone_call'}},
      {...good,message:{...good.message,witnessIds:['not-a-cast-member']}},
      {...good,message:{...good.message,id:'not-uuid'}},
      {...good,worldId:f.otherId},
      {...good,message:{...good.message,content:''}}
    ];
    for(const proposal of invalid)
      assert.throws(()=>appendPlayerMessage(f.store.forWorld(f.worldId),proposal));
    assert.equal(f.store.forWorld(f.worldId).load().revision,f.snapshot.revision);
    assert.equal(f.store.forWorld(f.worldId).load().state.sessions[0].messages.length,1);
    assert.equal(f.store.forWorld(f.worldId).db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{f.close();}
});

test('HTTP delta append requires correct world, scene, cast and current revision',async()=>{
  const f=fixture();
  const app=createApp({store:f.store,fetchImpl:async()=>{throw Error('No model')}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+app.address().port;
  const post=(input)=>fetch(base+'/api/scene/messages/append',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)
  });
  try{
    const original=f.make();
    const wrong=await post({...original,worldId:'unknown-world'});
    assert.equal(wrong.status,404);
    const foreign=await post({...original,worldId:f.otherId});
    assert.equal(foreign.status,422);
    const forged=await post({...original,message:{...original.message,
      witnessIds:['different-actor']}});
    assert.equal(forged.status,422);
    assert.equal((await post({...original,message:{...original.message,role:'assistant'}})).status,422);
    const response=await post(original);
    assert.equal(response.status,201,await response.clone().text());
    const body=await response.json();
    assert.equal(body.revision,original.revision+1);
    assert.equal((await post(original)).status,409);
    const state=await(await fetch(base+'/api/state?worldId='+f.worldId)).json();
    assert.equal(state.revision,body.revision);
    assert.equal(state.state.sessions[0].messages.at(-1).id,original.message.id);
    const next=f.make();
    next.revision=state.revision;
    next.message.id=original.message.id;
    assert.equal((await post(next)).status,422,'duplicate message IDs are not allowed');
  }finally{
    await new Promise(resolve=>app.close(resolve));
    rmSync(f.store.dataDir,{recursive:true,force:true});
  }
});
