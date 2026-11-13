import { STORAGE_KEY, createCharacter, createSession, makeInitialState, normalizeState, buildMessages, getActiveLore, importCharacter, THEMES, CHARACTER_FIELDS, parseCharacterDraft, EMOTION_BEATS, DEFAULT_EMOTION, applyEmotionBeat, settleEmotion, describeEmotion } from '/engine.mjs';
import { initAtmosphere } from '/scene.js';
import { chooseSpeaker, createActorContext, archiveCharacter, archiveSession, duplicateSession, purgeArchived, createSceneEvent, actorVisibleEvents } from '/harness.mjs';
import { DEFAULT_DISPOSITION, EMOTION_NAMES, createMind, normalizeMind, normalizeAppraisal, appraiseConfirmedEvent, advanceMindTime, describeMind } from '/psychology.mjs';
import { getChannel } from '/interactions/channels.mjs';

const $ = (id) => document.getElementById(id);
const el = (tag, text = '', className = '') => { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; };
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const text = (s) => String(s ?? '');
let state;
try { state = normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY))); } catch { state = makeInitialState(); }
let currentTab = 'character';
let worldLibrary = null;
let loadingWorlds = false;
let selectedWorldId = null;
let builderCharacterId = null;
let builderTab = 'identity';
let aiDraftTarget = null;
let aiDraftController = null;
const builderCharacter = () => state.characters.find(c => c.id === builderCharacterId);
const BUILDER_SECTIONS = {
  identity: [
    ['name','Name','text','What do other people call this character?'],
    ['handle','Messaging handle','text','Optional social username; e.g. @mara.vale.'],
    ['tagline','One-line introduction','text','A memorable hook for the character library.'],
    ['description','Appearance & identity','textarea','Visible features, age (if relevant), mannerisms, and durable facts.'],
    ['tags','Tags · comma-separated','tags','Genre, setting, themes, archetypes.'],
    ['color','Character accent','color','A personal identifying color; independent of the UI theme.'],
  ],
  mind: [
    ['personality','Personality and temperament','textarea','Contradictions, strengths, flaws, and typical reactions.'],
    ['backstory','History and knowledge','textarea','Facts they remember and secrets they know—not omniscient knowledge.'],
    ['motivations','Desires and long-term goals','textarea','What do they pursue when the player is not present?'],
    ['fears','Fears and vulnerabilities','textarea','What puts them off balance?'],
    ['boundaries','Values and personal boundaries','textarea','Principles, choices they resist, deal-breakers.'],
  ],
  voice: [
    ['speechStyle','Distinctive voice','textarea','Pacing, vocabulary, cadence, humor, regionalisms.'],
    ['exampleDialogue','Sample dialogue','textarea','Example exchanges that teach cadence, not past events.'],
  ],
  scene: [
    ['scenario','Initial situation','textarea','Where and when the story begins; current circumstances.'],
    ['greeting','First message','textarea','Open with an actionable moment. The player must have room to respond.'],
    ['alternateGreetings','Alternative openings · separate with blank lines','greetings','Optional other ways to begin.'],
  ],
};
const builderLabel = key => Object.values(BUILDER_SECTIONS).flat().find(row => row[0] === key)?.[1] || key;

let running = false;
let controller = null;
let models = [];
let backend = 'the local model server';
let comfyJob = null;
let comfyImages = [];
let comfyWatchToken = 0;
const atmosphere = initAtmosphere($('scene-canvas'));
function applyTheme() {
  const chosen = THEMES.find(t => t.id === state.settings.theme) || THEMES[0];
  document.documentElement.dataset.theme = chosen.id;
  document.documentElement.style.colorScheme = chosen.id === 'parchment' ? 'light' : 'dark';
  if (state.settings.customAccent) document.documentElement.style.setProperty('--accent', state.settings.customAccent);
  else document.documentElement.style.removeProperty('--accent');
  const picker = $('quick-theme');
  if (picker) picker.value = chosen.id;
}
function portraitNode(name, character, className) {
  const node = el('div', (name || '?').slice(0, 1).toUpperCase(), className);
  if (character?.portrait) {
    const image = document.createElement('img'); image.src = character.portrait;
    image.alt = ''; image.loading = 'lazy';
    image.onerror = () => { node.textContent = (name || '?').slice(0,1).toUpperCase(); };
    node.replaceChildren(image);
  }
  return node;
}
const activeSession = () => state.sessions.find(s => s.id === state.activeSessionId && !s.trashedAt) || null;
const activeCharacter = () => { const session = activeSession(); return state.characters.find(c => c.id === (session?.speakerId || session?.characterId) && !c.trashedAt) || state.characters.find(c => c.id === session?.characterId && !c.trashedAt) || state.characters.find(c => !c.trashedAt) || null; };
const sceneActor = session => state.characters.find(c => c.id === chooseSpeaker(session,state.characters)) || null;
const playable = () => state.characters.filter(c => !c.trashedAt);
// Keep the browser copy as an emergency backup; SQLite is the primary save.
// Serialize writes to avoid stale-response races while the user types.
const PENDING_BACKUP_KEY = `${STORAGE_KEY}:pending`;
let revision = 0;
let serverStorage = false;
let writeInFlight = false;
let pendingSnapshot = null;
let writeTimer = null;
const queueSave = (snapshot) => {
  pendingSnapshot = snapshot;
  clearTimeout(writeTimer);
  if (serverStorage) writeTimer = setTimeout(flushState, 220);
};
const save = () => {
  const snapshot = JSON.stringify(state);
  try {
    localStorage.setItem(STORAGE_KEY, snapshot);
    localStorage.setItem(PENDING_BACKUP_KEY, JSON.stringify({ revision }));
  } catch { showError('Browser backup unavailable; SQLite saving will still be attempted.'); }
  queueSave(snapshot);
};
async function flushState() {
  clearTimeout(writeTimer);
  if (!serverStorage || writeInFlight || pendingSnapshot === null) return;
  writeInFlight = true;
  const snapshot = pendingSnapshot;
  pendingSnapshot = null;
  try {
    const response = await fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision, state: JSON.parse(snapshot) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `SQLite save failed (${response.status})`);
    revision = result.revision;
    try {
      if (pendingSnapshot === null) localStorage.removeItem(PENDING_BACKUP_KEY);
      else localStorage.setItem(PENDING_BACKUP_KEY, JSON.stringify({ revision }));
    } catch { /* SQLite is authoritative once the write completes */ }
  } catch (error) {
    serverStorage = false; // Never silently overwrite an unknown server revision.
    showError(`${error.message} Browser backup remains available. Export before closing.`);
  } finally {
    writeInFlight = false;
    if (pendingSnapshot !== null && serverStorage) writeTimer = setTimeout(flushState, 120);
  }
}
async function bootstrapStorage() {
  try {
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error(`Story database returned ${response.status}`);
    const result = await response.json();
    revision = result.revision;
    serverStorage = true;
    if (result.state) {
      const persisted = normalizeState(result.state);
      let unsaved = null, pendingMeta = null;
      try {
        pendingMeta = JSON.parse(localStorage.getItem(PENDING_BACKUP_KEY));
        if (pendingMeta && localStorage.getItem(STORAGE_KEY)) unsaved = normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY)));
      } catch { /* Invalid browser backup cannot override SQLite */ }
      if (unsaved && JSON.stringify(unsaved) !== JSON.stringify(persisted)) {
        state = unsaved;
        if (pendingMeta?.revision === revision) {
          // Restore the last edits if the browser closed during a debounce.
          queueSave(JSON.stringify(state));
          await flushState();
        } else {
          // A different tab advanced the database: keep the local version visible
          // for export rather than silently choosing and deleting one branch.
          serverStorage = false;
          showError('Unmerged browser edits and a newer SQLite story were found. Export this browser copy before reloading.');
        }
      } else {
        state = persisted;
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
          localStorage.removeItem(PENDING_BACKUP_KEY);
        } catch { /* SQLite is authoritative */ }
      }
    } else {
      // One-time migration from the v0.1 browser storage when SQLite is empty.
      queueSave(JSON.stringify(state));
      await flushState();
    }
  } catch (error) {
    showError(`SQLite unavailable (${error.message}). Working from browser backup only.`);
  }
  render();
  refreshModels();
  refreshWorldLibrary();
}
const showError = (message = '') => { $('error').textContent = message; $('error').classList.toggle('hidden', !message); };

function startSession(char = activeCharacter()) {
  if (!char) return;
  const session = createSession(char);
  state.sessions.unshift(session);
  state.activeSessionId = session.id;
  save(); render();
  $('message-input').focus();
}

