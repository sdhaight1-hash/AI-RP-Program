import {makeLocationAuthoringRequest,makeEntityAuthoringRequest} from '../authoring/world-scene.mjs';
import {makeSourceMentionRequest,parseSourceMentionSuggestions} from '../world/assisted-extraction.mjs';

function mountMentionRecommendations(host,{el,worldId,focus,entries=[],onChoose,fetch,getModel,onReviewComplete}){
  const section=el('section','','universe-mention-panel group');
  section.setAttribute('aria-label',focus==='locations'?'Suggested places from prior mentions':'Suggested social and cultural entries');
  section.append(el('h3',focus==='locations'?'Discovered place mentions':'Discovered groups & cultures','builder-subtitle'),
    el('p','Review the original source before creating, linking, or dismissing a suggestion. Dialogue and rumors are not automatically canon.','help'));
  const search=el('input','','universe-mention-search');
  search.type='search';search.maxLength=120;
  search.placeholder='Filter source passages by keywords…';
  search.setAttribute('aria-label','Search universe evidence');
  const summary=el('p','Loading indexed universe references…','help');
  summary.setAttribute('role','status');
  const candidates=el('div','','universe-mention-items');
  section.append(search,summary,candidates);
  const ai=el('details','','universe-extract-panel');
  ai.append(el('summary','Optional local AI · find less obvious names'));
  const intro=el('p','Select an indexed passage, then ask your local model for exact source-quoted names. This creates suggestions only, never canon.','help');
  const sourcesSelect=el('select','','universe-extract-source');
  sourcesSelect.setAttribute('aria-label','Indexed passage for name extraction');
  const sourcePreview=el('p','','help universe-extract-preview');
  const analyze=el('button','Analyze selected passage','subtle-button');
  analyze.type='button';
  const cancelAnalysis=el('button','Cancel extraction','subtle-button');
  cancelAnalysis.type='button';cancelAnalysis.hidden=true;
  const aiStatus=el('p','','help');aiStatus.setAttribute('role','status');
  const aiCandidates=el('div','','universe-mention-items');
  ai.append(intro,sourcesSelect,sourcePreview,analyze,cancelAnalysis,aiStatus,aiCandidates);
  section.append(ai);
  const conflicts=el('details','','universe-claim-conflicts');
  conflicts.append(el('summary','Review potentially contradictory canon claims'));
  const conflictStatus=el('p','','help');conflictStatus.setAttribute('role','status');
  const conflictRows=el('div','','universe-claim-conflict-items');
  conflicts.append(el('p','Only explicit dated founding/birth and headquarters assertions are checked. Different eras, branches, and unreliable speakers may explain differences. Nothing is corrected automatically.','help'),
    conflictStatus,conflictRows);
  section.append(conflicts);
  conflicts.ontoggle=async()=>{
    if(!conflicts.open)return;
    conflictStatus.textContent='Checking current indexed claims…';
    try{
      const response=await fetch('/api/worlds/discovery/conflicts?'+
        new URLSearchParams({worldId,focus}));
      const data=await response.json();
      if(!response.ok)throw Error(data.error||'Could not inspect claim conflicts');
      if(!section.isConnected||!conflicts.open)return;
      conflictRows.replaceChildren();
      conflictStatus.textContent=data.conflicts.length?
        data.conflicts.length+' potential discrepancies. Review sources before changing canon.':
        'No conflicting explicit claims detected in the indexed categories.';
      for(const conflict of data.conflicts){
        const card=el('article','','lore-card universe-claim-conflict');
        const label={founded_year:'Founding year',birth_year:'Birth year',headquarters:'Headquarters'}[conflict.predicate]||conflict.predicate;
        card.append(el('strong',conflict.name+' · '+label));
        for(const value of conflict.values){
          card.append(el('p','Reported value: '+value.value,'help'));
          for(const proof of value.evidence)
            card.append(el('p',proof.type+' / '+proof.field+' ('+proof.trust+'): “'+proof.quote+'”','help'));
        }
        conflictRows.append(card);
      }
    }catch(error){if(section.isConnected)conflictStatus.textContent=error.message;}
  };
  host.append(section);
  let lastRequest=0,timer=null,busy=false;
  const review=async(input,row)=>{
    if(busy)return;
    busy=true;
    const controls=row.querySelectorAll('button, select');
    controls.forEach(x=>x.disabled=true);
    const status=el('p','Saving review decision…','help');status.setAttribute('role','status');
    row.append(status);
    try{
      const response=await fetch('/api/worlds/discovery/review',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({worldId,focus,...input})
      });
      const data=await response.json();
      if(!response.ok)throw Error(data.error||'Could not record review decision');
      if(onReviewComplete)await onReviewComplete();
      if(section.isConnected)await reload();
    }catch(error){status.textContent=error.message;}
    finally{
      busy=false;
      if(row.isConnected)controls.forEach(x=>x.disabled=false);
    }
  };
  const renderCandidate=(candidate,target=candidates)=>{
    const row=el('div','','lore-card universe-mention-item');
    row.append(el('strong',candidate.name),el('small',candidate.kind+' · unverified mention','help'));
    for(const source of candidate.evidence.slice(0,3))
      row.append(el('p',`${source.type} / ${source.field} (${source.trust}): “${source.quote}”`,'help'));
    if(candidate.possibleMatches?.length)
      row.append(el('p','Possible existing match: '+
        candidate.possibleMatches.map(x=>x.name).join(', ')+' — verify before linking','help'));
    const create=el('button','Review as new entry','subtle-button');create.type='button';
    create.onclick=()=>onChoose(candidate);
    row.append(create);
    const proof=candidate.evidence.find(x=>x.fingerprint);
    if(proof&&entries.length){
      const picker=el('select','','universe-mention-link-target');
      picker.setAttribute('aria-label','Existing canon entry to link to '+candidate.name);
      picker.add(new Option('Link to existing…',''));
      for(const entry of entries)picker.add(new Option(entry.name+' ('+entry.kind+')',entry.id));
      const link=el('button','Link alias','subtle-button');
      link.type='button';link.onclick=()=>{
        if(!picker.value)return;
        void review({action:'link',name:candidate.name,targetId:picker.value,sourceProof:proof},row);
      };
      row.append(picker,link);
    }
    if(proof){
      const dismiss=el('button','Dismiss mention','subtle-button');
      dismiss.type='button';
      dismiss.onclick=()=>void review({action:'dismiss',name:candidate.name,
        evidence:candidate.evidence.filter(x=>x.fingerprint)},row);
      row.append(dismiss);
    }
    target.append(row);
  };
  const render=result=>{
    candidates.replaceChildren();
    summary.textContent=`Indexed ${result.scannedSources} passages · ${result.suggestions.length} unregistered suggestions`;
    if(!result.suggestions.length)candidates.append(el('p','No unregistered matches in these sources. Try another keyword, or add an entry manually.','help'));
    for(const candidate of result.suggestions)renderCandidate(candidate);
    section.querySelector('.universe-mention-existing')?.remove();
    if(result.existingLinks?.length){
      const existing=el('details','','universe-mention-existing');
      existing.append(el('summary',`${result.existingLinks.length} already linked or established`));
      for(const match of result.existingLinks)
        existing.append(el('p',`${match.name} · ${match.status==='alias'?'alias of '+match.canonicalName:'existing canon'}`,'help'));
      section.append(existing);
    }
  };
  const reload=async()=>{
    const version=++lastRequest;
    try{
      const params=new URLSearchParams({worldId,focus});
      if(search.value.trim())params.set('query',search.value.trim());
      const response=await fetch('/api/worlds/discovery?'+params);
      const data=await response.json();
      if(!response.ok)throw Error(data.error||'Could not load evidence index');
      if(!section.isConnected||version!==lastRequest)return;
      render(data);
    }catch(error){
      if(!section.isConnected||version!==lastRequest)return;
      summary.textContent='Discovery unavailable: '+error.message;
      candidates.replaceChildren();
    }
  };
  let sourceList=[],sourceRequest=0,extracting=false,analysisController=null;
  cancelAnalysis.onclick=()=>analysisController?.abort();
  const updateSourcePreview=()=>{
    const item=sourceList[Number(sourcesSelect.value)];
    sourcePreview.textContent=item?item.text.slice(0,450):'No indexed source selected.';
    analyze.disabled=!item||extracting;
  };
  const loadSources=async()=>{
    const version=++sourceRequest;
    try{
      const params=new URLSearchParams({worldId});
      if(search.value.trim())params.set('query',search.value.trim());
      const response=await fetch('/api/worlds/discovery/sources?'+params);
      const data=await response.json();
      if(!response.ok)throw Error(data.error||'Could not retrieve indexed passages');
      if(!section.isConnected||version!==sourceRequest)return;
      sourceList=data.sources||[];
      sourcesSelect.replaceChildren();
      sourceList.forEach((source,i)=>sourcesSelect.add(
        new Option(source.type+' / '+source.field+' · '+source.text.slice(0,65),String(i))));
      aiStatus.textContent=sourceList.length?
        sourceList.length+' current indexed passages available for optional extraction.':
        'No indexed passages. Write some universe, character, lore, or scene content first.';
      updateSourcePreview();
    }catch(error){
      if(version!==sourceRequest||!section.isConnected)return;
      aiStatus.textContent=error.message;sourceList=[];sourcesSelect.replaceChildren();
      updateSourcePreview();
    }
  };
  sourcesSelect.onchange=updateSourcePreview;
  ai.ontoggle=()=>{if(ai.open)void loadSources();};
  analyze.onclick=async()=>{
    if(extracting)return;
    const source=sourceList[Number(sourcesSelect.value)];
    if(!source)return;
    const model=getModel?.();
    if(!model){aiStatus.textContent='Select a local model in Settings & tools first.';return;}
    const controller=new AbortController();
    analysisController=controller;
    extracting=true;cancelAnalysis.hidden=false;
    sourcesSelect.disabled=true;
    updateSourcePreview();aiCandidates.replaceChildren();
    aiStatus.textContent='Analyzing this passage with the local model…';
    const chosen=source;
    try{
      const request=makeSourceMentionRequest({
        worldId,focus,source:chosen,existingNames:entries.map(x=>x.name)
      });
      const response=await fetch('/api/chat',{
        method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json'},
        body:JSON.stringify({worldId,model,temperature:0.2,max_tokens:1100,messages:request.messages})
      });
      if(!response.ok){
        const message=await response.json().catch(()=>({}));
        throw Error(message.error||'Local model unavailable');
      }
      const raw=await readLocalModelText(response,{maxChars:6500});
      if(!section.isConnected||controller.signal.aborted||analysisController!==controller)return;
      const selectedNow=sourceList[Number(sourcesSelect.value)];
      if(!selectedNow||selectedNow.id!==chosen.id||selectedNow.field!==chosen.field||
         selectedNow.fingerprint!==chosen.fingerprint)
        throw Error('Selected source changed during extraction; regenerate the review.');
      const found=parseSourceMentionSuggestions(raw,request);
      aiStatus.textContent=found.length?
        found.length+' source-quoted suggestions. Review each before committing canon.':
        'No additional grounded names found in this passage.';
      for(const candidate of found)renderCandidate(candidate,aiCandidates);
    }catch(error){
      if(section.isConnected)aiStatus.textContent=controller.signal.aborted?
        'Extraction canceled. No canon changed.':error.message;
    }finally{
      if(analysisController===controller)analysisController=null;
      extracting=false;cancelAnalysis.hidden=true;sourcesSelect.disabled=false;
      if(section.isConnected)updateSourcePreview();
    }
  };
  search.oninput=()=>{
    clearTimeout(timer);
    timer=setTimeout(()=>{void reload();if(ai.open)void loadSources();},180);
  };
  void reload();
  return section;
}

