import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorldPartitionStore } from '../world/partition-store.mjs';
import { makeInitialState,makeEmptyWorldState } from '../engine.mjs';
import { backupWorldStorage } from '../scripts/backup-storage.mjs';
import { normalizeStorage } from '../scripts/normalize-storage.mjs';
import { projectionEnabled,verifyStoryProjection } from '../storage/normalized.mjs';

test('dry-run has no schema side effects; backed-up offline apply remains per-world and restart-safe',()=>{
  const temp=mkdtempSync(join(tmpdir(),'rp-projection-stage-'));
  const data=join(temp,'live'),backup=join(temp,'backup');
  try{
    const store=new WorldPartitionStore(data),a=store.activeWorldId;
    const b=store.worlds.createWorld({name:'World B'}).id;
    store.forWorld(a).save(makeInitialState(),store.forWorld(a).load().revision,{worldId:a});
    store.forWorld(b).save(makeEmptyWorldState(),store.forWorld(b).load().revision,{worldId:b});
    store.close();
    const planned=normalizeStorage(data);
    assert.equal(planned.mode,'dry-run');
    assert.equal(planned.worlds.length,2);
    assert.ok(planned.worlds.every(x=>x.result==='ready-to-normalize'));
    const before=new WorldPartitionStore(data);
    assert.equal(projectionEnabled(before.forWorld(a).db),false);
    assert.equal(projectionEnabled(before.forWorld(b).db),false);
    before.close();
    assert.throws(()=>normalizeStorage(data,{apply:true}),/backup is required/);
    backupWorldStorage(data,backup);
    const applied=normalizeStorage(data,{apply:true,backupDir:backup});
    assert.equal(applied.worlds.length,2);
    assert.ok(applied.worlds.every(x=>x.result==='normalized'));
    assert.ok(normalizeStorage(data,{apply:true,backupDir:backup})
      .worlds.every(x=>x.result==='already-normalized'));
    const reopened=new WorldPartitionStore(data);
    try{
      for(const id of [a,b]){
        const scoped=reopened.forWorld(id);
        assert.equal(verifyStoryProjection(scoped.db,scoped.load()).status,'matched');
      }
      const scoped=reopened.forWorld(a),before=scoped.load();
      before.state.sessions[0].messages.push({id:'new-staged-message',role:'user',
        content:'The journal is still here.',witnessIds:[before.state.characters[0].id]});
      scoped.save(before.state,before.revision,{worldId:a});
      assert.equal(verifyStoryProjection(scoped.db,scoped.load()).status,'matched');
      assert.equal(reopened.forWorld(b).load().state.sessions.length,0);
    }finally{reopened.close();}
  }finally{rmSync(temp,{recursive:true,force:true});}
});

test('stale backup blocks migration even if catalog world IDs still match',()=>{
  const temp=mkdtempSync(join(tmpdir(),'rp-projection-stale-'));
  const data=join(temp,'live'),backup=join(temp,'backup');
  try{
    let store=new WorldPartitionStore(data),id=store.activeWorldId;
    store.forWorld(id).save(makeInitialState(),store.forWorld(id).load().revision,{worldId:id});
    store.close();
    backupWorldStorage(data,backup);
    store=new WorldPartitionStore(data);
    const current=store.forWorld(id).load();
    current.state.characters[0].name='After backup';
    store.forWorld(id).save(current.state,current.revision,{worldId:id});
    store.close();
    assert.throws(()=>normalizeStorage(data,{apply:true,backupDir:backup}),
      /Backup does not match|Backup story differs/);
    const check=new WorldPartitionStore(data);
    try{assert.equal(projectionEnabled(check.forWorld(id).db),false);}
    finally{check.close();}
  }finally{rmSync(temp,{recursive:true,force:true});}
});


test('legacy snapshots without stable source IDs are rejected before schema staging',()=>{
  const temp=mkdtempSync(join(tmpdir(),'rp-projection-legacy-'));
  const data=join(temp,'live');
  try {
    const store=new WorldPartitionStore(data),id=store.activeWorldId;
    store.forWorld(id).save(makeInitialState(),store.forWorld(id).load().revision,{worldId:id});
    const file=store.worldFile(id);
    store.close();
    const db=new DatabaseSync(file);
    try{
      const document=JSON.parse(db.prepare('SELECT document FROM studio_state WHERE id=1').get().document);
      delete document.sessions[0].messages[0].id;
      db.prepare('UPDATE studio_state SET document=? WHERE id=1').run(JSON.stringify(document));
    }finally{db.close();}
    assert.throws(()=>normalizeStorage(data),/unstable IDs/);
    const inspect=new DatabaseSync(file,{readOnly:true});
    try{
      assert.equal(inspect.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='story_projection_meta'").get().n,0);
    }finally{inspect.close();}
  } finally {rmSync(temp,{recursive:true,force:true});}
});
