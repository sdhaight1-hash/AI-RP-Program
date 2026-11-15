// World and timeline editor presentation, wired to explicit world-scoped
// callbacks. Avoids mutating the browser's active-world selection implicitly.
export function renderWorldTimelineEditor(host,s,api) {
  const {$,el,worldLibrary,loadingWorlds,refreshWorldLibrary,
    activeWorldId,serverStorage,postWorld,switchWorld,setWorkspace,renderHeader,
    save,renderInspector,showError,running,fetch}=api;

  host.innerHTML = `<h2 class="panel-title">Worlds, timelines & fictional clocks</h2><p class="help">Every world has independent canon and timelines. Open a world explicitly before creating or editing its timelines. Places and relationships are in the adjacent World sections.</p><div id="world-library-list"></div><div class="group"><label class="field-label" for="world-new-name">New world</label><input id="world-new-name" maxlength="120" placeholder="e.g. Seaside Apartments"/><label class="field-label" for="world-new-description">World description</label><textarea id="world-new-description" rows="3" maxlength="4000" placeholder="Setting, era, tone and everyday life..."></textarea><button class="primary-button" id="world-create">Create world</button></div><div class="group"><label class="field-label" for="timeline-new-name">New timeline in the current world</label><input id="timeline-new-name" maxlength="120" placeholder="Timeline name"/><button class="subtle-button" id="timeline-create">Create timeline</button></div><div class="group"><label class="field-label" for="timeline-select">Timeline in this world</label><select id="timeline-select"></select><p class="help">Selecting a timeline lets you set its clock below. Applying it to the active scene is a separate action.</p><button id="timeline-assign" class="subtle-button">Place this scene in selected timeline</button></div><div class="group"><label class="field-label" for="timeline-clock-utc">Timeline clock · UTC reference</label><input id="timeline-clock-utc" type="datetime-local"/><label class="field-label" for="timeline-clock-zone">Display time zone (IANA)</label><input id="timeline-clock-zone" value="UTC" placeholder="America/Los_Angeles"/><button class="subtle-button" id="timeline-clock-save">Set fictional time</button><p class="help">Historical scenes retain their manually written dates until you explicitly set a timeline clock.</p></div><div class="group"><h3 class="builder-subtitle">Encounter templates</h3><p class="help">Reusable openings and communication modes live in their own Encounters workspace. Use it to remove templates blocking permanent character deletion.</p><button id="world-manage-encounters" class="subtle-button">Manage encounters</button></div><p class="footer-note">Each world has its own characters, lore, locations, timelines, and templates. Existing stories were imported into separate world storage.</p>`;
  const report = $('world-library-list');
  if (!worldLibrary) {
    report.append(el('p','Loading your local worlds...','help'));
    if (!loadingWorlds) refreshWorldLibrary();
    return;
  }
  const timelineSelect=$('timeline-select');
  for(const world of worldLibrary.worlds){
     const card=el('div','','lore-card');
    const title=el('strong',world.name);const desc=el('p',world.description||'Blank canon world','help');
    card.append(title,desc);
    const open=el('button',world.id===activeWorldId?'Current World':'Open World','subtle-button');
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
  $('world-manage-encounters').onclick=()=>setWorkspace('encounters');
  if(!worldLibrary.worlds.length)report.append(el('p','Create your first world to begin.','empty-note'));
   if(s?.timelineId && worldLibrary.timelines.some(t=>t.id===s.timelineId&&t.worldId===activeWorldId))
    timelineSelect.value=s.timelineId;
  const fillClock=()=>{
    const clock=worldLibrary.clocks?.find(c=>c.timelineId===timelineSelect.value);
    $('timeline-clock-utc').value=clock?new Date(clock.instantMs).toISOString().slice(0,16):'';
    $('timeline-clock-zone').value=clock?.timeZone||'UTC';
  };
  timelineSelect.onchange=fillClock;
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
    try{
      if(!serverStorage)throw Error('The SQLite server must be connected to create worlds.');
      const res=await fetch('/api/worlds',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:$('world-new-name').value,description:$('world-new-description').value})});
      const data=await res.json();if(!res.ok)throw Error(data.error||'Could not create world');
      await switchWorld(data.id);showError();
    }catch(error){showError(error.message);}
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
