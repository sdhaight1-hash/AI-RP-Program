import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioStore } from '../storage.mjs';
import { WorldPartitionStore } from '../world/partition-store.mjs';
import { makeInitialState,makeEmptyWorldState } from '../engine.mjs';
import { createApp } from '../server.mjs';
import { backupWorldStorage } from '../scripts/backup-storage.mjs';
import { normalizeStorage } from '../scripts/normalize-storage.mjs';
import { inspectWorldStorage } from '../scripts/storage-health.mjs';
import {
  writeStoryProjection,verifyStoryProjection,projectionPrimary,
  enablePrimaryProjection,readPrimaryStory
} from '../storage/normalized.mjs';

function staged(store) {
  const before=store.load();
  store.db.exec('BEGIN IMMEDIATE');
  try {
    writeStoryProjection(store.db,before.state,before.revision);
    const applied=enablePrimaryProjection(store.db,before);
    store.db.exec('COMMIT');
    return applied;
  } catch(error){if(store.db.isTransaction)store.db.exec('ROLLBACK');throw error;}
}
test('opt-in primary preserves scene history and accepted-event source locks across restart',()=>{
  const directory=mkdtempSync(join(tmpdir(),'rp-primary-'));
  const path=join(directory,'story.sqlite');
  try{
    let store=new StudioStore(path);
    const state=makeInitialState(),scene=state.sessions[0],actor=state.characters[0];
    scene.messages.push({id:'locked',role:'assistant',content:'A signed promise.',
      speakerId:actor.id,witnessIds:[actor.id],channelId:'in_person'});
    store.save(state,0);
    const timelineId=store.load().state.sessions[0].timelineId;
    const proposal=store.events.propose({sceneId:scene.id,timelineId,
      sourceMessageId:'locked',description:'The character made a promise'});
    store.events.decide({proposalId:proposal.id,decision:'accept'});
    const applied=staged(store);
    assert.equal(applied.revision,1);
    assert.equal(projectionPrimary(store.db),true);
    const metadata=JSON.parse(store.db.prepare('SELECT document FROM studio_state WHERE id=1').get().document);
    assert.deepEqual(metadata.characters,[]);
    assert.deepEqual(metadata.sessions,[]);
    assert.equal(store.load().state.sessions[0].messages.length,2);
    store.close();
    store=new StudioStore(path);
    try{
      const current=store.load();
      assert.equal(current.state.sessions[0].messages.at(-1).content,'A signed promise.');
      assert.equal(store.events.visible(timelineId,actor.id)[0].description,'The character made a promise');
      const tampered=structuredClone(current.state);
      tampered.sessions[0].messages.at(-1).content='Contradicted promise.';
      assert.throws(()=>store.save(tampered,current.revision),/Accepted world event locks/);
      assert.equal(store.load().revision,current.revision);
      const valid=structuredClone(current.state);
      valid.sessions[0].messages.push({id:'after-primary',role:'user',
        content:'A newly observed scene turn.',witnessIds:[actor.id]});
      store.save(valid,current.revision);
      const after=store.load();
      assert.equal(after.revision,2);
      assert.equal(after.state.sessions[0].messages.at(-1).id,'after-primary');
      assert.equal(verifyStoryProjection(store.db,after).status,'matched');
    } finally{store.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('large story saves exceed legacy 4 MB only after explicit primary cutover',()=>{
  const store=new StudioStore(':memory:');
  try{
    store.save(makeInitialState(),0);
    staged(store);
    const baseline=store.load(),state=baseline.state,actor=state.characters[0];
    for(let i=0;i<3100;i++)state.sessions[0].messages.push({
      id:'long-'+i,role:'user',content:'The repeated journal detail: '+'z'.repeat(1400),
      witnessIds:[actor.id],sentAt:i+1000
    });
    assert.ok(Buffer.byteLength(JSON.stringify(state),'utf8')>4_000_000);
    store.save(state,baseline.revision);
    const final=store.load();
    assert.equal(final.state.sessions[0].messages.length,3101);
    assert.equal(final.revision,2);
    assert.equal(verifyStoryProjection(store.db,final).status,'matched');
    assert.ok(Buffer.byteLength(store.db.prepare('SELECT document FROM studio_state WHERE id=1')
      .get().document,'utf8')<4_000_000);
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{store.close();}
});

test('primary failure rolls back both metadata revision and normalized records',()=>{
  const store=new StudioStore(':memory:');
  try {
    store.save(makeInitialState(),0);
    staged(store);
    const before=store.load();
    store.db.exec(`CREATE TRIGGER reject_primary_revision BEFORE UPDATE ON story_projection_meta
      BEGIN SELECT RAISE(ABORT,'primary synchronization denied'); END;`);
    const edited=structuredClone(before.state);
    edited.sessions[0].messages.push({id:'pending',role:'user',content:'Never committed.',
      witnessIds:[edited.characters[0].id]});
    assert.throws(()=>store.save(edited,before.revision),/primary synchronization denied/);
    assert.equal(store.load().revision,before.revision);
    assert.equal(store.load().state.sessions[0].messages.length,before.state.sessions[0].messages.length);
    assert.equal(projectionPrimary(store.db),true);
    assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length,0);
  }finally{store.close();}
});

test('backup-gated primary migration handles independent worlds and restores original snapshots',()=>{
  const directory=mkdtempSync(join(tmpdir(),'rp-primary-worlds-'));
  const data=join(directory,'data'),backup=join(directory,'backup');
  try{
    const store=new WorldPartitionStore(data),one=store.activeWorldId;
    const two=store.worlds.createWorld({name:'Another independent world'}).id;
    store.forWorld(one).save(makeInitialState(),store.forWorld(one).load().revision,{worldId:one});
    store.forWorld(two).save(makeEmptyWorldState(),store.forWorld(two).load().revision,{worldId:two});
    store.close();
    backupWorldStorage(data,backup);
    assert.throws(()=>normalizeStorage(data,{primary:true,backupDir:backup}),
      /Stage the normalized shadow projection/);
    normalizeStorage(data,{apply:true,backupDir:backup});
    const switched=normalizeStorage(data,{primary:true,backupDir:backup});
    assert.equal(switched.mode,'primary');
    assert.ok(switched.worlds.every(w=>w.result==='normalized-primary'));
    assert.ok(inspectWorldStorage(data).ok);
    const reopened=new WorldPartitionStore(data);
    try{
      assert.equal(reopened.forWorld(one).load().state.characters[0].name,'Mara Vale');
      assert.equal(reopened.forWorld(two).load().state.characters.length,0);
      assert.ok(projectionPrimary(reopened.forWorld(one).db));
      assert.ok(projectionPrimary(reopened.forWorld(two).db));
      assert.equal(readPrimaryStory(reopened.forWorld(one).db,{
        revision:reopened.forWorld(one).load().revision,
        document:reopened.forWorld(one).db.prepare('SELECT document FROM studio_state WHERE id=1').get().document
      }).characters[0].name,'Mara Vale');
    } finally{reopened.close();}
    // The pre-cutover copy remains a restorable, fully populated world.
    const restored=new WorldPartitionStore(backup);
    try {
      assert.equal(restored.forWorld(one).load().state.characters[0].name,'Mara Vale');
      assert.equal(projectionPrimary(restored.forWorld(one).db),false);
    }finally{restored.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('large primary story passes actual HTTP PUT/GET with scoped-world revisions',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'rp-primary-http-'));
  const store=new WorldPartitionStore(directory);
  const worldId=store.activeWorldId,other=store.worlds.createWorld({name:'Separate HTTP world'}).id;
  const scoped=store.forWorld(worldId);
  scoped.save(makeInitialState(),scoped.load().revision,{worldId});
  staged(scoped.current);
  const initial=scoped.load();
  const state=initial.state,actor=state.characters[0];
  for(let i=0;i<2800;i++)state.sessions[0].messages.push({
    id:'http-large-'+i,role:'user',content:'A long serialized transcript. '+'q'.repeat(1550),
    witnessIds:[actor.id],sentAt:1000+i
  });
  const body=JSON.stringify({revision:initial.revision,worldId,state});
  assert.ok(Buffer.byteLength(body,'utf8')>4_500_000);
  const app=createApp({store,fetchImpl:async()=>{throw Error('No model needed')}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+app.address().port;
  try{
    const put=()=>fetch(base+'/api/state',{method:'PUT',
      headers:{'Content-Type':'application/json'},body});
    const first=await put();
    assert.equal(first.status,200,await first.clone().text());
    const saved=await first.json();
    assert.equal(saved.revision,initial.revision+1);
    assert.equal((await put()).status,409,'stale full-document writes are still rejected');
    const response=await fetch(base+'/api/state?worldId='+encodeURIComponent(worldId));
    assert.equal(response.status,200);
    const actual=await response.json();
    assert.equal(actual.state.sessions[0].messages.length,2801);
    assert.equal(actual.state.sessions[0].messages.at(-1).id,'http-large-2799');
    assert.equal(actual.worldId,worldId);
    const foreign=await(await fetch(base+'/api/state?worldId='+encodeURIComponent(other))).json();
    assert.equal(foreign.state.characters.length,0);
    assert.equal(foreign.revision,1);
  }finally{
    await new Promise(resolve=>app.close(resolve));
    rmSync(directory,{recursive:true,force:true});
  }
});

test('legacy multiworld importer refuses a normalized-primary source without changing it',()=>{
  const directory=mkdtempSync(join(tmpdir(),'rp-primary-legacy-'));
  const file=join(directory,'studio.sqlite');
  try{
    const legacy=new StudioStore(file);
    legacy.save(makeInitialState(),0);
    staged(legacy);
    legacy.close();
    assert.throws(()=>new WorldPartitionStore(directory),
      /Legacy world migration does not support normalized-primary storage/);
    const restored=new StudioStore(file);
    try{
      assert.equal(restored.load().state.characters[0].name,'Mara Vale');
      assert.equal(projectionPrimary(restored.db),true);
      assert.equal(restored.load().revision,1);
    }finally{restored.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('unchanged primary message rows skip update triggers without weakening edit detection',()=>{
  const store=new StudioStore(':memory:');
  try{
    store.save(makeInitialState(),0);
    staged(store);
    const existing=store.load();
    store.db.exec(`CREATE TRIGGER forbid_redundant_projection_update
      BEFORE UPDATE ON story_projection_messages
      BEGIN SELECT RAISE(ABORT,'unchanged message should not be rewritten'); END;`);
    const noOp=store.save(existing.state,existing.revision);
    assert.equal(noOp.revision,existing.revision+1);
    assert.equal(store.load().state.sessions[0].messages.length,1);
    const changed=store.load();
    changed.state.sessions[0].messages[0].content='A modified source must be checked.';
    assert.throws(()=>store.save(changed,changed.revision),
      /unchanged message should not be rewritten/);
    assert.equal(store.load().revision,noOp.revision);
    assert.equal(verifyStoryProjection(store.db,store.load()).status,'matched');
  }finally{store.close();}
});
