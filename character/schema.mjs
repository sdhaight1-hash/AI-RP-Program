// Durable identity and habits belong to the world; present whereabouts, mood
// and learned memories are timeline state, never permanent character fields.
const str = (v,n=2500) => typeof v==='string' ? v.slice(0,n) : '';
export const CHARACTER_V2_FIELDS=Object.freeze([
  'name','handle','tagline','age','pronouns','aliases','occupation',
  'description','facialFeatures','hair','eyes','physique','clothingStyle',
  'personality','values','contradictions','stressBehavior','comfortBehavior','conflictStyle','socialHabits',
  'backstory','familyHistory','formativeEvents','motivations','fears','boundaries',
  'hobbies','preferredEnvironment','dailyRoutine',
  'speechStyle','inPersonStyle','phoneStyle','textStyle','exampleDialogue',
]);

export function normalizeFrequentPlaces(items) {
  if (!Array.isArray(items)) return [];
  const ids=new Set();
  return items.slice(0,30).flatMap(item=>{
    if (!item || typeof item.locationId!=='string' || !item.locationId.trim() || item.locationId.length>160 || ids.has(item.locationId))return [];
    ids.add(item.locationId);
    return [{locationId:item.locationId,role:str(item.role,80),frequency:str(item.frequency,120),reason:str(item.reason,600)}];
  });
}

export function normalizeCharacterV2(source) {
  const result = {};
  for(const key of CHARACTER_V2_FIELDS)result[key]=str(source?.[key],key==='name'?100:12000);
  result.homeLocationId=typeof source?.homeLocationId==='string'?str(source.homeLocationId,160):null;
  result.workLocationId=typeof source?.workLocationId==='string'?str(source.workLocationId,160):null;
  result.frequentPlaces=normalizeFrequentPlaces(source?.frequentPlaces);
  // World assignment is owned by the database boundary, not a pasted card.
  if(typeof source?.worldId==='string')result.worldId=source.worldId;
  return result;
}

export function importedEncounter(character) {
  const scenario = str(character?.scenario,3000), greeting = str(character?.greeting,3000);
  const alternatives = Array.isArray(character?.alternateGreetings) ? character.alternateGreetings.filter(x=>typeof x==='string').slice(0,12) : [];
  if (!scenario && !greeting && !alternatives.length) return null;
  return {
    id:`imported-encounter:${character.id}`, title:`First encounter with ${str(character.name,100)}`,
    characterIds:[character.id],locationId:null,channelId:'in_person',
    premise:scenario,opening:greeting,alternativeOpenings:alternatives,
    imported:true,
  };
}

export function normalizeEncounters(items,characterIds) {
  const known=new Set(characterIds);
  if(!Array.isArray(items))return [];
  return items.slice(0,150).flatMap(e=>{
    if(!e || typeof e.id!=='string' || !e.id || e.id.length>180 || typeof e.title!=='string')return [];
    const participants=Array.isArray(e.characterIds)?[...new Set(e.characterIds.filter(x=>known.has(x)))]:[];
    if(!participants.length)return [];
    return [{id:e.id,title:str(e.title,120),characterIds:participants,
      locationId:typeof e.locationId==='string'?str(e.locationId,160):null,
      channelId:['in_person','phone_call','text_message'].includes(e.channelId)?e.channelId:'in_person',
      premise:str(e.premise,3000),opening:str(e.opening,3000),
      alternativeOpenings:Array.isArray(e.alternativeOpenings)?e.alternativeOpenings.filter(x=>typeof x==='string').slice(0,12):[],
      imported:Boolean(e.imported)}];
  });
}
