// World-scoped Atlas and Relations editors. The caller owns world identity,
// writes and the selected scene; this module owns only editor presentation.
// All interactions invoke the same guarded endpoints as the original UI.
export function renderAtlasPanel(host,session,api) {
  const {$,el,worldLibrary,loadingWorlds,refreshWorldLibrary,addWorldChooser,selectedWorld,
    postWorld,permanentlyDeleteWorldEntry,save,renderHeader,renderInspector,showError}=api;
  host.innerHTML=`<h2 class="panel-title">World Atlas</h2><p class="help">Create and connect locations within the active universe. Places can be a character’s usual home or workplace without declaring where they are in the current scene.</p><div class="group"><label class="field-label" for="atlas-world">Selected canon world</label><select id="atlas-world"></select></div><div id="atlas-places"></div><div class="group"><label class="field-label" for="atlas-name">New location</label><input id="atlas-name" maxlength="120" placeholder="e.g. Mara's Apartment"/><select id="atlas-kind"><option value="region">Region</option><option value="town">Town</option><option value="neighborhood">Neighborhood</option><option value="building">Building</option><option value="room">Room</option><option value="outdoor">Outdoor area</option><option value="other">Other</option></select><label class="field-label" for="atlas-parent">Inside</label><select id="atlas-parent"></select><textarea id="atlas-description" rows="3" maxlength="4000" placeholder="Description, atmosphere, daily life..."></textarea><button class="primary-button" id="atlas-create">Create place</button></div>`;
  if(!worldLibrary){if(!loadingWorlds)refreshWorldLibrary();return;}
  addWorldChooser('atlas-world');
  const world=selectedWorld();if(!world){$('atlas-create').disabled=true;return;}
  const locations=worldLibrary.locations?.filter(l=>l.worldId===world.id)||[];
  const parent=$('atlas-parent');parent.add(new Option('Top-level place',''));
  for(const loc of locations)parent.add(new Option(loc.name,loc.id));
  const container=$('atlas-places');
  if(!locations.length)container.append(el('p','No locations yet. Start with a town or region.','empty-note'));
  for(const loc of locations){
    const card=el('div','','lore-card');const parentName=locations.find(x=>x.id===loc.parentId)?.name;
    card.append(el('strong',loc.name),el('p',`${loc.kind}${parentName?' · inside '+parentName:''}${loc.description?' · '+loc.description:''}`,'help'));
    const use=el('button','Use as scene location','subtle-button');use.disabled=!session;
    use.onclick=()=>{
      const activeTimeline=worldLibrary.timelines.find(t=>t.id===session?.timelineId);
      if(!session||activeTimeline?.worldId!==world.id)return showError('Place the active scene in a timeline for this world first.');
      session.location=loc.name;session.locationId=loc.id;save();renderHeader();renderInspector();showError();
    };
    card.append(use);
    if(session?.locationId===loc.id){
      const unlink=el('button','Clear scene location','subtle-button');
      unlink.onclick=()=>{session.locationId=null;session.location='';save();renderHeader();renderInspector();};
      card.append(unlink);
    }
    const remove=el('button','Permanently delete place','mini-action');
    remove.onclick=()=>{void permanentlyDeleteWorldEntry('location',loc,world.id);};
    card.append(remove);container.append(card);
  }
  $('atlas-create').onclick=async()=>{
    try{await postWorld('/api/worlds/locations',{worldId:world.id,name:$('atlas-name').value,kind:$('atlas-kind').value,parentId:$('atlas-parent').value||null,description:$('atlas-description').value});showError();}
    catch(err){showError(err.message);}
  };
}
export function renderRelationsPanel(host,api) {
  const {$,el,worldLibrary,loadingWorlds,refreshWorldLibrary,addWorldChooser,selectedWorld,
    postWorld,permanentlyDeleteWorldEntry,state,showError}=api;
  host.innerHTML=`<h2 class="panel-title">Relationship Codex</h2><p class="help">Create or permanently delete world people, entities and relationships. Archived character profiles are hidden until restored; deleting an independent world entity also deletes its linked relationships.</p><div class="group"><label class="field-label" for="relations-world">World</label><select id="relations-world"></select></div><div id="relations-list"></div><div class="group"><label class="field-label" for="relations-entity-name">Add person or entity</label><input id="relations-entity-name" maxlength="120" placeholder="Name"/><select id="relations-entity-kind"><option value="character">Character</option><option value="organization">Organization</option><option value="faction">Faction</option><option value="object">Object</option><option value="concept">Concept</option></select><button id="relations-add-entity" class="subtle-button">Add to world</button></div><div class="group"><label class="field-label" for="relations-from">From → To (direction matters)</label><select id="relations-from"></select><select id="relations-to"></select><input id="relations-type" maxlength="70" placeholder="e.g. childhood friend, older sister, colleague"/><textarea id="relations-notes" rows="3" maxlength="2000" placeholder="History, current dynamic, boundaries..."></textarea><button id="relations-add" class="primary-button">Create relationship</button></div>`;
  if(!worldLibrary){if(!loadingWorlds)refreshWorldLibrary();return;}
  addWorldChooser('relations-world');
  const world=selectedWorld();if(!world){$('relations-add-entity').disabled=true;$('relations-add').disabled=true;return;}
  // Archived profiles keep recoverable database rows but do not belong in the
  // active social codex. They reappear if restored from the Trash.
  const archived=new Set(state.characters.filter(c=>c.trashedAt).map(c=>c.id));
  const entities=(worldLibrary.entities||[]).filter(e=>e.worldId===world.id &&
    !(e.sourceCharacterId&&archived.has(e.sourceCharacterId)));
  const byId=new Map(entities.map(e=>[e.id,e]));
  const list=$('relations-list');
  for(const entity of entities){
    const row=el('div','','lore-card');
    row.append(el('strong',entity.name),el('p',entity.kind,'help'));
    const remove=el('button','Permanently delete entity','mini-action');
    remove.onclick=()=>{void permanentlyDeleteWorldEntry('entity',entity,world.id);};
    row.append(remove);list.append(row);
  }
  if(!entities.length)list.append(el('p','Add a couple of characters before connecting them.','empty-note'));
  for(const edge of worldLibrary.relationships?.filter(r=>r.worldId===world.id &&
    byId.has(r.fromId)&&byId.has(r.toId))||[]){
    const row=el('div','','lore-card');row.append(el('strong',`${byId.get(edge.fromId).name} → ${byId.get(edge.toId).name} · ${edge.kind}`));
    if(edge.notes)row.append(el('p',edge.notes,'help'));
    const remove=el('button','Delete relationship','mini-action');
    remove.onclick=()=>{void permanentlyDeleteWorldEntry('relationship',edge,world.id);};
    row.append(remove);list.append(row);
  }
  for(const entity of entities){$('relations-from').add(new Option(entity.name,entity.id));$('relations-to').add(new Option(entity.name,entity.id));}
  $('relations-add-entity').onclick=async()=>{
    try{await postWorld('/api/worlds/entities',{worldId:world.id,name:$('relations-entity-name').value,kind:$('relations-entity-kind').value});showError();}
    catch(err){showError(err.message);}
  };
  $('relations-add').disabled=entities.length<2;
  $('relations-add').onclick=async()=>{
    try{await postWorld('/api/worlds/relationships',{worldId:world.id,fromId:$('relations-from').value,toId:$('relations-to').value,kind:$('relations-type').value,notes:$('relations-notes').value});showError();}
    catch(err){showError(err.message);}
  };
}
