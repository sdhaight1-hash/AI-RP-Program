import {makeWorldAuthoringRequest,makeUniverseRevisionRequest,makeBlueprintAuthoringRequest} from '../authoring/world-scene.mjs';
import {UNIVERSE_BLUEPRINT_FIELDS,emptyUniverseBlueprint} from '../world/blueprint.mjs';
import {mountWorldSceneAssistant} from './world-scene-assist.mjs';
import {mountEntryPhotoGallery} from './world-entry-media.mjs';

// The workspace is rebuilt after world-catalog refreshes. Keep the local,
// uncommitted creation draft outside the disposable DOM, not in world canon.
let pendingWorldDraft={name:'',description:'',blueprint:emptyUniverseBlueprint()};
let pendingUniverseBlueprint=null;
let savingBlueprint=false;
function renderBlueprintFields(host,values,prefix,onChange){
  host.replaceChildren();
  for(const [key,meta] of Object.entries(UNIVERSE_BLUEPRINT_FIELDS)){
    const item=document.createElement('div');item.className='universe-blueprint-field';
    const label=document.createElement('label');label.className='field-label';
    const id=prefix+'-'+key;label.htmlFor=id;label.textContent=meta.label;
    const input=document.createElement('textarea');input.id=id;input.rows=3;
    input.maxLength=meta.max;input.value=values[key]||'';
    input.placeholder=meta.purpose;
    input.oninput=()=>onChange(key,input.value);
    item.append(label,input);host.append(item);
  }
}