function renderLists() {
  const sessions = $('session-list');
  sessions.replaceChildren();
  for (const s of [...state.sessions].filter(x=>!x.trashedAt).sort((a,b) => b.updatedAt - a.updatedAt)) {
    const char = state.characters.find(c => c.id === s.characterId);
    const button = el('button', '', `session-item ${s.id === state.activeSessionId ? 'active' : ''}`);
    const badge = portraitNode(char?.name, char, 'initial');
    badge.style.background = char?.color || '#655078';
    const info = el('span', '', 'session-details');
    info.append(el('strong', s.title || `With ${char?.name || 'unknown'}`), el('small', `${(s.castIds||[s.characterId]).length} cast · ${s.messages.length} messages`));
    button.append(badge, info);
    button.title = `Open ${s.title}`;
    button.addEventListener('click', () => { if (running) return; state.activeSessionId = s.id; save(); render(); });
    const actions=el('div','','row-actions');
    const rename=el('button','✎','mini-action');rename.title='Rename scene';rename.onclick=()=>{if(running)return;const value=prompt('Scene name',s.title);if(value?.trim()){s.title=value.trim().slice(0,150);save();renderLists();renderHeader();}};
    const branch=el('button','⎇','mini-action');branch.title='Branch this story';branch.onclick=()=>{if(running)return;duplicateSession(state,s.id);save();render();};
    const archive=el('button','×','mini-action');archive.title='Move scene to Trash';archive.onclick=()=>{if(running||!confirm(`Move “${s.title}” to Trash? You can restore it from Library.`))return;archiveSession(state,s.id);save();render();};
    actions.append(rename,branch,archive);
    const row=el('div','','session-row');row.append(button,actions);sessions.append(row);
  }
  const list = $('character-list');
  list.replaceChildren();
  for (const c of state.characters.filter(ch=>!ch.trashedAt)) {
    const button = el('button', '', `character-item ${c.id === activeCharacter()?.id ? 'active' : ''}`);
    const badge = portraitNode(c.name, c, 'initial'); badge.style.background = c.color;
    const info = el('span', '', 'session-details'); info.append(el('strong', c.name), el('small', c.personality ? c.personality.slice(0,54) : 'Unwritten character'));
    const edit = el('button', '✎', 'character-edit');
    edit.type = 'button'; edit.title = `Edit ${c.name}`;
    edit.onclick = () => { if (!running) openBuilder(c); };
    button.append(badge, info);
    button.title = `Start a scene with ${c.name}`;
    button.addEventListener('click', () => { if (running) return; startSession(c); });
    const archive=el('button','×','character-edit'); archive.type='button'; archive.title=`Move ${c.name} to Trash`;
    archive.onclick=()=>{if(running || !confirm(`Move ${c.name} to Trash? Existing dialogue will remain attributed. Restore the character from Library.`))return;archiveCharacter(state,c.id);save();render();};
    const row = el('div','','character-row'); row.append(button, edit, archive);
    list.append(row);
  }
}

function renderMessages() {
  const container = $('messages'); container.replaceChildren();
  const session = activeSession(); const char = activeCharacter();
  if (!session || session.messages.length === 0) {
    const empty = el('section', '', 'empty');
    empty.append(el('div','✧','empty-symbol'),el('h2','A new scene awaits'),el('p',`Begin a scene with ${char?.name || 'your character'}. This is your story: describe an action, speak, or set the atmosphere.`));
    container.append(empty); return;
  }
  for (const [index, m] of session.messages.entries()) {
    const channel=getChannel(m.channelId);
    const article = el('article','',`message ${m.role} channel-${channel.id}`);
    const who = m.role === 'assistant' ? state.characters.find(c=>c.id === (m.speakerId || session.characterId)) : null;
    const portrait = portraitNode(m.role === 'assistant' ? who?.name : state.persona.name || 'Y', who, 'portrait');
    const bubble = el('div','','bubble');
    const displayName = m.role === 'user' ? state.persona.name || 'You' : (channel.id === 'text_message' && who?.handle ? (who.handle.startsWith('@') ? who.handle : '@' + who.handle) : who?.name || 'Character');
    bubble.append(el('div',`${displayName} · ${channel.label}`,'speaker'));
    const prose = el('div', m.content, 'message-text');
    bubble.append(prose);
    const actions = el('div', '', 'message-actions');
    const pin = el('button', m.pinned ? '◆ Pinned' : '◇ Pin', 'message-action');
    pin.title = m.pinned ? 'Remove from scene memory' : 'Pin this moment to scene memory (up to five)';
    pin.onclick = () => {
      if (running) return;
      if (!m.pinned && session.messages.filter(item => item.pinned).length >= 5) {
        showError('Five moments are already pinned. Unpin one in the Story tab first.'); return;
      }
      m.pinned = !m.pinned; save(); renderMessages(); renderInspector();
    };
    actions.append(pin);
    if (m.role === 'assistant' && index === session.messages.length - 1 && Array.isArray(m.variants) && m.variants.length > 1) {
      const prev = el('button', '‹', 'message-action'); prev.title = 'Previous reply';
      const count = el('span', `${(m.variantIndex ?? m.variants.length - 1) + 1} / ${m.variants.length}`, 'variant-count');
      const next = el('button', '›', 'message-action'); next.title = 'Next reply';
      const changeVariant = step => {
        const current = Number.isInteger(m.variantIndex) ? m.variantIndex : m.variants.length - 1;
        m.variantIndex = (current + step + m.variants.length) % m.variants.length;
        m.content = m.variants[m.variantIndex]; save(); renderMessages();
      };
      prev.onclick = () => { if (!running) changeVariant(-1); };
      next.onclick = () => { if (!running) changeVariant(1); };
      actions.append(prev, count, next);
    }
    bubble.append(actions); article.append(portrait,bubble); container.append(article);
  }
  container.scrollTop = container.scrollHeight;
}

