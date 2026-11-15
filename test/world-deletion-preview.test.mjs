import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorldPartitionStore } from '../world/partition-store.mjs';
import { makeInitialState } from '../engine.mjs';
import { previewWorldDeletion } from '../world/deletion-preview.mjs';
import { createApp } from '../server.mjs';

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'rp-deletion-preview-'));
  const store=new WorldPartitionStore(dir),worldId=store.activeWorldId;
  const scoped=store.forWorld(worldId);
  const current=scoped.load();
  scoped.save(makeInitialState(),current.revision,{worldId});
  const foreign=store.worlds.createWorld({name:'Unrelated universe'});
  return {dir,store,worldId,scoped,foreignId:foreign.id,
    close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('impact report includes exact world-owned identities without deleting any records',()=>{
  const f=fixture();
  try{
    const before=f.scoped.load();
    const report=previewWorldDeletion(f.scoped,{worldId:f.worldId});
    assert.equal(report.mode,'world');
    assert.equal(report.worldId,f.worldId);
    assert.equal(report.revision,before.revision);
    assert.deepEqual(report.sceneIds,before.state.sessions.map(s=>s.id));
    assert.deepEqual(report.characterIds,before.state.characters.map(c=>c.id));
    assert.equal(report.records.messages,before.state.sessions[0].messages.length);
    assert.equal(report.destructiveOperationEnabled,false);
    assert.equal(report.backupVerified,false);
    assert.ok(report.blockers.length>=3);
    assert.deepEqual(f.scoped.load().state,before.state);
    assert.equal(f.scoped.load().revision,before.revision);
    assert.equal(f.store.forWorld(f.foreignId).load().state.sessions.length,0);
  }finally{f.close();}
});

test('timeline preview preserves shared character profiles and reports child fork dependencies',()=>{
  const f=fixture();
  try{
    const scene=f.scoped.load().state.sessions[0];
    const report=previewWorldDeletion(f.scoped,{worldId:f.worldId,timelineId:scene.timelineId});
    assert.equal(report.mode,'timeline');
    assert.deepEqual(report.timelineIds,[scene.timelineId]);
    assert.deepEqual(report.sceneIds,[scene.id]);
    assert.equal(report.characterDisposition,'referenced-only (profiles not owned by timeline)');
    assert.equal(report.records.locations,undefined);
    assert.throws(()=>previewWorldDeletion(f.scoped,{worldId:f.foreignId}),/Open the requested world/);
    assert.throws(()=>previewWorldDeletion(f.scoped,{worldId:f.worldId,timelineId:'unknown'}),/does not belong/);
  }finally{f.close();}
});

test('HTTP deletion preview is world scoped, non-destructive and refuses an unknown timeline',async()=>{
  const f=fixture();
  const app=createApp({store:f.store,fetchImpl:async()=>{throw Error('No model needed')}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  try{
    const base='http://127.0.0.1:'+app.address().port;
    const prior=f.scoped.load();
    const url=base+'/api/worlds/deletion-preview?worldId='+encodeURIComponent(f.worldId);
    const response=await fetch(url);
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(body.worldId,f.worldId);
    assert.deepEqual(body.sceneIds,prior.state.sessions.map(x=>x.id));
    assert.equal(body.destructiveOperationEnabled,false);
    const missing=await fetch(url+'&timelineId=missing-timeline');
    assert.equal(missing.status,422);
    assert.equal(f.scoped.load().revision,prior.revision);
  }finally{
    await new Promise(resolve=>app.close(resolve));
    rmSync(f.dir,{recursive:true,force:true});
  }
});
