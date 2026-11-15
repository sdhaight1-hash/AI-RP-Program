import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorldPartitionStore} from '../world/partition-store.mjs';
import {makeInitialState} from '../engine.mjs';
import {createApp} from '../server.mjs';

test('Connical Universe identity is editable without changing universe, timeline or character IDs',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-universe-edit-'));
  const store=new WorldPartitionStore(dir);
  const worldId=store.activeWorldId;
  const scoped=store.forWorld(worldId);
  const basis=scoped.load();
  scoped.save(makeInitialState(),basis.revision,{worldId});
  const before=scoped.load();
  const catalog=store.worlds.list(),old=catalog.worlds.find(w=>w.id===worldId);
  const timelineIds=catalog.timelines.map(t=>t.id);
  const app=createApp({store,fetchImpl:async()=>{throw Error('Local model not required')}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  try{
    const base='http://127.0.0.1:'+app.address().port;
    const patch=async params=>fetch(base+'/api/worlds',{method:'PATCH',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(params)});
    const update={worldId,name:'The Saltwater Canon',description:'A revised independent setting',
      expectedName:old.name,expectedDescription:old.description};
    const changed=await patch(update);
    assert.equal(changed.status,200,await changed.clone().text());
    const result=await changed.json();
    assert.equal(result.id,worldId);
    assert.equal(result.name,update.name);
    const renamed=store.worlds.list().worlds.find(w=>w.id===worldId);
    assert.equal(renamed.name,update.name);
    assert.equal(renamed.description,update.description);
    assert.equal(scoped.db.prepare('SELECT name FROM worlds WHERE id=?').get(worldId).name,update.name);
    assert.deepEqual(store.worlds.list().timelines.map(t=>t.id),timelineIds);
    assert.deepEqual(scoped.load().state,before.state);
    assert.equal(scoped.load().revision,before.revision);
    const stale=await patch({...update,name:'Stale overwrite'});
    assert.equal(stale.status,409);
    assert.equal(store.worlds.list().worlds.find(w=>w.id===worldId).name,update.name);
    const failed=await patch({...update,expectedName:update.name,
      expectedDescription:update.description,name:'',description:'invalid'});
    assert.equal(failed.status,422);
    const oversized=await patch({...update,expectedName:update.name,
      expectedDescription:update.description,name:'Valid',
      description:'🌌'.repeat(2001)});
    assert.equal(oversized.status,422);
    assert.equal(store.worlds.list().worlds.find(w=>w.id===worldId).name,update.name);
  }finally{await new Promise(resolve=>app.close(resolve));}
  const reopened=new WorldPartitionStore(dir);
  try{
    assert.equal(reopened.worlds.list().worlds.find(w=>w.id===worldId).name,'The Saltwater Canon');
    assert.equal(reopened.current.worlds.list().worlds.find(w=>w.id===worldId).name,'The Saltwater Canon');
    assert.deepEqual(reopened.load().state,before.state);
  }finally{reopened.close();rmSync(dir,{recursive:true,force:true});}
});

test('universe edits cannot target a foreign or nonexistent world',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-universe-scope-'));
  const store=new WorldPartitionStore(dir);
  const originalId=store.activeWorldId;
  const another=store.worlds.createWorld({name:'Other Connical Universe',description:'Independent'});
  const app=createApp({store,fetchImpl:async()=>{throw Error('Unused')}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  try{
    const request=await fetch('http://127.0.0.1:'+app.address().port+'/api/worlds',{
      method:'PATCH',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({worldId:another.id,name:'Nope',description:'',
        expectedName:another.name,expectedDescription:another.description})});
    assert.notEqual(request.status,200);
    assert.equal(store.worlds.list().worlds.find(x=>x.id===another.id).name,another.name);
    assert.equal(store.activeWorldId,originalId);
  }finally{await new Promise(resolve=>app.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
