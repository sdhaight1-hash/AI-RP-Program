import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorldPartitionStore} from '../world/partition-store.mjs';
import {createApp} from '../server.mjs';
import {verifyEntryImage} from '../world/media.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/+vXkAAAAASUVORK5CYII=','base64');
test('entry photo validation rejects forged MIME types, invalid bytes and oversized images',()=>{
  assert.equal(verifyEntryImage(png,'image/png'),'image/png');
  assert.throws(()=>verifyEntryImage(png,'image/jpeg'),/Invalid image/);
  assert.throws(()=>verifyEntryImage(Buffer.from('<svg>unsafe</svg>'),'image/svg+xml'),/Photo must/);
  assert.throws(()=>verifyEntryImage(Buffer.alloc(12_000_001),'image/png'),/Photo must/);
});

test('universe, place and collective galleries preserve bytes and captions; deletion cascades without cross-world access',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-visual-galleries-'));
  const store=new WorldPartitionStore(dir);
  const first=store.activeWorldId;
  const location=store.worlds.createLocation({
    worldId:first,name:'Willow Harbor',kind:'town',
    description:'A working waterfront'});
  const entity=store.worlds.createEntity({
    worldId:first,name:'Harbor Guild',kind:'organization',
    description:'Local boat builders'});
  const second=store.worlds.createWorld({name:'Another isolated setting'});
  const server=createApp({store,fetchImpl:async()=>{throw Error('No model required')}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let photoId,universePhotoId,groupId;
  try{
    const base='http://127.0.0.1:'+server.address().port;
    const upload=async(worldId,entryType,entryId,caption,mime='image/png',bytes=png)=>
      fetch(base+'/api/worlds/photos?'+new URLSearchParams({
        worldId,entryType,entryId,caption
      }),{method:'POST',headers:{'Content-Type':mime},body:bytes});
    const firstUpload=await upload(first,'location',location.id,'The waterfront at sunrise');
    assert.equal(firstUpload.status,201,await firstUpload.clone().text());
    const added=await firstUpload.json();photoId=added.id;
    assert.equal(added.caption,'The waterfront at sunrise');
    assert.equal(added.entryId,location.id);
    const worldUpload=await upload(first,'universe',first,'Setting mood board');
    assert.equal(worldUpload.status,201,await worldUpload.clone().text());
    universePhotoId=(await worldUpload.json()).id;
    const groupUpload=await upload(first,'entity',entity.id,'Guild emblem');
    assert.equal(groupUpload.status,201,await groupUpload.clone().text());
    groupId=(await groupUpload.json()).id;
    const catalog=store.worlds.list();
    assert.equal(catalog.photos.length,3);
    assert.ok(catalog.photos.every(x=>!Object.hasOwn(x,'bytes')&&!Object.hasOwn(x,'content')));
    const image=await fetch(base+'/api/worlds/photos/'+photoId+'?worldId='+encodeURIComponent(first));
    assert.equal(image.status,200);
    assert.equal(image.headers.get('content-type'),'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
    const other=await fetch(base+'/api/worlds/photos/'+photoId+'?worldId='+encodeURIComponent(second.id));
    assert.notEqual(other.status,200,'other universe cannot fetch photo bytes');
    const foreignUpload=await upload(second.id,'location',location.id,'Cross-world attempt');
    assert.notEqual(foreignUpload.status,201);
    assert.equal(store.forWorld(second.id).worlds.list().photos.length,0);
    const bogus=await upload(first,'entity',entity.id,'Not a PNG','image/png',Buffer.from('not a real PNG'));
    assert.notEqual(bogus.status,201);
    const caption=await fetch(base+'/api/worlds/photos',{method:'PATCH',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({worldId:first,id:photoId,caption:'Boats and salt air'})});
    assert.equal(caption.status,200);
    assert.equal((await caption.json()).caption,'Boats and salt air');
    store.worlds.updateEntity({worldId:first,id:entity.id,
      name:'Harbor Craft Guild',kind:'organization',description:'Local boat builders',
      expectedName:'Harbor Guild',expectedKind:'organization',expectedDescription:'Local boat builders'});
    assert.equal(store.worlds.list().photos.find(p=>p.id===groupId)?.entryId,entity.id,
      'renaming an organization does not orphan its visual identity');
    const remove=await fetch(base+'/api/worlds/photos',{method:'DELETE',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({worldId:first,id:photoId})});
    assert.equal(remove.status,200);
    const gone=await fetch(base+'/api/worlds/photos/'+photoId+'?worldId='+first);
    assert.equal(gone.status,404);
    store.worlds.deleteEntry({worldId:first,kind:'entity',id:entity.id});
    assert.equal(store.worlds.list().photos.find(p=>p.id===groupId),undefined,
      'permanent canon deletion also deletes attached photo BLOBs');
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    const preserved=await fetch(base+'/api/worlds/photos/'+universePhotoId+'?worldId='+first);
    assert.equal(preserved.status,200,'removing a group must not remove the universe image');
  }finally{await new Promise(resolve=>server.close(resolve));}
  const reopened=new WorldPartitionStore(dir);
  try{
    assert.equal(reopened.forWorld(first).worlds.list().photos.some(p=>p.id===universePhotoId),true);
    assert.equal(reopened.forWorld(first).worlds.list().photos.some(p=>p.id===groupId),false);
    assert.deepEqual(reopened.forWorld(second.id).worlds.list().photos,[]);
  }finally{reopened.close();rmSync(dir,{recursive:true,force:true});}
});

test('cover selection, gallery ordering and spoiler visibility are saved without leaking into player view',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-photo-controls-'));
  const store=new WorldPartitionStore(dir),worldId=store.activeWorldId;
  const place=store.worlds.createLocation({worldId,name:'Saffron Market',kind:'town'});
  const photos=['First photo','Second photo','Third photo'].map(caption=>
    store.worlds.addPhoto({worldId,entryType:'location',entryId:place.id,
      caption,mimeType:'image/png',bytes:png}));
  const server=createApp({store,fetchImpl:async()=>{throw Error('No model')}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const patch=async(id,body)=>{
    const response=await fetch(base+'/api/worlds/photos',{method:'PATCH',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({worldId,id,...body})});
    return {status:response.status,data:await response.json()};
  };
  try{
    assert.equal((await patch(photos[2].id,{cover:true})).status,200);
    assert.equal((await patch(photos[0].id,{visibility:'spoiler'})).status,200);
    assert.equal((await patch(photos[1].id,{visibility:'private'})).status,200);
    const catalog=store.worlds.list();
    assert.equal(catalog.photos.filter(x=>x.isCover).length,1);
    assert.equal(catalog.photos.find(x=>x.isCover).id,photos[2].id);
    for(const [i,expected] of ['spoiler','private','public'].entries())
      assert.equal(catalog.photos.find(x=>x.id===photos[i].id).visibility,expected);
    for(const p of photos){
      const response=await fetch(base+'/api/worlds/photos/'+p.id+'?worldId='+worldId+'&view=player');
      assert.equal(response.status,p.id===photos[2].id?200:404,
        'player endpoints do not stream restricted photos');
      const editor=await fetch(base+'/api/worlds/photos/'+p.id+'?worldId='+worldId);
      assert.equal(editor.status,200,'creator retains restricted references');
    }
    assert.equal((await patch(photos[2].id,{move:'up'})).status,200);
    const ordered=store.worlds.list().photos.filter(x=>x.entryId===place.id);
    assert.deepEqual(ordered.map(x=>x.caption),['First photo','Third photo','Second photo']);
    const invalid=await patch(photos[0].id,{visibility:'guess'});
    assert.equal(invalid.status,422);
    assert.equal(store.worlds.list().photos.find(x=>x.id===photos[0].id).visibility,'spoiler');
    const foreign=store.worlds.createWorld({name:'Separate world'});
    const wrong=await fetch(base+'/api/worlds/photos',{method:'PATCH',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({worldId:foreign.id,id:photos[2].id,cover:true})});
    assert.notEqual(wrong.status,200);
    assert.equal(store.forWorld(foreign.id).worlds.list().photos.length,0);
    store.worlds.removePhoto({worldId,id:photos[2].id});
    assert.equal(store.worlds.list().photos.filter(x=>x.isCover).length,1,
      'deleting cover automatically selects remaining image');
  }finally{
    await new Promise(resolve=>server.close(resolve));
    rmSync(dir,{recursive:true,force:true});
  }
});

test('universe SQLite export includes canon, story and gallery BLOBs in a readable consistent backup',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-photo-export-'));
  const store=new WorldPartitionStore(dir),worldId=store.activeWorldId;
  const location=store.worlds.createLocation({worldId,name:'Harbor Point',kind:'town',
    description:'The iconic coastal district'});
  const image=store.worlds.addPhoto({worldId,entryType:'location',entryId:location.id,
    caption:'Local architecture',mimeType:'image/png',bytes:png});
  const server=createApp({store,fetchImpl:async()=>{throw Error('Unused')}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const response=await fetch('http://127.0.0.1:'+server.address().port+
      '/api/worlds/export?worldId='+worldId);
    assert.equal(response.status,200,await response.clone().text().catch(()=>''));
    assert.match(response.headers.get('content-disposition'),/\.sqlite/);
    const bytes=Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.toString('ascii',0,16),'SQLite format 3\0');
    const snapshot=join(dir,'export.sqlite');writeFileSync(snapshot,bytes);
    const exported=new DatabaseSync(snapshot);
    try{
      const linked=exported.prepare('SELECT * FROM universe_entry_photos WHERE id=?').get(image.id);
      assert.ok(linked,'snapshot includes photo metadata');
      assert.deepEqual(Buffer.from(linked.content),png,'snapshot includes full photo bytes');
      assert.equal(exported.prepare('SELECT description FROM world_locations WHERE id=?').get(location.id).description,
        'The iconic coastal district');
      assert.equal(exported.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
      assert.ok(exported.prepare('SELECT document FROM studio_state').get());
    }finally{exported.close();}
    const foreign=store.worlds.createWorld({name:'Other'});
    const denied=await fetch('http://127.0.0.1:'+server.address().port+
      '/api/worlds/export?worldId='+foreign.id);
    assert.equal(denied.status,200);
    const foreignPath=join(dir,'other.sqlite');
    writeFileSync(foreignPath,Buffer.from(await denied.arrayBuffer()));
    const other=new DatabaseSync(foreignPath);
    try{assert.equal(other.prepare('SELECT count(*) AS n FROM universe_entry_photos').get().n,0);}
    finally{other.close();}
  }finally{await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