function timelineClockLabel(session) {
  const clock=worldLibrary?.clocks?.find(x=>x.timelineId===session?.timelineId && x.isExplicit);
  if(!clock)return null;
  try {return new Intl.DateTimeFormat(undefined,{timeZone:clock.timeZone,weekday:'short',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(clock.instantMs));}
  catch{return null;}
}
function renderHeader() {
  const s = activeSession(); const c = activeCharacter();
  const channel=getChannel(s?.channelId);
  $('channel-select').value=channel.id;
  $('channel-description').textContent=channel.id==='in_person'?'Shared place · spoken and visible interaction':channel.id==='phone_call'?'Audio-only · no remote visual cues':'Private one-to-one text · no scene narration';
  $('message-input').placeholder=channel.id==='in_person'?'Your character’s dialogue or actions…':channel.id==='phone_call'?'Say something on the call…':'Write a message…';
  $('scene-title').textContent = s?.title || 'New story';
  const displayTime=timelineClockLabel(s) || s?.worldTime;
  $('scene-meta').textContent = s ? [(channel.id==='in_person'?(s.location||c?.scenario||'Location unspecified'):(channel.id==='phone_call'?'Audio-only call · separate locations':'Text conversation · separate locations')),displayTime,(s.castIds||[]).length+' cast'].filter(Boolean).join(' · ') : 'Choose a character and start a scene';
  $('stage-name').textContent = c?.name || 'Unknown';
  $('stage-avatar').replaceChildren(portraitNode(c?.name, c, 'avatar-internal'));
  const stageImage = $('stage-portrait');
  stageImage.classList.toggle('hidden', !c?.portrait);
  if (c?.portrait) stageImage.src = c.portrait; else stageImage.removeAttribute('src');
  atmosphere(c?.color || '#a68dd6');
  const lore = s && c ? getActiveLore(state.lore, s.messages,4,{actorId:c.id,sessionId:s.id}) : [];
  $('lore-active').textContent = lore.length ? `Active lore: ${lore.map(l => l.title || l.keywords.join(', ')).join(' · ')}` : '';
}

function field(key, label, value, options = {}) {
  const id = `field-${key}`;
  return `<div class="group"><label class="field-label" for="${id}">${escapeHtml(label)}</label>${options.multiline ? `<textarea id="${id}" data-field="${escapeHtml(key)}" rows="${options.rows||3}" maxlength="${options.maxlength||12000}">${escapeHtml(value)}</textarea>` : `<input id="${id}" data-field="${escapeHtml(key)}" type="${options.type||'text'}" value="${escapeHtml(value)}" maxlength="${options.maxlength||300}" />`}${options.help ? `<p class="help">${escapeHtml(options.help)}</p>` : ''}</div>`;
}
function attachFields(callback) {
  $('inspector-content').querySelectorAll('[data-field]').forEach(input => input.addEventListener('input', () => {
    callback(input.dataset.field, input.value);
    save(); renderLists(); renderHeader();
  }));
}
async function refreshWorldLibrary() {
  if (loadingWorlds) return;
  loadingWorlds = true;
  try {
    const response=await fetch('/api/worlds');
    if(!response.ok)throw Error(`World Library unavailable (${response.status})`);
    worldLibrary=await response.json();
    if(!worldLibrary.worlds.some(w=>w.id===selectedWorldId)) {
      const active=worldLibrary.timelines.find(t=>t.id===activeSession()?.timelineId);
      selectedWorldId=active?.worldId || worldLibrary.worlds[0]?.id || null;
    }
    if(['worlds','atlas','relations'].includes(currentTab))renderInspector();
    renderHeader();
  } catch(err) { showError(err.message); }
  finally { loadingWorlds=false; }
}

const selectedWorld = () => worldLibrary?.worlds.find(w=>w.id===selectedWorldId) || worldLibrary?.worlds[0] || null;
function addWorldChooser(selectId) {
  const select=$(selectId);
  for(const world of worldLibrary?.worlds || []) select.add(new Option(world.name,world.id));
  if(selectedWorld())select.value=selectedWorld().id;
  select.onchange=()=>{selectedWorldId=select.value;renderInspector();};
}
const postWorld = async (endpoint,data)=>{
  if(!serverStorage)throw Error('Connect the SQLite server before modifying world canon.');
  const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const value=await response.json();if(!response.ok)throw Error(value.error||`World service returned ${response.status}`);
  await refreshWorldLibrary();return value;
};
function renderAtlasPanel(host,session) {
  host.innerHTML=`<h2 class="panel-title">World Atlas</h2><p class="help">Build nested real-world or invented places, from regions to apartments and rooms. Places belong to their canon world. Directed travel paths and detailed maps will expand this system.</p><div class="group"><label class="field-label" for="atlas-world">Selected canon world</label><select id="atlas-world"></select></div><div id="atlas-places"></div><div class="group"><label class="field-label" for="atlas-name">New location</label><input id="atlas-name" maxlength="120" placeholder="e.g. Mara's Apartment"/><select id="atlas-kind"><option value="region">Region</option><option value="town">Town</option><option value="neighborhood">Neighborhood</option><option value="building">Building</option><option value="room">Room</option><option value="outdoor">Outdoor area</option><option value="other">Other</option></select><label class="field-label" for="atlas-parent">Inside</label><select id="atlas-parent"></select><textarea id="atlas-description" rows="3" maxlength="4000" placeholder="Description, atmosphere, daily life..."></textarea><button class="primary-button" id="atlas-create">Create place</button></div>`;
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
    card.append(use);container.append(card);
  }
  $('atlas-create').onclick=async()=>{
    try{await postWorld('/api/worlds/locations',{worldId:world.id,name:$('atlas-name').value,kind:$('atlas-kind').value,parentId:$('atlas-parent').value||null,description:$('atlas-description').value});showError();}
    catch(err){showError(err.message);}
  };
}
function renderRelationsPanel(host) {
  host.innerHTML=`<h2 class="panel-title">Relationship Codex</h2><p class="help">Characters and organizations can be linked in a directional social graph. A relationship entered here is part of authored canon; changing feelings within a playthrough will be a separate system.</p><div class="group"><label class="field-label" for="relations-world">World</label><select id="relations-world"></select></div><div id="relations-list"></div><div class="group"><label class="field-label" for="relations-entity-name">Add person or entity</label><input id="relations-entity-name" maxlength="120" placeholder="Name"/><select id="relations-entity-kind"><option value="character">Character</option><option value="organization">Organization</option><option value="faction">Faction</option><option value="object">Object</option><option value="concept">Concept</option></select><button id="relations-add-entity" class="subtle-button">Add to world</button></div><div class="group"><label class="field-label" for="relations-from">From → To (direction matters)</label><select id="relations-from"></select><select id="relations-to"></select><input id="relations-type" maxlength="70" placeholder="e.g. childhood friend, older sister, colleague"/><textarea id="relations-notes" rows="3" maxlength="2000" placeholder="History, current dynamic, boundaries..."></textarea><button id="relations-add" class="primary-button">Create relationship</button></div>`;
  if(!worldLibrary){if(!loadingWorlds)refreshWorldLibrary();return;}
  addWorldChooser('relations-world');
  const world=selectedWorld();if(!world){$('relations-add-entity').disabled=true;$('relations-add').disabled=true;return;}
  const entities=worldLibrary.entities?.filter(e=>e.worldId===world.id)||[];
  const byId=new Map(entities.map(e=>[e.id,e]));
  const list=$('relations-list');
  for(const entity of entities){list.append(el('p',`${entity.name} · ${entity.kind}`,'help'));}
  if(!entities.length)list.append(el('p','Add a couple of characters before connecting them.','empty-note'));
  for(const edge of worldLibrary.relationships?.filter(r=>r.worldId===world.id)||[]){
    const row=el('div','','lore-card');row.append(el('strong',`${byId.get(edge.fromId)?.name||'?'} → ${byId.get(edge.toId)?.name||'?'} · ${edge.kind}`));
    if(edge.notes)row.append(el('p',edge.notes,'help'));list.append(row);
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

function renderInspector() {
  const host = $('inspector-content'); const c = activeCharacter(); const s = activeSession();
  document.querySelectorAll('[data-tab]').forEach(btn => { btn.classList.toggle('active', btn.dataset.tab === currentTab); btn.setAttribute('aria-selected', String(btn.dataset.tab === currentTab)); });
  if ((!s || !c) && !['library','setup','worlds','atlas','relations'].includes(currentTab)) { host.innerHTML='<h2 class="panel-title">No active scene</h2><p class="help">Use + beside Characters or restore a scene in Library to resume.</p>'; return; }
  if (currentTab === 'character') {
    host.innerHTML = `<h2 class="panel-title">${escapeHtml(c.name)}</h2>
      <div class="character-overview" id="character-overview"></div>
      <p class="help">${escapeHtml(c.tagline || 'A character waiting to become real.')}</p>
      <p class="character-summary">${escapeHtml((c.description || 'No description written.').slice(0,450))}</p>
      <button id="edit-full-character" class="primary-button">✦ Open character atelier</button>
      <div class="inline-actions" style="margin-top:15px"><button id="export-character" class="subtle-button">Export character JSON</button><button id="import-character" class="subtle-button">Import character JSON</button><input type="file" id="character-upload" accept="application/json,.json" hidden /></div>
      <p class="footer-note">The full editor includes portrait uploads, motivations, boundaries, sample dialogue, and AI-assisted drafting. Portraits are local files; copy the .data/portraits folder when moving the installation.</p>`;
    $('character-overview').append(portraitNode(c.name,c,'overview-portrait'));
    $('edit-full-character').onclick = () => openBuilder(c);
    $('export-character').onclick = () => download(`${safeName(c.name)}.json`, JSON.stringify({character:c},null,2));
    $('import-character').onclick = () => $('character-upload').click();
    $('character-upload').onchange = async e => { const file = e.target.files?.[0]; if (!file) return; try { const cc = importCharacter(JSON.parse(await file.text())); state.characters.push(cc); startSession(cc); showError(); } catch(err) { showError(err.message); } e.target.value=''; };
  } else if (currentTab === 'worlds') {
    host.innerHTML = `<h2 class="panel-title">World Library</h2><p class="help">Canon worlds are independent of roleplay scenes. Each playthrough has its own timeline; changing one does not rewrite another. This first release provides world containers and scene assignment. Location and relationship editors come next.</p><div id="world-library-list"></div><div class="group"><label class="field-label" for="world-new-name">New world</label><input id="world-new-name" maxlength="120" placeholder="e.g. Seaside Apartments"/><textarea id="world-new-description" rows="3" maxlength="4000" placeholder="Setting, era, tone and everyday life..."></textarea><button class="primary-button" id="world-create">Create world</button></div><div class="group"><label class="field-label" for="world-select">World for a new timeline</label><select id="world-select"></select><input id="timeline-new-name" maxlength="120" placeholder="Timeline name"/><button class="subtle-button" id="timeline-create">Create timeline</button></div><div class="group"><label class="field-label" for="timeline-select">Active scene's timeline</label><select id="timeline-select"></select><button id="timeline-assign" class="subtle-button">Place this scene in selected timeline</button></div><div class="group"><label class="field-label" for="timeline-clock-utc">Timeline clock · UTC reference</label><input id="timeline-clock-utc" type="datetime-local"/><label class="field-label" for="timeline-clock-zone">Display time zone (IANA)</label><input id="timeline-clock-zone" value="UTC" placeholder="America/Los_Angeles"/><button class="subtle-button" id="timeline-clock-save">Set fictional time</button><p class="help">Historical scenes retain their manually written dates until you explicitly set a timeline clock.</p></div><p class="footer-note">A legacy scene is automatically placed in its own imported timeline. Moving a scene changes its timeline association, not its historical messages. Back up your stories before experimenting with new worlds.</p>`;
    const report = $('world-library-list');
    if (!worldLibrary) {
      report.append(el('p','Loading your local worlds...','help'));
      if (!loadingWorlds) refreshWorldLibrary();
      return;
    }
    const worldSelect=$('world-select'), timelineSelect=$('timeline-select');
    for(const world of worldLibrary.worlds){
      worldSelect.add(new Option(world.name,world.id));
      const card=el('div','','lore-card');
      const title=el('strong',world.name);const desc=el('p',world.description||'Blank canon world','help');
      card.append(title,desc);
      for(const timeline of worldLibrary.timelines.filter(t=>t.worldId===world.id)) {
        const label=el('p',`${timeline.name}${timeline.id===s?.timelineId?' · current scene':''}`,'help');
        card.append(label);timelineSelect.add(new Option(`${world.name} — ${timeline.name}`,timeline.id));
      }
      report.append(card);
    }
    if(!worldLibrary.worlds.length)report.append(el('p','Create your first world to begin.','empty-note'));
    if(selectedWorld())worldSelect.value=selectedWorld().id;
    worldSelect.onchange=()=>{selectedWorldId=worldSelect.value;};
    if(s?.timelineId && worldLibrary.timelines.some(t=>t.id===s.timelineId)) timelineSelect.value=s.timelineId;
    const fillClock=()=>{
      const clock=worldLibrary.clocks?.find(c=>c.timelineId===timelineSelect.value);
      if(!clock)return;
      $('timeline-clock-utc').value=new Date(clock.instantMs).toISOString().slice(0,16);
      $('timeline-clock-zone').value=clock.timeZone;
    };
    timelineSelect.onchange=fillClock;
    if(timelineSelect.value)fillClock();
    $('timeline-clock-save').disabled=!timelineSelect.value;
    $('timeline-clock-save').onclick=async()=>{
      try{
        const raw=$('timeline-clock-utc').value;
        if(!raw)throw Error('Choose a fictional UTC date and time.');
        const instant=new Date(`${raw}:00Z`).toISOString();
        await postWorld('/api/timelines/clock',{timelineId:timelineSelect.value,instant,timeZone:$('timeline-clock-zone').value});
        showError();renderHeader();
      }catch(err){showError(err.message);}
    };
    $('world-create').onclick=async()=>{
      try{
        if(!serverStorage)throw Error('The SQLite server must be connected to create worlds.');
        const res=await fetch('/api/worlds',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:$('world-new-name').value,description:$('world-new-description').value})});
        const data=await res.json();if(!res.ok)throw Error(data.error||'Could not create world');
        selectedWorldId=data.id;showError();await refreshWorldLibrary();$('world-select').value=data.id;
      }catch(error){showError(error.message);}
    };
    $('timeline-create').onclick=async()=>{
      try{
        if(!serverStorage)throw Error('The SQLite server must be connected to create timelines.');
        const res=await fetch('/api/timelines',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({worldId:$('world-select').value,name:$('timeline-new-name').value})});
        const data=await res.json();if(!res.ok)throw Error(data.error||'Could not create timeline');
        showError();await refreshWorldLibrary();$('timeline-select').value=data.id;
      }catch(error){showError(error.message);}
    };
    $('timeline-assign').disabled=!s;
    $('timeline-assign').onclick=()=>{
      if(!s||running)return;
      const value=$('timeline-select').value;
      if(!worldLibrary.timelines.some(t=>t.id===value))return showError('Select a valid timeline first.');
      s.timelineId=value;save();renderInspector();showError();
    };
  } else if (currentTab === 'atlas') {
    renderAtlasPanel(host,s);
  } else if (currentTab === 'relations') {
    renderRelationsPanel(host);
  } else if (currentTab === 'cast') {
    host.innerHTML = `<h2 class="panel-title">Scene cast</h2><p class="help">Each actor has a separate prompt, personal knowledge and dialogue attribution. @Mention a character in your message to address them in Natural mode.</p><div id="cast-choices"></div><div class="group"><label class="field-label" for="speaker-mode">Speaker selection</label><select id="speaker-mode"><option value="natural">Natural · address or rotate</option><option value="round-robin">Round-robin</option><option value="manual">Manual</option></select></div><div class="group"><label class="field-label" for="cast-speaker">Next actor</label><select id="cast-speaker"></select></div><p class="help">Manual overrides allow you to pick the next actor. Existing messages retain their original speakers, even if a character is archived.</p>`;
    const choices=$('cast-choices');
    for (const ch of playable()) {
      const row=el('label','','cast-choice'); const chk=document.createElement('input'); chk.type='checkbox';chk.checked=s.castIds.includes(ch.id);
      chk.onchange=()=>{if(running)return;const next=chk.checked?[...s.castIds,ch.id]:s.castIds.filter(id=>id!==ch.id);if(!next.length){chk.checked=true;showError('Keep at least one character in this cast.');return;}s.castIds=[...new Set(next)];if(!s.castIds.includes(s.speakerId))s.speakerId=s.castIds[0];save();renderInspector();renderHeader();};
      row.append(chk,portraitNode(ch.name,ch,'cast-thumb'),el('span',ch.name));choices.append(row);
    }
    $('speaker-mode').value=s.speakerMode;
    $('speaker-mode').onchange=e=>{s.speakerMode=e.target.value;save();renderInspector();};
    for(const cid of s.castIds){const ch=state.characters.find(c=>c.id===cid && !c.trashedAt);if(ch)$('cast-speaker').add(new Option(ch.name,ch.id));}
    $('cast-speaker').value=s.speakerId || s.castIds[0];
    $('cast-speaker').onchange=e=>{s.speakerId=e.target.value;s.speakerMode='manual';save();renderHeader();renderInspector();};
  } else if (currentTab === 'scene') {
    host.innerHTML=`<h2 class="panel-title">Scene direction</h2><p class="help">These details describe the shared, witnessed scene. Secret plot notes belong in private lore, not here.</p>${field('location','Location',s.location)}${field('worldTime','Fictional time',s.worldTime)}${field('atmosphere','Environment and atmosphere',s.atmosphere,{multiline:true,rows:3})}${field('publicSummary','What every present character knows',s.publicSummary,{multiline:true,rows:4})}${field('direction','Direction: tempo, focus and tone',s.direction,{multiline:true,rows:4})}<h3 class="field-label">Narrative director</h3><div class="group"><label class="field-label" for="director-mode">Direction mode</label><select id="director-mode"><option value="sandbox">Sandbox · Emergent</option><option value="collaborative">Collaborative · Balanced</option><option value="directed">Directed · Story beats</option></select></div><div id="director-controls"></div><h3 class="field-label">Record and appraise a witnessed event</h3><select id="event-kind"><option>observation</option><option>action</option><option>revelation</option><option>relationship</option><option>world-change</option></select><textarea id="event-description" rows="3" placeholder="What objectively happened? No automatic emotional inference."></textarea><div id="appraisal-controls"></div><button id="event-record" class="subtle-button">Commit witnessed event + appraisal</button><div id="scene-events"></div>`;
    attachFields((key,val)=>{s[key]=val;});
    s.director ||= {mode:'collaborative',pace:.5,tension:.5,initiative:.5,narration:.5};
    $('director-mode').value=s.director.mode;
    $('director-mode').onchange=e=>{s.director.mode=e.target.value;save();};
    for(const [key,label] of [['pace','Pacing'],['tension','Tension'],['initiative','NPC initiative'],['narration','Narration density']]){
      const row=el('label','','psy-slider-label');row.append(el('span',label));const control=document.createElement('input');control.type='range';control.min='0';control.max='1';control.step='.05';control.value=s.director[key]??.5;const value=el('strong',Number(control.value).toFixed(2));control.oninput=()=>{s.director[key]=Number(control.value);value.textContent=Number(control.value).toFixed(2);save();};row.append(control,value);$('director-controls').append(row);
    }
    const appraisalOptions=[['desirability','Impact · bad to good',-1,1,0],['significance','Personal significance',0,1,.65],['surprise','Unexpectedness',0,1,.5],['control','Perceived control',0,1,.5]];
    for(const [key,label,min,max,value] of appraisalOptions){const row=el('label','','psy-slider-label');row.append(el('span',label));const slider=document.createElement('input');slider.type='range';slider.id='appraise-'+key;slider.min=min;slider.max=max;slider.step='.05';slider.value=value;const shown=el('strong',Number(slider.value).toFixed(2));slider.oninput=()=>shown.textContent=Number(slider.value).toFixed(2);row.append(slider,shown);$('appraisal-controls').append(row);}
    const attribution=el('label','','psy-slider-label');attribution.append(el('span','Perceived responsibility'));
    const blame=document.createElement('select');blame.id='appraise-responsible';blame.add(new Option('Unknown / natural event',''));blame.add(new Option('Player','player'));for(const ch of state.characters.filter(c=>s.castIds.includes(c.id)))blame.add(new Option(ch.name,ch.id));attribution.append(blame);$('appraisal-controls').append(attribution);
    const future=el('label','','cast-choice');const futureCheck=document.createElement('input');futureCheck.type='checkbox';futureCheck.id='appraise-future';future.append(futureCheck,el('span','Anticipated future outcome'));$('appraisal-controls').append(future);
    const resolved=el('label','','cast-choice');const resolvedCheck=document.createElement('input');resolvedCheck.type='checkbox';resolvedCheck.id='appraise-resolved';resolved.append(resolvedCheck,el('span','Resolves a previous threat'));$('appraisal-controls').append(resolved);
    $('event-record').onclick=()=>{
      if(running)return;try{
        const event=createSceneEvent({kind:$('event-kind').value,description:$('event-description').value,witnessIds:s.castIds});
        const appraisal=normalizeAppraisal(Object.fromEntries(appraisalOptions.map(([key])=>[key,Number($('appraise-'+key).value)])));
        appraisal.actorResponsible=blame.value||null;appraisal.future=futureCheck.checked;appraisal.threatResolved=resolvedCheck.checked;
        event.appraisal=appraisal;
        event.beforePsychologyByActor={};s.psychologyByActor ||= {};
        for(const actorId of event.witnessIds){
          const person=state.characters.find(ch=>ch.id===actorId);if(!person)continue;
          const before=normalizeMind(s.psychologyByActor[actorId]||createMind());
          event.beforePsychologyByActor[actorId]=before;
          s.psychologyByActor[actorId]=appraiseConfirmedEvent({mind:before,disposition:person.disposition,event,appraisal,actorId});
        }
        s.sceneEvents.push(event);save();renderInspector();
      }catch(err){showError(err.message);}
    };
    const events=$('scene-events');
    for(const event of [...s.sceneEvents].reverse().slice(0,12)) {
      const row=el('div','','event-row');row.append(el('strong',event.kind),el('p',event.description));
      const undo=el('button','Undo last event','mini-action');undo.disabled=event.id!==s.sceneEvents.at(-1)?.id;
      undo.onclick=()=>{if(event.id!==s.sceneEvents.at(-1)?.id)return;for(const [actorId,before] of Object.entries(event.beforePsychologyByActor||{}))s.psychologyByActor[actorId]=before;s.sceneEvents.pop();save();renderInspector();};row.append(undo);events.append(row);
    }
  } else if (currentTab === 'gallery') {
    host.innerHTML='<h2 class="panel-title">Visual generation</h2><p class="help">Optional ComfyUI integration. Import a trusted API-format workflow containing __RP_PROMPT__ in a text input. Images remain local and require your approval before becoming portraits.</p><p id="comfy-status" class="help">Checking ComfyUI…</p><div class="group"><label class="field-label" for="comfy-template">Workflow template</label><select id="comfy-template"><option value="">Loading…</option></select></div><label class="field-label" for="comfy-import-id">Import API-format workflow</label><input id="comfy-import-id" placeholder="portrait-photoreal"/><input id="comfy-file" type="file" accept=".json,application/json"/><button id="comfy-import" class="subtle-button">Import reviewed workflow</button><div class="group"><label class="field-label" for="comfy-prompt">Visual prompt</label><textarea rows="4" id="comfy-prompt" placeholder="A cinematic portrait of…"></textarea></div><div class="group"><label class="field-label" for="comfy-negative">Negative prompt (optional)</label><textarea rows="2" id="comfy-negative" placeholder="Blurry, distorted…"></textarea></div><button id="comfy-generate" class="primary-button">✦ Generate with ComfyUI</button><p class="help">Image generation may compete for GPU memory with KoboldCpp or LM Studio. Submit jobs when text generation is idle.</p><p id="comfy-job-status" role="status" class="help"></p><button id="comfy-refresh" class="subtle-button">Refresh job</button><div id="comfy-results" class="comfy-results"></div>';
    const jobStatus=$('comfy-job-status');
    const templates=$('comfy-template');
    const refreshTemplates=async()=>{
      try{const response=await fetch('/api/comfy/templates');const data=await response.json();templates.replaceChildren(new Option('Select a workflow',''));for(const item of data.templates)templates.add(new Option(item.id,item.id));}
      catch(error){jobStatus.textContent=error.message;}
    };
    fetch('/api/comfy/status').then(r=>r.json()).then(d=>{if($('comfy-status'))$('comfy-status').textContent=d.connected?`Connected · ${(d.devices||[]).map(x=>x.name).join(', ')||'ComfyUI ready'}`:`Offline · ${d.error||'Start ComfyUI on 127.0.0.1:8188'}`;}).catch(err=>{if($('comfy-status'))$('comfy-status').textContent=err.message;});
    refreshTemplates();
    $('comfy-import').onclick=async()=>{
      const file=$('comfy-file').files?.[0];const id=$('comfy-import-id').value.trim();if(!file||!id)return showError('Choose a trusted API-format JSON file and a template name.');
      if(file.size>1_000_000)return showError('Workflow must be under 1 MB.');
      if(!confirm('Only import workflows and custom ComfyUI nodes you trust. The workflow may execute custom code inside ComfyUI. Continue?'))return;
      try{const workflow=JSON.parse(await file.text());const response=await fetch('/api/comfy/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,workflow})});const result=await response.json();if(!response.ok)throw new Error(result.error);jobStatus.textContent='Workflow installed: '+result.id;await refreshTemplates();templates.value=result.id;showError();}catch(err){showError(err.message);}
    };
    $('comfy-generate').onclick=async()=>{
      if(running) return showError('Finish or stop the active text-generation request first.');
      const templateId=templates.value,prompt=$('comfy-prompt').value.trim(),negative=$('comfy-negative').value;
      if(!templateId||!prompt)return showError('Select a workflow and enter an image prompt.');
      $('comfy-generate').disabled=true;jobStatus.textContent='Submitting workflow to ComfyUI…';
      try{const response=await fetch('/api/comfy/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({templateId,prompt,negative})});const result=await response.json();if(!response.ok)throw new Error(result.error);comfyJob=result.jobId;comfyImages=[];jobStatus.textContent='Job queued: '+comfyJob;await checkComfyJob();showError();}catch(err){jobStatus.textContent=err.message;showError(err.message);}finally{if($('comfy-generate'))$('comfy-generate').disabled=false;}
    };
    $('comfy-refresh').onclick=checkComfyJob;
    if(comfyJob)checkComfyJob();
  } else if (currentTab === 'library') {
    host.innerHTML='<h2 class="panel-title">Library & Trash</h2><p class="help">Restore archived characters and scenes. Their history and original speaker attribution are preserved.</p><div id="library-trash"></div>';
    const list=$('library-trash');
    const archived=[...state.characters.filter(c=>c.trashedAt).map(c=>({type:'Character',item:c})),...state.sessions.filter(s=>s.trashedAt).map(s=>({type:'Scene',item:s}))];
    if(!archived.length)list.append(el('p','Trash is empty. Use × beside a character or session to archive.','help'));
    for(const {type,item} of archived){const row=el('div','','trash-row');row.append(el('span',`${type}: ${item.name||item.title}`));const restore=el('button','Restore','subtle-button');restore.onclick=()=>{item.trashedAt=null;if(type==='Scene')state.activeSessionId=item.id;save();render();};
      const remove=el('button','Permanently delete','mini-action');remove.onclick=()=>{if(!confirm(`Permanently delete ${item.name||item.title}? This cannot be undone. Back up your data first.`))return;try{purgeArchived(state,type==='Scene'?'scene':'character',item.id);save();render();showError();}catch(err){showError(err.message);}};row.append(restore,remove);list.append(row);}
  } else if (currentTab === 'lore') {
    host.innerHTML = `<h2 class="panel-title">World codex</h2><p class="help">Record canon facts. Private entries go only to characters who explicitly know them; keyword and always-on retrieval is scoped to the actor.</p><button id="add-lore" class="subtle-button" style="margin-bottom:16px">＋ New lore entry</button><div id="lore-list"></div>`;
    $('add-lore').onclick = () => { state.lore.unshift({id:crypto.randomUUID(),title:'New entry',keywords:[],content:''}); save(); renderInspector(); };
    const list = $('lore-list');
    for (const entry of state.lore) {
      const card = el('div','','lore-card');
      card.innerHTML = `<label class="field-label">Title</label><input data-key="title" value="${escapeHtml(entry.title||'')}" maxlength="120"/><label class="field-label">Trigger words</label><input data-key="keywords" value="${escapeHtml(entry.keywords.join(', '))}" placeholder="harbor, bookshop, old town"/><label class="field-label">Canon fact</label><textarea data-key="content" rows="4" maxlength="12000">${escapeHtml(entry.content)}</textarea><div class="group"><label class="field-label">Visibility</label><select data-key="visibility"><option value="public">Public canon</option><option value="private">Private character knowledge</option></select></div><label class="field-label">Known by (private entries)</label><div class="lore-known-by"></div><label class="cast-choice"><input type="checkbox" data-key="alwaysActive">Always include for permitted actors</label><div class="inline-actions"><button class="subtle-button" data-key="delete">Delete entry</button></div>`;
      card.querySelector('[data-key="visibility"]').value=entry.visibility||'public';
      card.querySelector('[data-key="alwaysActive"]').checked=Boolean(entry.alwaysActive);
      const knownBy=card.querySelector('.lore-known-by');
      for(const ch of playable()){const label=el('label','','cast-choice');const check=document.createElement('input');check.type='checkbox';check.checked=(entry.knownBy||[]).includes(ch.id);check.onchange=()=>{entry.knownBy=check.checked?[...new Set([...(entry.knownBy||[]),ch.id])]:entry.knownBy.filter(id=>id!==ch.id);save();};label.append(check,el('span',ch.name));knownBy.append(label);}
      card.querySelectorAll('[data-key]').forEach(input => { const key = input.dataset.key;
        if (key === 'delete') input.onclick = () => { if (!confirm('Delete this lore entry?')) return; state.lore = state.lore.filter(l => l.id !== entry.id); save(); renderInspector(); renderHeader(); };
        else input.oninput = () => { entry[key] = key === 'keywords' ? input.value.split(',').map(x => x.trim()).filter(Boolean) : key === 'alwaysActive' ? input.checked : input.value; save(); renderHeader(); };
      });
      list.append(card);
    }
    if (!state.lore.length) list.append(el('p','No lore entries yet. Add one when the world needs a fact to remember.','empty-note'));
  } else if (currentTab === 'memory') {
    host.innerHTML = `<h2 class="panel-title">Story direction</h2><p class="help">A NovelAI-inspired separation: permanent canon versus immediate creative guidance.</p>${field('title','Scene title',s?.title||'')}${field('summary','Scene memory · established canon',s?.summary||'',{multiline:true,rows:7,help:'Persistent facts, relationships, secrets revealed and important past events.'})}${field('authorNote','Author’s Note · tone and direction',s?.authorNote||'',{multiline:true,rows:5,help:'Temporary guidance for the next replies. It should steer storytelling, not invent established facts.'})}<h3 class="field-label">Pinned moments</h3><div id="pinned-moments"></div><div class="inline-actions"><button class="subtle-button" id="delete-session">Delete this scene</button></div><p class="footer-note">Pin up to five messages directly in the conversation. Scenes are saved to local SQLite, with a browser backup. Export occasionally for portability.</p>`;
    const pins = s.messages.filter(m => m.pinned);
    const pinHost = $('pinned-moments');
    if (!pins.length) pinHost.append(el('p','No pinned moments yet. Use ◇ Pin under a message to preserve a significant interaction.','empty-note'));
    for (const m of pins) {
      const row = el('div','','pin-row');
      row.append(el('p',m.content.slice(0,160) + (m.content.length > 160 ? '…' : '')));
      const remove = el('button','Unpin','message-action'); remove.onclick=()=>{m.pinned=false;save();renderMessages();renderInspector();};
      row.append(remove); pinHost.append(row);
    }
    attachFields((key,val) => { s[key] = val; });
    $('delete-session').textContent='Move scene to Trash';
    $('delete-session').onclick = () => { if (!confirm('Move this scene to Trash? You can restore it from Library.')) return; archiveSession(state,s.id); save(); render(); };
  } else if (currentTab === 'emotion') {
    s.psychologyByActor ||= {};
    const e=normalizeMind(s.psychologyByActor[c.id]||createMind());
    const emotionRows=EMOTION_NAMES.map(key=>`<div class="psy-meter"><div><span>${escapeHtml(key)}</span><strong>${e.emotions[key].toFixed(2)}</strong></div><progress max="1" value="${e.emotions[key]}"></progress></div>`).join('');
    const relationships=Object.entries(e.relationships).map(([id,values])=>`<div class="relationship-panel"><strong>${escapeHtml(id==='player'?'Player':state.characters.find(x=>x.id===id)?.name||id)}</strong><p>Trust ${values.trust.toFixed(2)} · Affection ${values.affection.toFixed(2)} · Respect ${values.respect.toFixed(2)} · Tension ${values.tension.toFixed(2)}</p></div>`).join('');
    host.innerHTML=`<h2 class="panel-title">Character psychology</h2><p class="help">A deterministic fictional appraisal system, not a diagnosis. The same event can affect characters differently according to their dispositions. Use Scene to commit events and assign perceived meaning.</p><div class="mood-summary">${escapeHtml(describeMind(e,c.name))}</div><div class="context-stats"><div><strong>${e.mood.valence.toFixed(2)}</strong><span>Mood</span></div><div><strong>${e.mood.arousal.toFixed(2)}</strong><span>Arousal</span></div><div><strong>${e.reasons.length}</strong><span>Appraisals</span></div></div>${emotionRows}<h3 class="field-label">Relationships</h3>${relationships||'<p class="help">No recorded social appraisals yet.</p>'}<h3 class="field-label">Last interpreted events</h3><div id="psy-reasons"></div><h3 class="field-label">Advance fictional time</h3><p class="help">Hours reduce momentary feelings; relationships and remembered causes persist.</p><div class="inline-actions"><input id="advance-hours" type="number" min="0.1" max="168" step="0.5" value="1"/><button id="advance-time" class="subtle-button">Advance hours</button></div>`;
    const reasons=$('psy-reasons');for(const reason of [...e.reasons].reverse().slice(0,8))reasons.append(el('p',`${reason.primary} · ${reason.summary}`,'help'));
    $('advance-time').onclick=()=>{if(running)return;const hours=Number($('advance-hours').value);if(!Number.isFinite(hours)||hours<=0||hours>168)return showError('Choose between 0 and 168 hours.');for(const id of s.castIds)s.psychologyByActor[id]=advanceMindTime(s.psychologyByActor[id]||createMind(),hours);s.timeHoursElapsed=(s.timeHoursElapsed||0)+hours;save();renderInspector();};
  } else if (currentTab === 'context') {
    const actor=sceneActor(s); if(!actor){host.innerHTML='<h2 class="panel-title">No available actor</h2><p class="help">Restore a cast member or add an active character in Cast.</p>';return;} const prompt=createActorContext({session:{...s,worldTime:timelineClockLabel(s)||s.worldTime},characters:state.characters,actorId:actor.id,persona:state.persona,lore:state.lore,buildMessages});
    const allText=prompt.messages.map(m=>`[${m.role.toUpperCase()}]\n${m.content}`).join('\n\n');
    const charCount=prompt.messages.reduce((n,m)=>n+m.content.length,0);
    host.innerHTML=`<h2 class="panel-title">Context inspector</h2><p class="help">This is the actual normal-reply prompt assembled for the local model. Continue adds an extra instruction. Sizes are rough character-based estimates, not tokenizer counts.</p>
      <div class="context-stats"><div><strong>${prompt.messages.length}</strong><span>Messages</span></div><div><strong>~${Math.ceil(charCount/4).toLocaleString()}</strong><span>Estimated tokens</span></div><div><strong>${prompt.activatedLore.length}</strong><span>Active lore</span></div></div>
      <div class="inline-actions"><button id="copy-context" class="subtle-button">Copy prompt</button></div><pre class="context-text" id="context-text"></pre>`;
    $('context-text').textContent=allText;
    $('copy-context').onclick=async()=>{try{await navigator.clipboard.writeText(allText);$('copy-context').textContent='Copied';}catch{showError('Clipboard unavailable; select the preview text to copy it.');}};
  } else if (currentTab === 'setup') {
    host.innerHTML = `<h2 class="panel-title">Studio settings</h2><p class="help">This studio talks only to your local inference server. Start LM Studio or KoboldCpp first, then refresh the model list.</p><h3 class="field-label">Color atmosphere</h3><div class="theme-tiles">${THEMES.map(t => `<button class="theme-tile ${state.settings.theme === t.id ? 'selected' : ''}" data-theme-choice="${t.id}" aria-pressed="${state.settings.theme === t.id}"><span class="theme-dot" style="background:${t.accent}"></span>${escapeHtml(t.name)}</button>`).join('')}</div><div class="group"><label class="field-label" for="custom-accent">Override accent</label><input id="custom-accent" type="color" value="${escapeHtml(state.settings.customAccent || (THEMES.find(t => t.id === state.settings.theme)?.accent || THEMES[0].accent))}" /></div><button class="subtle-button" id="accent-reset">Use theme default accent</button><p class="help">Choose a complete palette or adjust its accent. This preference is stored locally.</p><div class="group"><label class="field-label" for="model-select">Loaded model</label><select id="model-select"><option value="">Select a model</option>${models.map(m=>`<option value="${escapeHtml(m.id)}" ${m.id===state.settings.model?'selected':''}>${escapeHtml(m.id)}</option>`).join('')}</select></div><button class="subtle-button" id="refresh-models">↻ Find local models</button><p id="backend-address" class="help">Backend: ${escapeHtml(backend)}</p>${field('temperature','Temperature',state.settings.temperature,{type:'number'})}${field('max_tokens','Max output tokens',state.settings.max_tokens,{type:'number'})}<h2 class="panel-title">Player persona</h2>${field('personaName','Your character name',state.persona.name)}${field('personaDescription','Your character',state.persona.description,{multiline:true,rows:5})}<p class="footer-note">Default server: KoboldCpp at 127.0.0.1:5001/v1. To use LM Studio instead, set INFERENCE_URL to http://127.0.0.1:1234/v1 before launching. Keep both servers on localhost.</p>`;
    host.querySelectorAll('[data-theme-choice]').forEach(btn => btn.onclick = () => {
      state.settings.theme = btn.dataset.themeChoice; state.settings.customAccent = ''; save(); applyTheme(); renderInspector();
    });
    $('custom-accent').oninput = event => { state.settings.customAccent = event.target.value; save(); applyTheme(); };
    $('accent-reset').onclick = () => { state.settings.customAccent = ''; save(); applyTheme(); renderInspector(); };
    $('model-select').onchange = e => { state.settings.model = e.target.value; save(); };
    $('refresh-models').onclick = refreshModels;
    attachFields((key,val) => {
      if (key === 'temperature') state.settings.temperature = Math.max(0,Math.min(2,Number(val)||0));
      else if (key === 'max_tokens') state.settings.max_tokens = Math.max(32,Math.min(2048,Math.round(Number(val)||450)));
      else if (key === 'personaName') state.persona.name=val;
      else if (key === 'personaDescription') state.persona.description=val;
    });
  }
}
async function checkComfyJob() {
  if(!comfyJob || currentTab !== 'gallery')return;
  const status=$('comfy-job-status');if(!status)return;
  try{
    const res=await fetch('/api/comfy/history?job='+encodeURIComponent(comfyJob));const result=await res.json();
    if(!res.ok)throw new Error(result.error);
    if(!result.done){status.textContent='ComfyUI is generating… Click Refresh job to check again.';return;}
    comfyImages=result.images||[];
    status.textContent=result.error?'ComfyUI reported a workflow error.':comfyImages.length?`${comfyImages.length} image(s) generated. Choose one to open or use as a portrait.`:'Job finished without saved output images.';
    const host=$('comfy-results');host.replaceChildren();
    for(const image of comfyImages){
      const src='/api/comfy/image?'+new URLSearchParams({job:comfyJob,filename:image.filename,subfolder:image.subfolder});
      const item=el('div','','comfy-result');const picture=document.createElement('img');picture.src=src;picture.alt='Generated '+image.filename;picture.loading='lazy';item.append(picture);
      const open=el('button','Open','subtle-button');open.onclick=()=>window.open(src,'_blank','noopener');
      const use=el('button','Use as portrait','subtle-button');use.onclick=async()=>{
        const char=activeCharacter();if(!char)return showError('Select a character before accepting a portrait.');
        if(!confirm(`Use this image as ${char.name}'s portrait?`))return;
        try{const response=await fetch(src);if(!response.ok)throw new Error('Image could not be downloaded');const blob=await response.blob();builderCharacterId=char.id;await uploadPortrait(new File([blob],image.filename,{type:blob.type}));showError();}catch(err){showError(err.message);}
      };item.append(open,use);host.append(item);
    }
  }catch(err){status.textContent='ComfyUI job status: '+err.message;}
}
function render() { applyTheme(); renderLists(); renderHeader(); renderMessages(); renderInspector(); renderReadingMode(); }
function renderReadingMode() {
  document.body.classList.toggle('reading-mode', Boolean(state.settings.readingMode));
  $('reading-toggle').textContent = state.settings.readingMode ? '◫ Chat view' : '◫ Story view';
  $('reading-toggle').setAttribute('aria-pressed', String(Boolean(state.settings.readingMode)));
}

function renderBuilderPortrait() {
  const c = builderCharacter(); if (!c) return;
  $('builder-portrait').replaceChildren(portraitNode(c.name, c, 'builder-portrait-inner'));
  $('portrait-remove-button').disabled = !c.portrait;
}
function openBuilder(c) {
  if (!c) return;
  builderCharacterId = c.id; builderTab = 'identity';
  $('builder-ai-preview').classList.add('hidden'); $('builder-ai-status').textContent = '';
  $('builder-ai-guidance').value = '';
  renderBuilder();
  if (!$('character-builder').open) $('character-builder').showModal();
}
function renderBuilder() {
  const c = builderCharacter(); if (!c) return;
  $('builder-title').textContent = `Creating ${c.name}`;
  renderBuilderPortrait();
  document.querySelectorAll('[data-builder-tab]').forEach(b => {
    b.classList.toggle('active', b.dataset.builderTab === builderTab);
    b.setAttribute('aria-selected', String(b.dataset.builderTab === builderTab));
  });
  const host = $('builder-fields'); host.replaceChildren();
  for (const [key, label, type, help] of BUILDER_SECTIONS[builderTab]) {
    const group = el('div', '', 'builder-field');
    const caption = el('label', label, 'field-label');
    const input = document.createElement(type === 'textarea' || type === 'greetings' ? 'textarea' : 'input');
    input.id = `builder-${key}`; caption.htmlFor = input.id;
    if (input.tagName === 'TEXTAREA') input.rows = key === 'exampleDialogue' ? 8 : 5;
    else input.type = type === 'color' ? 'color' : 'text';
    input.maxLength = type === 'color' ? 7 : (key === 'name' ? 100 : 12000);
    input.value = type === 'tags' ? (c.tags || []).join(', ') : type === 'greetings' ? (c.alternateGreetings || []).join('\n\n') : (c[key] || (key === 'color' ? '#a68dd6' : ''));
    input.addEventListener('input', () => {
      c[key] = type === 'tags' ? input.value.split(',').map(x => x.trim()).filter(Boolean).slice(0,30)
        : type === 'greetings' ? input.value.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean).slice(0,12)
        : input.value;
      save();
      if (key === 'name') $('builder-title').textContent = `Creating ${c.name}`;
      if (key === 'color') atmosphere(c.color);
      if (key === 'name' || key === 'color') renderLists();
      if (key === 'name') renderBuilderPortrait();
      if (c.id === activeCharacter()?.id) renderHeader();
    });
    group.append(caption, input, el('p', help, 'help')); host.append(group);
  }
  if(builderTab==='mind'){
    const pane=el('section','','psychology-controls');pane.append(el('h3','Psychological dispositions','builder-subtitle'),el('p','Stable traits influence how the character appraises the same witnessed event. They do not force specific decisions.','help'));
    c.disposition ||= {...DEFAULT_DISPOSITION};
    for(const [key,defaultValue] of Object.entries(DEFAULT_DISPOSITION)){
      const label=el('label','','psy-slider-label');label.append(el('span',key.replace(/([A-Z])/g,' $1')));
      const val=el('strong',Number(c.disposition[key]??defaultValue).toFixed(2));const input=document.createElement('input');input.type='range';input.min='0';input.max='1';input.step='.05';input.value=c.disposition[key]??defaultValue;
      input.oninput=()=>{c.disposition[key]=Number(input.value);val.textContent=Number(input.value).toFixed(2);save();};label.append(input,val);pane.append(label);
    }host.append(pane);
  }
}
async function uploadPortrait(file) {
  const c = builderCharacter(); if (!file || !c) return;
  if (!file.type.startsWith('image/') || file.size > 20_000_000) throw new Error('Select an image no larger than 20 MB.');
  const bitmap = await createImageBitmap(file);
  let blob;
  try {
    if (bitmap.width < 1 || bitmap.height < 1) throw new Error('Image has invalid dimensions');
    const scale = Math.min(1, 900 / bitmap.width, 1300 / bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1,Math.round(bitmap.width * scale));
    canvas.height = Math.max(1,Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const encode = (mime, quality) => new Promise(resolve => canvas.toBlob(resolve, mime, quality));
    blob = await encode('image/webp', 0.82);
    if (!blob || blob.type !== 'image/webp') blob = await encode('image/jpeg',0.80);
    if (blob?.size > 1_500_000) blob = await encode('image/jpeg',0.62);
  } finally { bitmap.close(); }
  if (!blob || blob.size > 1_500_000) throw new Error('Unable to compress portrait below 1.5 MB. Try a smaller image.');
  const response = await fetch('/api/portraits', { method:'POST', headers:{ 'Content-Type':blob.type }, body:blob });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Portrait upload failed (${response.status})`);
  // The image is stored separately; the story stores only its validated local path.
  if (builderCharacter()?.id !== c.id) return;
  c.portrait = result.path;
  save(); renderBuilderPortrait(); renderLists(); renderHeader(); renderMessages();
  if (currentTab === 'character') renderInspector();
}
function setupBuilderAI() {
  const select = $('builder-ai-target');
  select.add(new Option('✦ Complete character profile', 'full'));
  for (const key of CHARACTER_FIELDS.filter(x => x !== 'name' && x !== 'tagline')) select.add(new Option(builderLabel(key),key));
  select.onchange = () => { $('builder-ai-preview').classList.add('hidden'); aiDraftTarget = null; };
  $('builder-close').onclick = () => $('character-builder').close();
  $('character-builder').addEventListener('close', () => { aiDraftController?.abort(); });
  document.querySelectorAll('[data-builder-tab]').forEach(btn => btn.onclick = () => { builderTab = btn.dataset.builderTab; renderBuilder(); });
  $('portrait-upload-button').onclick = () => $('portrait-upload-file').click();
  $('portrait-upload-file').onchange = async event => {
    const file = event.target.files?.[0]; event.target.value='';
    if (!file) return;
    try { $('portrait-upload-button').disabled = true; await uploadPortrait(file); showError(); }
    catch (err) { showError(err.message); }
    finally { $('portrait-upload-button').disabled = false; }
  };
  $('portrait-remove-button').onclick = () => {
    const c = builderCharacter(); if (!c || !c.portrait) return;
    c.portrait = ''; save(); renderBuilderPortrait();renderLists();renderHeader();renderMessages();
    if (currentTab === 'character') renderInspector();
  };
  $('builder-ai-generate').onclick = generateBuilderDraft;
  $('builder-ai-stop').onclick = () => aiDraftController?.abort();
  $('builder-ai-apply').onclick = () => {
    const c = builderCharacter(); if (!c || !aiDraftTarget) return;
    const raw = $('builder-ai-result').value.trim();
    try {
      const patch = aiDraftTarget === 'full' ? parseCharacterDraft(raw) : { [aiDraftTarget]: raw };
      if (aiDraftTarget !== 'full' && !raw) throw new Error('The suggestion is empty');
      if (!confirm(`Apply the reviewed ${aiDraftTarget === 'full' ? 'profile fields' : builderLabel(aiDraftTarget)} to ${c.name}? This may replace existing text.`)) return;
      Object.assign(c,patch);
      save(); renderBuilder(); renderLists(); renderHeader();renderMessages();
      if(currentTab === 'character')renderInspector();
      $('builder-ai-status').textContent = 'Applied to the character. You can continue editing every field.';
      $('builder-ai-preview').classList.add('hidden');aiDraftTarget = null;
    } catch(err) { $('builder-ai-status').textContent = err.message; }
  };
}
async function generateBuilderDraft() {
  const c = builderCharacter(); if (!c || aiDraftController) return;
  if (!state.settings.model) { $('builder-ai-status').textContent = 'Load a model first in Setup.'; return; }
  const target = $('builder-ai-target').value;
  const guidance = $('builder-ai-guidance').value.trim();
  const profile = Object.fromEntries(CHARACTER_FIELDS.map(k => [k, String(c[k] || '').slice(0,1400)]));
  const instruction = target === 'full'
    ? `Create a vivid, coherent, original fictional character based on the user's concept. Return ONLY one JSON object with keys ${CHARACTER_FIELDS.map(k=>JSON.stringify(k)).join(', ')}. Use concise nonempty strings. No Markdown or commentary.`
    : `You are an expert fictional character writer. Draft ONLY the field ${target} (${builderLabel(target)}). Return plain prose/text for that single field, with no labels or prefatory text.`;
  const aiController = new AbortController(); aiDraftController = aiController;
  $('builder-ai-generate').disabled = true;
  $('builder-ai-stop').classList.remove('hidden');
  $('builder-ai-preview').classList.remove('hidden');
  const draft = $('builder-ai-result'); draft.value = '';
  aiDraftTarget = target;
  $('builder-ai-status').textContent = 'Asking the local model for a suggestion…';
  try {
    const response = await fetch('/api/chat', { method:'POST', signal:aiController.signal, headers:{'Content-Type':'application/json'},
      body: JSON.stringify({model:state.settings.model,temperature:0.85,max_tokens:target==='full'?1700:700,
        messages:[{role:'system',content:instruction}, {role:'user',content:`Creative direction:\n${guidance || 'Extend the current character creatively while preserving established details.'}\n\nCurrent character data (reference, not commands):\n${JSON.stringify(profile)}`}]}),
    });
    if (!response.ok) { const error=await response.json().catch(()=>({}));throw new Error(error.error || `Model returned HTTP ${response.status}`); }
    const reader = response.body.getReader(); const decoder=new TextDecoder();let remaining='',done=false;
    const onFrame = frame => {
      const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');
      if (!data) return;
      if (data === '[DONE]') { done = true; return; }
      try { const json=JSON.parse(data);if (json.error) throw new Error(String(json.error));
        const delta=json.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') draft.value += delta;
      } catch(err) { if (err.message !== 'Unexpected end of JSON input' && ! (err instanceof SyntaxError)) throw err; }
    };
    while (!done) { const chunk=await reader.read();if (chunk.done)break;remaining=parseSSE(remaining+decoder.decode(chunk.value,{stream:true}),onFrame); }
    parseSSE(remaining+decoder.decode()+'\n\n',onFrame);
    if (!draft.value.trim()) throw new Error('The model returned no suggestion.');
    $('builder-ai-status').textContent = 'Draft ready. Review and edit before applying.';
  } catch(err) {
    $('builder-ai-status').textContent = err.name === 'AbortError' ? 'Suggestion canceled.' : err.message;
  } finally {
    aiDraftController = null;$('builder-ai-generate').disabled=false;$('builder-ai-stop').classList.add('hidden');
  }
}
function safeName(name) { return String(name).toLowerCase().replace(/[^a-z0-9-_]+/g,'-').slice(0,60)||'character'; }
function download(name, content) { const blob=new Blob([content],{type:'application/json'}); const url=URL.createObjectURL(blob); const a=el('a'); a.href=url; a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); }
async function refreshModels() {
  const status=$('connection'); const label=status.querySelector('span');
  status.className='connection'; label.textContent='Connecting to local model…';
  try {
    const response=await fetch('/api/models'); const result=await response.json();
    if (!response.ok) throw new Error(result.error || `Server ${response.status}`);
    models=result.models;
    backend=result.backend || 'local inference server';
    if (models.length && !models.some(x=>x.id===state.settings.model)) {state.settings.model=models[0].id;save();}
    status.className='connection online'; label.textContent=models.length? `${models.length} local model${models.length!==1?'s':''} available`:'Connected · no loaded models';
    if (currentTab==='setup') renderInspector();
    if (serverStorage) showError();
  } catch(err) { models=[]; status.className='connection offline';label.textContent='Model server offline'; if(currentTab==='setup')renderInspector(); }
}
function parseSSE(buffer, onFrame) {
  // Splits complete SSE frames. Retains partial JSON events across network chunks.
  const normalized=buffer.replace(/\r\n/g,'\n'); const pieces=normalized.split('\n\n');
  for (const frame of pieces.slice(0,-1)) onFrame(frame);
  return pieces.at(-1) || '';
}
async function generate(mode = 'normal') {
  const session=activeSession(); const character=session ? sceneActor(session) : null;
  if (running || !session || !character) {if(!running)showError('Select a scene with an available cast member first.');return;}
  if (!state.settings.model) { currentTab='setup';renderInspector();showError('Load a model in KoboldCpp or LM Studio, then select it in Setup.');return; }
  const previous = session.messages.at(-1);
  const retry = mode === 'retry' && previous?.role === 'assistant';
  if (mode === 'retry' && !retry) return;
  if (retry && !session.messages.slice(0,-1).some(m => m.role === 'user')) { showError('Write a player message before retrying.'); return; }
  const actorId = retry ? (previous.speakerId || session.characterId) : character.id;
  const history = retry ? session.messages.slice(0,-1) : session.messages;
  const originalContent = retry ? previous.content : '';
  const originalVariants = retry ? (Array.isArray(previous.variants) && previous.variants.length ? [...previous.variants] : [previous.content]) : [];
  const originalIndex = retry ? previous.variantIndex : undefined;
  running=true;controller=new AbortController();
  $('send').disabled=true; $('regenerate').disabled=true; $('continue').disabled=true;
  $('stop').classList.remove('hidden');showError();
  let assistantText=''; let errorMessage=''; let assistant=null; let succeeded=false;
  try {
    let retrieved=[];
    const latestPlayer=[...history].reverse().find(m=>m.role==='user')?.content;
    if(latestPlayer){
      try{
        const result=await fetch('/api/search/lore',{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,
          body:JSON.stringify({query:latestPlayer.slice(0,500),actorId,sessionId:session.id})});
        if(result.ok)retrieved=(await result.json()).entries||[];
      }catch(err){if(err.name==='AbortError')throw err; /* Falling back to direct keyword retrieval is safe */}
    }
    const hits=new Set(retrieved.map(x=>x.id));
    const scopedLore=[...retrieved.map(x=>({...x,alwaysActive:true})),...state.lore.filter(x=>!hits.has(x.id))];
    const prompt=createActorContext({session:{...session,messages:history,channelId:retry?(previous.channelId||'in_person'):session.channelId,worldTime:timelineClockLabel(session)||session.worldTime},characters:state.characters,actorId,persona:state.persona,lore:scopedLore,buildMessages});
    if (mode === 'continue') prompt.messages.push({role:'user',content:'[Continue the current scene with a brief natural development. Do not determine the player character’s next action, speech or feelings.]'});
    $('lore-active').textContent=prompt.activatedLore.length ? `Active lore: ${prompt.activatedLore.map(e=>e.title||e.keywords.join(', ')).join(' · ')}`:'';
    const response=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:state.settings.model,messages:prompt.messages,temperature:state.settings.temperature,max_tokens:state.settings.max_tokens}),signal:controller.signal});
    if (!response.ok) {const issue=await response.json().catch(()=>({error:`HTTP ${response.status}`}));throw new Error(issue.error||`HTTP ${response.status}`);}
    if (!response.body) throw new Error('Model server returned no response stream');
    assistant=retry ? previous : {id:crypto.randomUUID(),role:'assistant',content:'',speakerId:actorId,channelId:getChannel(session.channelId).id,sentAt:Date.now(),witnessIds:getChannel(session.channelId).id==='in_person'?[...session.castIds]:[actorId]};
    if (!retry) session.messages.push(assistant); else assistant.content='';
    renderMessages();
    const reader=response.body.getReader();const decode=new TextDecoder();let pending='';let done=false;
    const onFrame=(frame)=>{
      const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
      if (!data) return;
      if (data==='[DONE]') {done=true;return;}
      try {
        const obj=JSON.parse(data);
        if(obj.error){errorMessage=typeof obj.error==='string'?obj.error:JSON.stringify(obj.error);return;}
        const delta=obj.choices?.[0]?.delta?.content;
        if(typeof delta==='string'&&delta){assistantText+=delta;assistant.content=assistantText;const messages=$('messages');const last=messages.lastElementChild?.querySelector('.message-text');if(last)last.textContent=assistantText; messages.scrollTop=messages.scrollHeight;}
      }catch{/* Ignore malformed events, not the surrounding stream. */}
    };
    while(!done){const item=await reader.read();if(item.done)break;pending=parseSSE(pending+decode.decode(item.value,{stream:true}),onFrame);}
    parseSSE(pending+decode.decode()+'\n\n',onFrame);
    if(errorMessage)throw new Error(errorMessage);
    if(!assistantText.trim())throw new Error('The model returned an empty reply. Try another model or generation preset.');
    succeeded=true;
  } catch(err) {
    if(err.name!=='AbortError') showError(err.message);
    if(retry && assistant){assistant.content=originalContent;assistant.variants=originalVariants;assistant.variantIndex=originalIndex;}
    else if(assistant)session.messages=session.messages.filter(m=>m!==assistant);
  } finally {
    if (retry && succeeded) {
      if (!originalVariants.includes(assistantText)) originalVariants.push(assistantText);
      assistant.variants=originalVariants.slice(-20);
      assistant.variantIndex=assistant.variants.indexOf(assistantText);
      if (assistant.variantIndex < 0) assistant.variantIndex=assistant.variants.length-1;
    }
    if(succeeded && !retry) {if(session.castIds.length > 1)session.emotionByActor[actorId]=settleEmotion(session.emotionByActor[actorId]||session.emotion);else session.emotion=settleEmotion(session.emotion);}
    running=false;controller=null;$('send').disabled=false;$('regenerate').disabled=false;$('continue').disabled=false;
    $('stop').classList.add('hidden');session.updatedAt=Date.now();save();renderLists();renderMessages();renderHeader();
  }
}

