// Encounter templates are reusable world-level starting situations, not
// permanent character traits or NPC facts. Pure state operations: deletion
// keeps any already-played dialogue and clears only its stale template link.
export function encounterDependencies(state,characterId){
  return (state?.encounters||[]).filter(e=>e.characterIds?.includes(characterId));
}

export function removeEncounterTemplate(state,templateId){
  if(!state||!Array.isArray(state.encounters))throw new Error('No encounter library');
  const template=state.encounters.find(e=>e.id===templateId);
  if(!template)throw new Error('Encounter template not found');
  state.encounters=state.encounters.filter(e=>e.id!==templateId);
  for(const scene of state.sessions||[])
    if(scene.encounterId===templateId)scene.encounterId=null;
  return template;
}

export function encounterParticipantNames(state,template){
  return (template.characterIds||[]).map(id=>
    state.characters?.find(c=>c.id===id)?.name||'Missing character').join(', ');
}
