// Reviewed aliases and dismissals share the existing world-local canon identity.
// Neither action creates facts, changes actor memories, nor imports other worlds.
import {verifyUniverseSourceProof} from './source-index.mjs';

export const canonNameKey=value=>String(value??'').normalize('NFKC')
  .toLocaleLowerCase().replace(/[’]/gu,"'").replace(/\s+/gu,' ').trim();

const targetTable={location:'world_locations',entity:'world_entities'};
const focusType={locations:'location',groups:'entity'};
function validName(name){
  if(typeof name!=='string'||name.trim().length<3||name.trim().length>120)
    throw Error('Candidate name must be 3–120 characters');
  return canonNameKey(name);
}
function transaction(db,action){
  db.exec('SAVEPOINT universe_review_decision');
  try{
    const result=action();
    db.exec('RELEASE SAVEPOINT universe_review_decision');
    return result;
  }catch(error){
    db.exec('ROLLBACK TO SAVEPOINT universe_review_decision');
    db.exec('RELEASE SAVEPOINT universe_review_decision');
    throw error;
  }
}
export function listUniverseAliases(db,worldId){
  return db.prepare(`SELECT entry_type AS entryType,entry_id AS entryId,
    alias,alias_key AS aliasKey,source_key AS sourceKey,
    source_fingerprint AS fingerprint,source_quote AS quote
    FROM universe_entry_aliases WHERE world_id=? ORDER BY alias_key`).all(worldId);
}
export function linkUniverseAlias(db,{worldId,focus,name,targetId,sourceProof}={}){
  const entryType=focusType[focus],aliasKey=validName(name);
  if(!entryType||typeof worldId!=='string'||!worldId||
     typeof targetId!=='string'||!targetId)throw Error('Invalid alias linkage');
  return transaction(db,()=>{
    const target=db.prepare(`SELECT id,name,kind FROM ${targetTable[entryType]}
      WHERE id=? AND world_id=?`).get(targetId,worldId);
    if(!target)throw Error('Target canon entry does not exist in this universe');
    const canonical=db.prepare(`SELECT id,name FROM ${targetTable[entryType]}
      WHERE world_id=?`).all(worldId)
      .find(item=>canonNameKey(item.name)===aliasKey);
    if(canonical)throw Error('A canon entry already has this name; use its existing identity');
    if(canonNameKey(target.name)===aliasKey)throw Error('This is already the canonical name');
    const existing=db.prepare(`SELECT entry_id AS entryId
      FROM universe_entry_aliases WHERE world_id=? AND entry_type=? AND alias_key=?`)
      .get(worldId,entryType,aliasKey);
    if(existing)throw Error('Alias already belongs to a canon entry; review existing links');
    const verified=verifyUniverseSourceProof(db,sourceProof,name);
    db.prepare(`INSERT INTO universe_entry_aliases
      (world_id,entry_type,entry_id,alias,alias_key,source_key,
       source_fingerprint,source_quote,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(worldId,entryType,targetId,name.trim(),aliasKey,verified.sourceKey,
        verified.fingerprint,verified.quote,Date.now());
    return {worldId,entryType,entryId:targetId,alias:name.trim(),
      canonicalName:target.name,status:'linked'};
  });
}
export function dismissUniverseMention(db,{worldId,focus,name,evidence}={}){
  const nameKey=validName(name);
  if(!focusType[focus]||typeof worldId!=='string'||!worldId||
    !Array.isArray(evidence)||evidence.length<1||evidence.length>4)
    throw Error('Invalid candidate dismissal');
  return transaction(db,()=>{
    const insert=db.prepare(`INSERT INTO universe_candidate_dismissals
      (world_id,focus,name_key,source_key,source_fingerprint,recorded_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(world_id,focus,name_key,source_key) DO UPDATE
      SET source_fingerprint=excluded.source_fingerprint,
          recorded_at=excluded.recorded_at`);
    const unique=new Set();
    for(const proof of evidence){
      const verified=verifyUniverseSourceProof(db,proof,name);
      if(unique.has(verified.sourceKey))continue;
      unique.add(verified.sourceKey);
      insert.run(worldId,focus,nameKey,verified.sourceKey,verified.fingerprint,Date.now());
    }
    return {worldId,focus,name,status:'dismissed',evidenceSources:unique.size};
  });
}
// Conservative possible-match hints: never equate two entries from spelling
// similarity alone. Exact aliases require a separate reviewed link.
function possibleMatches(candidate,established){
  const tokens=name=>new Set(canonNameKey(name).replace(/^(?:the|a|an) /u,'')
    .split(/\s+/u).filter(x=>x.length>2));
  const a=tokens(candidate.name);
  if(!a.size)return [];
  return established.flatMap(item=>{
    const b=tokens(item.name);
    const shared=[...a].filter(word=>b.has(word)).length;
    const similarity=shared/Math.max(a.size,b.size,1);
    return shared>=2&&similarity>=0.6
      ?[{id:item.id,name:item.name,kind:item.kind,reason:'similar name'}]:[];
  }).slice(0,4);
}
export function resolveUniverseCandidates(db,{worldId,focus,library,result}){
  const entryType=focusType[focus];
  if(!entryType||worldId!==library.activeWorldId||result.worldId!==worldId)
    throw Error('Universe review scope mismatch');
  const entries=(entryType==='location'?library.locations||[]:library.entities||[])
    .filter(x=>x.worldId===worldId);
  const aliases=listUniverseAliases(db,worldId).filter(x=>x.entryType===entryType);
  const aliasByKey=new Map(aliases.map(x=>[x.aliasKey,x]));
  const dismissed=new Map(db.prepare(`SELECT name_key AS nameKey,source_key AS sourceKey,
    source_fingerprint AS fingerprint FROM universe_candidate_dismissals
    WHERE world_id=? AND focus=?`).all(worldId,focus)
    .map(x=>[JSON.stringify([x.nameKey,x.sourceKey]),x.fingerprint]));
  const suggestions=[];
  const existingLinks=[...result.existingLinks];
  for(const candidate of result.suggestions){
    const key=canonNameKey(candidate.name);
    const alias=aliasByKey.get(key);
    if(alias){
      const entry=entries.find(x=>x.id===alias.entryId);
      if(entry)existingLinks.push({name:candidate.name,id:entry.id,kind:entry.kind,
        canonicalName:entry.name,status:'alias',evidence:candidate.evidence});
      continue;
    }
    const ignored=candidate.evidence.length&&candidate.evidence.every(proof=>
      proof.fingerprint&&dismissed.get(JSON.stringify([key,JSON.stringify([
        proof.type,proof.id,proof.field
      ])]))===proof.fingerprint);
    if(ignored)continue;
    suggestions.push({...candidate,possibleMatches:possibleMatches(candidate,entries)});
  }
  return {...result,suggestions:suggestions.slice(0,14),existingLinks:existingLinks.slice(0,20)};
}
export function purgeUniverseReviewLinks(db,{worldId,kind,id}){
  if(!targetTable[kind])return;
  db.prepare('DELETE FROM universe_entry_aliases WHERE world_id=? AND entry_type=? AND entry_id=?')
    .run(worldId,kind,id);
}
