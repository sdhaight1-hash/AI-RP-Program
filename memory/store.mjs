// Actor-owned recollection of witnessed dialogue. A recollection of what was
// said is NOT evidence that the statement is objectively true.
import { createHash } from 'node:crypto';

export function initializeMemorySchema(db) {
  db.exec([
    "CREATE TABLE IF NOT EXISTS actor_memories (id TEXT PRIMARY KEY, timeline_id TEXT NOT NULL REFERENCES timelines(id), scene_id TEXT NOT NULL, actor_id TEXT NOT NULL, source_message_id TEXT NOT NULL, source_hash TEXT NOT NULL, text TEXT NOT NULL, occurred_at INTEGER NOT NULL, origin TEXT NOT NULL CHECK(origin IN ('direct','inherited')), UNIQUE(timeline_id,scene_id,actor_id,source_message_id,origin))",
    "CREATE INDEX IF NOT EXISTS actor_memories_owner_idx ON actor_memories(timeline_id,actor_id,occurred_at)",
    "CREATE VIRTUAL TABLE IF NOT EXISTS actor_memories_fts USING fts5(text, tokenize='unicode61')",
    "CREATE TRIGGER IF NOT EXISTS actor_memories_ai AFTER INSERT ON actor_memories BEGIN INSERT INTO actor_memories_fts(rowid,text) VALUES(new.rowid,new.text); END",
    "CREATE TRIGGER IF NOT EXISTS actor_memories_ad AFTER DELETE ON actor_memories BEGIN DELETE FROM actor_memories_fts WHERE rowid=old.rowid; END",
    "CREATE TRIGGER IF NOT EXISTS actor_memories_au AFTER UPDATE OF text ON actor_memories BEGIN DELETE FROM actor_memories_fts WHERE rowid=old.rowid; INSERT INTO actor_memories_fts(rowid,text) VALUES(new.rowid,new.text); END",
  ].join(';\n')+';');
}
const digest = value => createHash('sha256').update(value).digest('hex');

// Called inside the same transaction as the corresponding story snapshot.
export function syncConversationMemories(db, state) {
  const people = new Map((state.characters || []).map(c => [c.id,c.name]));
  const expected = new Set();
  const upsert = db.prepare("INSERT INTO actor_memories(id,timeline_id,scene_id,actor_id,source_message_id,source_hash,text,occurred_at,origin) VALUES(?,?,?,?,?,?,?,?, 'direct') ON CONFLICT(id) DO UPDATE SET source_hash=excluded.source_hash,text=excluded.text,occurred_at=excluded.occurred_at");
  const current = db.prepare('SELECT source_hash FROM actor_memories WHERE id=?');
  const validTimeline = db.prepare('SELECT 1 FROM timeline_actors WHERE timeline_id=? AND actor_id=?');
  for (const scene of state.sessions || []) {
    if (!scene.timelineId) continue;
    const cast = new Set(scene.castIds || [scene.characterId]);
    for (const message of scene.messages || []) {
      if (!message?.id || !['user','assistant'].includes(message.role) || !message.content?.trim()) continue;
      // Missing witness attribution in legacy messages does not grant everyone access.
      const witnesses = Array.isArray(message.witnessIds) ? message.witnessIds : [];
      const speaker = message.role === 'assistant' ? (message.speakerId || scene.characterId) : null;
      const holders = new Set([...witnesses, ...(speaker ? [speaker] : [])]);
      const sourceHash = digest(JSON.stringify([message.role,speaker,message.content,message.channelId,witnesses.slice().sort()]));
      for (const actorId of holders) {
        if (!cast.has(actorId) || !people.has(actorId) || !validTimeline.get(scene.timelineId,actorId)) continue;
        const identifier = digest(JSON.stringify([scene.timelineId,scene.id,actorId,message.id]));
        expected.add(identifier);
        if (current.get(identifier)?.source_hash === sourceHash) continue;
        const who = message.role === 'user' ? 'Player' : (speaker === actorId ? 'You' : people.get(speaker) || 'Another character');
        const text = who + ' said: ' + message.content.slice(0,1400);
        const occurredAt = Number.isFinite(message.sentAt) ? message.sentAt : Number(scene.updatedAt) || 0;
        upsert.run(identifier,scene.timelineId,scene.id,actorId,message.id,sourceHash,text,occurredAt);
      }
    }
  }
  // Removing a source message removes its derived dialogue memory, but never
  // erases an immutable memory snapshot held by a fork.
  const direct = db.prepare("SELECT id FROM actor_memories WHERE origin='direct'").all();
  const remove = db.prepare("DELETE FROM actor_memories WHERE id=?");
  for (const row of direct) if (!expected.has(row.id)) remove.run(row.id);
}

