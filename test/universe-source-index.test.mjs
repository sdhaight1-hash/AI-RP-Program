import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorldPartitionStore} from '../world/partition-store.mjs';
import {createApp} from '../server.mjs';
import {makeEmptyWorldState,createCharacter,createSession} from '../engine.mjs';
import {findUniverseSources,syncUniverseSources} from '../world/source-index.mjs';

test('source indexing is atomic with story saves; edits and purges never leave ghost mentions',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-source-index-'));
  const store=new WorldPartitionStore(dir);
  const worldId=store.activeWorldId;
  const server=createApp({store,fetchImpl:async()=>{throw Error('unused')}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const base='http://127.0.0.1:'+server.address().port;
    const character=createCharacter('Iris');
    character.backstory='Iris lives in Cedar Market and joined the Lantern Guild.';
    const scene=createSession(character);
    scene.direction='Iris visits Amber Plaza.';
    const state=makeEmptyWorldState();
    state.characters=[character];
    state.sessions=[scene];
    const initial=store.forWorld(worldId).load();
    const saved=store.forWorld(worldId).save(state,initial.revision,{worldId});
    assert.equal(saved.revision,initial.revision+1);
    const db=store.forWorld(worldId).db;
    assert.ok(findUniverseSources(db,{query:'Cedar Market'}).some(x=>x.id===character.id));
    assert.ok(findUniverseSources(db,{query:'Lantern Guild'}).some(x=>x.id===character.id));
    const discover=async focus=>(await(await fetch(base+'/api/worlds/discovery?worldId='+
      encodeURIComponent(worldId)+'&focus='+focus)).json());
    const places=await discover('locations');
    assert.ok(places.suggestions.some(x=>x.name==='Cedar Market'));
    assert.ok(places.suggestions.some(x=>x.name==='Amber Plaza'));
    assert.ok(places.suggestions.some(x=>x.name==='Cedar Market'&&x.evidence.some(e=>e.fingerprint)));
    const collectives=await discover('groups');
    assert.ok(collectives.suggestions.some(x=>x.name==='Lantern Guild'));
    const unchanged=syncUniverseSources(db,{
      worldId,state:store.forWorld(worldId).load().state,library:store.forWorld(worldId).worlds.list()
    });
    assert.equal(unchanged.changed,0);
    assert.equal(unchanged.removed,0);

    const edited=store.forWorld(worldId).load().state;
    edited.characters[0].backstory='Iris lives in Eastbank and joined the Docks Council.';
    edited.sessions[0].direction='Iris visits Market Square.';
    store.forWorld(worldId).save(edited,saved.revision,{worldId});
    assert.equal(findUniverseSources(db,{query:'Cedar Market'}).length,0);
    assert.equal(findUniverseSources(db,{query:'Lantern Guild'}).length,0);
    assert.ok(findUniverseSources(db,{query:'Market Square'}).length>0);
    assert.equal((await discover('locations')).suggestions.some(x=>x.name==='Cedar Market'),false);
    const purged=store.forWorld(worldId).load().state;
    purged.sessions=[];purged.characters=[];
    store.forWorld(worldId).save(purged,saved.revision+1,{worldId,purgedSceneId:scene.id,purgedCharacterId:character.id});
    assert.equal(findUniverseSources(db,{query:'Market Square'}).length,0);
    assert.equal(findUniverseSources(db,{query:'Docks Council'}).length,0);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});

test('source retrieval is independently scoped per universe and quote searches treat punctuation literally',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-source-scope-'));
  const store=new WorldPartitionStore(dir);
  const first=store.activeWorldId;
  const second=store.worlds.createWorld({name:'Other continuity'});
  const a=store.forWorld(first),b=store.forWorld(second.id);
  try{
    const one=a.load();const s1=makeEmptyWorldState();
    const hero=createCharacter('Morgan');
    hero.backstory='Morgan works at Willow Harbor.';
    s1.characters=[hero];
    a.save(s1,one.revision,{worldId:first});
    assert.equal(findUniverseSources(b.db,{query:'Willow Harbor'}).length,0);
    const result=syncUniverseSources(b.db,{worldId:second.id,state:b.load().state,library:b.worlds.list()});
    assert.equal(result.worldId,second.id);
    assert.equal(findUniverseSources(b.db,{query:'Willow Harbor'}).length,0);
    assert.ok(findUniverseSources(a.db,{query:'Willow Harbor'}).length>0);
    assert.deepEqual(findUniverseSources(a.db,{query:'"* OR world:*'}),[]);
    assert.throws(()=>findUniverseSources(a.db,{query:'a'.repeat(121)}),/at most 120/);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
