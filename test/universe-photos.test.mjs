import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync,symlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorldPartitionStore} from '../world/partition-store.mjs';
import {createApp} from '../server.mjs';
import {verifyEntryImage,initializeEntryPhotos} from '../world/media.mjs';
import {crc32,makeUniverseZip} from '../world/export-bundle.mjs';

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

function unpackStoredZip(bytes){
  const end=bytes.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));
  assert.ok(end>=0,'ZIP end-of-directory record exists');
  const count=bytes.readUInt16LE(end+10),entries=new Map();
  let position=bytes.readUInt32LE(end+16);
  for(let i=0;i<count;i++){
    assert.equal(bytes.readUInt32LE(position),0x02014b50);
    assert.equal(bytes.readUInt16LE(position+10),0,'archive uses portable stored mode');
    const checksum=bytes.readUInt32LE(position+16),size=bytes.readUInt32LE(position+20);
    const nameLen=bytes.readUInt16LE(position+28);
    const extraLen=bytes.readUInt16LE(position+30),commentLen=bytes.readUInt16LE(position+32);
    const offset=bytes.readUInt32LE(position+42);
    const name=bytes.toString('utf8',position+46,position+46+nameLen);
    assert.equal(bytes.readUInt32LE(offset),0x04034b50);
    const start=offset+30+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28);
    const data=bytes.subarray(start,start+size);
    assert.equal(data.length,size);
    assert.equal(crc32(data),checksum,'ZIP data CRC must match central-directory metadata');
    entries.set(name,data);
    position+=46+nameLen+extraLen+commentLen;
  }
  return entries;
}
test('complete universe ZIP preserves gallery BLOBs, external portraits and hashes without crossing worlds',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-zip-universe-'));
  const store=new WorldPartitionStore(dir),worldId=store.activeWorldId;
  const place=store.worlds.createLocation({worldId,name:'Maple Square',kind:'town'});
  const image=store.worlds.addPhoto({worldId,entryType:'location',entryId:place.id,
    mimeType:'image/png',caption:'Before sunset',bytes:png});
  const portraitDirectory=store.assetDir('portraits');
  mkdirSync(portraitDirectory,{recursive:true});
  writeFileSync(join(portraitDirectory,'character.webp'),'asset binary for portrait');
  const foreign=store.worlds.createWorld({name:'Different world'});
  mkdirSync(store.forWorld(foreign.id).assetDir('portraits'),{recursive:true});
  writeFileSync(join(store.forWorld(foreign.id).assetDir('portraits'),'secret.webp'),'OTHER WORLD DATA');
  const server=createApp({store,fetchImpl:async()=>{throw Error('No model needed')}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const response=await fetch('http://127.0.0.1:'+server.address().port+
      '/api/worlds/export/bundle?worldId='+worldId);
    assert.equal(response.status,200,await response.clone().text().catch(()=>''));
    assert.match(response.headers.get('content-type'),/application\/zip/);
    const entries=unpackStoredZip(Buffer.from(await response.arrayBuffer()));
    assert.ok(entries.has('world.sqlite'));
    assert.deepEqual(entries.get('assets/portraits/character.webp'),
      Buffer.from('asset binary for portrait'));
    assert.equal(entries.has('assets/portraits/secret.webp'),false,
      'a world archive must never include another universe asset');
    const manifest=JSON.parse(entries.get('manifest.json').toString('utf8'));
    assert.equal(manifest.worldId,worldId);
    for(const item of manifest.files)
      assert.equal(createHash('sha256').update(entries.get(item.path)).digest('hex'),item.sha256);
    const snapshot=join(dir,'restored-from-zip.sqlite');
    writeFileSync(snapshot,entries.get('world.sqlite'));
    const db=new DatabaseSync(snapshot);
    try{
      const record=db.prepare('SELECT content FROM universe_entry_photos WHERE id=?').get(image.id);
      assert.deepEqual(Buffer.from(record.content),png);
      assert.ok(db.prepare('SELECT id FROM world_locations WHERE id=?').get(place.id));
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    }finally{db.close();}
    const denied=await fetch('http://127.0.0.1:'+server.address().port+
      '/api/worlds/export/bundle?worldId=missing');
    assert.notEqual(denied.status,200);
  }finally{await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
test('ZIP builder rejects symlinked assets rather than exporting files outside the universe',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-zip-symlink-'));
  const folder=join(dir,'world'),portrait=join(folder,'portraits');
  mkdirSync(portrait,{recursive:true});
  const outside=join(dir,'secret');writeFileSync(outside,'private content');
  symlinkSync(outside,join(portrait,'linked-photo'));
  const snapshot=join(dir,'world.sqlite');writeFileSync(snapshot,'placeholder');
  await assert.rejects(makeUniverseZip({
    worldId:'testing',snapshotPath:snapshot,worldFolder:folder,outputPath:join(dir,'export.zip')
  }),/linked asset/);
  rmSync(dir,{recursive:true,force:true});
});
test('CRC-32 implementation follows the ZIP standard known-answer test',()=>{
  assert.equal(crc32(Buffer.from('123456789')),0xcbf43926);
});

test('pre-existing galleries upgrade additively and preserve deliberate cover selection on restart',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec(`CREATE TABLE worlds(id TEXT PRIMARY KEY);
      CREATE TABLE world_locations(id TEXT PRIMARY KEY,world_id TEXT);
      CREATE TABLE world_entities(id TEXT PRIMARY KEY,world_id TEXT);
      CREATE TABLE universe_entry_photos(
        id TEXT PRIMARY KEY,world_id TEXT NOT NULL,entry_type TEXT NOT NULL,
        entry_id TEXT NOT NULL,mime_type TEXT NOT NULL,
        caption TEXT NOT NULL DEFAULT '',content BLOB NOT NULL,created_at INTEGER NOT NULL
      );`);
    db.prepare('INSERT INTO worlds(id) VALUES(?)').run('legacy');
    db.prepare('INSERT INTO world_locations(id,world_id) VALUES(?,?)').run('district','legacy');
    const put=db.prepare(`INSERT INTO universe_entry_photos
      (id,world_id,entry_type,entry_id,mime_type,caption,content,created_at)
      VALUES(?,?,?,?,?,?,?,?)`);
    put.run('old-1','legacy','location','district','image/png','first',png,10);
    put.run('old-2','legacy','location','district','image/png','second',png,20);
    initializeEntryPhotos(db);
    const check=()=>db.prepare(`SELECT id,sort_order AS sortOrder,is_cover AS isCover,
      visibility FROM universe_entry_photos ORDER BY created_at`).all();
    assert.deepEqual(check().map(x=>x.isCover),[1,0]);
    assert.ok(check().every(x=>x.visibility==='public'));
    db.prepare('UPDATE universe_entry_photos SET is_cover=0').run();
    db.prepare('UPDATE universe_entry_photos SET is_cover=1 WHERE id=?').run('old-2');
    initializeEntryPhotos(db);
    assert.deepEqual(check().map(x=>x.isCover),[0,1],
      'a second initialization must not replace a user-selected cover');
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{db.close();}
});


test('cover deletion rolls back if replacement selection fails',()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-photo-delete-atomic-'));
  const store=new WorldPartitionStore(dir);
  try{
    const worldId=store.activeWorldId;
    const location=store.worlds.createLocation({worldId,name:'Gallery rollback',kind:'town'});
    const first=store.worlds.addPhoto({worldId,entryType:'location',entryId:location.id,
      caption:'Cover',mimeType:'image/png',bytes:png});
    const second=store.worlds.addPhoto({worldId,entryType:'location',entryId:location.id,
      caption:'Replacement',mimeType:'image/png',bytes:png});
    store.db.exec(`CREATE TRIGGER reject_cover_reassignment
      BEFORE UPDATE OF is_cover ON universe_entry_photos
      WHEN NEW.is_cover=1
      BEGIN SELECT RAISE(ABORT,'simulated cover reassignment failure'); END`);
    assert.throws(()=>store.worlds.removePhoto({worldId,id:first.id}),
      /simulated cover reassignment failure/);
    const after=store.worlds.list().photos.filter(x=>x.entryId===location.id);
    assert.equal(after.length,2,'failed cover reassignment must restore deleted bytes');
    assert.equal(after.find(x=>x.id===first.id)?.isCover,1);
    assert.equal(after.find(x=>x.id===second.id)?.isCover,0);
    store.db.exec('DROP TRIGGER reject_cover_reassignment');
    store.worlds.removePhoto({worldId,id:first.id});
    const final=store.worlds.list().photos.filter(x=>x.entryId===location.id);
    assert.equal(final.length,1);
    assert.equal(final[0].id,second.id);
    assert.equal(final[0].isCover,1);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