// Forked timelines snapshot all memories known at the fork instant. Later
// updates/deletes in the parent cannot rewrite that branch's experiences.
export function snapshotMemoriesForFork(db, parentTimelineId, childTimelineId) {
  const records = db.prepare("SELECT * FROM actor_memories WHERE timeline_id=?").all(parentTimelineId);
  const insert = db.prepare("INSERT OR IGNORE INTO actor_memories(id,timeline_id,scene_id,actor_id,source_message_id,source_hash,text,occurred_at,origin) VALUES(?,?,?,?,?,?,?,?, 'inherited')");
  for (const row of records) {
    const id = digest(JSON.stringify([childTimelineId,row.scene_id,row.actor_id,row.source_message_id,'inherited']));
    insert.run(id,childTimelineId,row.scene_id,row.actor_id,row.source_message_id,row.source_hash,row.text,row.occurred_at);
  }
}

export function retrieveActorMemories(db,{timelineId,actorId,query='',excludeMessageIds=[],limit=6}) {
  if (!timelineId || !actorId || !db.prepare('SELECT 1 FROM timeline_actors WHERE timeline_id=? AND actor_id=?').get(timelineId,actorId))
    throw new Error('Actor is not in this timeline');
  const words = [...new Set((String(query).match(/[\p{L}\p{N}]{2,32}/gu)||[]).map(x=>x.toLocaleLowerCase()))].slice(0,12);
  const match = words.map(w=>'"'+w.replaceAll('"','')+'"').join(' OR ');
  const rows = match ? db.prepare("SELECT m.*,bm25(actor_memories_fts) AS lexical FROM actor_memories_fts JOIN actor_memories m ON m.rowid=actor_memories_fts.rowid WHERE actor_memories_fts MATCH ? AND m.timeline_id=? AND m.actor_id=? ORDER BY lexical LIMIT 50").all(match,timelineId,actorId) : [];
  const recent = db.prepare("SELECT *,0 AS lexical FROM actor_memories WHERE timeline_id=? AND actor_id=? ORDER BY occurred_at DESC,rowid DESC LIMIT 12").all(timelineId,actorId);
  const excluded = new Set(excludeMessageIds);
  const matched = new Set(rows.map(x=>x.id));
  const candidates = [...rows,...recent.filter(x=>!matched.has(x.id))];
  const seen = new Set();
  const lowerWords = words.filter(w=>!['that','this','with','from','have','what','when','where','would','about','there','your','were','then'].includes(w));
  const maxDate = Math.max(1,...candidates.map(x=>x.occurred_at));
  const ranked = candidates.filter(x=>!excluded.has(x.source_message_id)).map(x=>{
    const lower = x.text.toLocaleLowerCase();
    const hits = lowerWords.filter(w=>lower.includes(w)).length;
    const score = hits*3 + (matched.has(x.id)?2:0) + (x.occurred_at===maxDate?0.2:0);
    return { ...x, score };
  }).sort((a,b)=>b.score-a.score||b.occurred_at-a.occurred_at);
  return ranked.filter(x=>{
    // Duplicate messages imported via a fork retain the same evidence hash.
    const key = x.source_hash+'|'+x.actor_id;
    if(seen.has(key)) return false;
    seen.add(key);return true;
  }).slice(0,Math.max(1,Math.min(12,limit))).map(({id,text,scene_id,source_message_id,occurred_at,origin,score})=>({
    id,text,sceneId:scene_id,sourceMessageId:source_message_id,occurredAt:occurred_at,origin,score
  }));
}
