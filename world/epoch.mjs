// A durable per-SQLite-world mutation version. Story changes carry their own
// studio_state revision; these triggers cover independently committed canon,
// positions, clocks, witnessed memory and event provenance. SQLite updates the
// version in the SAME transaction as the underlying write, even if another
// connection makes the change or the server restarts.
const WATCHED_TABLES=Object.freeze([
  'worlds','world_revisions','timelines','timeline_fork_snapshots','timeline_actors',
  'timeline_clocks','timeline_positions','world_locations','location_connections',
  'world_entities','world_relationships','character_world_sources',
  'character_world_relationship_sources','event_proposals','timeline_events',
  'timeline_event_observers','actor_memories','actor_facts'
]);
const OPS=Object.freeze(['INSERT','UPDATE','DELETE']);

export function initializeWorldEpoch(db){
  db.exec(`CREATE TABLE IF NOT EXISTS world_epoch (
    id INTEGER PRIMARY KEY CHECK(id=1),
    version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0)
  );
  INSERT OR IGNORE INTO world_epoch(id,version) VALUES(1,0);`);
  for(const table of WATCHED_TABLES){
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
      throw new Error('World mutation tracking requires missing table '+table);
    for(const op of OPS){
      // Identifiers are sourced only from the constant table/operation lists.
      const name=`world_epoch_${table}_${op.toLowerCase()}`;
      db.exec(`CREATE TRIGGER IF NOT EXISTS "${name}" AFTER ${op} ON "${table}"
        BEGIN UPDATE world_epoch SET version=version+1 WHERE id=1; END;`);
    }
  }
}

export function readWorldEpoch(db){
  const version=db.prepare('SELECT version FROM world_epoch WHERE id=1').get()?.version;
  if(!Number.isSafeInteger(version)||version<0)
    throw new Error('World mutation version missing or invalid; restore a verified backup');
  return version;
}
