// Single-user, local SQLite snapshot store. SQLite gives atomic commits without
// adding a native npm dependency or changing the existing browser state shape.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { normalizeState } from './engine.mjs';

export class StudioStore {
  constructor(filename = join(process.cwd(), '.data', 'studio.sqlite')) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`CREATE TABLE IF NOT EXISTS studio_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      document TEXT NOT NULL
    )`);
  }

  load() {
    const row = this.db.prepare('SELECT revision, updated_at, document FROM studio_state WHERE id = 1').get();
    return row ? { revision: row.revision, updatedAt: row.updated_at, state: normalizeState(JSON.parse(row.document)) } :
      { revision: 0, updatedAt: null, state: null };
  }

  save(state, expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new TypeError('Invalid revision');
    const validated = normalizeState(state);
    const payload = JSON.stringify(validated);
    if (Buffer.byteLength(payload, 'utf8') > 4_000_000) throw new RangeError('Story data exceeds the 4 MB save limit; export and archive older stories.');
    const updatedAt = Date.now();
    if (expectedRevision === 0) {
      const result = this.db.prepare('INSERT OR IGNORE INTO studio_state (id, revision, updated_at, document) VALUES (1, 1, ?, ?)').run(updatedAt, payload);
      if (result.changes) return { revision: 1, updatedAt };
    } else {
      const result = this.db.prepare('UPDATE studio_state SET revision = revision + 1, updated_at = ?, document = ? WHERE id = 1 AND revision = ?').run(updatedAt, payload, expectedRevision);
      if (result.changes) return { revision: expectedRevision + 1, updatedAt };
    }
    return null; // Concurrent tab or stale revision. Never overwrite newer data.
  }

  close() { this.db.close(); }
}