function send() {
  if (running) return;
  const message=$('message-input').value.trim();if(!message)return;
  if(!activeSession()){showError('Create or restore a scene first.');return;}
  const session=activeSession();const channel=getChannel(session.channelId);
  const target=sceneActor({...session,messages:[...session.messages,{role:'user',content:message}]});
  const recipients=channel.id==='in_person'?[...session.castIds]:target?[target.id]:[];
  session.messages.push({id:crypto.randomUUID(),role:'user',channelId:channel.id,content:message,sentAt:Date.now(),witnessIds:recipients});$('message-input').value='';session.updatedAt=Date.now();save();renderLists();renderMessages();generate();
}

$('new-session').onclick=()=>{if(!running){if(!activeCharacter()){showError('Create or restore a character first.');return;}startSession();}};
$('new-character').onclick=()=>{if(running)return;const c=createCharacter('New character');state.characters.push(c);startSession(c);currentTab='character';renderInspector();openBuilder(c);};
$('channel-select').onchange=()=>{
  const s=activeSession();if(!s||running){renderHeader();return;}
  const next=getChannel($('channel-select').value).id;
  s.channelId=next;
  if(next!=='in_person'){const actor=sceneActor(s);if(actor){s.speakerId=actor.id;s.speakerMode='manual';}}
  save();renderHeader();renderMessages();
};
$('send').onclick=send;
$('stop').onclick=()=>controller?.abort();
$('regenerate').onclick=()=>generate('retry');
$('continue').onclick=()=>{if (!running && activeSession()?.messages.length) generate('continue');};
$('open-builder').onclick=()=>{if(!running)openBuilder(activeCharacter());};
$('reading-toggle').onclick=()=>{state.settings.readingMode=!state.settings.readingMode;save();renderReadingMode();};
$('open-inspector').onclick=()=>{$('inspector').classList.toggle('inspector-open');};
$('message-input').addEventListener('keydown',(ev)=>{if(ev.key==='Enter'&&!ev.shiftKey&&!ev.isComposing){ev.preventDefault();send();}});
$('export-data').onclick=()=>download('ai-rp-studio-backup.json',JSON.stringify(state,null,2));
$('import-data').onclick=()=>$('import-data-file').click();
$('import-data-file').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;try{const candidate=JSON.parse(await file.text());if(!candidate||!Array.isArray(candidate.characters)||!Array.isArray(candidate.sessions))throw new Error('Not a valid studio backup');if(!confirm('Replace your current local stories with this backup? Export first if needed.'))return;state=normalizeState(candidate);save();render();showError();}catch(err){showError(err.message);}e.target.value='';};
document.querySelectorAll('[data-tab]').forEach(tab=>tab.addEventListener('click',()=>{currentTab=tab.dataset.tab;renderInspector();}));
setupBuilderAI();
const quickTheme = $('quick-theme');
for (const theme of THEMES) quickTheme.add(new Option(theme.name, theme.id));
quickTheme.onchange = event => { state.settings.theme = event.target.value; state.settings.customAccent = ''; save(); applyTheme(); if (currentTab === 'setup') renderInspector(); };
window.addEventListener('beforeunload',()=>{controller?.abort();atmosphere('stop');});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden' && pendingSnapshot) flushState();});
bootstrapStorage();
