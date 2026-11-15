import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorldPartitionStore} from '../world/partition-store.mjs';
import {makeInitialState} from '../engine.mjs';
import {writeStoryProjection,enablePrimaryProjection,enableVerifiedAppendJournal} from '../storage/normalized.mjs';
import {journalEnabled} from '../storage/append-journal.mjs';
import {appendAuthorizedPlayerMessage} from '../scene/verified-append.mjs';
import {createApp} from '../server.mjs';
import {backupWorldStorage} from '../scripts/backup-storage.mjs';
import {normalizeStorage} from '../scripts/normalize-storage.mjs';

function fixture({activate=true}={}){
  const dir=mkdtempSync(join(tmpdir(),'rp-authorized-append-'));
  const store=new WorldPartitionStore(dir),worldId=store.activeWorldId;
  const scoped=store.forWorld(worldId);
  const basis=scoped.load();
  scoped.save(makeInitialState(),basis.revision,{worldId});
  if(activate){
    const current=scoped.load(),db=scoped.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      writeStoryProjection(db,current.state,current.revision);
      enablePrimaryProjection(db,current);
      enableVerifiedAppendJournal(db,current);
      db.exec('COMMIT');
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  }
  const saved=scoped.load(),scene=saved.state.sessions[0],actor=saved.state.characters[0];
  const input=()=>({worldId,sceneId:scene.id,revision:scoped.load().revision,
    messageId:randomUUID(),content:'Please remember the cedar-key is beneath the desk.'});
  return {dir,store,scoped,worldId,scene,actor,input,
    close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('verified fast append is opt-in and cannot silently convert an unprepared world',()=>{
  const f=fixture({activate:false});
  try{
    const before=f.scoped.load();
    assert.equal(journalEnabled(f.scoped.db),false);
    assert.throws(()=>appendAuthorizedPlayerMessage(f.scoped,f.input()),/disabled/);
    assert.deepEqual(f.scoped.load(),before);
  }finally{f.close();}
});

test('authorized append persists one player turn, memories and epoch without rewriting sealed message rows',()=>{
  const f=fixture();
  try{
    const before=f.scoped.load();
    const rows=f.scoped.db.prepare('SELECT count(*) AS n FROM story_projection_messages').get().n;
    const compact=f.scoped.db.prepare('SELECT document FROM studio_state WHERE id=1').get().document;
    const input=f.input();
    const applied=appendAuthorizedPlayerMessage(f.scoped,input);
    assert.equal(applied.revision,before.revision+1);
    assert.equal(applied.message.id,input.messageId);
    assert.deepEqual(applied.message.witnessIds,[f.actor.id]);
    const after=f.scoped.load();
    assert.equal(after.state.sessions[0].messages.at(-1).id,input.messageId);
    assert.equal(f.scoped.db.prepare('SELECT count(*) AS n FROM story_projection_messages').get().n,rows);
    assert.equal(f.scoped.db.prepare('SELECT count(*) AS n FROM story_append_rows').get().n,1);
    assert.equal(f.scoped.db.prepare('SELECT document FROM studio_state WHERE id=1').get().document,compact);
    assert.equal(f.scoped.db.prepare('SELECT count(*) AS n FROM actor_memories WHERE source_message_id=?').get(input.messageId).n,1);
    assert.equal(f.scoped.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{f.close();}
});

test('forged role, witnesses, channel, replay or world cannot reach an append transaction',()=>{
  const f=fixture();
  try{
    const original=f.input(),before=f.scoped.load();
    for(const field of [{role:'assistant'},{witnessIds:['fake']},{channelId:'email'},{speakerId:f.actor.id}]){
      assert.throws(()=>appendAuthorizedPlayerMessage(f.scoped,{...original,...field}),/Invalid world-scoped/);
    }
    assert.throws(()=>appendAuthorizedPlayerMessage(f.scoped,{...original,worldId:'wrong-world'}),/Invalid world-scoped/);
    assert.deepEqual(f.scoped.load(),before);
    appendAuthorizedPlayerMessage(f.scoped,original);
    assert.throws(()=>appendAuthorizedPlayerMessage(f.scoped,original),/revision changed/i);
    assert.equal(f.scoped.db.prepare('SELECT count(*) AS n FROM story_append_rows').get().n,1);
  }finally{f.close();}
});

test('HTTP append is scoped to one world and never accepts a caller-supplied witness set',async()=>{
  const f=fixture();
  const app=createApp({store:f.store,fetchImpl:async()=>{throw Error('No model needed')}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  try{
    const base='http://127.0.0.1:'+app.address().port;
    const post=async input=>fetch(base+'/api/scene/player-append',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    assert.equal((await post({...f.input(),role:'assistant'})).status,422);
    const original=f.input();
    const accepted=await post(original);
    assert.equal(accepted.status,201,await accepted.clone().text());
    const output=await accepted.json();
    assert.equal(output.worldId,f.worldId);
    assert.deepEqual(output.message.witnessIds,[f.actor.id]);
    assert.equal((await post(original)).status,409);
    const snapshot=await(await fetch(base+'/api/state?worldId='+f.worldId)).json();
    assert.equal(snapshot.revision,output.revision);
    assert.equal(snapshot.state.sessions[0].messages.at(-1).id,original.messageId);
  }finally{
    await new Promise(resolve=>app.close(resolve));
    rmSync(f.dir,{recursive:true,force:true});
  }
});

test('append journal offline activation is backup-gated and never enabled by a dry-run',()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-journal-cutover-'));
  const data=join(dir,'live'),backup1=join(dir,'backup-shadow'),
    backup2=join(dir,'backup-primary'),backup3=join(dir,'backup-journal');
  try{
    const store=new WorldPartitionStore(data),worldId=store.activeWorldId;
    const scope=store.forWorld(worldId);
    scope.save(makeInitialState(),scope.load().revision,{worldId});
    store.close();
    assert.throws(()=>normalizeStorage(data,{journal:true}),/backup is required/);
    backupWorldStorage(data,backup1);
    assert.throws(()=>normalizeStorage(data,{journal:true,backupDir:backup1}),
      /normalized-primary/);
    normalizeStorage(data,{apply:true,backupDir:backup1});
    backupWorldStorage(data,backup2);
    normalizeStorage(data,{primary:true,backupDir:backup2});
    assert.equal(normalizeStorage(data).mode,'dry-run');
    const before=new WorldPartitionStore(data);
    assert.equal(journalEnabled(before.forWorld(worldId).db),false);
    before.close();
    backupWorldStorage(data,backup3);
    const cutover=normalizeStorage(data,{journal:true,backupDir:backup3});
    assert.equal(cutover.mode,'journal');
    assert.equal(cutover.worlds[0].result,'append-journal-enabled');
    const reopened=new WorldPartitionStore(data);
    try{
      const current=reopened.forWorld(worldId);
      assert.equal(journalEnabled(current.db),true);
      assert.equal(current.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    }finally{reopened.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
