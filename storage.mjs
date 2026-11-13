// Single-user, local SQLite snapshot store. SQLite gives atomic commits without
// adding a native npm dependency or changing the existing browser state shape.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { normalizeState } from './engine.mjs';
import { canKnowLore } from './harness.mjs';
import { bindTimelineIds } from './world/canon.mjs';
import { initializeWorldSchema, WorldRepository, synchronizeSceneTimelines } from './world/persistence.mjs';

export class StudioStore {
  constructor(filename = join(process.cwd(), '.data', 'studio.sqlite')) {
    if (filename !== ':memory:') {
      mkdirSync(dirname(filename), { recursive: true });
      // Keep one pre-upgrade backup of the original single-document database.
      if (existsSync(filename) && !existsSync(`${filename}.before-world-v1.bak`))
        copyFileSync(filename, `${filename}.before-world-v1.bak`);
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
    this.worlds = new WorldRepository(this.db);
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
