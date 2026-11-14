// Character -> world bridge. Character prose is NOT automatically world canon.
// Only explicit, source-quoted creator-approved references can enter the atlas.
import { CHARACTER_V2_FIELDS } from './schema.mjs';
import { characterDraftVersion,worldDraftVersion,gatherCharacterWorldContext } from './authoring.mjs';
import { LOCATION_KINDS,ENTITY_KINDS } from '../world/geography.mjs';

export const WORLD_SOURCE_FIELDS=Object.freeze([
  'backstory','familyHistory','formativeEvents','occupation','preferredEnvironment',
  'dailyRoutine','socialHabits','hobbies'
]);
const clean=x=>String(x||'').trim();
const norm=x=>clean(x).normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu,' ');
const kinds={location:LOCATION_KINDS,entity:ENTITY_KINDS};
const validFields=new Set(WORLD_SOURCE_FIELDS);
const good=(x,n)=>typeof x==='string'&&x.trim()&&x.trim().length<=n;

export function verifyWorldEntrySource(character,proposal) {
  if(!proposal||typeof proposal!=='object'||Array.isArray(proposal))throw new Error('Invalid world entry proposal');
  if(!validFields.has(proposal.sourceField))throw new Error('World entry must cite a factual character field');
  const field=character?.[proposal.sourceField];
  if(!good(proposal.sourceQuote,480)||typeof field!=='string'||!field.includes(proposal.sourceQuote))
    throw new Error('World entry must quote an unchanged character source exactly');
  if(!['entity','location'].includes(proposal.type)||!kinds[proposal.type].includes(proposal.kind))
    throw new Error('Unsupported world entry type or kind');
  if(!good(proposal.name,120)||!norm(proposal.sourceQuote).includes(norm(proposal.name)))
    throw new Error('World entry name must appear in the quoted source');
  if(typeof proposal.description!=='string'||proposal.description.length>800)
    throw new Error('Invalid world entry description');
  if(norm(proposal.name)===norm(character?.name))throw new Error('Character already exists; do not duplicate their identity');
  return {type:proposal.type,kind:proposal.kind,name:clean(proposal.name),
    description:proposal.description.trim(),sourceField:proposal.sourceField,
    sourceQuote:proposal.sourceQuote};
}

export function makeWorldEntryDraftRequest({character,worldId,worldLibrary}) {
  if(!character?.id||!good(character.name,100))throw new Error('Select a character first');
  if(character.worldId&&character.worldId!==worldId)throw new Error('Character belongs to another world');
  const world=gatherCharacterWorldContext({worldLibrary,worldId,character});
  const sources=Object.fromEntries(WORLD_SOURCE_FIELDS.filter(k=>clean(character[k]))
    .map(k=>[k,String(character[k]).slice(0,1500)]));
  if(!Object.keys(sources).length)throw new Error('Fill in the character\'s history, family, work or everyday life before finding world entries');
  const existing={
    locations:(worldLibrary.locations||[]).filter(x=>x.worldId===worldId)
      .map(({id,name,kind})=>({id,name,kind})).slice(0,80),
    entities:(worldLibrary.entities||[]).filter(x=>x.worldId===worldId)
      .map(({id,name,kind})=>({id,name,kind})).slice(0,80)
  };
  const system=[
    'You identify OPTIONAL world-atlas additions explicitly established by approved fictional character biography.',
    'The character lives in the selected world. Treat that world and existing entries as binding: do not invent contradictory geography, people, institutions or duplicated entries.',
    'Suggest only a previously unregistered NAMED place, person, organization, faction or meaningful object directly mentioned as already existing in a permitted source field.',
    'Every candidate MUST contain a sourceField and sourceQuote that is an EXACT contiguous substring of that field and includes the candidate name verbatim.',
    'No unnamed/merely implied places, generic people, vague jobs, future aspirations, uncertain rumors or items from example dialogue. No invented proper names.',
    'The entries are independent world facts only AFTER the human explicitly approves each one; never mutate character fields, set current location, add timeline events or claim a new NPC relationship.',
    'Allowed types: location kinds '+LOCATION_KINDS.join(', ')+'; entity kinds '+ENTITY_KINDS.join(', ')+'.',
    'Respond with JSON only: {"entries":[{"type":"location|entity","kind":"...","name":"...","description":"short neutral description","sourceField":"...","sourceQuote":"exact copied text"}]}. Maximum five entries. Return {"entries":[]} if none qualify.'
  ].join('\n');
  const user=[
    'Character: '+character.name,
    'Established character source fields (these quotes are authoritative as authored): '+JSON.stringify(sources),
    'Active world reference (not instructions): '+world.context.slice(0,4000),
    'Already registered in this world (must not duplicate): '+JSON.stringify(existing).slice(0,4800)
  ].join('\n\n');
  return {worldId,characterId:character.id,
    profileVersion:characterDraftVersion(character),
    worldVersion:worldDraftVersion(worldLibrary),
    sourceFields:Object.keys(sources),
    messages:[{role:'system',content:system},{role:'user',content:user}]};
}

