// Optional v1 normalized projection of the canonical world snapshot.
// The existing studio_state row remains authoritative until an independently
// tested cutover. Projection tables are NEVER a new source of actor knowledge.
// Migrations and save-time updates share a SQLite transaction with the snapshot.
import { createHash } from 'node:crypto';

const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
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
      core TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS story_projection_characters (
      position INTEGER PRIMARY KEY CHECK(position>=0),
      character_id TEXT NOT NULL UNIQUE,
      document TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS story_projection_scenes (
      scene_id TEXT PRIMARY KEY,
      position INTEGER NOT NULL UNIQUE CHECK(position>=0),
      document TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS story_projection_messages (
      scene_id TEXT NOT NULL REFERENCES story_projection_scenes(scene_id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK(position>=0),
      message_id TEXT NOT NULL,
      document TEXT NOT NULL,
      PRIMARY KEY(scene_id,position),
      UNIQUE(scene_id,message_id)
    );
    CREATE INDEX IF NOT EXISTS story_projection_messages_by_id
      ON story_projection_messages(scene_id,message_id);
  `);
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
  const identity={core,characters,sessions};
  const keepCharacters=new Set(),keepScenes=new Set();
  const upsertChar=db.prepare(`INSERT INTO story_projection_characters(position,character_id,document)
    VALUES(?,?,?) ON CONFLICT(position) DO UPDATE SET character_id=excluded.character_id,
      document=excluded.document WHERE character_id!=excluded.character_id OR document!=excluded.document`);
  const upsertScene=db.prepare(`INSERT INTO story_projection_scenes(scene_id,position,document)
    VALUES(?,?,?) ON CONFLICT(scene_id) DO UPDATE SET position=excluded.position,
      document=excluded.document WHERE position!=excluded.position OR document!=excluded.document`);
  const upsertMessage=db.prepare(`INSERT INTO story_projection_messages(scene_id,position,message_id,document)
    VALUES(?,?,?,?) ON CONFLICT(scene_id,position) DO UPDATE SET message_id=excluded.message_id,
      document=excluded.document WHERE message_id!=excluded.message_id OR document!=excluded.document`);
  for(const [position,character] of characters.entries()){
    keepCharacters.add(position);
    upsertChar.run(position,character.id,encode(character));
  }
  // Delete moved/deleted characters before inserting at reused positions.
  db.prepare('DELETE FROM story_projection_characters WHERE position>=?').run(characters.length);
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
  for(const row of current)if(!keepScenes.has(row.scene_id))deleteScene.run(row.scene_id);
  db.prepare(`INSERT INTO story_projection_meta(id,format_version,revision,fingerprint,core)
    VALUES(1,1,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,
    fingerprint=excluded.fingerprint,core=excluded.core`)
    .run(revision,hash(identity),encode(core));
  return {revision,...inspectStoryProjectionInput(state)};
}

// Read-only parity check; no normalization that might hide malformed records.
export function readStoryProjection(db) {
  if(!hasSchema(db))return null;
  const meta=db.prepare('SELECT format_version AS version,revision,fingerprint,core FROM story_projection_meta WHERE id=1').get();
  if(!meta)return null;
  if(meta.version!==1)throw new Error('Unknown normalized story projection version');
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
  const identity={core,characters,sessions};
  if(hash(identity)!==meta.fingerprint)throw new Error('Normalized projection fingerprint mismatch');
  return {revision:meta.revision,state:{characters,sessions,...core},fingerprint:meta.fingerprint};
}

export function verifyStoryProjection(db,snapshot) {
  const projected=readStoryProjection(db);
  if(!projected)return {status:'absent'};
  if(projected.revision!==snapshot.revision)
    throw new Error('Normalized projection revision mismatch');
  const {characters,sessions,...core}=snapshot.state;
  if(projected.fingerprint!==hash({core,characters,sessions}))
    throw new Error('Normalized projection differs from canonical story');
  return {status:'matched',revision:snapshot.revision,
    ...inspectStoryProjectionInput(snapshot.state)};
}

export function projectionEnabled(db) {
  return hasSchema(db)&&Boolean(db.prepare('SELECT 1 FROM story_projection_meta WHERE id=1').get());
}
