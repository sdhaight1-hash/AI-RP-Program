// Reviewed, actor-owned knowledge derived from a real witnessed source message.
// This is a subjective recollection, NOT a mutation of world canon.
import { createHash,randomUUID } from 'node:crypto';
import { sourceFingerprint } from '../world/event-ledger.mjs';

const kinds=new Set(['belief','promise','relationship','autobiography','observation']);
const stableId=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function initializeFactSchema(db) {
  db.exec([
    "CREATE TABLE IF NOT EXISTS actor_facts (id TEXT PRIMARY KEY,timeline_id TEXT NOT NULL REFERENCES timelines(id),actor_id TEXT NOT NULL,scene_id TEXT NOT NULL,source_message_id TEXT NOT NULL,source_hash TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('belief','promise','relationship','autobiography','observation')),text TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','superseded','revoked')),origin TEXT NOT NULL CHECK(origin IN ('direct','inherited')),supersedes_id TEXT,created_at INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS actor_facts_owner_idx ON actor_facts(timeline_id,actor_id,status,created_at)",
    "CREATE VIRTUAL TABLE IF NOT EXISTS actor_facts_fts USING fts5(text,tokenize='unicode61')",
    "CREATE TRIGGER IF NOT EXISTS actor_facts_ai AFTER INSERT ON actor_facts BEGIN INSERT INTO actor_facts_fts(rowid,text) VALUES(new.rowid,new.text); END",
    "CREATE TRIGGER IF NOT EXISTS actor_facts_ad AFTER DELETE ON actor_facts BEGIN DELETE FROM actor_facts_fts WHERE rowid=old.rowid; END",
    "CREATE TRIGGER IF NOT EXISTS actor_facts_au AFTER UPDATE OF text ON actor_facts BEGIN DELETE FROM actor_facts_fts WHERE rowid=old.rowid; INSERT INTO actor_facts_fts(rowid,text) VALUES(new.rowid,new.text); END",
  ].join(';\n')+';');
}

const actorInTimeline=(db,timelineId,actorId)=>Boolean(db.prepare('SELECT 1 FROM timeline_actors WHERE timeline_id=? AND actor_id=?').get(timelineId,actorId));
const canRecall=(message,actorId,scene)=>Boolean(message && (
  (Array.isArray(message.witnessIds) && message.witnessIds.includes(actorId)) ||
  (message.role==='assistant' && (message.speakerId||scene.characterId)===actorId)
));

