// Optional v1 normalized projection of the canonical world snapshot.
// The existing studio_state row remains authoritative until an independently
// tested cutover. Projection tables are NEVER a new source of actor knowledge.
// Migrations and save-time updates share a SQLite transaction with the snapshot.
import { createHash } from 'node:crypto';

const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const canonicalSessions=sessions=>sessions.map(({messages,...metadata})=>({...metadata,messages}));
const fingerprint=state=>{
  const {characters,sessions,...core}=state;
  return hash({core,characters,sessions:canonicalSessions(sessions)});
};
const encode=JSON.stringify;
const decode=JSON.parse;
const hasSchema=db=>Boolean(db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name='story_projection_meta'"
).get());

export function initializeStoryProjection(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS story_projection_meta (
      id INTEGER PRIMARY KEY CHECK(id=1),
      format_version INTEGER NOT NULL CHECK(format_version=1),
      revision INTEGER NOT NULL,
      fingerprint TEXT NOT NULL,
      core TEXT NOT NULL,
      primary_mode INTEGER NOT NULL DEFAULT 0 CHECK(primary_mode IN (0,1))
    );
    CREATE TABLE IF NOT EXISTS story_projection_characters (
      character_id TEXT PRIMARY KEY,
      position INTEGER NOT NULL CHECK(position>=0),
      document TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS story_projection_scenes (
      scene_id TEXT PRIMARY KEY,
      position INTEGER NOT NULL CHECK(position>=0),
      document TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS story_projection_messages (
      scene_id TEXT NOT NULL REFERENCES story_projection_scenes(scene_id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK(position>=0),
      message_id TEXT NOT NULL,
      document TEXT NOT NULL,
      PRIMARY KEY(scene_id,position)
    );
  `);
  // Shadow tables created before primary mode was introduced gain the flag
  // transactionally; do not reinterpret existing records as primary.
  if(!db.prepare('PRAGMA table_info(story_projection_meta)').all().some(x=>x.name==='primary_mode'))
    db.exec('ALTER TABLE story_projection_meta ADD COLUMN primary_mode INTEGER NOT NULL DEFAULT 0 CHECK(primary_mode IN (0,1))');
}

export function inspectStoryProjectionInput(state) {
  if(!state||!Array.isArray(state.characters)||!Array.isArray(state.sessions))
    throw new Error('Invalid canonical story projection');
  const characters=new Set(),scenes=new Set();
  let messageCount=0;
  for(const character of state.characters){
    if(typeof character?.id!=='string'||!character.id||characters.has(character.id))
      throw new Error('Duplicate or invalid character ID in normalized projection');
    characters.add(character.id);
  }
  for(const scene of state.sessions){
    if(typeof scene?.id!=='string'||!scene.id||scenes.has(scene.id)||!Array.isArray(scene.messages))
      throw new Error('Duplicate or invalid scene ID in normalized projection');
    scenes.add(scene.id);
    const ids=new Set();
    for(const message of scene.messages){
      if(typeof message?.id!=='string'||!message.id||ids.has(message.id))
        throw new Error('Duplicate or invalid message ID in normalized projection');
      ids.add(message.id);
      messageCount++;
    }
  }
  return {characters:characters.size,scenes:scenes.size,messages:messageCount};
}

// Requires an existing SQLite write transaction. A trigger or disk error must
// abort the original save, not leave the JSON and normalized copies divergent.
export function writeStoryProjection(db,state,revision) {
  if(!db.isTransaction)throw new Error('Normalized projection requires an active transaction');
  if(!Number.isSafeInteger(revision)||revision<0)throw new Error('Invalid projection revision');
  inspectStoryProjectionInput(state);
  initializeStoryProjection(db);
  const {characters,sessions,...core}=state;
  const keepCharacters=new Set(),keepScenes=new Set();
  const upsertChar=db.prepare(`INSERT INTO story_projection_characters(character_id,position,document)
    VALUES(?,?,?) ON CONFLICT(character_id) DO UPDATE SET position=excluded.position,
      document=excluded.document WHERE position!=excluded.position OR document!=excluded.document`);
  const upsertScene=db.prepare(`INSERT INTO story_projection_scenes(scene_id,position,document)
    VALUES(?,?,?) ON CONFLICT(scene_id) DO UPDATE SET position=excluded.position,
      document=excluded.document WHERE position!=excluded.position OR document!=excluded.document`);
  const upsertMessage=db.prepare(`INSERT INTO story_projection_messages(scene_id,position,message_id,document)
    VALUES(?,?,?,?) ON CONFLICT(scene_id,position) DO UPDATE SET message_id=excluded.message_id,
      document=excluded.document WHERE message_id!=excluded.message_id OR document!=excluded.document`);
  for(const [position,character] of characters.entries()){
    keepCharacters.add(character.id);
    upsertChar.run(character.id,position,encode(character));
  }
  const deleteCharacter=db.prepare('DELETE FROM story_projection_characters WHERE character_id=?');
  for(const row of db.prepare('SELECT character_id FROM story_projection_characters').all())
    if(!keepCharacters.has(row.character_id))deleteCharacter.run(row.character_id);
  for(const [position,scene] of sessions.entries()){
    keepScenes.add(scene.id);
    const {messages,...metadata}=scene;
    upsertScene.run(scene.id,position,encode(metadata));
    for(const [messagePosition,message] of messages.entries())
      upsertMessage.run(scene.id,messagePosition,message.id,encode(message));
    db.prepare('DELETE FROM story_projection_messages WHERE scene_id=? AND position>=?')
      .run(scene.id,messages.length);
  }
  const current=db.prepare('SELECT scene_id FROM story_projection_scenes').all();
  const deleteScene=db.prepare('DELETE FROM story_projection_scenes WHERE scene_id=?');
  const deleteMessages=db.prepare('DELETE FROM story_projection_messages WHERE scene_id=?');
  for(const row of current)if(!keepScenes.has(row.scene_id)){
    deleteMessages.run(row.scene_id); // Also safe when legacy SQLite foreign_keys is disabled.
    deleteScene.run(row.scene_id);
  }
  db.prepare(`INSERT INTO story_projection_meta(id,format_version,revision,fingerprint,core)
    VALUES(1,1,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,
    fingerprint=excluded.fingerprint,core=excluded.core`)
    .run(revision,fingerprint(state),encode(core));
  return {revision,...inspectStoryProjectionInput(state)};
}

// Read-only parity check; no normalization that might hide malformed records.
export function readStoryProjection(db) {
  if(!hasSchema(db))return null;
  const meta=db.prepare('SELECT format_version AS version,revision,fingerprint,core FROM story_projection_meta WHERE id=1').get();
  if(!meta)return null;
  if(meta.version!==1)throw new Error('Unknown normalized story projection version');
  const orphan=db.prepare(`SELECT 1 FROM story_projection_messages m
    WHERE NOT EXISTS(SELECT 1 FROM story_projection_scenes s WHERE s.scene_id=m.scene_id) LIMIT 1`).get();
  if(orphan)throw new Error('Orphaned normalized message');
  const core=decode(meta.core);
  const characters=db.prepare('SELECT character_id,document FROM story_projection_characters ORDER BY position').all()
    .map(row=>{const item=decode(row.document);if(item.id!==row.character_id)throw Error('Character projection identity mismatch');return item;});
  const sessions=db.prepare('SELECT scene_id,document FROM story_projection_scenes ORDER BY position').all()
    .map(row=>{
      const scene=decode(row.document);
      if(scene.id!==row.scene_id)throw Error('Scene projection identity mismatch');
      const messages=db.prepare('SELECT message_id,document FROM story_projection_messages WHERE scene_id=? ORDER BY position')
        .all(row.scene_id).map(message=>{
          const item=decode(message.document);
          if(item.id!==message.message_id)throw Error('Message projection identity mismatch');
          return item;
        });
      return {...scene,messages};
    });
  if(fingerprint({characters,sessions,...core})!==meta.fingerprint)
    throw new Error('Normalized projection fingerprint mismatch');
  return {revision:meta.revision,state:{characters,sessions,...core},fingerprint:meta.fingerprint};
}

export function verifyStoryProjection(db,snapshot) {
  const projected=readStoryProjection(db);
  if(!projected)return {status:'absent'};
  if(projected.revision!==snapshot.revision)
    throw new Error('Normalized projection revision mismatch');
  if(projected.fingerprint!==fingerprint(snapshot.state))
    throw new Error('Normalized projection differs from canonical story');
  return {status:'matched',revision:snapshot.revision,
    ...inspectStoryProjectionInput(snapshot.state)};
}

export function projectionEnabled(db) {
  return hasSchema(db)&&Boolean(db.prepare('SELECT 1 FROM story_projection_meta WHERE id=1').get());
}

export function projectionPrimary(db) {
  if(!projectionEnabled(db))return false;
  const fields=db.prepare('PRAGMA table_info(story_projection_meta)').all();
  if(!fields.some(x=>x.name==='primary_mode'))return false;
  return db.prepare('SELECT primary_mode AS active FROM story_projection_meta WHERE id=1').get()?.active===1;
}

export function compactPrimaryDocument(state) {
  const {characters,sessions,...core}=state;
  return {characters:[],sessions:[],...core};
}

// Reads the full story only from the verified, explicitly activated projection.
// The smaller studio_state row still controls the monotonic revision and retains
// core settings; it is NOT a fallback that may silently erase a timeline.
export function readPrimaryStory(db,row) {
  if(!projectionPrimary(db))throw Error('Normalized primary storage is not enabled');
  const projected=readStoryProjection(db);
  if(!projected||projected.revision!==row.revision)
    throw Error('Normalized primary revision mismatch');
  if(JSON.stringify(compactPrimaryDocument(projected.state))!==row.document)
    throw Error('Normalized primary metadata differs from canonical revision');
  return projected.state;
}

// Apply inside the same world SQLite transaction. Backup-gated CLI only.
export function enablePrimaryProjection(db,snapshot) {
  if(!db.isTransaction)throw Error('Primary cutover requires a SQLite transaction');
  if(!projectionEnabled(db))throw Error('Stage and verify normalized shadow storage first');
  if(projectionPrimary(db))throw Error('Normalized primary storage already active');
  verifyStoryProjection(db,snapshot);
  initializeStoryProjection(db);
  const compact=JSON.stringify(compactPrimaryDocument(snapshot.state));
  const update=db.prepare('UPDATE studio_state SET document=? WHERE id=1 AND revision=?')
    .run(compact,snapshot.revision);
  if(update.changes!==1)throw Error('Story revision changed during primary cutover');
  db.prepare('UPDATE story_projection_meta SET primary_mode=1 WHERE id=1 AND revision=?')
    .run(snapshot.revision);
  readPrimaryStory(db,{revision:snapshot.revision,document:compact});
  return {revision:snapshot.revision,compactBytes:Buffer.byteLength(compact,'utf8')};
}