import {mountWorldSceneAssistant,readLocalModelText} from './world-scene-assist.mjs';
// World-scoped Atlas and Relations editors. The caller owns world identity,
// writes and the selected scene; this module owns only editor presentation.
// All interactions invoke the same guarded endpoints as the original UI.
export function renderAtlasPanel(host,session,api) {
  const {$,el,worldLibrary,loadingWorlds,refreshWorldLibrary,addWorldChooser,selectedWorld,
    postWorld,permanentlyDeleteWorldEntry,save,renderHeader,renderInspector,showError,getModel,state,fetch}=api;
  host.innerHTML=`<h2 class="panel-title">World Atlas</h2><p class="help">Create and connect locations within the active universe. Places can be a character’s usual home or workplace without declaring where they are in the current scene.</p><div class="group"><label class="field-label" for="atlas-world">Selected canon world</label><select id="atlas-world"></select></div><div id="atlas-places"></div><div class="group"><label class="field-label" for="atlas-name">New location</label><input id="atlas-name" maxlength="120" placeholder="e.g. Mara's Apartment"/><select id="atlas-kind"><option value="region">Region</option><option value="town">Town</option><option value="neighborhood">Neighborhood</option><option value="building">Building</option><option value="room">Room</option><option value="outdoor">Outdoor area</option><option value="other">Other</option></select><label class="field-label" for="atlas-parent">Inside</label><select id="atlas-parent"></select><textarea id="atlas-description" rows="9" maxlength="1000000" placeholder="History, geography, architecture, daily life, relationships and other setting detail..."></textarea><button class="primary-button" id="atlas-create">Create place</button></div>`;
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
    const origin=(worldLibrary.entryProvenance||[]).find(x=>x.entryType==='location'&&x.entryId===loc.id);
    if(origin)card.append(el('p',`Source: ${origin.trust} · ${origin.sourceStatus} · “${origin.quote}”`,'help'));
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
  let selectedPlaceProof=null;
  const placeMentions=mountMentionRecommendations(host,{
    el,fetch,worldId:world.id,focus:'locations',entries:locations,getModel,onReviewComplete:refreshWorldLibrary,
    onChoose:candidate=>{
      $('atlas-name').value=candidate.name;
      selectedPlaceProof=candidate.evidence.find(x=>x.fingerprint)||null;
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
    try{
      const name=$('atlas-name').value;
      const proof=selectedPlaceProof&&selectedPlaceProof.quote.toLocaleLowerCase()
        .includes(name.trim().toLocaleLowerCase())?selectedPlaceProof:null;
      await postWorld('/api/worlds/locations',{
        worldId:world.id,name,kind:$('atlas-kind').value,
        parentId:$('atlas-parent').value||null,description:$('atlas-description').value,
        ...(proof?{sourceProof:proof}:{})
      });
      selectedPlaceProof=null;showError();
    }
    catch(err){showError(err.message);}
  };
}
export function renderRelationsPanel(host,api) {
  const {$,el,worldLibrary,loadingWorlds,refreshWorldLibrary,addWorldChooser,selectedWorld,
    postWorld,permanentlyDeleteWorldEntry,state,showError,openCharacterProfile,fetch,getModel}=api;
  host.innerHTML=`<h2 class="panel-title">Relationship Codex</h2><p class="help">Create or permanently delete world people, entities and relationships. Archived character profiles are hidden until restored; deleting an independent world entity also deletes its linked relationships.</p><div class="group"><label class="field-label" for="relations-world">World</label><select id="relations-world"></select></div><div id="relations-list"></div><div class="group"><label class="field-label" for="relations-entity-name">Add person or entity</label><input id="relations-entity-name" maxlength="120" placeholder="Name"/><select id="relations-entity-kind"><option value="character">Character</option><option value="organization">Organization</option><option value="faction">Faction</option><option value="family">Family / dynasty</option><option value="community">Community</option><option value="culture">Culture</option><option value="group">Informal group</option><option value="object">Object</option><option value="concept">Concept</option></select><label class="field-label" for="relations-entity-description">What is established?</label><textarea id="relations-entity-description" rows="9" maxlength="1000000" placeholder="Purpose, practices, membership, shared history or cultural traditions…"></textarea><button id="relations-add-entity" class="subtle-button">Add to canon</button>
  <div id="relations-entity-ai-slot" aria-label="Contextual AI writing partner for social and cultural entries"></div></div>
  <div id="relations-edit-panel" class="group hidden">
    <h3 class="builder-subtitle">Edit existing canon entry</h3>
    <label class="field-label" for="relations-edit-name">Name</label><input id="relations-edit-name" maxlength="120"/>
    <label class="field-label" for="relations-edit-kind">Category</label><select id="relations-edit-kind"></select>
    <label class="field-label" for="relations-edit-description">Established details</label>
    <textarea id="relations-edit-description" rows="9" maxlength="1000000"></textarea>
    <div class="inline-actions"><button id="relations-save-entity" class="primary-button">Save entry</button><button id="relations-edit-cancel" class="subtle-button">Cancel</button></div>
  </div><div class="group"><label class="field-label" for="relations-from">From → To (direction matters)</label><select id="relations-from"></select><select id="relations-to"></select><input id="relations-type" maxlength="70" placeholder="e.g. childhood friend, older sister, colleague"/><textarea id="relations-notes" rows="9" maxlength="1000000" placeholder="History, current dynamic, boundaries..."></textarea><button id="relations-add" class="primary-button">Create relationship</button></div>`;
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
    const origin=(worldLibrary.entryProvenance||[]).find(x=>x.entryType==='entity'&&x.entryId===entity.id);
    if(origin)row.append(el('p',`Source: ${origin.trust} · ${origin.sourceStatus} · “${origin.quote}”`,'help'));
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
  let selectedGroupProof=null;
  const groupMentions=mountMentionRecommendations(host,{
    el,fetch,worldId:world.id,focus:'groups',entries:entities,getModel,onReviewComplete:refreshWorldLibrary,
    onChoose:candidate=>{
      $('relations-entity-name').value=candidate.name;
      selectedGroupProof=candidate.evidence.find(x=>x.fingerprint)||null;
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
    try{
      const name=$('relations-entity-name').value;
      const proof=selectedGroupProof&&selectedGroupProof.quote.toLocaleLowerCase()
        .includes(name.trim().toLocaleLowerCase())?selectedGroupProof:null;
      await postWorld('/api/worlds/entities',{
        worldId:world.id,name,kind:$('relations-entity-kind').value,
        description:$('relations-entity-description').value,
        ...(proof?{sourceProof:proof}:{})
      });
      selectedGroupProof=null;showError();
    }
    catch(err){showError(err.message);}
  };
  $('relations-add').disabled=entities.length<2;
  $('relations-add').onclick=async()=>{
    try{await postWorld('/api/worlds/relationships',{worldId:world.id,fromId:$('relations-from').value,toId:$('relations-to').value,kind:$('relations-type').value,notes:$('relations-notes').value});showError();}
    catch(err){showError(err.message);}
  };
}
