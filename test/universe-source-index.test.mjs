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
    const illegal=store.forWorld(worldId).load().state;
    illegal.sessions=[]; // cannot permanently delete a live scene without explicit archive and purge
    assert.throws(()=>store.forWorld(worldId).save(illegal,saved.revision+1,{worldId}),
      /permanent-delete|Archive first/);
    assert.ok(findUniverseSources(db,{query:'Market Square'}).length>0,
      'failed canonical writes must not leave new FTS state');
    const archived=store.forWorld(worldId).load().state;
    archived.sessions[0].trashedAt=Date.now();
    archived.characters[0].trashedAt=Date.now();
    store.forWorld(worldId).save(archived,saved.revision+1,{worldId});
    assert.equal(findUniverseSources(db,{query:'Market Square'}).length,0,
      'archiving a scene must remove its text from discovery');
    assert.equal(findUniverseSources(db,{query:'Docks Council'}).length,0,
      'archiving a character must remove their backstory from discovery');
    const purged=store.forWorld(worldId).load().state;
    purged.sessions=[];purged.characters=[];
    store.forWorld(worldId).save(purged,saved.revision+2,{
      worldId,purgedSceneId:scene.id,purgedCharacterId:character.id
    });
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

test('reviewed mention creates one linked canon record and retains source provenance after revisions',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-reviewed-provenance-'));
  const store=new WorldPartitionStore(dir);
  const worldId=store.activeWorldId;
  const server=createApp({store,fetchImpl:async()=>{throw Error('unused')}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const base='http://127.0.0.1:'+server.address().port;
    const request=async(endpoint,input)=>fetch(base+endpoint,{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    const char=createCharacter('Morgan');
    char.backstory='Morgan grew up in Copper Ward. The Willow Guild controlled trade.';
    const current=store.forWorld(worldId).load();
    const state=makeEmptyWorldState();state.characters=[char];
    const first=store.forWorld(worldId).save(state,current.revision,{worldId});
    const get=async focus=>(await(await fetch(base+'/api/worlds/discovery?worldId='+
      encodeURIComponent(worldId)+'&focus='+focus)).json());
    const groups=await get('groups');
    const guild=groups.suggestions.find(x=>x.name==='Willow Guild');
    assert.ok(guild,'indexed character backstory should surface social entry');
    const proof=guild.evidence.find(e=>e.fingerprint);
    assert.ok(proof,'source version is needed for a reviewable commit');
    const location=(await get('locations')).suggestions.find(x=>x.name==='Copper Ward');
    assert.ok(location);
    const created=await request('/api/worlds/entities',{
      worldId,name:guild.name,kind:'organization',
      description:'Trades local craftwork',sourceProof:proof
    });
    assert.equal(created.status,201,await created.clone().text());
    const entity=await created.json();
    assert.equal(entity.provenance.sourceStatus,'current');
    const duplicate=await request('/api/worlds/entities',{
      worldId,name:guild.name,kind:'organization',sourceProof:proof
    });
    assert.equal(duplicate.status,400);
    const located=await request('/api/worlds/locations',{
      worldId,name:location.name,kind:'neighborhood',
      description:'The historic dockside district',sourceProof:location.evidence.find(e=>e.fingerprint)
    });
    assert.equal(located.status,201,await located.clone().text());
    const place=await located.json();
    const before=store.forWorld(worldId).worlds.list().entryProvenance;
    assert.ok(before.some(p=>p.entryId===entity.id&&p.sourceStatus==='current'));
    assert.ok(before.some(p=>p.entryId===place.id&&p.sourceStatus==='current'));
    const altered=store.forWorld(worldId).load().state;
    altered.characters[0].backstory='Morgan abandoned her old trade relationships.';
    store.forWorld(worldId).save(altered,first.revision,{worldId});
    const provenance=store.forWorld(worldId).worlds.list().entryProvenance;
    assert.equal(provenance.find(p=>p.entryId===entity.id).sourceStatus,'changed');
    assert.equal(provenance.find(p=>p.entryId===place.id).sourceStatus,'changed');
    assert.ok(provenance.find(p=>p.entryId===entity.id).quote.includes('Willow Guild'));
    const stale=await request('/api/worlds/entities',{
      worldId,name:'Willow Circle',kind:'organization',sourceProof:proof
    });
    assert.equal(stale.status,400,'stale source evidence cannot establish a new canon entry');
    const foreign=store.worlds.createWorld({name:'Independent'});
    const cross=await request('/api/worlds/entities',{
      worldId:foreign.id,name:'Willow Circle',kind:'organization',sourceProof:proof
    });
    assert.notEqual(cross.status,201);
    assert.deepEqual(store.forWorld(foreign.id).worlds.list().entryProvenance,[]);
    store.forWorld(worldId).worlds.deleteEntry({worldId,kind:'entity',id:entity.id});
    store.forWorld(worldId).worlds.deleteEntry({worldId,kind:'location',id:place.id});
    assert.deepEqual(store.forWorld(worldId).worlds.list().entryProvenance,[],
      'Permanent canon deletion must also purge only that entry provenance');
    assert.equal(store.forWorld(worldId).db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});

test('the full stored scene transcript is searchable beyond the former 250-message cutoff',()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-long-transcript-index-'));
  const store=new WorldPartitionStore(dir);
  try{
    const worldId=store.activeWorldId;
    const char=createCharacter('Sable');
    const scene=createSession(char);
    scene.messages=Array.from({length:300},(_,i)=>({
      id:'source-msg-'+i,role:'user',
      content:i===0?'I arrived at Old Mill Square.':
        i===299?'I left the council at Northern Harbor.':'Routine city conversation '+i,
      witnessIds:[char.id]
    }));
    const story=makeEmptyWorldState();
    story.characters=[char];story.sessions=[scene];
    store.forWorld(worldId).save(story,store.forWorld(worldId).load().revision,{worldId});
    const db=store.forWorld(worldId).db;
    assert.ok(findUniverseSources(db,{query:'Old Mill Square'}).some(x=>x.id==='source-msg-0'));
    assert.ok(findUniverseSources(db,{query:'Northern Harbor'}).some(x=>x.id==='source-msg-299'));
    const indexed=db.prepare("SELECT count(*) AS count FROM universe_source_documents WHERE source_type='dialogue'").get().count;
    assert.equal(indexed,300);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
