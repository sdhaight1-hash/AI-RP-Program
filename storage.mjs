// Single-user, local SQLite snapshot store. SQLite gives atomic commits without
// adding a native npm dependency or changing the existing browser state shape.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { normalizeState } from './engine.mjs';
import { canKnowLore } from './harness.mjs';
import { bindTimelineIds } from './world/canon.mjs';
import { initializeWorldSchema, WorldRepository, synchronizeSceneTimelines } from './world/persistence.mjs';
import { EventLedger, initializeEventLedger, sourceFingerprint } from './world/event-ledger.mjs';

export class StudioStore {
  constructor(filename = join(process.cwd(), '.data', 'studio.sqlite')) {
    if (filename !== ':memory:') {
      mkdirSync(dirname(filename), { recursive: true });
      // Keep one pre-upgrade backup of the original single-document database.
      if (existsSync(filename) && !existsSync(`${filename}.before-world-v1.bak`))
        copyFileSync(filename, `${filename}.before-world-v1.bak`);
      if (existsSync(filename) && !existsSync(`${filename}.before-world-v2.bak`))
        copyFileSync(filename, `${filename}.before-world-v2.bak`);
      if (existsSync(filename) && !existsSync(`${filename}.before-world-v3.bak`))
        copyFileSync(filename, `${filename}.before-world-v3.bak`);
      if (existsSync(filename) && !existsSync(`${filename}.before-world-v4.bak`))
        copyFileSync(filename, `${filename}.before-world-v4.bak`);
    }
    this.db = new DatabaseSync(filename);
    this.db.exec(`CREATE TABLE IF NOT EXISTS studio_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      document TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS lore_fts USING fts5(id UNINDEXED, title, body, keywords, tokenize='unicode61')`);
    // Existing SQLite snapshots from earlier versions acquire a search index on first load.
    const persisted = this.load().state;
    initializeWorldSchema(this.db, persisted);
    initializeEventLedger(this.db);
    this.worlds = new WorldRepository(this.db);
    this.events = new EventLedger(this);
    this.rebuildLoreIndex(persisted?.lore || []);
  }

  load() {
    const row = this.db.prepare('SELECT revision, updated_at, document FROM studio_state WHERE id = 1').get();
    return row ? { revision: row.revision, updatedAt: row.updated_at, state: bindTimelineIds(normalizeState(JSON.parse(row.document))) } :
      { revision: 0, updatedAt: null, state: null };
  }

  rebuildLoreIndex(entries) {
    this.db.prepare('DELETE FROM lore_fts').run();
    const insert = this.db.prepare('INSERT INTO lore_fts (id,title,body,keywords) VALUES (?,?,?,?)');
    for (const item of entries) {
      insert.run(item.id, String(item.title || '').slice(0, 500), String(item.content || '').slice(0, 12000),
        (item.keywords || []).join(' ').slice(0, 1000));
    }
  }

  searchLore(query, { actorId, sessionId = null, limit = 6 } = {}) {
    if (typeof actorId !== 'string' || !actorId) throw new TypeError('An acting character is required');
    const tokens = String(query || '').match(/[\p{L}\p{N}]+/gu)?.slice(0, 8) || [];
    if (!tokens.length) return [];
    const expression = tokens.map(x => `"${x.replaceAll('"','')}"`).join(' OR ');
    // Retrieval uses FTS candidates; access-control is checked against canonical lore.
    const candidates = this.db.prepare('SELECT id, bm25(lore_fts) AS rank FROM lore_fts WHERE lore_fts MATCH ? ORDER BY rank LIMIT 100').all(expression);
    const { state } = this.load();
    const source = new Map((state?.lore || []).map(x => [x.id,x]));
    return candidates.map(hit => source.get(hit.id))
      .filter(entry => entry && canKnowLore(entry, actorId, sessionId))
      .slice(0, Math.min(20,Math.max(1,Math.round(limit))));
  }

