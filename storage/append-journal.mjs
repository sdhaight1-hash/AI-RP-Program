// Optional append journal layered over a verified normalized-primary v1 base.
// The existing v1 fingerprint continues to protect every base message. Each
// incremental row is linked to that fingerprint with a collision-resistant
// append chain. No world is enabled automatically.
import {createHash} from 'node:crypto';
import {syncAppendedPlayerMemory} from '../memory/store.mjs';
import {getChannel} from '../interactions/channels.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const seed=fingerprint=>hash('ai-rp-journal-v1:'+fingerprint);
const link=(previous,row)=>hash(JSON.stringify([previous,row.version,row.scene_id,
  row.position,row.message_id,row.document,row.updated_at]));
const hasTable=(db,name)=>Boolean(db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

export function journalEnabled(db){
  return hasTable(db,'story_append_meta')&&Boolean(db.prepare(
    'SELECT 1 FROM story_append_meta WHERE id=1').get());
}

function createJournalTables(db){
  if(!db.isTransaction)throw new Error('Append journal schema requires a transaction');
  db.exec(`CREATE TABLE IF NOT EXISTS story_append_meta (
    id INTEGER PRIMARY KEY CHECK(id=1),
    base_revision INTEGER NOT NULL CHECK(base_revision>=0),
    revision INTEGER NOT NULL CHECK(revision>=base_revision),
    base_fingerprint TEXT NOT NULL,
    chain TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS story_append_rows (
    version INTEGER PRIMARY KEY CHECK(version>=0),
    scene_id TEXT NOT NULL REFERENCES story_projection_scenes(scene_id),
    position INTEGER NOT NULL CHECK(position>=0),
    message_id TEXT NOT NULL,
    document TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    chain TEXT NOT NULL,
    UNIQUE(scene_id,position),
    UNIQUE(scene_id,message_id)
  );
  CREATE TABLE IF NOT EXISTS story_append_heads (
    scene_id TEXT PRIMARY KEY REFERENCES story_projection_scenes(scene_id),
    message_count INTEGER NOT NULL CHECK(message_count>=0),
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS story_message_source_idx
    ON story_projection_messages(scene_id,message_id);`);
}

function rebuildHeads(db,state){
  db.prepare('DELETE FROM story_append_heads').run();
  const insert=db.prepare('INSERT INTO story_append_heads(scene_id,message_count,updated_at) VALUES(?,?,?)');
  for(const scene of state.sessions)
    insert.run(scene.id,scene.messages.length,Number(scene.updatedAt)||0);
}

export function enableAppendJournal(db,snapshot){
  if(!db.isTransaction)throw new Error('Journal activation requires an offline SQLite transaction');
  if(journalEnabled(db))throw new Error('Append journal already enabled');
  if(!hasTable(db,'story_projection_meta'))
    throw new Error('Verify and explicitly enable normalized-primary storage first');
  const projection=db.prepare('SELECT revision,fingerprint,primary_mode FROM story_projection_meta WHERE id=1').get();
  const story=db.prepare('SELECT revision FROM studio_state WHERE id=1').get();
  if(!projection||projection.primary_mode!==1||!story||
     projection.revision!==snapshot?.revision||story.revision!==snapshot.revision)
    throw new Error('Verify and explicitly enable normalized-primary storage first');
  if(!snapshot.state||!Array.isArray(snapshot.state.sessions))
    throw new Error('Verified canonical snapshot required');
  createJournalTables(db);
  rebuildHeads(db,snapshot.state);
  db.prepare('INSERT INTO story_append_meta(id,base_revision,revision,base_fingerprint,chain) VALUES(1,?,?,?,?)')
    .run(snapshot.revision,snapshot.revision,projection.fingerprint,seed(projection.fingerprint));
  return {revision:snapshot.revision,scenes:snapshot.state.sessions.length};
}

export function clearAppendJournalRowsForRewrite(db){
  if(!journalEnabled(db))return;
  if(!db.isTransaction)throw new Error('Journal preparation requires a transaction');
  // Drop both dependent sidecar tables before ordinary full-save
  // projection deletes old scenes. The enclosing transaction restores them
  // if an accepted-source lock or any later write fails.
  db.prepare('DELETE FROM story_append_rows').run();
  db.prepare('DELETE FROM story_append_heads').run();
}

// A normal full-world save can compact the journal in that same transaction.
// Only the current canonical state may be used as the new verified base.
export function resetAppendJournal(db,state,revision,fingerprint){
  if(!journalEnabled(db))return;
  if(!db.isTransaction)throw new Error('Journal compaction requires a transaction');
  db.prepare('DELETE FROM story_append_rows').run();
  rebuildHeads(db,state);
  db.prepare('UPDATE story_append_meta SET base_revision=?,revision=?,base_fingerprint=?,chain=? WHERE id=1')
    .run(revision,revision,fingerprint,seed(fingerprint));
}

// The low-level primitive does not authorize user input. A future player-only
// HTTP boundary must authenticate the current scene/cast/channel and compute
// witness IDs *before* invoking this function.
export function appendVerifiedPlayerRow(db,{sceneId,message,expectedRevision,updatedAt=Date.now()}){
  if(!db.isTransaction)throw new Error('Message append requires a SQLite transaction');
  if(!journalEnabled(db))throw new Error('Append journal not enabled');
  if(typeof sceneId!=='string'||!sceneId||sceneId.length>160||
     !message||message.role!=='user'||typeof message.id!=='string'||
     !message.id||message.id.length>160||typeof message.content!=='string'||
     !message.content.trim()||message.content.length>30000||
     typeof message.channelId!=='string'||!Array.isArray(message.witnessIds)||
     !Number.isSafeInteger(message.sentAt)||message.sentAt<0||
     Object.keys(message).some(key=>!['id','role','content','channelId','sentAt','witnessIds','pinned'].includes(key))||
     !Number.isSafeInteger(expectedRevision)||expectedRevision<0||
     !Number.isSafeInteger(updatedAt)||updatedAt<0)
    throw new Error('Invalid verified player message append');
  const story=db.prepare('SELECT revision FROM studio_state WHERE id=1').get();
  const meta=db.prepare('SELECT * FROM story_append_meta WHERE id=1').get();
  if(!story||story.revision!==expectedRevision||meta.revision!==expectedRevision)
    throw new Error('Story revision changed before append');
  const scene=db.prepare('SELECT document FROM story_projection_scenes WHERE scene_id=?').get(sceneId);
  const head=db.prepare('SELECT message_count FROM story_append_heads WHERE scene_id=?').get(sceneId);
  if(!scene||!head)throw new Error('Scene not found');
  const sceneMetadata=JSON.parse(scene.document);
  if(sceneMetadata.trashedAt||sceneMetadata.channelId!==message.channelId||
     !sceneMetadata.timelineId)
    throw new Error('Scene archived, unsaved or its communication medium changed');
  // Produce the same canonical player-message fields as normalizeState on a
  // full save, otherwise a later verified projection parity check would see
  // a different source despite the same visible content.
  const writtenMessage={...message,id:message.id,pinned:Boolean(message.pinned),
    channelId:getChannel(message.channelId).id,sentAt:message.sentAt,
    speakerId:undefined,witnessIds:[...new Set(message.witnessIds)],variants:undefined};
  if(db.prepare('SELECT 1 FROM story_projection_messages WHERE scene_id=? AND message_id=?').get(sceneId,message.id)||
    db.prepare('SELECT 1 FROM story_append_rows WHERE scene_id=? AND message_id=?').get(sceneId,message.id))
    throw new Error('Duplicate source message ID');
  const row={version:expectedRevision+1,scene_id:sceneId,position:head.message_count,
    message_id:message.id,document:JSON.stringify(writtenMessage),updated_at:updatedAt};
  const nextChain=link(meta.chain,row);
  db.prepare('INSERT INTO story_append_rows(version,scene_id,position,message_id,document,updated_at,chain) VALUES(?,?,?,?,?,?,?)')
    .run(row.version,row.scene_id,row.position,row.message_id,row.document,row.updated_at,nextChain);
  db.prepare('UPDATE story_append_heads SET message_count=message_count+1,updated_at=? WHERE scene_id=?')
    .run(updatedAt,sceneId);
  db.prepare('UPDATE story_append_meta SET revision=?,chain=? WHERE id=1')
    .run(row.version,nextChain);
  const written=db.prepare('UPDATE studio_state SET revision=?,updated_at=? WHERE id=1 AND revision=?')
    .run(row.version,updatedAt,expectedRevision);
  if(written.changes!==1)throw new Error('Story changed during append');
  // Source memory + FTS is committed with the same journal row and revision,
  // never deferred to a later full-history resave.
  syncAppendedPlayerMemory(db,sceneMetadata,writtenMessage);
  // Even a zero-witness journal append (if explicitly permitted by a future
  // checked API) is a world change relevant to another actor's reply basis.
  db.prepare('UPDATE world_epoch SET version=version+1 WHERE id=1').run();
  return {revision:row.version,message:writtenMessage};
}

export function applyAppendJournal(db,base,storyRevision){
  if(!journalEnabled(db)){
    if(base.revision!==storyRevision)throw new Error('Normalized primary revision mismatch');
    return base;
  }
  const meta=db.prepare('SELECT * FROM story_append_meta WHERE id=1').get();
  if(meta.base_revision!==base.revision||meta.base_fingerprint!==base.fingerprint||
     meta.revision!==storyRevision)
    throw new Error('Append journal base/revision mismatch');
  const scenes=new Map(base.state.sessions.map(s=>[s.id,s]));
  let chain=seed(base.fingerprint),revision=base.revision;
  const rows=db.prepare('SELECT * FROM story_append_rows ORDER BY version').all();
  for(const row of rows){
    if(row.version!==revision+1)throw new Error('Append journal revision gap');
    const scene=scenes.get(row.scene_id);
    if(!scene||scene.trashedAt||row.position!==scene.messages.length)
      throw new Error('Append journal scene/position mismatch');
    const message=JSON.parse(row.document);
    if(message.id!==row.message_id||message.role!=='user'||
      scene.messages.some(m=>m.id===message.id))
      throw new Error('Append journal source identity mismatch');
    chain=link(chain,row);
    if(chain!==row.chain)throw new Error('Append journal chain mismatch');
    scene.messages.push(message);
    scene.updatedAt=row.updated_at;
    revision=row.version;
  }
  if(chain!==meta.chain||revision!==meta.revision)
    throw new Error('Append journal terminal checksum mismatch');
  const heads=db.prepare('SELECT scene_id,message_count,updated_at FROM story_append_heads').all();
  if(heads.length!==scenes.size)throw new Error('Append journal head count mismatch');
  for(const head of heads){
    const scene=scenes.get(head.scene_id);
    if(!scene||scene.messages.length!==head.message_count||
      (Number(scene.updatedAt)||0)!==head.updated_at)
      throw new Error('Append journal scene head mismatch');
  }
  return {revision,state:base.state,fingerprint:base.fingerprint};
}
