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
