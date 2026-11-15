import {makeLocationAuthoringRequest,makeEntityAuthoringRequest} from '../authoring/world-scene.mjs';
import {discoverUniverseMentions} from '../world/discovery.mjs';

function mountMentionRecommendations(host,{$,el,library,state,worldId,focus,onChoose}){
  const section=el('section','','universe-mention-panel group');
  section.setAttribute('aria-label',focus==='locations'?'Suggested places from prior mentions':'Suggested social and cultural entries');
  section.append(el('h3',focus==='locations'?'Discovered place mentions':'Discovered groups & cultures','builder-subtitle'),
    el('p','Candidate names come from earlier writing in this universe. Verify each source before adding canon; dialogue and private notes may be incomplete or unreliable.','help'));
  const results=discoverUniverseMentions({worldId,library,state,focus});
  const summary=el('p',`Scanned ${results.scannedSources} available source fields · ${results.suggestions.length} unregistered suggestions`,'help');
  summary.setAttribute('role','status');section.append(summary);
  const candidates=el('div','','universe-mention-items');section.append(candidates);
  if(!results.suggestions.length)candidates.append(el('p','No explicit unregistered names detected yet. Write established names in character histories, lore, scenes or the universe blueprint.','help'));
  for(const candidate of results.suggestions){
    const row=el('div','','lore-card universe-mention-item');
    row.append(el('strong',candidate.name),el('small',candidate.kind+' · mentioned, not canon','help'));
    for(const source of candidate.evidence.slice(0,2)){
      const details=el('p',`${source.type} / ${source.field}: “${source.quote}”`,'help');
      row.append(details);
    }
    const use=el('button','Review as new entry','subtle-button');
    use.type='button';use.onclick=()=>onChoose(candidate);
    row.append(use);candidates.append(row);
  }
  if(results.existingLinks.length){
    const existing=el('details','','universe-mention-existing');
    existing.append(el('summary',`${results.existingLinks.length} existing entries also mentioned`));
    for(const match of results.existingLinks)
      existing.append(el('p',`${match.name} · already linked by name; no new entry needed`,'help'));
    section.append(existing);
  }
  host.append(section);
  return section;
}

