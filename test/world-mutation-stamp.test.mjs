import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorldPartitionStore} from '../world/partition-store.mjs';
import {makeInitialState} from '../engine.mjs';
import {createApp} from '../server.mjs';

test('in-flight actor context refuses changed canon even when story revision stays unchanged',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-world-stamp-'));
  const store=new WorldPartitionStore(dir),worldId=store.activeWorldId,scoped=store.forWorld(worldId);
  scoped.save(makeInitialState(),scoped.load().revision,{worldId});
  const story=scoped.load(),scene=story.state.sessions[0],
    actor=story.state.characters[0],timelineId=scene.timelineId;
  const location=scoped.worlds.createLocation({worldId,name:'World timeline station',kind:'building'});
  const originalRevision=story.revision;
  let pending=null;
  const mock=async url=>{
    if(String(url).endsWith('/api/extra/true_max_context_length'))
      return Response.json({value:4096});
    if(String(url).endsWith('/api/extra/tokencount')){
      if(pending){
        pending.started();
        await pending.hold;
      }
      return Response.json({value:400});
    }
    throw Error('Unexpected external request: '+url);
  };
  const app=createApp({store,fetchImpl:mock});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+app.address().port;
  const request=()=>fetch(base+'/api/actor/context',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({worldId,sceneId:scene.id,actorId:actor.id,
      revision:originalRevision,contextWindow:4096,max_tokens:300})
  });
  const deferred=()=>{
    let started,release;
    const startedPromise=new Promise(resolve=>started=resolve);
    const hold=new Promise(resolve=>release=resolve);
    pending={started,hold};
    return {startedPromise,release};
  };
  try{
    let gate=deferred();
    let inFlight=request();
    await gate.startedPromise;
    // Same SQLite writer connection: total_changes catches this.
    scoped.worlds.setActorLocation({timelineId,actorId:actor.id,locationId:location.id});
    assert.equal(scoped.load().revision,originalRevision,'world location does not bump story revision');
    gate.release();
    let response=await inFlight;
    assert.equal(response.status,409,await response.clone().text());
    assert.match((await response.json()).error,/world knowledge changed/i);

    gate=deferred();
    inFlight=request();
    await gate.startedPromise;
    // Another SQLite connection: PRAGMA data_version catches this.
    const other=new DatabaseSync(store.worldFile(worldId));
    try{
      other.prepare('UPDATE timeline_clocks SET instant_ms=? WHERE timeline_id=?')
        .run(Date.now()+3600000,timelineId);
    }finally{other.close();}
    assert.equal(scoped.load().revision,originalRevision);
    gate.release();
    response=await inFlight;
    assert.equal(response.status,409,await response.clone().text());
    assert.match((await response.json()).error,/world knowledge changed/i);

    pending=null;
    const stable=await request();
    assert.equal(stable.status,200,await stable.clone().text());
    assert.equal((await stable.json()).metadata.worldId,worldId);
  }finally{
    pending?.started&&void 0;
    await new Promise(resolve=>app.close(resolve));
    rmSync(dir,{recursive:true,force:true});
  }
});
