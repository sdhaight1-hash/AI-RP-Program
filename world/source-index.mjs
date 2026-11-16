// Persistent world-local source index. SQLite owns source IDs and source text;
// FTS is derived and never confers canon authority.
import {createHash} from 'node:crypto';
import {sourcesFor,discoverUniverseMentions} from './discovery.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const sourceKey=s=>JSON.stringify([s.type,s.id,s.field]);
const MAX_QUERY=120;
export function initializeUniverseSourceIndex(db){
  db.exec(`CREATE TABLE IF NOT EXISTS universe_source_documents(
    id INTEGER PRIMARY KEY,
    source_key TEXT NOT NULL UNIQUE,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    field TEXT NOT NULL,
    trust TEXT NOT NULL,
    content TEXT NOT NULL,
    fingerprint TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS universe_entry_provenance (
    world_id TEXT NOT NULL,
    entry_type TEXT NOT NULL CHECK(entry_type IN ('location','entity')),
    entry_id TEXT NOT NULL,
    source_key TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    source_quote TEXT NOT NULL,
    source_trust TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY(world_id,entry_type,entry_id)
  );
  CREATE TABLE IF NOT EXISTS universe_entry_aliases (
    world_id TEXT NOT NULL,
    entry_type TEXT NOT NULL CHECK(entry_type IN ('location','entity')),
    entry_id TEXT NOT NULL,
    alias TEXT NOT NULL,
    alias_key TEXT NOT NULL,
    source_key TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    source_quote TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY(world_id,entry_type,alias_key)
  );
  CREATE INDEX IF NOT EXISTS universe_alias_target ON universe_entry_aliases(world_id,entry_type,entry_id);
  CREATE TABLE IF NOT EXISTS universe_candidate_dismissals (
    world_id TEXT NOT NULL,
    focus TEXT NOT NULL CHECK(focus IN ('locations','groups')),
    name_key TEXT NOT NULL,
    source_key TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY(world_id,focus,name_key,source_key)
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS universe_source_fts USING fts5(
    content,content='universe_source_documents',content_rowid='id',tokenize='unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS universe_source_ai AFTER INSERT ON universe_source_documents BEGIN
    INSERT INTO universe_source_fts(rowid,content) VALUES(new.id,new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS universe_source_ad AFTER DELETE ON universe_source_documents BEGIN
    INSERT INTO universe_source_fts(universe_source_fts,rowid,content)
    VALUES('delete',old.id,old.content);
  END;
  CREATE TRIGGER IF NOT EXISTS universe_source_au AFTER UPDATE ON universe_source_documents BEGIN
    INSERT INTO universe_source_fts(universe_source_fts,rowid,content)
    VALUES('delete',old.id,old.content);
    INSERT INTO universe_source_fts(rowid,content) VALUES(new.id,new.content);
  END;`);
}
export function syncUniverseSources(db,{worldId,state,library}){
  if(!worldId||library?.activeWorldId!==worldId)throw Error('Universe source index requires explicit world');
  const sources=sourcesFor({worldId,state,library});
  const previous=new Map(db.prepare('SELECT source_key,fingerprint FROM universe_source_documents').all()
    .map(x=>[x.source_key,x.fingerprint]));
  const existing=new Set();
  const upsert=db.prepare(`INSERT INTO universe_source_documents
    (source_key,source_type,source_id,field,trust,content,fingerprint)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(source_key) DO UPDATE SET
      trust=excluded.trust,content=excluded.content,fingerprint=excluded.fingerprint`);
  let changed=0,removed=0;
  const run=()=>{
    for(const source of sources){
      if(!source.id||!source.field)continue;
      const key=sourceKey(source),fingerprint=hash(source.trust+'\0'+source.text);
      existing.add(key);
      if(previous.get(key)===fingerprint)continue;
      upsert.run(key,source.type,source.id,source.field,source.trust,source.text,fingerprint);
      changed++;
    }
    const deletion=db.prepare('DELETE FROM universe_source_documents WHERE source_key=?');
    for(const key of previous.keys())if(!existing.has(key)){deletion.run(key);removed++;}
  };
  // A SAVEPOINT is safe both during the canonical story transaction and on
  // explicit refreshes after separate universe metadata updates.
  db.exec('SAVEPOINT universe_source_sync');
  try{run();db.exec('RELEASE SAVEPOINT universe_source_sync');}
  catch(error){
    db.exec('ROLLBACK TO SAVEPOINT universe_source_sync');
    db.exec('RELEASE SAVEPOINT universe_source_sync');
    throw error;
  }
  return {worldId,scanned:sources.length,changed,removed};
}
export function findUniverseSources(db,{query='',limit=400}={}){
  const size=Math.max(1,Math.min(1000,Number.isInteger(limit)?limit:400));
  let rows;
  if(query){
    if(typeof query!=='string'||query.length>MAX_QUERY)throw Error('Source search must be at most 120 characters');
    // Literal word/phrase search rather than raw user-supplied MATCH grammar.
    const terms=query.normalize('NFKC').match(/[\p{L}\p{N}]+/gu)?.slice(0,8)||[];
    if(!terms.length)return [];
    const expr=terms.map(term=>'"'+term.replaceAll('"','')+'"').join(' AND ');
    rows=db.prepare(`SELECT d.source_type AS type,d.source_id AS id,d.field,d.trust,d.content AS text,d.fingerprint
      FROM universe_source_fts f JOIN universe_source_documents d ON d.id=f.rowid
      WHERE universe_source_fts MATCH ? ORDER BY bm25(universe_source_fts),d.id DESC LIMIT ?`).all(expr,size);
  }else{
    rows=db.prepare(`SELECT source_type AS type,source_id AS id,field,trust,content AS text,fingerprint
      FROM universe_source_documents ORDER BY id DESC LIMIT ?`).all(size);
  }
  return rows;
}
export function discoverIndexedUniverseMentions(db,{worldId,library,focus='locations',query='',limit=14}={}){
  const sourcesOverride=findUniverseSources(db,{query,limit:query?750:1000});
  return discoverUniverseMentions({worldId,library,focus,limit,sourcesOverride});
}