let creatingWorld=false;
let editingUniverse=false;
let pendingUniverseRevision=null;
// World and timeline editor presentation, wired to explicit world-scoped
// callbacks. Avoids mutating the browser's active-world selection implicitly.
export function renderWorldTimelineEditor(host,s,api) {
  const {$,el,worldLibrary,loadingWorlds,refreshWorldLibrary,
    activeWorldId,serverStorage,postWorld,switchWorld,setWorkspace,renderHeader,
    save,renderInspector,showError,running,fetch,getModel,beforeCreateWorld,getCurrentWorldId,beforeUpdateUniverse}=api;

  host.innerHTML = `
  <div class="world-creation-shell">
    <header class="world-editor-hero">
      <span class="eyebrow">UNIVERSE WORKSPACE</span>
      <h2 class="panel-title">Connical Universes & timelines</h2>
      <p>Every Connical Universe is an independent continuity. Create a setting, then develop its people, places and timelines inside that world. AI suggestions are drafts until you approve them.</p>
    </header>
    <div class="world-composer-layout">
      <section class="world-create-composer" aria-labelledby="world-compose-heading">
        <div class="world-section-heading">
          <span class="world-step">01 / CREATE</span>
          <h3 id="world-compose-heading">Begin a new Connical Universe</h3>
          <p>Start with a seed idea or write everything yourself. Nothing is copied from another Connical Universe.</p>
        </div>
        <div class="world-composer-grid">
          <div class="world-composer-fields">
            <label class="field-label" for="world-new-name">Universe identity</label>
            <input id="world-new-name" maxlength="120" placeholder="Name your universe…" autocomplete="off"/>
            <label class="field-label" for="world-new-description">Setting foundation</label>
            <textarea id="world-new-description" rows="9" maxlength="1000000" placeholder="The time period, geography, cultures, ordinary life, tensions, atmosphere…"></textarea>
            <p class="help">Write as much detail as you need; long-form canon is saved in full. The AI works with shorter excerpts without shortening your saved text.</p>
            <div class="world-create-action">
              <span class="world-save-note">Separate continuity · No automatic canon changes</span>
              <button class="primary-button" id="world-create">Create & open universe</button>
            </div>
          </div>
          <div class="world-composer-assist" id="world-ai-slot" aria-label="World creation writing partner"></div>
        </div>
        <details class="universe-blueprint-details" id="universe-new-blueprint">
          <summary>Expand universe blueprint · 7 structured foundations</summary>
          <p class="help">Individually describe the universe's scale, era, rules, societies and conflicts. These are setting-wide facts, not scene events.</p>
          <div class="world-composer-grid">
            <div id="world-new-blueprint-fields" class="universe-blueprint-fields"></div>
            <div id="world-blueprint-ai-slot"></div>
          </div>
        </details>
      </section>
      <aside class="world-existing-list" aria-labelledby="world-existing-heading">
        <div class="world-section-heading">
          <span class="world-step">02 / EXPLORE</span>
          <h3 id="world-existing-heading">Your Connical Universes <span id="world-library-count" class="world-count"></span></h3>
          <p>Open an existing universe without merging its story or canon into another.</p>
        </div>
        <div id="world-library-list" class="world-library-entries"></div>
      </aside>
    </div>
    <section class="world-create-composer universe-identity-editor" id="universe-identity-editor" aria-labelledby="universe-identity-heading">
      <div class="world-section-heading">
        <span class="world-step">CURRENT CONTINUITY / EDIT</span>
        <h3 id="universe-identity-heading">Edit this Connical Universe</h3>
        <p>Rename or revise this universe without replacing its ID, characters, timelines, or established events.</p>
      </div>
      <div class="world-composer-grid">
        <div class="world-composer-fields">
          <label class="field-label" for="universe-edit-name">Universe name</label>
          <input id="universe-edit-name" maxlength="120" autocomplete="off"/>
          <label class="field-label" for="universe-edit-description">Canonical foundation</label>
          <textarea id="universe-edit-description" maxlength="1000000" rows="9"></textarea>
          <p class="help">Write extended universe foundations here. Long-form text is preserved; AI generation uses bounded excerpts.</p>
          <div class="world-create-action">
            <span class="world-save-note" id="universe-edit-state" role="status">No unsaved changes</span>
            <button class="primary-button" id="universe-edit-save">Save universe changes</button>
          </div>
        </div>
        <div class="world-composer-assist" id="universe-edit-ai-slot" aria-label="AI assistance for the current universe"></div>
      </div>
      <div id="universe-photo-gallery"></div>
      <div class="universe-complete-export">
        <a id="universe-export-bundle" class="primary-button" download>Export universe + all media (.zip)</a>
        <a id="universe-export-sqlite" class="subtle-button" download>SQLite database only</a>
        <p class="help">The ZIP includes a consistent universe database, gallery images, portraits, local maps and generated assets, with a checksum manifest. The SQLite-only download excludes external files. Restoring ZIP archives through the interface is not yet available.</p>
      </div>
      <details class="universe-blueprint-details" id="universe-edit-blueprint">
        <summary>Universe blueprint · edit structured canon foundations</summary>
        <p class="help">Keep physical rules, historical baselines, cultures and tensions separate from mutable narrative events.</p>
        <div class="world-composer-grid">
          <div>
            <div id="universe-edit-blueprint-fields" class="universe-blueprint-fields"></div>
            <div class="world-create-action">
              <span id="universe-blueprint-state" class="world-save-note" role="status">No changes</span>
              <button id="universe-blueprint-save" class="primary-button">Save blueprint</button>
            </div>
          </div>
          <div id="universe-blueprint-ai-slot"></div>
        </div>
      </details>
    </section>
    <section class="world-timeline-tools" aria-labelledby="world-timeline-heading">
      <div class="world-section-heading">
        <span class="world-step">CURRENT WORLD</span>
        <h3 id="world-timeline-heading">Timeline & continuity</h3>
        <p>Each timeline belongs to the world you currently have open. Changing the scene's timeline is always a separate decision.</p>
      </div>
      <div class="world-timeline-grid">
        <div class="world-tool-card">
          <h4>New timeline</h4>
          <label class="field-label" for="timeline-new-name">Timeline name</label>
          <input id="timeline-new-name" maxlength="120" placeholder="Main continuity, alternate ending…"/>
          <button class="subtle-button" id="timeline-create">Create timeline</button>
        </div>
        <div class="world-tool-card">
          <h4>Selected timeline</h4>
          <label class="field-label" for="timeline-select">Current-world timelines</label>
          <select id="timeline-select"></select>
          <button id="timeline-assign" class="subtle-button">Place current scene here</button>
          <p class="help">This affects the active scene only, not other scenes.</p>
        </div>
        <div class="world-tool-card">
          <h4>Fictional clock</h4>
          <label class="field-label" for="timeline-clock-utc">UTC reference date & time</label>
          <input id="timeline-clock-utc" type="datetime-local"/>
          <label class="field-label" for="timeline-clock-zone">Display time zone</label>
          <input id="timeline-clock-zone" value="UTC" placeholder="America/Los_Angeles"/>
          <button class="subtle-button" id="timeline-clock-save">Set fictional time</button>
          <p class="help">Written historical dates do not change automatically.</p>
        </div>
      </div>
    </section>
    <section class="world-admin-tools" aria-label="World safety and encounter tools">
      <div class="world-section-heading">
        <span class="world-step">ADMINISTRATION</span>
        <h3>Review & manage</h3>
        <p>These tools inspect dependencies and manage reusable openings. They do not affect the world creation draft above.</p>
      </div>
      <div class="world-admin-grid">
        <div class="world-tool-card" id="world-deletion-impact">
          <h4>Deletion impact — read only</h4>
          <p class="help">See records affected before any future permanent removal. Destructive world and timeline removal is not enabled.</p>
          <div class="inline-actions">
            <button id="world-impact-preview" class="subtle-button">Preview world dependencies</button>
            <button id="timeline-impact-preview" class="subtle-button">Preview selected timeline</button>
          </div>
          <div id="world-impact-report" aria-live="polite"></div>
        </div>
        <div class="world-tool-card">
          <h4>Encounter templates</h4>
          <p class="help">Edit reusable openings and communication modes in the Encounters workspace. Remove obsolete templates here before permanently deleting linked characters.</p>
          <button id="world-manage-encounters" class="subtle-button">Manage encounter templates</button>
        </div>
      </div>
    </section>
  </div>`;
  const worldName=$('world-new-name'),worldDescription=$('world-new-description');
  worldName.value=pendingWorldDraft.name;
  worldDescription.value=pendingWorldDraft.description;
  const rememberWorldDraft=()=>{
    pendingWorldDraft={...pendingWorldDraft,name:worldName.value,description:worldDescription.value};
  };
  $('world-create').disabled=creatingWorld;
  worldName.addEventListener('input',rememberWorldDraft);
  worldDescription.addEventListener('input',rememberWorldDraft);
  renderBlueprintFields($('world-new-blueprint-fields'),pendingWorldDraft.blueprint,'new-universe',(
    key,value)=>{pendingWorldDraft.blueprint={...pendingWorldDraft.blueprint,[key]:value};}
  );
  mountWorldSceneAssistant($('world-blueprint-ai-slot'),{
    mode:'blueprint',getModel,isCurrent:()=>host.isConnected&&!running,
    getRequest:(target,guidance)=>makeBlueprintAuthoringRequest({
      name:worldName.value,description:worldDescription.value,
      sections:pendingWorldDraft.blueprint,target,guidance
    }),
    onApply:patch=>{
      pendingWorldDraft.blueprint={...pendingWorldDraft.blueprint,...patch};
      renderBlueprintFields($('world-new-blueprint-fields'),pendingWorldDraft.blueprint,
        'new-universe',(key,value)=>{pendingWorldDraft.blueprint={...pendingWorldDraft.blueprint,[key]:value};});
    }
  });
  // Drafting a world never imports another world's private canon.
  mountWorldSceneAssistant($('world-ai-slot'),{
    mode:'world',getModel,isCurrent:()=>host.isConnected&&!running,
    getRequest:(target,guidance)=>makeWorldAuthoringRequest({
      name:$('world-new-name').value,description:$('world-new-description').value,target,guidance
    }),
    onApply:patch=>{
      if(patch.name!==undefined)$('world-new-name').value=patch.name;
      if(patch.description!==undefined)$('world-new-description').value=patch.description;
      rememberWorldDraft();
    }
  });
  const report = $('world-library-list');
  if (!worldLibrary) {
    report.append(el('p','Loading your local worlds...','help'));
    if (!loadingWorlds) refreshWorldLibrary();
    return;
  }
  $('world-library-count').textContent='('+worldLibrary.worlds.length+')';
  const currentUniverse=worldLibrary.worlds.find(x=>x.id===activeWorldId);
  const identitySection=$('universe-identity-editor');
  identitySection.hidden=!currentUniverse;
  if(currentUniverse){
    $('universe-export-bundle').href='/api/worlds/export/bundle?worldId='+encodeURIComponent(activeWorldId);
    $('universe-export-bundle').download='ai-rp-universe-'+activeWorldId+'.zip';
    $('universe-export-sqlite').href='/api/worlds/export?worldId='+encodeURIComponent(activeWorldId);
    $('universe-export-sqlite').download='ai-rp-universe-'+activeWorldId+'.sqlite';
    mountEntryPhotoGallery($('universe-photo-gallery'),{
      worldId:activeWorldId,entryType:'universe',entryId:activeWorldId,
      entryName:currentUniverse.name,photos:worldLibrary.photos||[],
      fetchImpl:fetch,refreshWorldLibrary,showError
    });
    if(!pendingUniverseRevision||pendingUniverseRevision.worldId!==activeWorldId){
      pendingUniverseRevision={
        worldId:activeWorldId,expectedName:currentUniverse.name,
        expectedDescription:currentUniverse.description,
        name:currentUniverse.name,description:currentUniverse.description
      };
    }
    const authoritativeBlueprint=worldLibrary.blueprint?.worldId===activeWorldId
      ?worldLibrary.blueprint:{worldId:activeWorldId,revision:0,sections:emptyUniverseBlueprint()};
    if(!pendingUniverseBlueprint||pendingUniverseBlueprint.worldId!==activeWorldId){
      pendingUniverseBlueprint={
        worldId:activeWorldId,revision:authoritativeBlueprint.revision,
        original:structuredClone(authoritativeBlueprint.sections),
        sections:structuredClone(authoritativeBlueprint.sections)
      };
    }
    const blueprintDraft=pendingUniverseBlueprint;
    const renderEditBlueprint=()=>renderBlueprintFields(
      $('universe-edit-blueprint-fields'),blueprintDraft.sections,'edit-universe',
      (key,value)=>{
        blueprintDraft.sections={...blueprintDraft.sections,[key]:value};
        showBlueprintChanges();
      }
    );
    const showBlueprintChanges=()=>{
      const changed=JSON.stringify(blueprintDraft.sections)!==JSON.stringify(blueprintDraft.original);
      $('universe-blueprint-state').textContent=changed?'Unsaved blueprint changes':
        'No unsaved blueprint changes';
      $('universe-blueprint-save').disabled=savingBlueprint||!changed;
    };
    renderEditBlueprint();showBlueprintChanges();
    mountWorldSceneAssistant($('universe-blueprint-ai-slot'),{
      mode:'blueprint',getModel,
      isCurrent:()=>identitySection.isConnected&&
        getCurrentWorldId()===blueprintDraft.worldId&&!savingBlueprint,
      beforeGenerate:beforeUpdateUniverse,
      getRequest:(target,guidance)=>makeBlueprintAuthoringRequest({
        worldId:blueprintDraft.worldId,library:worldLibrary,
        name:currentUniverse.name,description:currentUniverse.description,
        sections:blueprintDraft.sections,target,guidance
      }),
      onApply:patch=>{
        blueprintDraft.sections={...blueprintDraft.sections,...patch};
        renderEditBlueprint();showBlueprintChanges();
      }
    });
    $('universe-blueprint-save').onclick=async()=>{
      if(savingBlueprint)return;
      savingBlueprint=true;showBlueprintChanges();
      try {
        if(!serverStorage)throw Error('Connect SQLite to save the universe blueprint');
        await beforeUpdateUniverse();
        if(getCurrentWorldId()!==blueprintDraft.worldId)
          throw Error('Universe switched while saving the blueprint');
        const response=await fetch('/api/worlds/blueprint',{
          method:'PATCH',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            worldId:blueprintDraft.worldId,
            revision:blueprintDraft.revision,sections:blueprintDraft.sections
          })
        });
        const data=await response.json();
        if(!response.ok)throw Error(data.error||'Blueprint save failed');
        pendingUniverseBlueprint=null;
        await refreshWorldLibrary();
        showError();
      }catch(error){showError(error.message);}
      finally{savingBlueprint=false;
        if($('universe-blueprint-save')?.isConnected)$('universe-blueprint-save').disabled=false;
      }
    };
    const draft=pendingUniverseRevision;
    const editName=$('universe-edit-name'),editDescription=$('universe-edit-description');
    editName.value=draft.name;editDescription.value=draft.description;
    const indicate=()=>{
      const changed=draft.name!==draft.expectedName||draft.description!==draft.expectedDescription;
      $('universe-edit-state').textContent=changed?'Unsaved universe changes':'No unsaved changes';
      $('universe-edit-save').disabled=editingUniverse||!changed;
    };
    const remember=()=>{
      draft.name=editName.value;draft.description=editDescription.value;indicate();
    };
    editName.oninput=remember;editDescription.oninput=remember;indicate();
    mountWorldSceneAssistant($('universe-edit-ai-slot'),{
      mode:'universe',getModel,
      isCurrent:()=>identitySection.isConnected&&getCurrentWorldId()===draft.worldId&&!editingUniverse,
      beforeGenerate:beforeUpdateUniverse,
      getRequest:(target,guidance)=>makeUniverseRevisionRequest({
        worldId:draft.worldId,library:worldLibrary,
        name:editName.value,description:editDescription.value,target,guidance
      }),
      onApply:patch=>{
        if(patch.name!==undefined)editName.value=patch.name;
        if(patch.description!==undefined)editDescription.value=patch.description;
        remember();
      }
    });
    $('universe-edit-save').onclick=async()=>{
      if(editingUniverse)return;
      editingUniverse=true;indicate();
      try{
        if(!serverStorage)throw Error('Connect SQLite before editing a Connical Universe');
        await beforeUpdateUniverse();
        if(draft.worldId!==getCurrentWorldId())throw Error('Universe changed during save. Reopen the correct universe.');
        const response=await fetch('/api/worlds',{
          method:'PATCH',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            worldId:draft.worldId,name:editName.value,description:editDescription.value,
            expectedName:draft.expectedName,expectedDescription:draft.expectedDescription
          })
        });
        const data=await response.json();
        if(!response.ok)throw Error(data.error||'Unable to save universe details');
        pendingUniverseRevision=null;
        await refreshWorldLibrary();
        showError();
      }catch(error){showError(error.message);}
      finally{
        editingUniverse=false;
        if($('universe-edit-save')?.isConnected){
          $('universe-edit-save').disabled=false;
          if(pendingUniverseRevision?.worldId===activeWorldId)indicate();
        }
      }
    };
  }
  const timelineSelect=$('timeline-select');
  for(const world of worldLibrary.worlds){
     const card=el('div','','lore-card');
    const title=el('strong',world.name);const desc=el('p',world.description||'No setting description yet','help');
    card.classList.add('world-library-card');
    if(world.id===activeWorldId)card.classList.add('is-current');
    card.append(title,desc);
    const open=el('button',world.id===activeWorldId?'Currently open':'Open world','subtle-button');
    open.disabled=world.id===activeWorldId;
    open.onclick=()=>{void switchWorld(world.id).catch(error=>showError(error.message));};
    card.append(open);
    for(const timeline of worldLibrary.timelines.filter(t=>t.worldId===world.id)) {
      const label=el('p',`${timeline.name}${timeline.id===s?.timelineId?' · current scene':''}`,'help');
      card.append(label);
      if(world.id===activeWorldId)timelineSelect.add(new Option(timeline.name,timeline.id));
    }
    report.append(card);
  }
  const previewHost=$('world-impact-report');
  const showImpact=async timelineId=>{
    if(!serverStorage||!activeWorldId)return showError('Connect and open a world to inspect deletion impact.');
    if(timelineId&&!worldLibrary.timelines.some(t=>t.id===timelineId&&t.worldId===activeWorldId))
      return showError('Select a timeline in the current world first.');
    const button=timelineId?$('timeline-impact-preview'):$('world-impact-preview');
    button.disabled=true;
    previewHost.replaceChildren(el('p','Inspecting dependencies…','help'));
    try{
      const url='/api/worlds/deletion-preview?worldId='+encodeURIComponent(activeWorldId)+
        (timelineId?'&timelineId='+encodeURIComponent(timelineId):'');
      const response=await fetch(url);
      const data=await response.json();
      if(!response.ok)throw Error(data.error||'Could not read deletion impact');
      if(!host.isConnected)return; // Do not write a previous world's report after switching tabs.
      previewHost.replaceChildren();
      previewHost.append(el('h4',timelineId?'Selected timeline dependencies':'Current world dependencies','builder-subtitle'));
      const items=[
        ['World',data.worldName],['Timelines',data.timelineIds.length],
        ['Scenes',data.records.scenes],['Messages',data.records.messages],
        ['Character references',data.characterIds.length],
        ['Actor memories',data.records.actorMemories],
        ['Actor facts',data.records.actorFacts],
        ['World events',data.records.timelineEvents],
        ['Child fork timelines',data.descendantTimelineIds.length]
      ];
      for(const [label,value] of items)
        previewHost.append(el('p',label+': '+value,'help'));
      previewHost.append(el('p','Deletion is unavailable. This is a snapshot; it must be reverified under a lock before any destructive operation.','help'));
      for(const blocker of data.blockers)previewHost.append(el('p','Blocked: '+blocker,'help'));
      showError();
    }catch(error){
      if(host.isConnected)previewHost.replaceChildren(el('p',error.message,'help'));
    }finally{if(host.isConnected)button.disabled=false;}
  };
  $('world-impact-preview').onclick=()=>void showImpact(null);
  $('timeline-impact-preview').disabled=!timelineSelect.value;
  $('timeline-impact-preview').onclick=()=>void showImpact(timelineSelect.value);
  $('world-manage-encounters').onclick=()=>setWorkspace('encounters');
  if(!worldLibrary.worlds.length)report.append(el('p','Create your first world to begin.','empty-note'));
   if(s?.timelineId && worldLibrary.timelines.some(t=>t.id===s.timelineId&&t.worldId===activeWorldId))
    timelineSelect.value=s.timelineId;
  const fillClock=()=>{
    const clock=worldLibrary.clocks?.find(c=>c.timelineId===timelineSelect.value);
    $('timeline-clock-utc').value=clock?new Date(clock.instantMs).toISOString().slice(0,16):'';
    $('timeline-clock-zone').value=clock?.timeZone||'UTC';
  };
  timelineSelect.onchange=()=>{fillClock();$('timeline-impact-preview').disabled=!timelineSelect.value;};
  if(timelineSelect.value)fillClock();
  $('timeline-clock-save').disabled=!timelineSelect.value;
  $('timeline-clock-save').onclick=async()=>{
    try{
      const timelineId=$('timeline-select').value;
      if(!worldLibrary.timelines.some(t=>t.id===timelineId&&t.worldId===activeWorldId))
        throw Error('Choose a timeline belonging to the current world.');
      const raw=$('timeline-clock-utc').value;
      if(!raw)throw Error('Choose a fictional UTC date and time.');
      const instant=new Date(`${raw}:00Z`).toISOString();
      await postWorld('/api/timelines/clock',{worldId:activeWorldId,timelineId,instant,timeZone:$('timeline-clock-zone').value});
      showError();renderHeader();
    }catch(err){showError(err.message);}
  };
  $('world-create').onclick=async()=>{
    if(creatingWorld)return;
    const button=$('world-create');
    creatingWorld=true;button.disabled=true;
    let created=null;
    try{
      if(!serverStorage)throw Error('The SQLite server must be connected to create worlds.');
      const name=worldName.value.trim();
      const sourceWorldId=getCurrentWorldId();
      if(!name)throw Error('Give the new world a name before creating it.');
      // Confirm pending replies, unsent messages and SQLite writes BEFORE
      // committing a durable new world, never after the POST succeeds.
      if(!await beforeCreateWorld())return;
      const res=await fetch('/api/worlds',{method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({name,description:worldDescription.value,blueprint:pendingWorldDraft.blueprint})});
      const data=await res.json();if(!res.ok)throw Error(data.error||'Could not create world');
      created=data;
      pendingWorldDraft={name:'',description:'',blueprint:emptyUniverseBlueprint()};
      if(getCurrentWorldId()!==sourceWorldId)
        throw Error('The active world changed while this world was being created.');
      const switched=await switchWorld(data.id,{confirmed:true});
      if(!switched)throw Error('World was created, but could not be opened automatically.');
      showError();
    }catch(error){
      if(created){
        // Never pretend an already-created SQLite world was rolled back.
        showError('World "'+created.name+'" was created but not opened: '+error.message+
          ' Open it from Your universes. Do not create it again.');
        void refreshWorldLibrary();
      }else showError(error.message);
    }finally{
      creatingWorld=false;
      if($('world-create'))$('world-create').disabled=false;
    }
  };
  $('timeline-create').onclick=async()=>{
    try{
      if(!serverStorage)throw Error('The SQLite server must be connected to create timelines.');
      if(!worldLibrary.worlds.some(w=>w.id===activeWorldId))throw Error('Open a world before creating its timeline.');
      const res=await fetch('/api/timelines',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({worldId:activeWorldId,name:$('timeline-new-name').value})});
      const data=await res.json();if(!res.ok)throw Error(data.error||'Could not create timeline');
      showError();await refreshWorldLibrary();
      const picker=$('timeline-select');picker.value=data.id;
      picker.dispatchEvent(new Event('change'));
    }catch(error){showError(error.message);}
  };
  $('timeline-assign').disabled=!s;
  $('timeline-assign').onclick=()=>{
    if(!s||running)return;
    const value=$('timeline-select').value;
    if(!worldLibrary.timelines.some(t=>t.id===value&&t.worldId===activeWorldId))
      return showError('Select a timeline within this world; scenes cannot cross world boundaries.');
    s.timelineId=value;save();renderInspector();showError();
  };
}