import {mountWorldSceneAssistant} from './world-scene-assist.mjs';
// World-scoped Atlas and Relations editors. The caller owns world identity,
// writes and the selected scene; this module owns only editor presentation.
// All interactions invoke the same guarded endpoints as the original UI.
export function renderAtlasPanel(host,session,api) {
  const {$,el,worldLibrary,loadingWorlds,refreshWorldLibrary,addWorldChooser,selectedWorld,
    postWorld,permanentlyDeleteWorldEntry,save,renderHeader,renderInspector,showError,getModel,state}=api;
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
  const placeMentions=mountMentionRecommendations(host,{
    $,el,library:worldLibrary,state,worldId:world.id,focus:'locations',
    onChoose:candidate=>{
      $('atlas-name').value=candidate.name;
      $('atlas-kind').value='other';
      $('atlas-name').focus();
    }
  });
  host.insertBefore(placeMentions,$('atlas-name').parentElement);
  mountWorldSceneAssistant($('atlas-create').parentElement,{
    mode:'location',getModel,isCurrent:()=>host.isConnected&&selectedWorld()?.id===world.id,
    getRequest:(target,guidance)=>makeLocationAuthoringRequest({
      worldId:world.id,library:worldLibrary,kind:$('atlas-kind').value,
      parentId:$('atlas-parent').value||null,name:$('atlas-name').value,
      description:$('atlas-description').value,guidance,target
    }),
    onApply:patch=>{
      if(patch.name!==undefined)$('atlas-name').value=patch.name;
      if(patch.description!==undefined)$('atlas-description').value=patch.description;
    }
  });
  $('atlas-create').onclick=async()=>{
    try{await postWorld('/api/worlds/locations',{worldId:world.id,name:$('atlas-name').value,kind:$('atlas-kind').value,parentId:$('atlas-parent').value||null,description:$('atlas-description').value});showError();}
    catch(err){showError(err.message);}
  };
}
export function renderRelationsPanel(host,api) {
  const {$,el,worldLibrary,loadingWorlds,refreshWorldLibrary,addWorldChooser,selectedWorld,
    postWorld,permanentlyDeleteWorldEntry,state,showError,openCharacterProfile,fetch,getModel}=api;
  host.innerHTML=`<h2 class="panel-title">Relationship Codex</h2><p class="help">Create or permanently delete world people, entities and relationships. Archived character profiles are hidden until restored; deleting an independent world entity also deletes its linked relationships.</p><div class="group"><label class="field-label" for="relations-world">World</label><select id="relations-world"></select></div><div id="relations-list"></div><div class="group"><label class="field-label" for="relations-entity-name">Add person or entity</label><input id="relations-entity-name" maxlength="120" placeholder="Name"/><select id="relations-entity-kind"><option value="character">Character</option><option value="organization">Organization</option><option value="faction">Faction</option><option value="family">Family / dynasty</option><option value="community">Community</option><option value="culture">Culture</option><option value="group">Informal group</option><option value="object">Object</option><option value="concept">Concept</option></select><label class="field-label" for="relations-entity-description">What is established?</label><textarea id="relations-entity-description" rows="3" maxlength="4000" placeholder="Purpose, practices, membership, shared history or cultural traditions…"></textarea><button id="relations-add-entity" class="subtle-button">Add to canon</button>
  <div id="relations-entity-ai-slot" aria-label="Contextual AI writing partner for social and cultural entries"></div></div>
  <div id="relations-edit-panel" class="group hidden">
    <h3 class="builder-subtitle">Edit existing canon entry</h3>
    <label class="field-label" for="relations-edit-name">Name</label><input id="relations-edit-name" maxlength="120"/>
    <label class="field-label" for="relations-edit-kind">Category</label><select id="relations-edit-kind"></select>
    <label class="field-label" for="relations-edit-description">Established details</label>
    <textarea id="relations-edit-description" rows="4" maxlength="4000"></textarea>
    <div class="inline-actions"><button id="relations-save-entity" class="primary-button">Save entry</button><button id="relations-edit-cancel" class="subtle-button">Cancel</button></div>
  </div><div class="group"><label class="field-label" for="relations-from">From → To (direction matters)</label><select id="relations-from"></select><select id="relations-to"></select><input id="relations-type" maxlength="70" placeholder="e.g. childhood friend, older sister, colleague"/><textarea id="relations-notes" rows="3" maxlength="2000" placeholder="History, current dynamic, boundaries..."></textarea><button id="relations-add" class="primary-button">Create relationship</button></div>`;
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
  let editing=null;
  const editPanel=$('relations-edit-panel');
  const editKind=$('relations-edit-kind');
  for(const option of $('relations-entity-kind').options)
    editKind.add(new Option(option.textContent,option.value));
  $('relations-edit-cancel').onclick=()=>{
    editing=null;editPanel.classList.add('hidden');
  };
  $('relations-save-entity').onclick=async()=>{
    if(!editing)return;
    const saveButton=$('relations-save-entity');saveButton.disabled=true;
    try{
      const response=await fetch('/api/worlds/entities',{method:'PATCH',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          worldId:world.id,id:editing.id,name:$('relations-edit-name').value,
          kind:editKind.value,description:$('relations-edit-description').value,
          expectedName:editing.name,expectedKind:editing.kind,
          expectedDescription:editing.description||''
        })});
      const result=await response.json();
      if(!response.ok)throw Error(result.error||'Unable to update canon');
      await refreshWorldLibrary();showError();
    }catch(error){showError(error.message);}
    finally{if(saveButton.isConnected)saveButton.disabled=false;}
  };
  for(const entity of entities){
    const row=el('div','','lore-card');
    row.append(el('strong',entity.name),el('p',entity.kind+(entity.description?' · '+entity.description:''),'help'));
    const character=entity.sourceCharacterId
      ?state.characters.find(c=>c.id===entity.sourceCharacterId&&!c.trashedAt):null;
    if(character){
      row.append(el('p','Linked character profile · archive and permanently delete from Characters → Trash. This entity is a world identity mirror.','help'));
      const edit=el('button','Edit character profile','subtle-button');
      edit.onclick=()=>openCharacterProfile(character);
      row.append(edit);
      const copies=entities.filter(e=>e.sourceCharacterId===entity.sourceCharacterId).length;
      if(copies>1){
        const duplicate=el('button','Delete duplicate world entry','mini-action');
        duplicate.onclick=()=>{void permanentlyDeleteWorldEntry('entity',entity,world.id);};
        row.append(duplicate);
      }
    }else{
      const edit=el('button','Edit canon entry','subtle-button');edit.type='button';
      edit.onclick=()=>{
        editing=entity;
        $('relations-edit-name').value=entity.name;
        editKind.value=entity.kind;
        $('relations-edit-description').value=entity.description||'';
        editPanel.classList.remove('hidden');
        $('relations-edit-name').focus();
      };
      row.append(edit);
      const remove=el('button','Permanently delete entity','mini-action');
      remove.onclick=()=>{void permanentlyDeleteWorldEntry('entity',entity,world.id);};
      row.append(remove);
    }
    list.append(row);
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
  const groupMentions=mountMentionRecommendations(host,{
    $,el,library:worldLibrary,state,worldId:world.id,focus:'groups',
    onChoose:candidate=>{
      $('relations-entity-name').value=candidate.name;
      $('relations-entity-kind').value=candidate.kind;
      $('relations-entity-name').focus();
    }
  });
  host.insertBefore(groupMentions,$('relations-entity-name').parentElement);
  mountWorldSceneAssistant($('relations-entity-ai-slot'),{
    mode:'entity',getModel,isCurrent:()=>host.isConnected&&selectedWorld()?.id===world.id,
    getRequest:(target,guidance)=>makeEntityAuthoringRequest({
      worldId:world.id,library:worldLibrary,kind:$('relations-entity-kind').value,
      name:$('relations-entity-name').value,
      description:$('relations-entity-description').value,target,guidance
    }),
    onApply:patch=>{
      if(patch.name!==undefined)$('relations-entity-name').value=patch.name;
      if(patch.description!==undefined)$('relations-entity-description').value=patch.description;
    }
  });
  $('relations-add-entity').onclick=async()=>{
    try{await postWorld('/api/worlds/entities',{worldId:world.id,name:$('relations-entity-name').value,kind:$('relations-entity-kind').value,description:$('relations-entity-description').value});showError();}
    catch(err){showError(err.message);}
  };
  $('relations-add').disabled=entities.length<2;
  $('relations-add').onclick=async()=>{
    try{await postWorld('/api/worlds/relationships',{worldId:world.id,fromId:$('relations-from').value,toId:$('relations-to').value,kind:$('relations-type').value,notes:$('relations-notes').value});showError();}
    catch(err){showError(err.message);}
  };
}