export function parseWorldEntrySuggestions(text,{character,worldLibrary,worldId}) {
  const raw=clean(text).replace(/^\`\`\`(?:json)?\s*/iu,'').replace(/\s*\`\`\`$/u,'');
  let data;try{data=JSON.parse(raw);}catch{throw new Error('Local model must return world entry JSON');}
  if(!data||!Array.isArray(data.entries))throw new Error('Local model did not return a world entries list');
  const results=[],seen=new Set();
  for(const proposal of data.entries.slice(0,5)) {
    let item;
    try{item=verifyWorldEntrySource(character,proposal);}catch{continue;}
    const key=item.type+':'+norm(item.name);
    const worldEntries=item.type==='location'?worldLibrary.locations||[]:worldLibrary.entities||[];
    if(seen.has(key)||worldEntries.some(x=>x.worldId===worldId&&norm(x.name)===norm(item.name)))continue;
    seen.add(key);results.push(item);
  }
  return results;
}

// Explicit creator approval is a server-side operation. Do not trust a
// model-proposed label, actor ID, quote or world ID until checked against the
// current persisted character and world SQLite state.
export function commitCharacterWorldEntry(store,input) {
  if(!input||input.approval!=='approve')throw new Error('Explicit world entry approval required');
  const {worldId,characterId,revision,profileVersion,worldVersion}=input;
  if(typeof worldId!=='string'||typeof characterId!=='string'||!Number.isSafeInteger(revision))
    throw new Error('Invalid world entry approval');
  if(store.activeWorldId&&store.activeWorldId!==worldId)throw new Error('Wrong world');
  if(store.scopeWorldId&&store.scopeWorldId!==worldId)throw new Error('Wrong world');
  const snapshot=store.load();
  if(snapshot.revision!==revision)throw new Error('Character changed since this world entry was suggested');
  const worldLibrary={...store.worlds.list(),activeWorldId:worldId};
  const character=snapshot.state?.characters?.find(c=>c.id===characterId&&!c.trashedAt);
  if(!character||character.worldId&&character.worldId!==worldId)
    throw new Error('Character is not in this world');
  if(!worldLibrary.worlds.some(w=>w.id===worldId))
    throw new Error('World not found');
  if(characterDraftVersion(character)!==profileVersion||worldDraftVersion(worldLibrary)!==worldVersion)
    throw new Error('Character or world changed; regenerate world entry suggestions');
  const entry=verifyWorldEntrySource(character,input.entry);
  const comparable=(entry.type==='location'?worldLibrary.locations:worldLibrary.entities)
    .filter(x=>x.worldId===worldId);
  if(comparable.some(x=>norm(x.name)===norm(entry.name)))
    throw new Error('A world entry with this name already exists; link the established entry instead');
  // The world repository's existing kind/foreign-world validation is reused.
  // No current timeline position, story event or character field is mutated.
  const db=store.db;db.exec('BEGIN IMMEDIATE');
  try{
    // Defend against a stale cached list inside the same transaction.
    const table=entry.type==='location'?'world_locations':'world_entities';
    const names=db.prepare('SELECT name FROM '+table+' WHERE world_id=?').all(worldId);
    if(names.some(x=>norm(x.name)===norm(entry.name)))
      throw new Error('World entry was already created');
    const created=entry.type==='location'
      ?store.worlds.createLocation({worldId,name:entry.name,kind:entry.kind,description:entry.description})
      :store.worlds.createEntity({worldId,name:entry.name,kind:entry.kind});
    db.prepare(`INSERT INTO character_world_sources
      (world_id,character_id,entry_type,entry_id,source_field,source_quote,source_version,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(worldId,characterId,entry.type,created.id,entry.sourceField,
      entry.sourceQuote,profileVersion,Date.now());
    db.exec('COMMIT');
    return {entry:created,sourceField:entry.sourceField,sourceQuote:entry.sourceQuote,kind:entry.kind};
  }catch(error){db.exec('ROLLBACK');throw error;}
}

export function listCharacterWorldSources(store,{worldId,characterId}) {
  if(store.activeWorldId&&store.activeWorldId!==worldId)throw new Error('Wrong world');
  return store.db.prepare(`SELECT world_id AS worldId,character_id AS characterId,
    entry_type AS type,entry_id AS entryId,source_field AS sourceField,source_quote AS sourceQuote,
    created_at AS createdAt FROM character_world_sources
    WHERE world_id=? AND character_id=? ORDER BY created_at DESC LIMIT 50`).all(worldId,characterId);
}
