import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorldPartitionStore } from '../world/partition-store.mjs';
import { makeInitialState } from '../engine.mjs';
import { characterDraftVersion,worldDraftVersion } from '../character/authoring.mjs';
import { createApp } from '../server.mjs';

const payload=(store,characterId,worldId)=>{
  const character=store.load().state.characters.find(x=>x.id===characterId);
  return {approval:'approve',worldId,characterId,revision:store.load().revision,
    profileVersion:characterDraftVersion(character),
    worldVersion:worldDraftVersion(store.worlds.list()),
    entry:{type:'entity',kind:'character',name:'Nessa',description:'Mara\'s aunt.',
      sourceField:'familyHistory',sourceQuote:'Her aunt Nessa ran the Lantern House.'}};
};
const request=(base,path,body)=>fetch(base+path,{method:'POST',
  headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});

test('world-entry API requires explicit review, persists source across restart and rejects stale world tab',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-world-bridge-'));
  const store=new WorldPartitionStore(dir),worldId=store.activeWorldId;
  let app,base;
  try {
    const state=makeInitialState();
    const character=state.characters[0];
    character.name='Mara';
    character.familyHistory='Her aunt Nessa ran the Lantern House.';
    store.save(state,store.load().revision,{worldId});
    const charId=character.id;
    const basis=payload(store,charId,worldId);
    app=createApp({store,fetchImpl:async()=>{throw Error('Not testing chat inference')}});
    await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
    base='http://127.0.0.1:'+app.address().port;

    const unapproved=await request(base,'/api/character/world-entries/approve',{...basis,approval:'draft'});
    assert.equal(unapproved.status,422);
    const good=await request(base,'/api/character/world-entries/approve',basis);
    assert.equal(good.status,201,JSON.stringify(await good.clone().json()));
    const created=await good.json();
    assert.equal(created.entry.worldId,worldId);
    const listing=await(await fetch(base+'/api/worlds')).json();
    assert.ok(listing.entities.some(e=>e.id===created.entry.id));
    const sources=await(await fetch(base+'/api/character/world-entries/sources?worldId='+
      encodeURIComponent(worldId)+'&characterId='+encodeURIComponent(charId))).json();
    assert.equal(sources.sources.length,1);
    assert.equal(sources.sources[0].entryId,created.entry.id);
    const duplicate=await request(base,'/api/character/world-entries/approve',basis);
    assert.equal(duplicate.status,409,'changed world version must invalidate the original proposal');

    const other=store.worlds.createWorld({name:'Separate world'});
    const switched=await request(base,'/api/worlds/activate',{worldId:other.id});
    assert.equal(switched.status,200);
    const blocked=await request(base,'/api/character/world-entries/approve',basis);
    assert.equal(blocked.status,409);
    await new Promise(resolve=>app.close(resolve));app=null;
    const reopened=new WorldPartitionStore(dir);
    try {
      reopened.activateWorld(worldId);
      assert.equal(reopened.db.prepare('SELECT count(*) AS total FROM character_world_sources WHERE world_id=?').get(worldId).total,1);
      assert.equal(reopened.worlds.list().entities.find(e=>e.id===created.entry.id).name,'Nessa');
      reopened.activateWorld(other.id);
      assert.equal(reopened.db.prepare('SELECT count(*) AS total FROM character_world_sources').get().total,0,
        'world B must not contain world A evidence');
    }finally{reopened.close();}
  }finally{
    if(app)await new Promise(resolve=>app.close(resolve));
    rmSync(dir,{recursive:true,force:true});
  }
});
