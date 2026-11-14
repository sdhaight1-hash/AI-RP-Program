// Promotes an explicit, previously reviewed character-origin world entity into
// a directed relationship. No NPC reply or model proposal may commit this.
import { characterDraftVersion,worldDraftVersion } from './authoring.mjs';

export const SUPPORTED_RELATIONSHIP_KINDS=Object.freeze([
  'aunt','uncle','mother','father','parent','sibling','sister','brother',
  'cousin','grandparent','grandmother','grandfather','child','daughter','son',
  'mentor','apprentice','friend','colleague','neighbor','employer','employee'
]);
const tokens=text=>(String(text||'').toLocaleLowerCase().match(/[\p{L}]+/gu)||[]);
export const proposedRelationshipKinds=quote=>{
  const words=new Set(tokens(quote));
  return SUPPORTED_RELATIONSHIP_KINDS.filter(kind=>words.has(kind));
};

export function approveCharacterWorldRelationship(store,input) {
  if(!input||input.approval!=='approve')throw new Error('Explicit relationship approval required');
  const {worldId,characterId,entryId,kind,revision,profileVersion,worldVersion}=input;
  if(![worldId,characterId,entryId,kind].every(x=>typeof x==='string'&&x.length>0&&x.length<=160)||
    !Number.isSafeInteger(revision))throw new Error('Invalid relationship approval');
  if(store.activeWorldId&&store.activeWorldId!==worldId)throw new Error('Wrong world');
  if(store.scopeWorldId&&store.scopeWorldId!==worldId)throw new Error('Wrong world');
  const saved=store.load();
  if(saved.revision!==revision)throw new Error('Character changed; regenerate relationship suggestion');
  const character=saved.state?.characters?.find(c=>c.id===characterId&&!c.trashedAt);
  if(!character||(character.worldId&&character.worldId!==worldId))
    throw new Error('Character does not belong to this world');
  const library={...store.worlds.list(),activeWorldId:worldId};
  if(characterDraftVersion(character)!==profileVersion||worldDraftVersion(library)!==worldVersion)
    throw new Error('Character or world changed; reload approved sources');
  const provenance=store.db.prepare(`SELECT source_field AS sourceField,source_quote AS sourceQuote
    FROM character_world_sources WHERE world_id=? AND character_id=?
    AND entry_type='entity' AND entry_id=?`).get(worldId,characterId,entryId);
  if(!provenance)throw new Error('Entity has no approved character-origin source in this world');
  if(!String(character[provenance.sourceField]||'').includes(provenance.sourceQuote))
    throw new Error('Character source was edited after approval; review the biography first');
  if(!proposedRelationshipKinds(provenance.sourceQuote).includes(kind))
    throw new Error('Relationship kind must be explicit in the approved source quote');
  const source=library.entities.find(e=>e.worldId===worldId&&e.id===entryId&&e.kind==='character');
  const target=library.entities.find(e=>e.worldId===worldId&&e.sourceCharacterId===characterId&&e.kind==='character');
  if(!source||!target||source.id===target.id)throw new Error('Both relationship participants must already exist in this world');
  if(library.relationships.some(r=>r.worldId===worldId&&r.fromId===source.id&&r.toId===target.id&&r.kind===kind))
    throw new Error('The same directed relationship is already established');
  const notes=`From ${provenance.sourceField}: "${provenance.sourceQuote}"`;
  if(notes.length>2000)throw new Error('Relationship source quote too long');
  store.db.exec('BEGIN IMMEDIATE');
  try {
    // The only permitted direction in this early bridge is newly approved
    // source person -> the originating Character Studio person.
    const relation=store.worlds.createRelationship({
      worldId,fromId:source.id,toId:target.id,kind,notes
    });
    store.db.prepare(`INSERT INTO character_world_relationship_sources
      (world_id,character_id,source_entry_id,relationship_id,source_field,source_quote,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(
        worldId,characterId,entryId,relation.id,provenance.sourceField,provenance.sourceQuote,Date.now());
    store.db.exec('COMMIT');
    return {relationship:relation,sourceName:source.name,characterName:target.name,
      sourceField:provenance.sourceField,sourceQuote:provenance.sourceQuote};
  }catch(error){store.db.exec('ROLLBACK');throw error;}
}
