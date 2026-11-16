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
    created_at INTEGER NOT NULL
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
    entry_id AS entryId,mime_type AS mimeType,caption,created_at AS createdAt
    FROM universe_entry_photos WHERE world_id=?
    ORDER BY created_at,id`).all(worldId);
}
export function addEntryPhoto(db,{worldId,entryType,entryId,mimeType,caption='',bytes}){
  assertOwner(db,{worldId,entryType,entryId});
  if(typeof caption!=='string'||caption.length>2000)
    throw Error('Photo caption must be at most 2,000 characters');
  verifyEntryImage(bytes,mimeType);
  const record={id:randomUUID(),worldId,entryType,entryId,mimeType,
    caption:caption.trim(),createdAt:Date.now()};
  db.prepare(`INSERT INTO universe_entry_photos
    (id,world_id,entry_type,entry_id,mime_type,caption,content,created_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(record.id,worldId,entryType,entryId,mimeType,
      record.caption,bytes,record.createdAt);
  return record;
}
export function readEntryPhoto(db,{worldId,id}){
  if(typeof id!=='string'||!/^[a-f0-9-]{36}$/i.test(id))
    throw Error('Invalid photo ID');
  return db.prepare(`SELECT mime_type AS mimeType,content AS bytes
    FROM universe_entry_photos WHERE world_id=? AND id=?`).get(worldId,id)||null;
}
export function deleteEntryPhoto(db,{worldId,id}){
  const result=db.prepare('DELETE FROM universe_entry_photos WHERE world_id=? AND id=?')
    .run(worldId,id);
  if(!result.changes)throw Error('Photo not found in this universe');
  return {deleted:true,worldId,id};
}
export function updateEntryPhotoCaption(db,{worldId,id,caption}){
  if(typeof caption!=='string'||caption.length>2000)
    throw Error('Photo caption must be at most 2,000 characters');
  const changed=db.prepare('UPDATE universe_entry_photos SET caption=? WHERE id=? AND world_id=?')
    .run(caption.trim(),id,worldId);
  if(!changed.changes)throw Error('Photo not found in this universe');
  return {worldId,id,caption:caption.trim()};
}
