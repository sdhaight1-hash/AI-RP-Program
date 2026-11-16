import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
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
