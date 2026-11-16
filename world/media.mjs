// Universe-local photo galleries. Photo bytes live in the owning world's
// SQLite file: metadata, image, backup and deletion share one transaction.
// Never include these BLOBs in AI prompts or catalog JSON.
import {randomUUID} from 'node:crypto';

export const MAX_ENTRY_PHOTO_BYTES=12_000_000;
const entryTables={universe:'worlds',location:'world_locations',entity:'world_entities'};
const supportedTypes=new Set(['image/png','image/jpeg','image/webp']);

export function initializeEntryPhotos(db){
  db.exec(`CREATE TABLE IF NOT EXISTS universe_entry_photos (
    id TEXT PRIMARY KEY,
    world_id TEXT NOT NULL,
    entry_type TEXT NOT NULL CHECK(entry_type IN ('universe','location','entity')),
    entry_id TEXT NOT NULL,
    mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png','image/jpeg','image/webp')),
    caption TEXT NOT NULL DEFAULT '',
    content BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_cover INTEGER NOT NULL DEFAULT 0 CHECK(is_cover IN (0,1)),
    visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','spoiler','private'))
  );
  CREATE INDEX IF NOT EXISTS entry_photos_by_owner ON universe_entry_photos
    (world_id,entry_type,entry_id,created_at);
  CREATE TRIGGER IF NOT EXISTS entry_photo_delete_world AFTER DELETE ON worlds BEGIN
    DELETE FROM universe_entry_photos WHERE world_id=OLD.id;
  END;
  CREATE TRIGGER IF NOT EXISTS entry_photo_delete_location AFTER DELETE ON world_locations BEGIN
    DELETE FROM universe_entry_photos WHERE world_id=OLD.world_id
      AND entry_type='location' AND entry_id=OLD.id;
  END;
  CREATE TRIGGER IF NOT EXISTS entry_photo_delete_entity AFTER DELETE ON world_entities BEGIN
    DELETE FROM universe_entry_photos WHERE world_id=OLD.world_id
      AND entry_type='entity' AND entry_id=OLD.id;
  END;`);
  // Existing installations need additive, non-destructive migrations.
  const columns=new Set(db.prepare('PRAGMA table_info(universe_entry_photos)').all().map(x=>x.name));
  if(!columns.has('sort_order'))
    db.exec('ALTER TABLE universe_entry_photos ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
  if(!columns.has('is_cover'))
    db.exec('ALTER TABLE universe_entry_photos ADD COLUMN is_cover INTEGER NOT NULL DEFAULT 0');
  if(!columns.has('visibility'))
    db.exec("ALTER TABLE universe_entry_photos ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'");
  db.exec('CREATE INDEX IF NOT EXISTS entry_photo_sort ON universe_entry_photos(world_id,entry_type,entry_id,sort_order,created_at)');
  // When upgrading an old gallery, select its oldest photo as cover only if
  // no cover has been chosen. Existing explicit cover choices remain intact.
  db.exec(`UPDATE universe_entry_photos SET is_cover=1 WHERE id IN (
    SELECT p.id FROM universe_entry_photos p
    WHERE p.id=(SELECT oldest.id FROM universe_entry_photos oldest
      WHERE oldest.world_id=p.world_id AND oldest.entry_type=p.entry_type
        AND oldest.entry_id=p.entry_id
      ORDER BY oldest.sort_order,oldest.created_at,oldest.id LIMIT 1)
      AND NOT EXISTS(SELECT 1 FROM universe_entry_photos chosen
        WHERE chosen.world_id=p.world_id AND chosen.entry_type=p.entry_type
          AND chosen.entry_id=p.entry_id AND chosen.is_cover=1)
  )`);
}

export function verifyEntryImage(bytes,mimeType){
  if(!Buffer.isBuffer(bytes)||bytes.length<16||bytes.length>MAX_ENTRY_PHOTO_BYTES||
    !supportedTypes.has(mimeType))throw Error('Photo must be a JPEG, PNG or WebP image up to 12 MB');
  if(mimeType==='image/jpeg'&&
    bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff&&
    bytes[bytes.length-2]===0xff&&bytes[bytes.length-1]===0xd9)return mimeType;
  if(mimeType==='image/png'&&bytes.length>=33&&
    bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&
    bytes.toString('ascii',12,16)==='IHDR'&&
    bytes.readUInt32BE(16)>0&&bytes.readUInt32BE(20)>0&&
    bytes.readUInt32BE(16)<=30000&&bytes.readUInt32BE(20)<=30000)return mimeType;
  if(mimeType==='image/webp'&&bytes.toString('ascii',0,4)==='RIFF'&&
    bytes.toString('ascii',8,12)==='WEBP'&&
    bytes.readUInt32LE(4)+8===bytes.length&&
    ['VP8 ','VP8L','VP8X'].includes(bytes.toString('ascii',12,16)))return mimeType;
  throw Error('Invalid image bytes or image MIME type');
}
function assertOwner(db,{worldId,entryType,entryId}){
  const table=entryTables[entryType];
  if(!table||typeof worldId!=='string'||!worldId||
    typeof entryId!=='string'||!entryId)throw Error('Invalid photo owner');
  if(entryType==='universe'&&entryId!==worldId)
    throw Error('Universe photo must belong to the selected universe');
  const row=db.prepare(`SELECT id FROM ${table} WHERE id=?${entryType==='universe'?'':' AND world_id=?'}`)
    .get(...(entryType==='universe'?[entryId]:[entryId,worldId]));
  if(!row)throw Error('Photo owner not found in this universe');
}
export function listEntryPhotos(db,worldId){
  return db.prepare(`SELECT id,world_id AS worldId,entry_type AS entryType,
    entry_id AS entryId,mime_type AS mimeType,caption,created_at AS createdAt,
    sort_order AS sortOrder,is_cover AS isCover,visibility
    FROM universe_entry_photos WHERE world_id=?
    ORDER BY entry_type,entry_id,sort_order,created_at,id`).all(worldId);
}
export function addEntryPhoto(db,{worldId,entryType,entryId,mimeType,caption='',bytes}){
  assertOwner(db,{worldId,entryType,entryId});
  if(typeof caption!=='string'||caption.length>2000)
    throw Error('Photo caption must be at most 2,000 characters');
  verifyEntryImage(bytes,mimeType);
  const order=db.prepare(`SELECT COALESCE(MAX(sort_order),-1)+1 AS next
    FROM universe_entry_photos WHERE world_id=? AND entry_type=? AND entry_id=?`)
    .get(worldId,entryType,entryId).next;
  const cover=db.prepare(`SELECT count(*) AS n FROM universe_entry_photos
    WHERE world_id=? AND entry_type=? AND entry_id=?`).get(worldId,entryType,entryId).n===0;
  const record={id:randomUUID(),worldId,entryType,entryId,mimeType,
    caption:caption.trim(),createdAt:Date.now(),sortOrder:order,
    isCover:cover?1:0,visibility:'public'};
  db.prepare(`INSERT INTO universe_entry_photos
    (id,world_id,entry_type,entry_id,mime_type,caption,content,created_at,sort_order,is_cover,visibility)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(record.id,worldId,entryType,entryId,mimeType,
      record.caption,bytes,record.createdAt,order,record.isCover,record.visibility);
  return record;
}
export function readEntryPhoto(db,{worldId,id,publicOnly=false}){
  if(typeof id!=='string'||!/^[a-f0-9-]{36}$/i.test(id))
    throw Error('Invalid photo ID');
  return db.prepare(`SELECT mime_type AS mimeType,content AS bytes
    FROM universe_entry_photos WHERE world_id=? AND id=?${publicOnly?" AND visibility='public'":''}`).get(worldId,id)||null;
}
export function deleteEntryPhoto(db,{worldId,id}){
  // The cover must not disappear if selecting its replacement fails.
  db.exec('SAVEPOINT entry_photo_delete');
  try{
    const before=db.prepare('SELECT entry_type AS entryType,entry_id AS entryId,is_cover AS isCover FROM universe_entry_photos WHERE world_id=? AND id=?').get(worldId,id);
    const result=db.prepare('DELETE FROM universe_entry_photos WHERE world_id=? AND id=?')
      .run(worldId,id);
    if(!result.changes)throw Error('Photo not found in this universe');
    if(before?.isCover)db.prepare(`UPDATE universe_entry_photos SET is_cover=1 WHERE id=(
      SELECT id FROM universe_entry_photos WHERE world_id=? AND entry_type=? AND entry_id=?
      ORDER BY sort_order,created_at,id LIMIT 1)`).run(worldId,before.entryType,before.entryId);
    db.exec('RELEASE SAVEPOINT entry_photo_delete');
    return {deleted:true,worldId,id};
  }catch(error){
    db.exec('ROLLBACK TO SAVEPOINT entry_photo_delete');
    db.exec('RELEASE SAVEPOINT entry_photo_delete');
    throw error;
  }
}
export function updateEntryPhotoCaption(db,{worldId,id,caption}){
  if(typeof caption!=='string'||caption.length>2000)
    throw Error('Photo caption must be at most 2,000 characters');
  const changed=db.prepare('UPDATE universe_entry_photos SET caption=? WHERE id=? AND world_id=?')
    .run(caption.trim(),id,worldId);
  if(!changed.changes)throw Error('Photo not found in this universe');
  return {worldId,id,caption:caption.trim()};
}

const VISIBILITY=new Set(['public','spoiler','private']);
function entryPhoto(db,worldId,id){
  const photo=db.prepare(`SELECT id,entry_type AS entryType,entry_id AS entryId,
    sort_order AS sortOrder,visibility,is_cover AS isCover FROM universe_entry_photos
    WHERE world_id=? AND id=?`).get(worldId,id);
  if(!photo)throw Error('Photo not found in this universe');
  return photo;
}
export function updateEntryPhoto(db,{worldId,id,caption,visibility,cover,move}){
  if(typeof worldId!=='string'||!worldId||typeof id!=='string')throw Error('Invalid photo update');
  if(caption!==undefined&&(typeof caption!=='string'||caption.length>2000))
    throw Error('Photo caption must be at most 2,000 characters');
  if(visibility!==undefined&&!VISIBILITY.has(visibility))throw Error('Unsupported photo visibility');
  if(cover!==undefined&&cover!==true)throw Error('Only setting the cover photo is supported');
  if(move!==undefined&&!['up','down'].includes(move))throw Error('Unsupported photo move');
  db.exec('SAVEPOINT entry_photo_update');
  try{
    const photo=entryPhoto(db,worldId,id);
    if(caption!==undefined)db.prepare('UPDATE universe_entry_photos SET caption=? WHERE world_id=? AND id=?')
      .run(caption.trim(),worldId,id);
    if(visibility!==undefined)db.prepare('UPDATE universe_entry_photos SET visibility=? WHERE world_id=? AND id=?')
      .run(visibility,worldId,id);
    if(cover){
      db.prepare(`UPDATE universe_entry_photos SET is_cover=0 WHERE world_id=? AND entry_type=? AND entry_id=?`)
        .run(worldId,photo.entryType,photo.entryId);
      db.prepare('UPDATE universe_entry_photos SET is_cover=1 WHERE world_id=? AND id=?')
        .run(worldId,id);
    }
    if(move){
      const siblings=db.prepare(`SELECT id FROM universe_entry_photos
        WHERE world_id=? AND entry_type=? AND entry_id=?
        ORDER BY sort_order,created_at,id`)
        .all(worldId,photo.entryType,photo.entryId);
      const at=siblings.findIndex(x=>x.id===id),next=at+(move==='up'?-1:1);
      if(next>=0&&next<siblings.length){
        [siblings[at],siblings[next]]=[siblings[next],siblings[at]];
        const reorder=db.prepare('UPDATE universe_entry_photos SET sort_order=? WHERE world_id=? AND id=?');
        siblings.forEach((x,i)=>reorder.run(i,worldId,x.id));
      }
    }
    db.exec('RELEASE SAVEPOINT entry_photo_update');
    return {worldId,id,updated:true,...(caption!==undefined?{caption:caption.trim()}:{})};
  }catch(error){
    db.exec('ROLLBACK TO SAVEPOINT entry_photo_update');
    db.exec('RELEASE SAVEPOINT entry_photo_update');
    throw error;
  }
}
