// Deterministic, auditable *potential* contradictions in explicit source claims.
// Values can differ across eras/timelines or unreliable speakers: no automatic
// truth selection, canon change, or character-knowledge promotion.
const NAME=String.raw`([A-Z][\p{L}\p{N}'’\-]*(?:\s+[A-Z][\p{L}\p{N}'’\-]*){0,4})`;
const VALUE=String.raw`([A-Z][\p{L}\p{N}'’\-]*(?:\s+[A-Z][\p{L}\p{N}'’\-]*){0,3})`;
const patterns=[
  {predicate:'founded_year',re:new RegExp(String.raw`\b(?:[Tt]he\s+)?`+NAME+String.raw`\s+was\s+(?:founded|established)\s+in\s+([12]\d{3})\b`,'gu')},
  {predicate:'birth_year',re:new RegExp(String.raw`\b(?:[Tt]he\s+)?`+NAME+String.raw`\s+was\s+born\s+in\s+([12]\d{3})\b`,'gu')},
  {predicate:'headquarters',re:new RegExp(String.raw`\b(?:[Tt]he\s+)?`+NAME+String.raw`\s+(?:is|was)\s+headquartered\s+in\s+`+VALUE,'gu')}
];
const keyOf=s=>String(s??'').normalize('NFKC').toLocaleLowerCase()
  .replace(/[’]/gu,"'").replace(/^(?:the|a|an)\s+/u,'')
  .replace(/\s+/gu,' ').trim();
const sourceKey=source=>JSON.stringify([source.type,source.id,source.field]);

export function extractSourceClaims(source){
  if(!source||typeof source.text!=='string')return [];
  const claims=[];
  for(const {predicate,re} of patterns){
    re.lastIndex=0;
    for(const match of source.text.matchAll(re)){
      const subject=match[1].trim(),value=match[2].trim();
      if(subject.length>120||value.length>100)continue;
      const quote=source.text.slice(match.index,match.index+match[0].length);
      claims.push({sourceKey:sourceKey(source),fingerprint:source.fingerprint,
        subject,subjectKey:keyOf(subject),predicate,value,valueKey:keyOf(value),
        quote,trust:source.trust});
    }
  }
  return claims;
}
export function replaceSourceClaims(db,source,fingerprint){
  const source_id=sourceKey(source);
  db.prepare('DELETE FROM universe_source_claims WHERE source_key=?').run(source_id);
  const insert=db.prepare(`INSERT INTO universe_source_claims
    (source_key,fingerprint,subject,subject_key,predicate,value,value_key,quote,trust)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  for(const c of extractSourceClaims({...source,fingerprint}))
    insert.run(c.sourceKey,fingerprint,c.subject,c.subjectKey,c.predicate,c.value,c.valueKey,c.quote,c.trust);
}
export function listPotentialClaimConflicts(db,{worldId,library,focus='groups',limit=12}={}){
  if(worldId!==library?.activeWorldId||!['groups','locations'].includes(focus))
    throw Error('Open the correct universe to review claim conflicts');
  const kind=focus==='groups'?'entity':'location';
  const canon=(kind==='entity'?library.entities||[]:library.locations||[])
    .filter(x=>x.worldId===worldId);
  const identities=new Map(canon.map(x=>[keyOf(x.name),x]));
  for(const alias of library.aliases||[]){
    if(alias.entryType!==kind)continue;
    const entry=canon.find(x=>x.id===alias.entryId);
    if(entry&&!identities.has(keyOf(alias.alias)))identities.set(keyOf(alias.alias),entry);
  }
  const groups=new Map();
  const rows=db.prepare(`SELECT source_key AS sourceKey,fingerprint,subject,subject_key AS subjectKey,
    predicate,value,value_key AS valueKey,quote,trust FROM universe_source_claims
    ORDER BY subject_key,predicate`).all();
  for(const claim of rows){
    const entry=identities.get(claim.subjectKey);
    if(!entry)continue;
    const identity=entry.id+'\0'+claim.predicate;
    if(!groups.has(identity))groups.set(identity,{entryId:entry.id,
      name:entry.name,kind:entry.kind,predicate:claim.predicate,values:new Map()});
    const group=groups.get(identity);
    if(!group.values.has(claim.valueKey))
      group.values.set(claim.valueKey,{value:claim.value,evidence:[]});
    const value=group.values.get(claim.valueKey);
    if(value.evidence.length<4){
      const [type,id,field]=JSON.parse(claim.sourceKey);
      value.evidence.push({type,id,field,quote:claim.quote,
        fingerprint:claim.fingerprint,trust:claim.trust});
    }
  }
  const conflicts=[...groups.values()].filter(x=>x.values.size>1)
    .map(x=>({entryId:x.entryId,name:x.name,kind:x.kind,predicate:x.predicate,
      status:'potential_conflict',values:[...x.values.values()]}))
    .slice(0,Math.max(1,Math.min(20,limit)));
  return {worldId,focus,scannedClaims:rows.length,conflicts};
}
