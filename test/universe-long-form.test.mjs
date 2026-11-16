import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorldPartitionStore} from '../world/partition-store.mjs';
import {createApp} from '../server.mjs';
import {findUniverseSources} from '../world/source-index.mjs';

test('long-form universe, blueprint, location and collective entries round-trip without losing indexed tail',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-long-form-canon-'));
  const store=new WorldPartitionStore(dir);
  const originalId=store.activeWorldId;
  const app=createApp({store,fetchImpl:async()=>{throw Error('Unused model')}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  let worldId,locationId,entityId;
  try{
    const base='http://127.0.0.1:'+app.address().port;
    const api=async(path,method,body)=>{
      const response=await fetch(base+path,{
        method,headers:{'Content-Type':'application/json'},
        body:JSON.stringify(body)
      });
      const data=await response.json();return {status:response.status,data};
    };
    const foundation='Foundational chronology. '.repeat(5000)+'The Longshore Guild was founded in 1702.';
    const rules='Every city has its own laws. '.repeat(3500)+'Teleportation cannot exist in the Northern Archipelago.';
    const initial=await api('/api/worlds','POST',{
      name:'Extensive Canon',description:foundation,
      blueprint:{rules,society:'The Verdant Culture has long oral traditions. '.repeat(3000)}
    });
    assert.equal(initial.status,201,JSON.stringify(initial.data).slice(0,500));
    worldId=initial.data.id;
    assert.equal(initial.data.description,foundation);
    assert.equal(store.activeWorldId,originalId);
    const catalog=store.forWorld(worldId).worlds.list();
    assert.equal(catalog.blueprint.sections.rules,rules);
    const newFoundation=foundation+' Additional historical material. '.repeat(3000);
    const amended=await api('/api/worlds','PATCH',{
      worldId,name:'Extensive Canon',description:newFoundation,
      expectedName:'Extensive Canon',expectedDescription:foundation
    });
    assert.equal(amended.status,200,JSON.stringify(amended.data).slice(0,500));
    assert.equal(amended.data.description,newFoundation.trim());
    const blueprintEdit=await api('/api/worlds/blueprint','PATCH',{
      worldId,revision:1,sections:{...catalog.blueprint.sections,
        conflicts:'Border tensions. '.repeat(5000)+'The Ember Council was founded in 1819.'}
    });
    assert.equal(blueprintEdit.status,200,JSON.stringify(blueprintEdit.data).slice(0,500));
    assert.equal(blueprintEdit.data.revision,2);
    const locationText='Detailed neighborhood architecture. '.repeat(4000)+
      'The location called Whispering Square appears far into the description.';
    const location=await api('/api/worlds/locations','POST',{
      worldId,name:'Longshore Quarter',kind:'neighborhood',description:locationText
    });
    assert.equal(location.status,201,JSON.stringify(location.data).slice(0,500));
    locationId=location.data.id;
    assert.equal(location.data.description,locationText);
    const groupText='Generations of community history. '.repeat(4000)+
      'The Starfall Circle coordinated port festivals.';
    const group=await api('/api/worlds/entities','POST',{
      worldId,name:'Longshore Community',kind:'community',description:groupText
    });
    assert.equal(group.status,201,JSON.stringify(group.data).slice(0,500));
    entityId=group.data.id;
    assert.equal(group.data.description,groupText);
    const updated=await api('/api/worlds/entities','PATCH',{
      worldId,id:entityId,name:'Longshore Community',kind:'community',
      description:groupText+' Expanded archival addendum.',
      expectedName:'Longshore Community',expectedKind:'community',
      expectedDescription:groupText
    });
    assert.equal(updated.status,200,JSON.stringify(updated.data).slice(0,500));
    assert.ok(updated.data.description.endsWith('Expanded archival addendum.'));
    const source=await fetch(base+'/api/worlds/discovery/sources?worldId='+worldId+'&query=Starfall');
    assert.equal(source.status,200);
    const sources=(await source.json()).sources;
    assert.ok(sources.some(x=>x.field.startsWith('description#')&&
      x.text.includes('Starfall Circle')),'full authored text must be indexed beyond the old 12K truncation');
    const db=store.forWorld(worldId).db;
    assert.ok(findUniverseSources(db,{query:'Whispering Square'})
      .some(x=>x.id===locationId&&x.field.startsWith('description#')));
    assert.ok(findUniverseSources(db,{query:'Northern Archipelago'})
      .some(x=>x.type==='blueprint'&&x.field.startsWith('rules#')));
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{
    await new Promise(resolve=>app.close(resolve));
  }
  const reopened=new WorldPartitionStore(dir);
  try{
    const scope=reopened.forWorld(worldId);
    const library=scope.worlds.list();
    assert.ok(library.worlds.some(w=>w.id===worldId&&w.description.includes('Additional historical material.')));
    assert.ok(library.locations.find(x=>x.id===locationId)?.description.includes('Whispering Square'));
    assert.ok(library.entities.find(x=>x.id===entityId)?.description.endsWith('Expanded archival addendum.'));
    assert.equal(library.blueprint.revision,2);
    assert.equal(scope.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{
    reopened.close();rmSync(dir,{recursive:true,force:true});
  }
});