export function addActorFact(store,{sceneId,actorId,sourceMessageId,kind='belief',text,supersedesId=null}) {
  if (!kinds.has(kind)) throw new Error('Unsupported memory kind');
  if (typeof text!=='string' || !text.trim() || text.trim().length>700) throw new Error('Memory text must contain 1–700 characters');
  const scene=store.load().state?.sessions?.find(x=>x.id===sceneId && !x.trashedAt);
  if(!scene || !(scene.castIds||[scene.characterId]).includes(actorId) ||
    !actorInTimeline(store.db,scene.timelineId,actorId))throw new Error('Actor is not in this scene and timeline');
  const source=scene.messages.find(m=>m.id===sourceMessageId);
  if(!canRecall(source,actorId,scene))throw new Error('Actor did not witness the source message');
  const record={id:randomUUID(),timelineId:scene.timelineId,sceneId,actorId,sourceMessageId,
    sourceHash:sourceFingerprint(source),kind,text:text.trim(),status:'active',origin:'direct',
    supersedesId,createdAt:Date.now()};
  const db=store.db;
  db.exec('BEGIN IMMEDIATE');
  try {
    if(supersedesId!==null){
      const prior=db.prepare('SELECT id FROM actor_facts WHERE id=? AND timeline_id=? AND actor_id=? AND status=?')
        .get(supersedesId,scene.timelineId,actorId,'active');
      if(!prior)throw new Error('Superseded memory does not belong to this actor and timeline');
      db.prepare("UPDATE actor_facts SET status='superseded' WHERE id=?").run(supersedesId);
    }
    db.prepare('INSERT INTO actor_facts(id,timeline_id,actor_id,scene_id,source_message_id,source_hash,kind,text,status,origin,supersedes_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(record.id,record.timelineId,record.actorId,record.sceneId,record.sourceMessageId,record.sourceHash,record.kind,record.text,record.status,record.origin,record.supersedesId,record.createdAt);
    db.exec('COMMIT');
    return record;
  }catch(error){db.exec('ROLLBACK');throw error;}
}

export function revokeActorFact(store,{id,actorId,timelineId}){
  const db=store.db;
  if(!actorInTimeline(db,timelineId,actorId))throw new Error('Actor is not in this timeline');
  const result=db.prepare("UPDATE actor_facts SET status='revoked' WHERE id=? AND actor_id=? AND timeline_id=? AND status='active'")
    .run(id,actorId,timelineId);
  if(!result.changes)throw new Error('Active memory not found for this actor and timeline');
  return {id,status:'revoked'};
}

export function listActorFacts(store,{timelineId,actorId}){
  if(!actorInTimeline(store.db,timelineId,actorId))throw new Error('Actor is not in this timeline');
  return store.db.prepare("SELECT id,timeline_id AS timelineId,actor_id AS actorId,scene_id AS sceneId,source_message_id AS sourceMessageId,kind,text,status,origin,supersedes_id AS supersedesId,created_at AS createdAt FROM actor_facts WHERE timeline_id=? AND actor_id=? ORDER BY created_at DESC,rowid DESC")
    .all(timelineId,actorId);
}

export function snapshotFactsForFork(db,parentId,childId){
  const rows=db.prepare("SELECT * FROM actor_facts WHERE timeline_id=? AND status='active'").all(parentId);
  const insert=db.prepare("INSERT OR IGNORE INTO actor_facts(id,timeline_id,actor_id,scene_id,source_message_id,source_hash,kind,text,status,origin,supersedes_id,created_at) VALUES(?,?,?,?,?,?,?,?, 'active','inherited',NULL,?)");
  for(const row of rows){
    const id=stableId([childId,row.id,'inherited']);
    insert.run(id,childId,row.actor_id,row.scene_id,row.source_message_id,row.source_hash,row.kind,row.text,row.created_at);
  }
}

export function retrieveActorFacts(store,{timelineId,actorId,query='',limit=5}){
  const db=store.db;
  if(!actorInTimeline(db,timelineId,actorId))throw new Error('Actor is not in this timeline');
  const tokens=[...new Set((String(query).match(/[\p{L}\p{N}]{3,32}/gu)||[])
    .map(x=>x.toLocaleLowerCase()).filter(x=>!['the','and','you','your','who','what','when','where','how','with','from','about','that','this','were','have','does'].includes(x)))].slice(-12);
  const expression=tokens.map(w=>'"'+w+'"').join(' OR ');
  const found=expression ? db.prepare("SELECT f.* FROM actor_facts_fts JOIN actor_facts f ON f.rowid=actor_facts_fts.rowid WHERE actor_facts_fts MATCH ? AND f.timeline_id=? AND f.actor_id=? AND f.status='active' ORDER BY bm25(actor_facts_fts) LIMIT 20")
    .all(expression,timelineId,actorId):[];
  const recent=db.prepare("SELECT * FROM actor_facts WHERE timeline_id=? AND actor_id=? AND status='active' ORDER BY created_at DESC LIMIT 3").all(timelineId,actorId);
  const all=[...found,...recent.filter(x=>!found.some(y=>y.id===x.id))];
  const scenes=new Map((store.load().state?.sessions||[]).map(s=>[s.id,s]));
  return all.filter(f=>{
    if(f.origin==='inherited')return true; // Immutable fork snapshot of already approved knowledge.
    const scene=scenes.get(f.scene_id);
    const message=scene?.messages?.find(m=>m.id===f.source_message_id);
    return canRecall(message,actorId,scene) && sourceFingerprint(message)===f.source_hash;
  }).slice(0,Math.max(1,Math.min(12,limit))).map(f=>({
    id:f.id,kind:f.kind,text:f.text,origin:f.origin,sourceMessageId:f.source_message_id,
    sceneId:f.scene_id,createdAt:f.created_at
  }));
}