export function verifyUniverseSourceProof(db,sourceProof,name){
  if(!sourceProof||typeof sourceProof!=='object'||Array.isArray(sourceProof))
    throw Error('Invalid source evidence');
  const {type,id,field,quote,fingerprint}=sourceProof;
  if(![type,id,field,quote,fingerprint].every(v=>typeof v==='string'&&v.length>0))
    throw Error('Incomplete source evidence');
  if([type,id,field].some(v=>v.length>160)||quote.length>500||!/^[a-f0-9]{64}$/i.test(fingerprint))
    throw Error('Invalid source evidence length');
  const row=db.prepare(`SELECT content,trust,fingerprint
    FROM universe_source_documents WHERE source_key=?`).get(sourceKey({type,id,field}));
  if(!row||row.fingerprint!==fingerprint)
    throw Error('Source changed; rescan and review the current evidence before saving canon');
  if(!row.content.includes(quote)||!quote.toLocaleLowerCase().includes(
    String(name||'').trim().toLocaleLowerCase()))
    throw Error('Selected source does not substantiate this name');
  return {sourceKey:sourceKey({type,id,field}),trust:row.trust,quote,fingerprint,type,id,field};
}

export function createSourcedUniverseEntry(db,repository,{worldId,entryType,sourceProof,...entry}){
  if(!['location','entity'].includes(entryType)||!sourceProof||
     typeof sourceProof!=='object'||Array.isArray(sourceProof))
    throw Error('Invalid sourced canon entry');
  const verified=verifyUniverseSourceProof(db,sourceProof,entry.name);
  const {type,id,field,quote,fingerprint}=verified;
  const row={trust:verified.trust};
  db.exec('SAVEPOINT universe_canon_approval');
  try{
    const created=entryType==='location'
      ?repository.createLocation({worldId,...entry})
      :repository.createEntity({worldId,...entry});
    db.prepare(`INSERT INTO universe_entry_provenance
      (world_id,entry_type,entry_id,source_key,source_fingerprint,source_quote,source_trust,recorded_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(worldId,entryType,created.id,
        sourceKey({type,id,field}),fingerprint,quote,row.trust,Date.now());
    db.exec('RELEASE SAVEPOINT universe_canon_approval');
    return {...created,provenance:{type,id,field,quote,trust:row.trust,sourceStatus:'current'}};
  }catch(error){
    db.exec('ROLLBACK TO SAVEPOINT universe_canon_approval');
    db.exec('RELEASE SAVEPOINT universe_canon_approval');
    throw error;
  }
}
export function listUniverseEntryProvenance(db,worldId){
  return db.prepare(`SELECT p.entry_type AS entryType,p.entry_id AS entryId,
    p.source_key AS sourceKey,p.source_fingerprint AS fingerprint,
    p.source_quote AS quote,p.source_trust AS trust,
    p.recorded_at AS recordedAt,
    CASE WHEN s.fingerprint=p.source_fingerprint THEN 'current'
      WHEN s.id IS NULL THEN 'removed' ELSE 'changed' END AS sourceStatus
    FROM universe_entry_provenance p
    LEFT JOIN universe_source_documents s ON s.source_key=p.source_key
    WHERE p.world_id=? ORDER BY p.recorded_at DESC`).all(worldId);
}