  save(state, expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new TypeError('Invalid revision');
    const validated = bindTimelineIds(normalizeState(state));
    const payload = JSON.stringify(validated);
    if (Buffer.byteLength(payload, 'utf8') > 4_000_000) throw new RangeError('Story data exceeds the 4 MB save limit; export and archive older stories.');
    const updatedAt = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Accepted world events depend on their precise source response. Never
      // overwrite its wording, speaker, channel or witnesses via Retry/swipes.
      const accepted=this.db.prepare(`SELECT p.scene_id AS sceneId,p.timeline_id AS timelineId,
        p.source_message_id AS messageId,p.source_hash AS fingerprint,e.rowid AS eventSeq
        FROM event_proposals p JOIN timeline_events e ON e.proposal_id=p.id
        WHERE p.status='accepted'`).all();
      const scenes=new Map(validated.sessions.map(s=>[s.id,s]));
      for(const lock of accepted){
        const scene=scenes.get(lock.sceneId);
        if(!scene)continue; // Library purge may delete a source scene, but not its event ledger.
        const message=scene.messages.find(m=>m.id===lock.messageId);
        if(scene.timelineId!==lock.timelineId || !message || sourceFingerprint(message)!==lock.fingerprint)
          throw new Error('Accepted world event locks its source NPC reply. Start a fresh timeline that does not inherit this event to change history.');
      }
      // Forks inherit an immutable prefix of their ancestors' accepted events.
      // Follow message origins through *all* nested scene/timeline forks. This
      // also detects deleting an inherited source, not only editing its text.
      const forkLookup=this.db.prepare('SELECT parent_timeline_id AS parentId,max_parent_event_rowid AS cutoff FROM timeline_fork_snapshots WHERE timeline_id=?');
      for(const scene of validated.sessions){
        const ancestry=[];let cursor=scene;
        const visited=new Set();
        while(cursor.parentSceneId && !visited.has(cursor.id)){
          visited.add(cursor.id);
          const parent=scenes.get(cursor.parentSceneId),fork=forkLookup.get(cursor.timelineId);
          if(!parent || fork?.parentId!==parent.timelineId)break;
          ancestry.push({parent,fork});cursor=parent;
        }
        for(let depth=0;depth<ancestry.length;depth++){
          const {parent,fork}=ancestry[depth];
          for(const lock of accepted.filter(x=>x.sceneId===parent.id && x.eventSeq<=fork.cutoff)){
            const descendant=scene.messages.find(msg=>{
              let origin=msg;
              for(let i=0;i<=depth;i++){
                origin=ancestry[i].parent.messages.find(m=>m.id===origin?.originMessageId);
                if(!origin)return false;
              }
              return origin.id===lock.messageId;
            });
            if(!descendant || sourceFingerprint(descendant)!==lock.fingerprint)
              throw new Error('This branch inherits a committed event. Its original source NPC reply cannot be rewritten.');
          }
        }
      }
      let result;
      if (expectedRevision === 0) {
        result = this.db.prepare('INSERT OR IGNORE INTO studio_state (id, revision, updated_at, document) VALUES (1, 1, ?, ?)').run(updatedAt, payload);
      } else {
        result = this.db.prepare('UPDATE studio_state SET revision = revision + 1, updated_at = ?, document = ? WHERE id = 1 AND revision = ?').run(updatedAt, payload, expectedRevision);
      }
      if (!result.changes) { this.db.exec('ROLLBACK'); return null; }
      synchronizeSceneTimelines(this.db,validated);
      // Timeline IDs are stable and part of the persisted scene snapshot.
      // synchronizeSceneTimelines may add metadata, so update the same revision document.
      this.db.prepare('UPDATE studio_state SET document = ? WHERE id = 1').run(JSON.stringify(validated));
      this.rebuildLoreIndex(validated.lore);
      this.db.exec('COMMIT');
      return { revision: expectedRevision + 1, updatedAt };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  close() { this.db.close(); }
}
