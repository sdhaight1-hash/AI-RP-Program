import { STORAGE_KEY, createCharacter, createSession, makeInitialState, normalizeState, importCharacter, THEMES, CHARACTER_FIELDS, parseCharacterDraft, EMOTION_BEATS, DEFAULT_EMOTION, applyEmotionBeat, settleEmotion, describeEmotion } from '/engine.mjs';
import { initAtmosphere } from '/scene.js';
import { chooseSpeaker, archiveCharacter, archiveSession, duplicateSession, createSceneEvent, actorVisibleEvents } from '/harness.mjs';
import { DEFAULT_DISPOSITION, EMOTION_NAMES, createMind, normalizeMind, normalizeAppraisal, appraiseConfirmedEvent, advanceMindTime, describeMind } from '/psychology.mjs';
import { getChannel,CHANNEL_OPTIONS,channelAudience } from '/interactions/channels.mjs';
import { inspectNpcReply, replyBasis, isReplyBasisCurrent } from '/interactions/reply-review.mjs';
import { normalizeFrequentPlaces, importedEncounter, CHARACTER_V2_FIELDS } from '/character/schema.mjs';
import { makeCharacterDraftRequest, parseCharacterSuggestions, selectCharacterChanges, validateCharacterDraftBasis, characterDraftVersion, worldDraftVersion } from '/character/authoring.mjs';
import { makeWorldEntryDraftRequest,parseWorldEntrySuggestions } from '/character/world-bridge.mjs';
import { proposedRelationshipKinds } from '/character/relationship-bridge.mjs';
import { CHARACTER_FIELD_CONTRACTS } from '/character/field-contracts.mjs';
import { BUILDER_SECTIONS } from '/character/sections.mjs';
import { FIDELITY_PROBES, FIDELITY_RATINGS, makeFidelityProbe, inspectFidelityReply, normalizeFidelityReviews } from '/fidelity.mjs';
import { makeLocalModelEvaluationTasks,inspectLocalModelResult,summarizeLocalModelEvaluation } from '/eval/local-model.mjs';
import { worldPath,loadWorldSnapshot,loadWorldCatalog } from '/world-client.mjs';
import { WORKSPACE_META,visibleDetailTabs,searchStudioCommands } from '/studio-navigation.mjs';
import { removeEncounterTemplate,encounterDependencies } from '/encounters/library.mjs';
import { renderEncounterStudio } from '/encounter-studio.mjs';
import {renderAtlasPanel as drawAtlas,renderRelationsPanel as drawRelations} from '/world-editors.mjs';

const $ = (id) => document.getElementById(id);
const el = (tag, text = '', className = '') => { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; };
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const text = (s) => String(s ?? '');
let state;
try { state = normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY))); } catch { state = makeInitialState(); }
let currentTab = 'scene';
let activeWorkspace = 'story';
let worldLibrary = null;
let worldLibraryRequest = 0;
let switchingWorld = false;
let selectedWorldId = null;
let worldEditorView='overview';
let selectedCharacterId = null;
let activeWorldId = sessionStorage.getItem('ai-rp-selected-world') || null;
// The selected world belongs to this browser tab. Every stateful request
// carries its world ID, regardless of other tabs' selections.
const scopedUrl = path => worldPath(path,activeWorldId);
const portraitSrc = path => typeof path === 'string' && path.startsWith('/portraits/') ? scopedUrl(path) : path;
let builderCharacterId = null;
let builderTab = 'identity';
let encounterEditingId=null;
let encounterReturnToTrash=false;
let aiDraftTarget = null;
let aiDraftRequest = null;
let aiDraftController = null;
let worldEntryController = null;
let worldEntryRequest = null;
let fidelityController = null;
let localEvalController = null;
let localEvalReport = null;
let fidelityDraft = null;
let fidelitySelectedProbe = 'everyday';
const builderCharacter = () => state.characters.find(c => c.id === builderCharacterId);
const builderLabel = key => Object.values(BUILDER_SECTIONS).flat().find(row => row[0] === key)?.[1] || key;

let running = false;
let destructiveActionInFlight = false;
let controller = null;
let streamingReply = null; // Never saved: a provisional model response.
let pendingReply = null; // Held for explicit review if it violates channel/agency expectations.
let models = [];
let backend = 'the local model server';
let comfyJob = null;
let comfyImages = [];
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
    const image = document.createElement('img'); image.src = portraitSrc(character.portrait);
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
const workspaceCharacter = () => state.characters.find(c=>c.id===selectedCharacterId&&!c.trashedAt) || activeCharacter();
// Keep the browser copy as an emergency backup; SQLite is the primary save.
// Serialize writes to avoid stale-response races while the user types.
const backupStateKey = () => activeWorldId ? `${STORAGE_KEY}:world:${activeWorldId}` : STORAGE_KEY;
const pendingBackupKey = () => activeWorldId ? `${STORAGE_KEY}:pending:${activeWorldId}` : `${STORAGE_KEY}:pending`;
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
    localStorage.setItem(backupStateKey(), snapshot);
    localStorage.setItem(pendingBackupKey(), JSON.stringify({ revision }));
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
      body: JSON.stringify({ revision, worldId: activeWorldId, state: JSON.parse(snapshot) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `SQLite save failed (${response.status})`);
    revision = result.revision;
    try {
      if (pendingSnapshot === null) localStorage.removeItem(pendingBackupKey());
      else localStorage.setItem(pendingBackupKey(), JSON.stringify({ revision }));
    } catch { /* SQLite is authoritative once the write completes */ }
  } catch (error) {
    serverStorage = false; // Never silently overwrite an unknown server revision.
    showError(`${error.message} Browser backup remains available. Export before closing.`);
  } finally {
    writeInFlight = false;
    if (pendingSnapshot !== null && serverStorage) writeTimer = setTimeout(flushState, 120);
  }
}
async function requireSavedStory() {
  if (!serverStorage) throw new Error('SQLite storage is offline. Export your story before reviewing world changes.');
  // Story writes are debounced; event proposals must use the version actually in SQLite.
  for (let attempts=0; attempts<50; attempts++) {
    if (!writeInFlight && pendingSnapshot !== null) await flushState();
    if (!serverStorage) throw new Error('The latest scene could not be saved. World change was not submitted.');
    if (!writeInFlight && pendingSnapshot === null) return;
    await new Promise(resolve=>setTimeout(resolve,60));
  }
  throw new Error('Story save is still in progress; try again after it completes.');
}

async function bootstrapStorage() {
  try {
    let result;
    try {result=await loadWorldSnapshot(fetch,activeWorldId);}
    catch(error) {
      // A world may have been deleted or moved since this tab last opened.
      // Fall back to the local default, never silently load another world under
      // the old world ID.
      if(!activeWorldId || error.status!==404)throw error;
      activeWorldId=null;
      sessionStorage.removeItem('ai-rp-selected-world');
      result=await loadWorldSnapshot(fetch,null);
    }
    revision = result.revision;
    activeWorldId = result.worldId || null;
    if(activeWorldId)sessionStorage.setItem('ai-rp-selected-world',activeWorldId);
    serverStorage = true;
    if (result.state) {
      const persisted = normalizeState(result.state);
      let unsaved = null, pendingMeta = null;
      try {
        pendingMeta = JSON.parse(localStorage.getItem(pendingBackupKey()));
        if (pendingMeta && localStorage.getItem(backupStateKey())) unsaved = normalizeState(JSON.parse(localStorage.getItem(backupStateKey())));
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
          localStorage.setItem(backupStateKey(), JSON.stringify(state));
          localStorage.removeItem(pendingBackupKey());
        } catch { /* SQLite is authoritative */ }
      }
    } else {
      // One-time migration from the v0.1 browser storage when SQLite is empty.
      queueSave(JSON.stringify(state));
      await flushState();
      // The server assigns stable timeline IDs while saving new/legacy scenes.
      // Adopt that canonical normalization immediately, not only after reload.
      if (serverStorage) {
        const saved=await fetch(scopedUrl('/api/state'));
        if(!saved.ok)throw Error('Could not reload the newly created timeline');
        const value=await saved.json();
        revision=value.revision;
        state=normalizeState(value.state);
        try{localStorage.setItem(backupStateKey(),JSON.stringify(state));}catch{/* SQLite is authoritative */}
      }
    }
  } catch (error) {
    showError(`SQLite unavailable (${error.message}). Working from browser backup only.`);
  }
  render();
  refreshModels();
  void refreshWorldLibrary().then(() => {renderWorldLauncher(); if(activeWorldId && !sessionStorage.getItem('ai-rp-world-opened')) $('world-launcher').showModal();});
}
const showError = (message = '') => {
  for(const id of ['error','detail-error']){
    const node=$(id);
    if(node){node.textContent=message;node.classList.toggle('hidden',!message);}
  }
};

function startSession(char = activeCharacter(), encounter = null,channelId=null) {
  if (!char) return;
  const session = createSession(char,encounter);
  if(!encounter&&channelId)session.channelId=getChannel(channelId).id;
  if(encounter?.locationId && getChannel(encounter.channelId).id==='in_person')session.location=worldLibrary?.locations.find(l=>l.id===encounter.locationId)?.name||'';
  state.sessions.unshift(session);
  state.activeSessionId = session.id;
  activeWorkspace='story';currentTab='scene';setDetailDeskOpen(false);
  save(); render();
  $('message-input').focus();
}

function openNewSceneDialog() {
  if(running)return;
  const actors=state.characters.filter(c=>!c.trashedAt);
  if(!actors.length)return showError('Create a character inside this world first.');
  const chosen=$('new-scene-character');chosen.replaceChildren();
  for(const c of actors)chosen.add(new Option(c.name,c.id));
  if(activeCharacter())chosen.value=activeCharacter().id;
  const refresh=()=>{
    const template=$('new-scene-encounter');template.replaceChildren();
    template.add(new Option('Unscripted scene (no opening template)',''));
    for(const encounter of state.encounters||[]){
      if(encounter.characterIds?.includes(chosen.value) &&
        encounter.characterIds.every(id=>state.characters.some(c=>c.id===id&&!c.trashedAt)))
        template.add(new Option(`${encounter.title} · ${getChannel(encounter.channelId).label}`,encounter.id));
    }
    const selected=$('new-scene-channel');
    selected.value='in_person';
    const showMedium=()=>{
      const item=(state.encounters||[]).find(e=>e.id===template.value);
      selected.disabled=Boolean(item);
      if(item)selected.value=getChannel(item.channelId).id;
      $('new-scene-channel-hint').textContent=getChannel(selected.value).description + (item?' · Set by the template.':' · Change this for an unscripted scene.');
    };
    template.onchange=showMedium;selected.onchange=showMedium;
    showMedium();
  };
  chosen.onchange=refresh;refresh();$('new-scene-dialog').showModal();
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
    button.addEventListener('click', () => { if (running) return; state.activeSessionId = s.id; activeWorkspace='story'; save(); render(); });
    const actions=el('div','','row-actions');
    const rename=el('button','✎','mini-action');rename.title='Rename scene';rename.onclick=()=>{if(running)return;const value=prompt('Scene name',s.title);if(value?.trim()){s.title=value.trim().slice(0,150);save();renderLists();renderHeader();}};
    const branch=el('button','⎇','mini-action');branch.title='Fork scene into an independent world timeline';
    branch.onclick=async()=>{
      if(running)return;
      branch.disabled=true;
      try{
        await requireSavedStory();
        if(!s.timelineId)throw Error('This scene has no saved timeline yet.');
        const timeline=await postWorld('/api/timelines/fork',{timelineId:s.timelineId,name:`${s.title} (alternate)`});
        const copy=duplicateSession(state,s.id);
        copy.timelineId=timeline.id;
        save();render();showError();
      }catch(err){showError(err.message);branch.disabled=false;}
    };
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
    const play = el('button', '▶', 'character-edit');
    play.type = 'button'; play.title = `Start scene with ${c.name}`;
    play.setAttribute('aria-label',play.title);
    play.onclick = () => { if (!running) startSession(c); };
    button.append(badge, info);
    button.title = `Edit ${c.name}'s character profile`;
    button.addEventListener('click', () => { if (running) return; selectedCharacterId=c.id;setWorkspace('characters');openBuilder(c); });
    const archive=el('button','×','character-edit'); archive.type='button'; archive.title=`Move ${c.name} to Trash`;
    archive.onclick=()=>{if(running || !confirm(`Move ${c.name} to Trash? Existing dialogue will remain attributed. Restore the character from Library.`))return;archiveCharacter(state,c.id);save();render();};
    const row = el('div','','character-row'); row.append(button, play, archive);
    list.append(row);
  }
}

function renderMessages() {
  const container = $('messages'); container.replaceChildren();
  const session = activeSession(); const char = activeCharacter();
  if (!session || session.messages.length === 0) {
    const empty = el('section', '', 'empty');
    empty.append(el('div','✧','empty-symbol'),el('h2','A new scene awaits'),el('p',`Begin a scene with ${char?.name || 'your character'}. This is your story: describe an action, speak, or set the atmosphere.`));
    container.append(empty); renderReplyReview(); return;
  }
  const preview = streamingReply?.sessionId===session.id ? streamingReply.message : pendingReply?.sessionId===session.id ? pendingReply.message : null;
  const display = preview ? [...session.messages, preview] : session.messages;
  for (const [index, m] of display.entries()) {
    const channel=getChannel(m.channelId);
    const article = el('article','',`message ${m.role} channel-${channel.id}`);
    const who = m.role === 'assistant' ? state.characters.find(c=>c.id === (m.speakerId || session.characterId)) : null;
    const portrait = portraitNode(m.role === 'assistant' ? who?.name : state.persona.name || 'Y', who, 'portrait');
    const bubble = el('div','','bubble');
    const displayName = m.role === 'user' ? state.persona.name || 'You' : (['text_message','social_dm','social_thread'].includes(channel.id) && who?.handle ? (who.handle.startsWith('@') ? who.handle : '@' + who.handle) : who?.name || 'Character');
    bubble.append(el('div',`${displayName} · ${channel.label}${m.provisional ? ' · DRAFT (not saved)' : ''}`,'speaker'));
    const prose = el('div', m.content, 'message-text');
    bubble.append(prose);
    const actions = el('div', '', 'message-actions');
    if (m.provisional) { article.classList.add('provisional'); bubble.append(actions); article.append(portrait,bubble); container.append(article); continue; }
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
    if (m.role === 'assistant' && index === session.messages.length - 1 && pendingReply?.sessionId!==session.id && Array.isArray(m.variants) && m.variants.length > 1) {
      const prev = el('button', '‹', 'message-action'); prev.title = 'Previous reply';
      const count = el('span', `${(m.variantIndex ?? m.variants.length - 1) + 1} / ${m.variants.length}`, 'variant-count');
      const next = el('button', '›', 'message-action'); next.title = 'Next reply';
      const changeVariant = async step => {
        if (!serverStorage) return showError('Story storage is offline; cannot check committed world events.');
        try {
          await requireSavedStory();
          const response=await fetch(scopedUrl(`/api/events/proposals?sceneId=${encodeURIComponent(session.id)}`));
          const data=await response.json();if(!response.ok)throw Error(data.error);
          if(data.proposals?.some(p=>p.sourceMessageId===m.id && p.status==='accepted'))
            return showError('This reply is locked by an accepted world event. To change it, start a fresh timeline from canon without this event.');
          if(activeSession()?.id!==session.id||session.messages.at(-1)!==m)return;
          const current = Number.isInteger(m.variantIndex) ? m.variantIndex : m.variants.length - 1;
          m.variantIndex = (current + step + m.variants.length) % m.variants.length;
          m.content = m.variants[m.variantIndex]; save(); renderMessages();showError();
        }catch(err){showError(err.message);}
      };
      prev.onclick = () => { if (!running) changeVariant(-1); };
      next.onclick = () => { if (!running) changeVariant(1); };
      actions.append(prev, count, next);
    }
    bubble.append(actions); article.append(portrait,bubble); container.append(article);
  }
  renderReplyReview();
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
  $('channel-description').textContent=channel.description;
  $('message-input').placeholder=channel.placeholder;
  $('scene-title').textContent = s?.title || 'New story';
  const displayTime=timelineClockLabel(s) || s?.worldTime;
  $('scene-meta').textContent = s ? [channel.id==='in_person'?(s.location||'Location unspecified'):channel.description,displayTime,(s.castIds||[]).length+' cast'].filter(Boolean).join(' · ') : 'Choose a character and start a scene';
  $('stage-name').textContent = c?.name || 'Unknown';
  $('stage-avatar').replaceChildren(portraitNode(c?.name, c, 'avatar-internal'));
  const stageImage = $('stage-portrait');
  stageImage.classList.toggle('hidden', !c?.portrait);
  if (c?.portrait) stageImage.src = portraitSrc(c.portrait); else stageImage.removeAttribute('src');
  atmosphere(c?.color || '#a68dd6');
  $('lore-active').textContent = s && c ? 'World-scoped actor memory · inspect Context for retrieved evidence' : '';
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
  // The latest request wins. An old fetch may finish after switching worlds;
  // blocking a new refresh behind it would leave an empty or stale Atlas.
  const requestId=++worldLibraryRequest;
  const requestedWorldId=activeWorldId;
  try {
    const received=await loadWorldCatalog(fetch,requestedWorldId);
    if(requestId!==worldLibraryRequest||requestedWorldId!==activeWorldId)return;
    worldLibrary=received;
    selectedWorldId=activeWorldId || selectedWorldId || worldLibrary.worlds[0]?.id || null;
    if(!activeWorldId && worldLibrary.activeWorldId)activeWorldId=worldLibrary.activeWorldId;
    const label=$('world-label'); if(label)label.textContent=worldLibrary.worlds.find(w=>w.id===activeWorldId)?.name || 'No active world';
    if(['worlds','atlas','relations'].includes(currentTab))renderInspector();
    renderHeader();
    renderWorkspace();
  } catch(err) { showError(err.message); }
}


// A world switch is a hard context boundary. No pending generation, browser
// backup, or stale per-world state is allowed to cross it.
async function switchWorld(worldId) {
  if (worldId === activeWorldId) { $('world-launcher')?.close();return; }
  if(switchingWorld)throw new Error('Another world switch is already in progress.');
  if(destructiveActionInFlight)throw new Error('Finish the permanent deletion before switching worlds.');
  if (running || aiDraftController || fidelityController || localEvalController || worldEntryController) throw new Error('Finish or cancel generation before switching worlds.');
  if (pendingReply && !confirm('Discard the unreviewed NPC draft before opening another world?')) return;
  if ($('message-input')?.value.trim() && !confirm('Discard the unsent message before opening another world?')) return;
  switchingWorld=true;
  try {
  await requireSavedStory();
  const result=await loadWorldSnapshot(fetch,worldId);
  pendingReply=null;streamingReply=null;pendingSnapshot=null;
  comfyJob=null;comfyImages=[]; // Do not expose another world's generated assets after switching.
  $('message-input').value='';
  aiDraftTarget=null;builderCharacterId=null;selectedCharacterId=null;fidelityDraft=null;
  $('character-builder')?.close();
  activeWorldId=result.worldId;
  selectedWorldId=result.worldId;
  sessionStorage.setItem('ai-rp-selected-world',activeWorldId);
  state=normalizeState(result.state);
  revision=result.revision;
  serverStorage=true;
  try {localStorage.setItem(backupStateKey(),JSON.stringify(state));sessionStorage.setItem('ai-rp-world-opened','1');} catch {}
  currentTab='worlds';worldLibrary=null;worldEditorView='overview';encounterEditingId=null;encounterReturnToTrash=false;
  $('world-launcher')?.close();
  applyTheme();render();await refreshWorldLibrary();renderWorldLauncher();showError();
  } finally {switchingWorld=false;}
}
function renderWorldLauncher() {
  const host=$('world-launcher-list');if(!host)return;
  host.replaceChildren();
  const all=worldLibrary?.worlds||[];
  const term=String($('world-filter')?.value||'').trim().toLocaleLowerCase();
  const shown=term?all.filter(w=>[w.name,w.description].some(x=>String(x||'').toLocaleLowerCase().includes(term))):all;
  $('world-list-count').textContent=`${shown.length} of ${all.length} independent ${all.length===1?'world':'worlds'}`;
  if(!shown.length)host.append(el('p','No worlds match this search. Clear the filter to see every universe.','empty-note'));
  for (const world of shown) {
    const card=el('div','','world-launcher-item');
    const active=world.id===activeWorldId;
    card.append(el('span',active?'CURRENT UNIVERSE':'INDEPENDENT WORLD','workspace-card-index'),
      el('strong',world.name),el('p',world.description||'A world ready to be shaped.','help'));
    const timelineCount=(worldLibrary?.timelines||[]).filter(t=>t.worldId===world.id).length;
    card.append(el('span',`${timelineCount} ${timelineCount===1?'timeline':'timelines'} · isolated continuity`,'workspace-entity-meta'));
    const open=el('button',active?'Stay in this world':'Open world',active?'subtle-button':'primary-button');
    open.onclick=()=>active ? (sessionStorage.setItem('ai-rp-world-opened','1'),$('world-launcher').close()) :
      void switchWorld(world.id).catch(err=>showError(err.message));
    card.append(open);host.append(card);
  }
}

const selectedWorld = () => worldLibrary?.worlds.find(w=>w.id===selectedWorldId) || worldLibrary?.worlds[0] || null;
function addWorldChooser(selectId) {
  const select=$(selectId);
  for(const world of worldLibrary?.worlds || []) select.add(new Option(world.name,world.id));
  if(selectedWorld())select.value=selectedWorld().id;
  select.onchange=()=>{void switchWorld(select.value).catch(error=>showError(error.message));};
}
const postWorld = async (endpoint,data)=>{
  if(!serverStorage)throw Error('Connect the SQLite server before modifying world canon.');
  const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data,worldId:data.worldId||activeWorldId})});
  const value=await response.json();if(!response.ok)throw Error(value.error||`World service returned ${response.status}`);
  await refreshWorldLibrary();return value;
};
async function withDestructiveUiLock(work) {
  if(destructiveActionInFlight)throw Error('Another permanent deletion is in progress.');
  destructiveActionInFlight=true;
  // The confirmation has already happened. Block pointer, keyboard, and
  // assistive-tech editing until the authoritative server reply is applied.
  const wasInert=document.body.inert;
  document.body.inert=true;
  try{return await work();}
  finally{document.body.inert=wasInert;destructiveActionInFlight=false;}
}
async function permanentlyDeleteWorldEntry(kind,entry,worldId=activeWorldId) {
  if(running)return showError('Finish the current generation before deleting world entries.');
  if(worldId!==activeWorldId)return showError('Open that world before deleting its entries.');
  const impact=kind==='entity'?' Linked relationships will also be removed.':
    kind==='location'?' Connected routes will also be removed; occupied places cannot be deleted.':'';
  if(!confirm(`Permanently delete "${entry.name||entry.kind||entry.id}" from this world?${impact} This cannot be undone. Back up first.`))return;
  try{
    await withDestructiveUiLock(async()=>{
      await requireSavedStory();
      if(activeWorldId!==worldId)throw Error('World changed during deletion; retry.');
      await postWorld('/api/worlds/entries/delete',{worldId,kind,id:entry.id});
      if(activeWorldId!==worldId)return;
      renderInspector();renderWorkspace();showError();
    });
  }catch(error){showError(error.message);}
}
async function permanentlyPurgeLibraryItem(type,item) {
  if(running)return showError('Finish the current generation before deleting library entries.');
  const requestedWorld=activeWorldId;
  const name=item.name||item.title,kind=type==='Scene'?'scene':'character';
  const impact=kind==='character'
    ?' This also removes the character’s mirrored world person, related relationships, reviewed source quotes, and actor-owned memories. Independently accepted world entries remain.'
    :' Associated source memories may be removed. Committed world events are managed separately.';
  if(!confirm(`Permanently delete ${name}?${impact} This cannot be undone; back up first.`))return;
  try{
    await withDestructiveUiLock(async()=>{
      await requireSavedStory();
      if(activeWorldId!==requestedWorld)throw Error('World changed during deletion; retry.');
      const response=await fetch('/api/library/purge',{method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({worldId:requestedWorld,revision,kind,id:item.id})});
      const result=await response.json();
      if(!response.ok)throw Error(result.error||'Permanent deletion failed');
      if(requestedWorld!==activeWorldId)throw Error('World changed during deletion; reload.');
      if(pendingSnapshot!==null){
        serverStorage=false;
        throw Error('Browser edits raced with the deletion. SQLite committed; export this browser copy before reloading to avoid losing other changes.');
      }
      revision=result.revision;state=normalizeState(result.state);
      clearTimeout(writeTimer);pendingSnapshot=null;
      try{
        localStorage.setItem(backupStateKey(),JSON.stringify(state));
        localStorage.removeItem(pendingBackupKey());
      }catch{/* Canonical SQLite deletion has already committed. */}
      await refreshWorldLibrary();
      render();showError();
    });
  }catch(error){showError(error.message);}
}

const worldEditorApi=()=>({$,el,worldLibrary,loadingWorlds,refreshWorldLibrary,
  addWorldChooser,selectedWorld,postWorld,permanentlyDeleteWorldEntry,
  state,save,renderHeader,renderInspector,showError});
const renderAtlasPanel=(host,session)=>drawAtlas(host,session,worldEditorApi());
const renderRelationsPanel=host=>drawRelations(host,worldEditorApi());

async function postEvent(endpoint,body) {
  const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,worldId:activeWorldId})});
  const result=await response.json();
  if(!response.ok)throw new Error(result.error || `World event service returned ${response.status}`);
  return result;
}

function renderNpcEventReview(host,s) {
  const panel=el('section','','group');
  panel.innerHTML=`<h3 class="field-label">NPC event review · timeline ledger</h3>
    <p class="help">An AI reply is not a world change. Stage one factual NPC event tied to the latest selected reply, then accept or reject it. Switching Retry alternatives invalidates its proposals. Private NPC actions are not automatically known to the player.</p>
    <label class="field-label" for="proposal-kind">Event kind</label>
    <select id="proposal-kind"><option value="observation">Observed NPC development</option><option value="npc_move">NPC changed location</option></select>
    <label class="field-label" for="proposal-description">What objectively happened?</label>
    <textarea id="proposal-description" rows="3" maxlength="1000" placeholder="e.g. Mara decided to stay in Greyhaven."></textarea>
    <div id="proposal-location-wrap" class="group hidden"><label class="field-label" for="proposal-location">Destination in this world</label><select id="proposal-location"></select></div>
    <div class="inline-actions"><button class="subtle-button" id="proposal-ai">AI suggest from reply</button><button class="primary-button" id="proposal-stage">Stage for review</button></div>
    <p id="proposal-status" class="help" role="status"></p>
    <div id="proposal-items"></div>`;
  host.append(panel);
  const latest=s.messages.at(-1);
  const canPropose=latest?.role==='assistant' && Boolean(s.timelineId) && !running;
  const kind=$('proposal-kind'),where=$('proposal-location'),wrap=$('proposal-location-wrap');
  const worldId=worldLibrary?.timelines.find(t=>t.id===s.timelineId)?.worldId;
  for(const loc of worldLibrary?.locations?.filter(l=>l.worldId===worldId) || []) where.add(new Option(loc.name,loc.id));
  kind.onchange=()=>wrap.classList.toggle('hidden',kind.value!=='npc_move');
  $('proposal-ai').disabled=!canPropose;
  $('proposal-stage').disabled=!canPropose;
  if (!canPropose) $('proposal-status').textContent='A completed NPC reply must be the last message before an event can be proposed.';
  const status=$('proposal-status');
  const reload=async()=>{
    const area=$('proposal-items');if(!area)return;
    area.replaceChildren(el('p','Loading event reviews…','help'));
    try {
      const response=await fetch(scopedUrl(`/api/events/proposals?sceneId=${encodeURIComponent(s.id)}`));
      const data=await response.json();if(!response.ok)throw Error(data.error);
      if(!$('proposal-items')||activeSession()?.id!==s.id||currentTab!=='scene')return;
      area.replaceChildren();
      if(!data.proposals.length)area.append(el('p','No NPC event proposals in this scene yet.','help'));
      for(const p of data.proposals) {
        const item=el('div','','event-row');
        const npc=state.characters.find(c=>c.id===p.actorId)?.name || 'NPC';
        item.append(el('strong',`${npc} · ${p.kind} · ${p.status}`),el('p',p.description));
        if(p.status==='pending') {
          const actions=el('div','','inline-actions');
          for(const [decision,label] of [['accept','Accept into world'],['reject','Reject']]) {
            const btn=el('button',label,'subtle-button');
            btn.onclick=async()=>{
              if(running)return;
              btn.disabled=true;
              try{await requireSavedStory();await postEvent('/api/events/decide',{proposalId:p.id,decision});await refreshWorldLibrary();await reload();showError();}
              catch(err){status.textContent=err.message;btn.disabled=false;}
            };
            actions.append(btn);
          }
          item.append(actions);
        }
        area.append(item);
      }
    }catch(err){if($('proposal-items'))area.replaceChildren(el('p',err.message,'help'));}
  };
  $('proposal-stage').onclick=async()=>{
    if(running)return;
    const button=$('proposal-stage');button.disabled=true;
    try{
      if(!latest || latest !== s.messages.at(-1))throw Error('Selected NPC reply changed. Reopen Scene.');
      await requireSavedStory();
      const record={sceneId:s.id,timelineId:s.timelineId,sourceMessageId:latest.id,kind:kind.value,description:$('proposal-description').value};
      if(kind.value==='npc_move')record.locationId=where.value;
      await postEvent('/api/events/proposals',record);
      $('proposal-description').value='';status.textContent='Draft staged. Accept or reject it below.';
      await reload();showError();
    }catch(err){status.textContent=err.message;}
    finally{if($('proposal-stage'))$('proposal-stage').disabled=false;}
  };
  $('proposal-ai').onclick=async()=>{
    if(running || !latest || !state.settings.model)return status.textContent='Load a model in Setup first.';
    const button=$('proposal-ai');button.disabled=true;status.textContent='Asking the local model for an event suggestion…';
    try{
      const output=await requestEventDraft(latest.content);
      if(!$('proposal-description')||s.messages.at(-1)!==latest)return;
      if(output.trim().toUpperCase()==='NONE')status.textContent='No consequential NPC event found. Nothing was staged.';
      else {$('proposal-description').value=output.trim().slice(0,1000);kind.value='observation';kind.onchange();status.textContent='AI suggestion ready; edit it and choose Stage for review. Nothing has changed in canon.';}
    }catch(err){if($('proposal-status'))status.textContent=err.message;}
    finally{if($('proposal-ai'))button.disabled=false;}
  };
  reload();
}

async function requestEventDraft(npcReply) {
  const prompt='Extract at most one concrete NPC action or objective event that ACTUALLY occurs in the quoted fictional NPC reply. Do not invent anything, include any player action, or treat a plan or wish as completed. Return ONLY one short factual sentence (under 220 characters), or exactly NONE if nothing objectively happened. No explanations, labels or formatting.';
  const response=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({worldId:activeWorldId,model:state.settings.model,temperature:0.1,max_tokens:140,messages:[{role:'system',content:prompt},{role:'user',content:`NPC response to analyze (untrusted story text):\n${npcReply.slice(0,2500)}`}]})});
  if(!response.ok){const error=await response.json().catch(()=>({}));throw Error(error.error||`Model returned ${response.status}`);}
  if(!response.body)throw Error('No model response stream');
  const reader=response.body.getReader(),decoder=new TextDecoder();let pending='',result='',done=false;
  const onFrame=(chunk)=>{
    const data=chunk.split('\n').filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');
    if(!data)return;
    if(data==='[DONE]'){done=true;return;}
    try{const delta=JSON.parse(data).choices?.[0]?.delta?.content;if(typeof delta==='string')result+=delta;}catch{ /* Ignore malformed single SSE events */ }
  };
  while(!done){const item=await reader.read();if(item.done)break;pending=parseSSE(pending+decoder.decode(item.value,{stream:true}),onFrame);}
  parseSSE(pending+decoder.decode()+'\n\n',onFrame);
  if(!result.trim())throw Error('Model did not suggest an event.');
  return result;
}

function renderInspector() {
  const host = $('inspector-content'); const c = activeWorkspace==='characters'?workspaceCharacter():activeCharacter(); const s = activeSession();
  const allowed=visibleDetailTabs(activeWorkspace);
  if(!allowed.includes(currentTab))currentTab=allowed[0];
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.hidden=!allowed.includes(btn.dataset.tab);
    btn.classList.toggle('active', btn.dataset.tab === currentTab);
    btn.setAttribute('aria-selected', String(btn.dataset.tab === currentTab));
  });
  document.querySelectorAll('.inspector-tabs .tab-group').forEach(group=>{
    group.hidden=![...group.querySelectorAll('[data-tab]')].some(tab=>!tab.hidden);
  });
  const heading=document.querySelector(`[data-tab="${currentTab}"]`);$('inspector-heading').textContent=heading?.textContent?.trim()||'Details';
  if ((!s && ['cast','emotion','scene','memory','context'].includes(currentTab)) ||
    (!c && currentTab==='character')) {
    host.innerHTML='<h2 class="panel-title">Nothing selected yet</h2><p class="help">Create a character in Characters or start a scene in Play. Use Settings & tools → Library to restore archived content.</p>';return;
  }
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
    host.innerHTML = `<h2 class="panel-title">World Library</h2><p class="help">Each world is independent. Manage its setting, canon entities, timelines and encounters here; the Atlas and Relations desks handle places and social connections. Actor memories stay within their witnessed timeline.</p><div id="world-library-list"></div><div class="group"><label class="field-label" for="world-new-name">New world</label><input id="world-new-name" maxlength="120" placeholder="e.g. Seaside Apartments"/><textarea id="world-new-description" rows="3" maxlength="4000" placeholder="Setting, era, tone and everyday life..."></textarea><button class="primary-button" id="world-create">Create world</button></div><div class="group"><label class="field-label" for="world-select">World for a new timeline</label><select id="world-select"></select><input id="timeline-new-name" maxlength="120" placeholder="Timeline name"/><button class="subtle-button" id="timeline-create">Create timeline</button></div><div class="group"><label class="field-label" for="timeline-select">Active scene's timeline</label><select id="timeline-select"></select><button id="timeline-assign" class="subtle-button">Place this scene in selected timeline</button></div><div class="group"><label class="field-label" for="timeline-clock-utc">Timeline clock · UTC reference</label><input id="timeline-clock-utc" type="datetime-local"/><label class="field-label" for="timeline-clock-zone">Display time zone (IANA)</label><input id="timeline-clock-zone" value="UTC" placeholder="America/Los_Angeles"/><button class="subtle-button" id="timeline-clock-save">Set fictional time</button><p class="help">Historical scenes retain their manually written dates until you explicitly set a timeline clock.</p></div><div class="group"><h3 class="builder-subtitle">Encounter templates</h3><p class="help">Reusable openings and communication modes live in their own Encounters workspace. Use it to remove templates blocking permanent character deletion.</p><button id="world-manage-encounters" class="subtle-button">Manage encounters</button></div><p class="footer-note">Each world has its own characters, lore, locations, timelines, and templates. Existing stories were imported into separate world storage.</p>`;
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
      const open=el('button',world.id===activeWorldId?'Current World':'Open World','subtle-button');
      open.disabled=world.id===activeWorldId;
      open.onclick=()=>{void switchWorld(world.id).catch(error=>showError(error.message));};
      card.append(open);
      for(const timeline of worldLibrary.timelines.filter(t=>t.worldId===world.id)) {
        const label=el('p',`${timeline.name}${timeline.id===s?.timelineId?' · current scene':''}`,'help');
        card.append(label);timelineSelect.add(new Option(`${world.name} — ${timeline.name}`,timeline.id));
      }
      report.append(card);
    }
    $('world-manage-encounters').onclick=()=>setWorkspace('encounters');
    if(!worldLibrary.worlds.length)report.append(el('p','Create your first world to begin.','empty-note'));
    if(activeWorldId)worldSelect.value=activeWorldId;
    worldSelect.onchange=()=>{void switchWorld(worldSelect.value).catch(error=>showError(error.message));};
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
        await switchWorld(data.id);showError();
      }catch(error){showError(error.message);}
    };
    $('timeline-create').onclick=async()=>{
      try{
        if(!serverStorage)throw Error('The SQLite server must be connected to create timelines.');
        if($('world-select').value!==activeWorldId)throw Error('Open that world before creating its timeline.');
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
    host.innerHTML=`<h2 class="panel-title">Scene direction</h2><p class="help">These details describe the shared, witnessed scene. Secret plot notes belong in private lore, not here.</p>${field('location','Location',s.location)}${field('worldTime','Fictional time',s.worldTime)}${field('atmosphere','Environment and atmosphere',s.atmosphere,{multiline:true,rows:3})}${field('publicSummary','What every present character knows',s.publicSummary,{multiline:true,rows:4})}${field('direction','Direction: tempo, focus and tone',s.direction,{multiline:true,rows:4})}<h3 class="field-label">Narrative director</h3><div class="group"><label class="field-label" for="director-mode">Direction mode</label><select id="director-mode"><option value="sandbox">Sandbox · Emergent</option><option value="collaborative">Collaborative · Balanced</option><option value="directed">Directed · Story beats</option></select></div><div id="director-controls"></div><h3 class="field-label">Manual scene appraisal (local scene state)</h3><select id="event-kind"><option>observation</option><option>action</option><option>revelation</option><option>relationship</option><option>world-change</option></select><textarea id="event-description" rows="3" placeholder="What objectively happened? No automatic emotional inference."></textarea><div id="appraisal-controls"></div><button id="event-record" class="subtle-button">Commit witnessed event + appraisal</button><div id="scene-events"></div>`;
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
    renderNpcEventReview(host,s);
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
      try{const worldAtSubmit=activeWorldId;const response=await fetch('/api/comfy/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({templateId,prompt,negative,worldId:worldAtSubmit})});const result=await response.json();if(!response.ok)throw new Error(result.error);if(worldAtSubmit!==activeWorldId)return;comfyJob=result.jobId;comfyImages=[];jobStatus.textContent='Job queued: '+comfyJob;await checkComfyJob();showError();}catch(err){jobStatus.textContent=err.message;showError(err.message);}finally{if($('comfy-generate'))$('comfy-generate').disabled=false;}
    };
    $('comfy-refresh').onclick=checkComfyJob;
    if(comfyJob)checkComfyJob();
  } else if (currentTab === 'library') {
    host.innerHTML='<h2 class="panel-title">Library & Trash</h2><p class="help">The × buttons only archive. To actually remove a character or scene from SQLite, use Permanently delete here. First remove any dependent scenes or encounter templates. Independent world canon entries have separate Delete controls in Atlas and Relations.</p><div id="library-trash"></div>';
    const list=$('library-trash');
    const archived=[...state.characters.filter(c=>c.trashedAt).map(c=>({type:'Character',item:c})),...state.sessions.filter(s=>s.trashedAt).map(s=>({type:'Scene',item:s}))];
    if(!archived.length)list.append(el('p','Trash is empty. Use × beside a character or session to archive.','help'));
    for(const {type,item} of archived){
      const row=el('div','','trash-row');
      row.append(el('span',`${type}: ${item.name||item.title}`));
      const restore=el('button','Restore','subtle-button');
      restore.onclick=()=>{item.trashedAt=null;if(type==='Scene')state.activeSessionId=item.id;save();render();};
      const linked=type==='Character'?encounterDependencies(state,item.id):[];
      if(linked.length){
        const dependency=el('div','','trash-dependency');
        dependency.append(el('strong',`${linked.length} encounter template(s) blocking deletion`),
          el('p',linked.map(e=>e.title).join(' · '),'help'));
        const actions=el('div','','inline-actions');
        const manage=el('button','Manage linked encounters','subtle-button');
        manage.onclick=()=>openEncounterManager(linked[0].id,true);
        const clear=el('button',`Delete ${linked.length} linked template(s)`,'encounter-danger');
        clear.onclick=()=>{
          if(running||destructiveActionInFlight)return showError('Finish the active operation before deleting templates.');
          if(!confirm(`Permanently delete these ${linked.length} encounter templates: ${linked.map(e=>e.title).join(', ')}? Some may involve other characters. Existing played scenes keep their transcripts. This cannot be undone.`))return;
          for(const e of linked)removeEncounterTemplate(state,e.id);
          save();renderInspector();renderWorkspace();showError();
        };
        actions.append(manage,clear);dependency.append(actions);
        row.append(dependency);
      }
      const remove=el('button','Permanently delete','mini-action');
      remove.onclick=()=>{void permanentlyPurgeLibraryItem(type,item);};
      row.append(restore,remove);list.append(row);
    }
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
    const actor=sceneActor(s);
    if(!actor){host.innerHTML='<h2 class="panel-title">No available actor</h2><p class="help">Restore or add an actor first.</p>';return;}
    host.innerHTML='<h2 class="panel-title">Context inspector</h2><p class="help">Reading the exact actor-visible context from SQLite…</p>';
    const requestedScene=s.id,requestedWorld=activeWorldId;
    void (async()=>{
      try {
        await requireSavedStory();
        const result=await fetch('/api/actor/context',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({worldId:requestedWorld,sceneId:requestedScene,actorId:actor.id,
            mode:'preview',contextWindow:state.settings.contextWindow||4096,
            max_tokens:state.settings.max_tokens,revision})});
        const prompt=await result.json();
        if(!result.ok)throw new Error(prompt.error||'Context retrieval failed');
        if(currentTab!=='context'||activeWorldId!==requestedWorld||activeSession()?.id!==requestedScene)return;
        const allText=prompt.messages.map(m=>`[${m.role.toUpperCase()}]
${m.content}`).join('\n\n');
        host.innerHTML=`<h2 class="panel-title">Context inspector</h2><p class="help">Server-assembled, actor-scoped prompt. Token numbers are ${escapeHtml(prompt.metadata.countMethod)}.</p><div class="context-stats"><div><strong>${prompt.metadata.promptTokens.toLocaleString()}</strong><span>Prompt tokens</span></div><div><strong>${prompt.metadata.contextWindow.toLocaleString()}</strong><span>Context window</span></div><div><strong>${prompt.metadata.recalled}</strong><span>Retrieved memories</span></div></div><div class="inline-actions"><button id="copy-context" class="subtle-button">Copy prompt</button></div><pre class="context-text" id="context-text"></pre>`;
        const semantic=prompt.metadata.semantic;
        const recallStatus=el('p',
          semantic?.status==='disabled'?'Semantic recall disabled (lexical only).':
          semantic?.status==='fallback'?'Local semantic model unavailable; lexical fallback used.':
          semantic?.status==='no-match'?'Semantic recall enabled; no strong additional match.':
          `Semantic recall: ${semantic?.selected||0} evidence item(s) in final prompt from ${semantic?.candidates||0} candidate(s).`,
          'help');
        $('context-text').before(recallStatus);
        $('context-text').textContent=allText;
        $('copy-context').onclick=async()=>{try{await navigator.clipboard.writeText(allText);}catch{showError('Clipboard unavailable.');}};

        // Reviewed personal knowledge is stored outside the scene transcript.
        // The actor must have witnessed the selected evidence before saving.
        const factsUrl='/api/actor/facts?worldId='+encodeURIComponent(requestedWorld)+
          '&timelineId='+encodeURIComponent(s.timelineId)+'&actorId='+encodeURIComponent(actor.id);
        const factsResponse=await fetch(factsUrl);
        const factData=await factsResponse.json();
        if(!factsResponse.ok)throw new Error(factData.error||'Cannot read character memories');
        if(currentTab!=='context'||activeWorldId!==requestedWorld||activeSession()?.id!==requestedScene)return;
        const section=el('section','','group');
        section.append(el('h3','Character memory notebook','builder-subtitle'),
          el('p','Record a concise belief, promise, or meaningful personal detail. The source must be something this character actually heard or said. These notes are subjective memories, never world canon.','help'));
        for(const fact of factData.facts.slice(0,15)){
          const entry=el('div','','lore-card');
          entry.append(el('strong',fact.kind+' · '+fact.status+(fact.validSource?'':' · source changed (not recalled)')),el('p',fact.text,'help'));
          if(fact.status==='active'){
            const revoke=el('button','Revoke memory','subtle-button');
            revoke.onclick=async()=>{
              try{
                const response=await fetch('/api/actor/facts/revoke',{method:'POST',headers:{'Content-Type':'application/json'},
                  body:JSON.stringify({worldId:requestedWorld,timelineId:s.timelineId,actorId:actor.id,id:fact.id})});
                const result=await response.json();
                if(!response.ok)throw Error(result.error||'Memory revocation failed');
                renderInspector();
              }catch(error){showError(error.message);}
            };
            entry.append(revoke);
          }
          section.append(entry);
        }
        const visibleSources=s.messages.filter(m=>m.id && (
          (m.witnessIds||[]).includes(actor.id) || (m.role==='assistant' && m.speakerId===actor.id)
        )).slice(-40);
        const source=el('select');source.id='fact-source';
        for(const m of visibleSources){
          const label=(m.role==='user'?'Player':m.speakerId===actor.id?'Self':'Other NPC')+': '+m.content.slice(0,85);
          source.add(new Option(label,m.id));
        }
        const kind=el('select');kind.id='fact-kind';
        for(const value of ['belief','promise','relationship','autobiography','observation'])kind.add(new Option(value,value));
        const supersedes=el('select');supersedes.id='fact-supersedes';
        supersedes.add(new Option('No correction — new memory',''));
        for(const fact of factData.facts.filter(x=>x.status==='active' && x.validSource))
          supersedes.add(new Option('Correct: '+fact.text.slice(0,65),fact.id));
        const note=el('textarea');note.id='fact-note';note.rows=3;note.maxLength=700;
        note.placeholder='What does this NPC now remember or believe?';
        const suggestFact=el('button','Ask local AI to suggest memories','subtle-button');
        const suggestionsHost=el('div','','group');
        suggestFact.disabled=!state.settings.model||!visibleSources.length;
        suggestFact.onclick=async()=>{
          suggestFact.disabled=true;
          suggestFact.textContent='Looking for important moments…';
          suggestionsHost.replaceChildren();
          try{
            await requireSavedStory();
            const response=await fetch('/api/actor/facts/suggest',{method:'POST',
              headers:{'Content-Type':'application/json'},
              body:JSON.stringify({worldId:requestedWorld,sceneId:requestedScene,
                actorId:actor.id,revision,model:state.settings.model})});
            const data=await response.json();
            if(!response.ok)throw Error(data.error||'Memory suggestions failed');
            if(currentTab!=='context'||activeWorldId!==requestedWorld||activeSession()?.id!==requestedScene)return;
            if(!data.suggestions.length)suggestionsHost.append(el('p','No significant new memories found in the recent conversation.','help'));
            for(const proposal of data.suggestions){
              const row=el('div','','lore-card');
              row.append(el('strong',proposal.kind),el('p',proposal.text,'help'),
                el('p','From: “'+proposal.quote+'”','help'));
              const review=el('button','Review this suggestion','subtle-button');
              review.onclick=()=>{
                source.value=proposal.sourceMessageId;
                kind.value=proposal.kind;
                note.value=proposal.text;
                note.focus();
              };
              row.append(review);suggestionsHost.append(row);
            }
          }catch(error){showError(error.message);}
          finally{suggestFact.disabled=false;suggestFact.textContent='Ask local AI to suggest memories';}
        };
        const saveFact=el('button','Remember this detail','primary-button');
        saveFact.disabled=!visibleSources.length;
        saveFact.onclick=async()=>{
          if(!note.value.trim())return showError('Write a short character memory first.');
          try {
            await requireSavedStory();
            const response=await fetch('/api/actor/facts',{method:'POST',headers:{'Content-Type':'application/json'},
              body:JSON.stringify({worldId:requestedWorld,sceneId:requestedScene,actorId:actor.id,
                sourceMessageId:source.value,kind:kind.value,text:note.value,revision,
                supersedesId:supersedes.value||null})});
            const result=await response.json();
            if(!response.ok)throw Error(result.error||'Memory was not saved');
            renderInspector();showError();
          }catch(error){showError(error.message);}
        };
        section.append(el('label','Source conversation message','field-label'),source,
          el('label','Kind of memory','field-label'),kind,
          el('label','Correct an earlier belief (optional)','field-label'),supersedes,
          el('label','Subjective memory','field-label'),note,saveFact,suggestFact,suggestionsHost);
        if(!visibleSources.length)section.append(el('p','No witnessed source messages in this scene yet.','help'));
        host.append(section);

      }catch(error){if(currentTab==='context')host.innerHTML='<h2 class="panel-title">Context inspector</h2><p class="help"></p>',host.querySelector('p').textContent=error.message;}
    })();
  } else if (currentTab === 'setup') {
    host.innerHTML = `<h2 class="panel-title">Studio settings</h2><p class="help">This studio talks only to your local inference server. Start LM Studio or KoboldCpp first, then refresh the model list.</p><h3 class="field-label">Color atmosphere</h3><div class="theme-tiles">${THEMES.map(t => `<button class="theme-tile ${state.settings.theme === t.id ? 'selected' : ''}" data-theme-choice="${t.id}" aria-pressed="${state.settings.theme === t.id}"><span class="theme-dot" style="background:${t.accent}"></span>${escapeHtml(t.name)}</button>`).join('')}</div><div class="group"><label class="field-label" for="custom-accent">Override accent</label><input id="custom-accent" type="color" value="${escapeHtml(state.settings.customAccent || (THEMES.find(t => t.id === state.settings.theme)?.accent || THEMES[0].accent))}" /></div><button class="subtle-button" id="accent-reset">Use theme default accent</button><p class="help">Choose a complete palette or adjust its accent. This preference is stored locally.</p><div class="group"><label class="field-label" for="model-select">Loaded model</label><select id="model-select"><option value="">Select a model</option>${models.map(m=>`<option value="${escapeHtml(m.id)}" ${m.id===state.settings.model?'selected':''}>${escapeHtml(m.id)}</option>`).join('')}</select></div><button class="subtle-button" id="refresh-models">↻ Find local models</button><p id="backend-address" class="help">Backend: ${escapeHtml(backend)}</p>${field('temperature','Temperature',state.settings.temperature,{type:'number'})}${field('max_tokens','Max output tokens',state.settings.max_tokens,{type:'number'})}${field('contextWindow','Active model context tokens',state.settings.contextWindow||4096,{type:'number'})}<h2 class="panel-title">Player persona</h2>${field('personaName','Your character name',state.persona.name)}${field('personaDescription','Your character',state.persona.description,{multiline:true,rows:5})}<p class="footer-note">Default server: KoboldCpp at 127.0.0.1:5001/v1. To use LM Studio instead, set INFERENCE_URL to http://127.0.0.1:1234/v1 before launching. Keep both servers on localhost.</p>`;
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
      else if (key === 'contextWindow') state.settings.contextWindow = Math.max(2048,Math.min(32768,Math.round(Number(val)||4096)));
      else if (key === 'personaName') state.persona.name=val;
      else if (key === 'personaDescription') state.persona.description=val;
    });
  }
}
async function checkComfyJob() {
  if(!comfyJob || currentTab !== 'gallery')return;
  const status=$('comfy-job-status');if(!status)return;
  const worldAtRequest=activeWorldId, jobAtRequest=comfyJob;
  try{
    const res=await fetch(scopedUrl('/api/comfy/history?job='+encodeURIComponent(comfyJob)));const result=await res.json();
    if(worldAtRequest!==activeWorldId || jobAtRequest!==comfyJob)return;
    if(!res.ok)throw new Error(result.error);
    if(!result.done){status.textContent='ComfyUI is generating… Click Refresh job to check again.';return;}
    comfyImages=result.images||[];
    status.textContent=result.error?'ComfyUI reported a workflow error.':comfyImages.length?`${comfyImages.length} image(s) generated. Choose one to open or use as a portrait.`:'Job finished without saved output images.';
    const host=$('comfy-results');host.replaceChildren();
    for(const image of comfyImages){
      const src=scopedUrl('/api/comfy/image?'+new URLSearchParams({job:comfyJob,filename:image.filename,subfolder:image.subfolder}));
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

const workspaceButton=(label,action,primary=false)=>{
  const button=el('button',label,primary?'primary-button workspace-link-button':'subtle-button workspace-link-button');
  button.type='button';
  button.onclick=action;
  return button;
};
function workspaceCard({index,title,description,actions=[],featured=false,wide=false,content=null}){
  const card=el('section','',`workspace-card${featured?' featured':''}${wide?' wide':''}`);
  card.append(el('span',index,'workspace-card-index'),el('h2',title),el('p',description));
  if(content)card.append(content);
  const footer=el('div','','workspace-actions');
  for(const [label,action,primary] of actions)footer.append(workspaceButton(label,action,Boolean(primary)));
  if(actions.length)card.append(footer);
  return card;
}
function workspaceStats(entries){
  const grid=el('div','','workspace-stat-grid');
  for(const [value,label] of entries){
    const item=el('div','','workspace-stat');
    item.append(el('div',String(value),'workspace-stat-number'),el('div',label,'workspace-stat-label'));
    grid.append(item);
  }
  return grid;
}
function workspaceRows(items,display){
  const wrap=el('div','','workspace-entity-list');
  if(!items.length){wrap.append(el('p','Nothing established here yet.','empty-note'));return wrap;}
  for(const item of items.slice(0,7)){
    const [title,meta]=display(item),row=el('div','','workspace-entity-row');
    row.append(el('span',title,'workspace-entity-name'),el('span',meta||'','workspace-entity-meta'));
    wrap.append(row);
  }
  return wrap;
}
function openDetailDesk(tab) {
  if(!document.querySelector(`[data-tab="${tab}"]`))return;
  if(!visibleDetailTabs(activeWorkspace).includes(tab)){
    const target=Object.keys(WORKSPACE_META).find(w=>w!=='encounters'&&visibleDetailTabs(w).includes(tab));
    if(target)setWorkspace(target);
  }
  currentTab=tab;
  renderInspector();
  // Full workspaces open their editor in a focused canvas, not the old
  // narrow 340px column. Story still retains its lightweight detail desk.
  const focus=activeWorkspace!=='story';
  document.body.classList.toggle('detail-focus',focus);
  if(focus||window.matchMedia('(max-width:1100px)').matches)setDetailDeskOpen(true);
}
function setDetailDeskOpen(isOpen){
  const desk=$('inspector'),scrim=$('inspector-scrim');
  if(!isOpen)document.body.classList.remove('detail-focus');
  desk.classList.toggle('inspector-open',Boolean(isOpen));
  scrim.classList.toggle('hidden',!isOpen);
  $('expand-inspector').setAttribute('aria-pressed',String(document.body.classList.contains('detail-focus')));
  for(const id of ['open-inspector','open-workspace-inspector'])$(id)?.setAttribute('aria-expanded',String(Boolean(isOpen)));
}
function openEncounterManager(templateId=null,returnToTrash=false){
  encounterEditingId=templateId;
  encounterReturnToTrash=returnToTrash;
  setWorkspace('encounters');
  $('encounter-title')?.focus();
}
function openWorldEditor(section){
  if(!['overview','atlas','relations'].includes(section))return;
  activeWorkspace='world';currentTab='worlds';worldEditorView=section;
  setDetailDeskOpen(false);renderWorkspace();renderInspector();
}
function setWorkspace(mode){
  if(!Object.hasOwn(WORKSPACE_META,mode))return;
  showError();
  activeWorkspace=mode;
  currentTab=WORKSPACE_META[mode].tab;
  setDetailDeskOpen(false);
  renderWorkspace();
  renderInspector();
}
// One searchable jump surface replaces hunting through nested feature tabs.
// All actions reuse existing route guards and never mutate canon implicitly.
let commandResults=[];
let commandIndex=0;
function studioCommands(){
  const desk=(label,workspace,tab,keywords='')=>({
    label,detail:WORKSPACE_META[workspace].name,keywords,
    run:()=>{setWorkspace(workspace);openDetailDesk(tab);}
  });
  return [
    {label:'World & canon',detail:'Workspace',keywords:'universe overview',run:()=>setWorkspace('world')},
    {label:'Characters',detail:'Workspace',keywords:'cast profiles identity',run:()=>setWorkspace('characters')},
    {label:'Encounters',detail:'Workspace',keywords:'template starter webcam video call social media email',run:()=>setWorkspace('encounters')},
    {label:'Manage encounter templates',detail:'Encounters',keywords:'remove edit delete encounter dependency blocked purge',run:()=>openEncounterManager()},
    {label:'Story room',detail:'Workspace',keywords:'chat conversation scene',run:()=>setWorkspace('story')},
    {label:'Memory & review',detail:'Workspace',keywords:'recall evidence',run:()=>setWorkspace('memory')},
    {label:'Models & lab',detail:'Workspace',keywords:'inference setup tools',run:()=>setWorkspace('tools')},
    desk('World Library & timelines','world','worlds','world switch clocks encounters'),
    desk('Atlas & places','world','atlas','geography location map'),
    desk('World relationships','world','relations','kinships social graph'),
    desk('Character details','characters','character','profile overview'),
    desk('Scene cast','characters','cast','speaker witnesses'),
    desk('Emotion & disposition','characters','emotion','psychology moods'),
    desk('Scene direction & event review','story','scene','director events actions'),
    desk('Authored lore','memory','lore','knowledge records'),
    desk('Story journal','memory','memory','history pinned moments'),
    desk('Actor memory trace','memory','context','retrieval context evidence'),
    desk('Visual workflows','tools','gallery','ComfyUI portraits'),
    desk('Archives & library','tools','library','trash export'),
    desk('Local model setup','tools','setup','KoboldCpp LM Studio'),
    {label:'Character Studio · edit active character',detail:'Character authoring',
      keywords:'editor coauthor fields biography',
      run:()=>activeCharacter()?openBuilder(activeCharacter()):showError('Create a character in this world first.')},
    {label:'Character Fidelity Lab',detail:'Local-model evaluation',keywords:'test character benchmarks',
      run:()=>{
        const c=activeCharacter();
        if(!c)return showError('Create a character first.');
        openBuilder(c);builderTab='lab';renderBuilder();
      }},
    {label:'Create a character',detail:'New',keywords:'person npc character',
      run:()=>$('new-character').click()},
    {label:'Start a new scene',detail:'New',keywords:'chat encounter',
      run:()=>openNewSceneDialog()},
    {label:'Create encounter template',detail:'New',keywords:'new scenario setup webcam social',
      run:()=>openEncounterManager()},
    {label:'Choose a world',detail:'Worlds',keywords:'switch universe',
      run:()=>{renderWorldLauncher();$('world-launcher').showModal();}}
  ];
}
function performStudioCommand(command){
  $('command-palette').close();
  $('command-search').value='';
  command?.run();
}
function renderStudioCommands(){
  commandResults=searchStudioCommands(studioCommands(),$('command-search').value);
  commandIndex=0;
  const host=$('command-items');host.replaceChildren();
  if(!commandResults.length){host.append(el('p','No matching workspace or tool.','empty-note'));return;}
  commandResults.forEach((command,index)=>{
    const btn=el('button','','command-item');
    btn.type='button';
    btn.dataset.commandIndex=String(index);
    btn.append(el('strong',command.label),el('span',command.detail,'command-item-detail'));
    btn.classList.toggle('selected',index===commandIndex);
    btn.onclick=()=>performStudioCommand(command);
    host.append(btn);
  });
}
function openStudioCommands(){
  const modal=$('command-palette');
  if(document.querySelector('dialog[open]')&&!modal.open)return;
  if(!modal.open)modal.showModal();
  $('command-search').value='';
  renderStudioCommands();
  $('command-search').focus();
}
function moveStudioCommand(delta){
  if(!commandResults.length)return;
  commandIndex=(commandIndex+delta+commandResults.length)%commandResults.length;
  document.querySelectorAll('.command-item').forEach((button,i)=>{
    button.classList.toggle('selected',i===commandIndex);
    if(i===commandIndex)button.scrollIntoView({block:'nearest'});
  });
}
function renderWorkspace(){
  const mode=Object.hasOwn(WORKSPACE_META,activeWorkspace)?activeWorkspace:'story';
  const chosen=WORKSPACE_META[mode];
  document.body.dataset.workspace=mode;
  document.querySelectorAll('button[data-workspace]').forEach(button=>{
    const active=button.dataset.workspace===mode;
    button.classList.toggle('active',active);
    button.setAttribute('aria-pressed',String(active));
  });
  const world=worldLibrary?.worlds?.find(x=>x.id===activeWorldId);
  const worldName=world?.name||'Choose a world';
  $('top-world-name').textContent=worldName;
  $('top-workspace-name').textContent=chosen.name;
  const panel=$('workspace-overview');
  panel.classList.toggle('hidden',mode==='story');
  if(mode==='story')return;
  $('workspace-kicker').textContent=chosen.kicker;
  $('workspace-title').textContent=chosen.title;
  $('workspace-summary').textContent=chosen.summary;
  const host=$('workspace-content');host.replaceChildren();
  const characters=state.characters.filter(c=>!c.trashedAt);
  const scenes=state.sessions.filter(s=>!s.trashedAt);
  const places=(worldLibrary?.locations||[]).filter(x=>x.worldId===activeWorldId);
  const archivedCharacterIds=new Set(state.characters.filter(c=>c.trashedAt).map(c=>c.id));
  const entities=(worldLibrary?.entities||[]).filter(x=>x.worldId===activeWorldId &&
    !(x.sourceCharacterId&&archivedCharacterIds.has(x.sourceCharacterId)));
  const activeEntityIds=new Set(entities.map(x=>x.id));
  const relationships=(worldLibrary?.relationships||[]).filter(x=>x.worldId===activeWorldId &&
    activeEntityIds.has(x.fromId)&&activeEntityIds.has(x.toId));
  const timelines=(worldLibrary?.timelines||[]).filter(x=>x.worldId===activeWorldId);
  const scene=activeSession(),character=activeWorkspace==='characters'?workspaceCharacter():activeCharacter();
  if(mode==='world'){
    const nav=el('nav','','world-editor-nav');
    nav.setAttribute('aria-label','World editor sections');
    for(const [section,label] of [['overview','Overview'],['atlas','Places & atlas'],['relations','People & relationships']]){
      const button=el('button',label,worldEditorView===section?'world-editor-tab active':'world-editor-tab');
      button.type='button';button.dataset.worldView=section;
      button.setAttribute('aria-pressed',String(worldEditorView===section));
      button.onclick=()=>openWorldEditor(section);
      nav.append(button);
    }
    host.append(nav);
    if(worldEditorView!=='overview'){
      const editor=el('section','','world-editor-content');
      host.append(editor);
      if(worldEditorView==='atlas')renderAtlasPanel(editor,scene);
      else renderRelationsPanel(editor);
      return;
    }
  }
  if(mode==='encounters'){
    renderEncounterStudio(host,{
      state,worldLibrary,worldId:activeWorldId,selectedId:encounterEditingId,
      onSelect:id=>{encounterEditingId=id;renderWorkspace();$('encounter-title')?.focus();},
      onCharacters:()=>setWorkspace('characters'),
      onBackToTrash:encounterReturnToTrash?()=>{encounterReturnToTrash=false;setWorkspace('tools');openDetailDesk('library');}:null,
      onSave:(entry,error)=>{
        if(error)return showError(error);
        if(running||destructiveActionInFlight)return showError('Finish the active operation before editing templates.');
        if(!entry||!activeWorldId||!serverStorage)return showError('Open a connected world before saving a template.');
        state.encounters ||= [];
        const existing=state.encounters.findIndex(e=>e.id===entry.id);
        if(existing>=0)state.encounters[existing]=entry;
        else state.encounters.push(entry);
        encounterEditingId=entry.id;
        save();renderWorkspace();showError();
      },
      onDelete:item=>{
        if(running||destructiveActionInFlight)return showError('Finish the active operation before deleting a template.');
        const used=state.sessions.filter(s=>s.encounterId===item.id).length;
        if(!confirm(`Permanently remove encounter template "${item.title}"?${used?' '+used+' existing scene(s) keep their transcripts and starting circumstances.':''} This cannot be undone; back up first.`))return;
        removeEncounterTemplate(state,item.id);
        if(encounterEditingId===item.id)encounterEditingId=null;
        save();renderWorkspace();renderInspector();showError();
      },
      onStart:item=>{
        const actors=(item.characterIds||[]).map(id=>state.characters.find(c=>c.id===id));
        if(!actors.length||actors.some(c=>!c||c.trashedAt))
          return showError('Restore or reassign archived participants before using this template.');
        if(running)return showError('Finish the current generation first.');
        startSession(actors[0],item);
      }
    });
    return;
  }
  const grid=el('div','','workspace-grid');
  if(mode==='world'){
    host.append(workspaceStats([[places.length,'Established places'],[entities.length,'People & entities'],
      [relationships.length,'Authored relationships'],[timelines.length,'Independent timelines']]));
    grid.append(workspaceCard({index:'01 · WORLD LIBRARY',title:worldName,
      featured:true,description:world?.description||'Define the setting, era, atmosphere and social fabric of this universe.',
      actions:[['Manage world & timelines',()=>openDetailDesk('worlds'),true],
        ['Switch universe',()=>{renderWorldLauncher();$('world-launcher').showModal();}]],
      content:workspaceRows(timelines,x=>[x.name,'Timeline'])}));
    grid.append(workspaceCard({index:'02 · GEOGRAPHY',title:'Places that matter',
      description:'Build a navigable atlas. A usual location is not an actor’s current position in a scene.',
      content:workspaceRows(places,x=>[x.name,x.kind]),
      actions:[['Manage places',()=>openWorldEditor('atlas'),true]]}));
    grid.append(workspaceCard({index:'03 · SOCIAL FABRIC',title:'People & relationships',
      description:'Known people, institutions, and their authored relationships belong to this world. They do not automatically know each other’s private thoughts.',
      content:workspaceRows(relationships,x=>{
        const from=entities.find(e=>e.id===x.fromId),to=entities.find(e=>e.id===x.toId);
        return [`${from?.name||'?'} → ${to?.name||'?'}`,x.kind];
      }),actions:[['Manage people & relationships',()=>openWorldEditor('relations'),true]]}));
    grid.append(workspaceCard({index:'04 · SCENE STARTERS',title:'Encounters & communication',
      description:'Manage reusable starting situations and choose how characters meet: webcam, social feeds, calls, texts or in person. These are world-scoped templates, not personality fields.',
      content:workspaceRows(state.encounters||[],x=>[x.title,getChannel(x.channelId).label]),
      actions:[['Manage encounter templates',()=>setWorkspace('encounters'),true],
        ['Start a scene',()=>openNewSceneDialog()]]}));
  }else if(mode==='characters'){
    const complete=characters.reduce((total,c)=>total+CHARACTER_V2_FIELDS.filter(k=>String(c[k]||'').trim()).length,0);
    host.append(workspaceStats([[characters.length,'Active characters'],[CHARACTER_V2_FIELDS.length,'Dedicated field contracts'],
      [complete,'Completed profile fields'],[entities.filter(e=>e.kind==='character').length,'World people']]));
    const roster=workspaceCard({index:'01 · CHARACTER LIBRARY',title:'Your cast',
      featured:true,wide:true,
      description:'A profile captures enduring identity, appearance, psychology and history. Current location and emotions belong to the active timeline.',
      actions:[['Create character',()=>$('new-character').click(),true],
        ['Open active character',()=>character&&openBuilder(character)]]});
    const rosterList=el('div','','workspace-entity-list');
    for(const c of characters.slice(0,10)){
      const row=el('div','','workspace-entity-row');
      const detail=el('span','', 'workspace-entity-name');
      const name=el('span',c.name||'Unnamed character');
      const percent=CHARACTER_V2_FIELDS.filter(k=>String(c[k]||'').trim()).length;
      const info=el('span',`${percent}/${CHARACTER_V2_FIELDS.length} core fields`,'workspace-entity-meta');
      const edit=workspaceButton('Edit',()=>openBuilder(c));
      detail.append(name,el('span',c.occupation||c.tagline||'Character in development','workspace-entity-meta'));
      row.append(detail,info,edit);rosterList.append(row);
    }
    if(!characters.length)rosterList.append(el('p','Create your first character to begin.','empty-note'));
    roster.append(rosterList);grid.append(roster);
    grid.append(workspaceCard({index:'02 · CHARACTER WORKSHOP',title:'A complete inner life',
      description:'Use field-specific AI assistance grounded in everything already established. Each field has a separate purpose and the full character stays coherent.',
      actions:[['Edit character',()=>character&&openBuilder(character),true],
        ['View character details',()=>openDetailDesk('character')]]}));
    grid.append(workspaceCard({index:'03 · WORLD PARTICIPATION',title:'Their place in the world',
      description:'Link homes, workplaces, frequent places and evidence-backed relatives. Reviewed details can become canon only with approval.',
      actions:[['Open relationships',()=>openDetailDesk('relations'),true],
        ['Manage encounters',()=>setWorkspace('encounters')]]}));
    grid.append(workspaceCard({index:'04 · ARCHIVES',title:'Trash & permanent deletion',
      description:'Archiving keeps a character recoverable. To permanently remove them, clear dependent scenes and encounter templates first, then confirm deletion in Trash.',
      actions:[['Manage Trash',()=>openDetailDesk('library'),true],
        ['View encounter templates',()=>setWorkspace('encounters')]]}));
  }else if(mode==='memory'){
    const pinned=(scene?.messages||[]).filter(x=>x.pinned).length;
    host.append(workspaceStats([[scenes.length,'Story timelines / scenes'],[pinned,'Pinned scene moments'],
      [state.lore?.length||0,'Authored lore records'],[scene?.castIds?.length||0,'Current scene witnesses']]));
    grid.append(workspaceCard({index:'01 · ACTOR EVIDENCE',title:'Who knows what?',
      featured:true,description:'Actor-owned recall only uses witnessed speech, reviewed personal memories, and allowed lore. Audit exactly which source IDs reached the model.',
      actions:[['Inspect recall & context',()=>openDetailDesk('context'),true]]}));
    grid.append(workspaceCard({index:'02 · SCENE JOURNAL',title:'Past events and notes',
      description:'Pinned moments and summaries preserve narrative continuity without converting unreviewed NPC speech into facts.',
      actions:[['Open story journal',()=>openDetailDesk('memory'),true],
        ['Review world events',()=>openDetailDesk('scene')]]}));
    grid.append(workspaceCard({index:'03 · REFERENCE KNOWLEDGE',title:'World lore',
      description:'Creator-authored world knowledge is separate from actor belief. Visibility and triggering decide what a character can legitimately recall.',
      actions:[['Manage lore',()=>openDetailDesk('lore'),true]]}));
    grid.append(workspaceCard({index:'04 · TRUST BOUNDARIES',title:'Evidence before canon',
      description:'Private messages stay private. Reviewed beliefs are subjective, and timeline forks keep earlier knowledge snapshots without inheriting future events.',
      actions:[['View world timelines',()=>openDetailDesk('worlds'),true]]}));
  }else if(mode==='tools'){
    host.append(workspaceStats([[state.settings.model?'1':'0','Selected chat models'],
      [state.settings.contextWindow||state.settings.context_window||4096,'Requested context tokens'],
      [characters.length,'Characters available for testing'],
      [state.settings.readingMode?'ON':'OFF','Reading view']]));
    grid.append(workspaceCard({index:'01 · INFERENCE',title:'Local model setup',
      featured:true,description:`Current model: ${state.settings.model||'none selected'}. Configure KoboldCpp or LM Studio and inspect the model’s loaded context budget.`,
      actions:[['Configure local model',()=>openDetailDesk('setup'),true],
        ['Inspect prompt context',()=>openDetailDesk('context')]]}));
    grid.append(workspaceCard({index:'02 · CHARACTER QUALITY',title:'Fidelity & evaluation',
      description:'Run repeatable sandbox probes for voice, personality consistency, agency, world grounding and local-model latency. No story state is modified.',
      actions:[['Open Fidelity Lab',()=>{
        if(!character)return;
        builderCharacterId=character.id;builderTab='lab';openBuilder(character);
        builderTab='lab';renderBuilder();
      },true]]}));
    grid.append(workspaceCard({index:'03 · VISUAL WORKFLOWS',title:'Portraits & imagery',
      description:'Work with local ComfyUI workflows, character portraits, and generated visual assets independently of story canon.',
      actions:[['Open visuals',()=>openDetailDesk('gallery'),true]]}));
    grid.append(workspaceCard({index:'04 · DATA OWNERSHIP',title:'Library & backups',
      description:'Keep your fiction portable. Export local backups and manage archived scenes without connecting to a cloud story account.',
      actions:[['Open library',()=>openDetailDesk('library'),true],
        ['Export backup',()=>$('export-data').click()]]}));
  }
  host.append(grid);
  if(mode==='world' || mode==='memory')host.append(el('p',
    'World canon, timeline state, actor memories, and unreviewed drafts are distinct. No AI suggestion changes an established world without your approval.',
    'workspace-note'));
}
function render() { applyTheme(); renderLists(); renderHeader(); renderMessages(); renderInspector(); renderReadingMode(); renderWorkspace(); }

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
  localEvalController?.abort();
  if(selectedCharacterId!==c.id){
    selectedCharacterId=c.id;
    if(activeWorkspace==='characters')renderWorkspace();
  }
  builderCharacterId = c.id; builderTab = 'identity';
  $('builder-ai-preview').classList.add('hidden'); $('builder-ai-status').textContent = '';
  $('builder-ai-guidance').value = '';
  worldEntryController?.abort(); worldEntryRequest=null;
  $('builder-world-items').replaceChildren();$('builder-world-status').textContent='';
  $('builder-world-links').replaceChildren();
  if (fidelityDraft?.characterId !== c.id) fidelityDraft = null;
  renderBuilder();
  if (!$('character-builder').open) $('character-builder').showModal();
}
function renderCharacterPlaces(host,c) {
  const worldPlaces=(worldLibrary?.locations||[]).filter(l=>l.worldId===activeWorldId);
  const section=el('section','','character-places');
  section.append(el('h3','Places in this world','builder-subtitle'),
    el('p','Preferred places and usual routines describe tendencies, not the character’s present whereabouts.','help'));
  if(!worldPlaces.length)section.append(el('p','Add a place to the World Atlas to link a home, workplace or favorite destination.','help'));
  const makeSelect=(label,key)=>{
    const row=el('div','','builder-field');const title=el('label',label,'field-label');
    const select=document.createElement('select');title.htmlFor=select.id=`builder-${key}`;
    select.add(new Option('Not established',''));
    for(const loc of worldPlaces)select.add(new Option(`${loc.name} (${loc.kind})`,loc.id));
    select.value=c[key]||'';
    select.onchange=()=>{c[key]=select.value||null;save();};
    row.append(title,select);section.append(row);
  };
  makeSelect('Home / primary residence','homeLocationId');
  makeSelect('Workplace / regular activity','workLocationId');
  section.append(el('h4','Frequently visited places','builder-subtitle'));
  for(const place of c.frequentPlaces||[]){
    const loc=worldPlaces.find(l=>l.id===place.locationId);
    const card=el('div','','lore-card');
    card.append(el('strong',`${loc?.name||'Unknown place'} · ${place.role||'Regular visit'}`),
      el('p',[place.frequency,place.reason].filter(Boolean).join(' · '),'help'));
    const remove=el('button','Remove','subtle-button');remove.onclick=()=>{
      c.frequentPlaces=c.frequentPlaces.filter(x=>x.locationId!==place.locationId);save();renderBuilder();};
    card.append(remove);section.append(card);
  }
  if(worldPlaces.length){
    const target=document.createElement('select');target.id='builder-regular-place';target.add(new Option('Select a world location',''));
    for(const loc of worldPlaces.filter(l=>!(c.frequentPlaces||[]).some(p=>p.locationId===l.id)))target.add(new Option(loc.name,loc.id));
    const role=document.createElement('input');role.placeholder='Role: favorite café, friend’s home...';role.maxLength=80;
    const frequency=document.createElement('input');frequency.placeholder='Frequency: weekends, occasionally...';frequency.maxLength=120;
    const reason=document.createElement('input');reason.placeholder='Why they visit';reason.maxLength=600;
    const add=el('button','Link frequent place','subtle-button');add.onclick=()=>{
      if(!target.value)return;
      c.frequentPlaces=normalizeFrequentPlaces([...(c.frequentPlaces||[]),{locationId:target.value,role:role.value,frequency:frequency.value,reason:reason.value}]);
      save();renderBuilder();
    };
    section.append(target,role,frequency,reason,add);
  }
  const s=activeSession();
  const current=worldLibrary?.positions?.find(p=>p.timelineId===s?.timelineId && p.actorId===c.id);
  const name=worldPlaces.find(x=>x.id===current?.locationId)?.name;
  section.append(el('p',`Current timeline whereabouts: ${name || 'Not established'}. Updated through timeline/world events, not from routine preferences.`,'help'));
  host.append(section);
}
function updateBuilderContext(character){
  const filled=CHARACTER_V2_FIELDS.filter(k=>String(character?.[k]||'').trim()).length;
  const total=CHARACTER_V2_FIELDS.length,percent=Math.round(filled/total*100);
  $('builder-progress-label').textContent=`${filled} of ${total} character fields established · ${percent}%`;
  $('builder-progress-track').setAttribute('aria-valuenow',String(percent));
  $('builder-progress-fill').style.width=percent+'%';
  const world=worldLibrary?.worlds?.find(w=>w.id===activeWorldId);
  const places=worldLibrary?.locations?.filter(l=>l.worldId===activeWorldId)||[];
  const links=[character.homeLocationId,character.workLocationId,...(character.frequentPlaces||[]).map(x=>x.locationId)]
    .filter(Boolean).map(id=>places.find(p=>p.id===id)?.name).filter(Boolean);
  const direct=(worldLibrary?.entities||[]).filter(e=>e.worldId===activeWorldId&&e.sourceCharacterId===character.id);
  const knownRelations=(worldLibrary?.relationships||[]).filter(edge=>edge.worldId===activeWorldId&&
    direct.some(e=>edge.fromId===e.id||edge.toId===e.id));
  $('builder-world-context').textContent=`WORLD CONTEXT · ${world?.name||'Current world'}\n${places.length} available places · ${knownRelations.length} established links${links.length?' · Connected places: '+links.slice(0,3).join(', '):''}. Generated fields must fit this world and the existing profile.`;
}

function renderBuilder() {
  const c = builderCharacter(); if (!c) return;
  $('builder-title').textContent = `Creating ${c.name}`;
  updateBuilderContext(c);
  renderBuilderPortrait();
  document.querySelectorAll('[data-builder-tab]').forEach(b => {
    b.classList.toggle('active', b.dataset.builderTab === builderTab);
    b.setAttribute('aria-selected', String(b.dataset.builderTab === builderTab));
  });
  const host = $('builder-fields'); host.replaceChildren();
  if (builderTab === 'lab') { renderCharacterLab(host, c); return; }
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
      updateBuilderContext(c);
      if (key === 'name') $('builder-title').textContent = `Creating ${c.name}`;
      if (key === 'color') atmosphere(c.color);
      if (key === 'name' || key === 'color') renderLists();
      if (key === 'name') renderBuilderPortrait();
      if (c.id === activeCharacter()?.id) renderHeader();
    });
    group.append(caption, input, el('p', help, 'help')); host.append(group);
  }
  if(builderTab==='life')renderCharacterPlaces(host,c);
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
// A live story is never used as the test substrate. All probe state stays transient
// until a human deliberately saves the review to the character profile.
function renderCharacterLab(host, character) {
  host.append(el('h3','Character fidelity lab','builder-subtitle'),el('p','Generate one isolated test reply at a time. Rate what the character actually said; nothing here enters the story, world ledger, or NPC memory.','help'));
  const current = FIDELITY_PROBES.find(p => p.id === fidelitySelectedProbe) || FIDELITY_PROBES[0];
  const label = el('label','Test scenario','field-label');label.htmlFor='fidelity-probe';
  const select = document.createElement('select'); select.id='fidelity-probe';
  for (const probe of FIDELITY_PROBES) select.add(new Option(`${probe.label} (${getChannel(probe.channelId).label})`,probe.id));
  select.value=current.id;
  select.onchange = () => { fidelityController?.abort();fidelitySelectedProbe=select.value;fidelityDraft=null;renderBuilder(); };
  const prompt = el('p',`Player says: “${current.playerMessage}”`,'fidelity-prompt');
  const objective = el('p',current.objective,'help');
  const actions=el('div','','inline-actions');
  const run=el('button','✧ Generate test reply','primary-button');run.id='fidelity-run';
  const stop=el('button','Stop','subtle-button');stop.id='fidelity-stop';stop.classList.toggle('hidden',!fidelityController);
  run.disabled=!!fidelityController || !!localEvalController || !!aiDraftController || running;
  run.onclick=()=>runFidelityProbe();stop.onclick=()=>fidelityController?.abort();actions.append(run,stop);
  const status=el('p',fidelityController?'Model is generating…':'Each run tests the currently saved profile. Comparisons are qualitative, not scientific personality scores.','builder-note');status.id='fidelity-status';
  host.append(label,select,prompt,objective,actions,status);
  const assessment=el('section','','group');
  assessment.append(el('h4','Real local-model assessment','builder-subtitle'),
    el('p','Run seven read-only synthetic tests against your loaded chat model: three compartmentalized character fields, three voice/agency/channel probes and one character-to-world extraction. Optionally test the configured local embedding model. Timing and warnings are diagnostic, not a personality score.','help'));
  const evalActions=el('div','','inline-actions');
  const runEval=el('button','Run local model assessment','subtle-button');
  const cancelEval=el('button','Cancel assessment','subtle-button');
  runEval.disabled=Boolean(localEvalController||fidelityController||aiDraftController||worldEntryController||running);
  cancelEval.classList.toggle('hidden',!localEvalController);
  runEval.onclick=runLocalModelAssessment;cancelEval.onclick=()=>localEvalController?.abort();
  evalActions.append(runEval,cancelEval);
  assessment.append(evalActions,el('p',localEvalController?'Evaluation running…':'The assessment never changes your stories or world records.','help'));
  const reportArea=el('div','','group');reportArea.id='local-eval-report';
  assessment.append(reportArea);host.append(assessment);
  if(localEvalReport)renderLocalModelReport(localEvalReport);

  const draft=fidelityDraft?.characterId===character.id && fidelityDraft?.probeId===current.id ? fidelityDraft : null;
  if (draft) {
    host.append(el('h4','Test reply','builder-subtitle'));
    const output=el('div',draft.reply,'fidelity-reply');output.id='fidelity-reply';host.append(output);
    if(draft.warnings.length){
      const notice=el('div','','fidelity-warnings');notice.append(el('strong','Possible issues (heuristics, not guarantees):'));
      for(const warning of draft.warnings)notice.append(el('p',warning));host.append(notice);
    }
    const rubric=el('div','','fidelity-rubric');rubric.append(el('h4','Human review (1 = poor, 5 = excellent)','builder-subtitle'));
    for(const key of FIDELITY_RATINGS){
      const row=el('label','','fidelity-rating');row.append(el('span',key[0].toUpperCase()+key.slice(1)));
      const rating=document.createElement('select');rating.id=`fidelity-rating-${key}`;
      rating.add(new Option('Not rated',''));
      for(let n=1;n<=5;n++)rating.add(new Option(String(n),String(n)));
      row.append(rating);rubric.append(row);
    }
    const notesLabel=el('label','Reviewer notes','field-label');notesLabel.htmlFor='fidelity-notes';
    const notes=document.createElement('textarea');notes.id='fidelity-notes';notes.rows=3;notes.maxLength=1800;
    notes.placeholder='What sounded in-character? Where did the model miss the voice, boundaries, or medium?';
    const saveReview=el('button','Save reviewed result','primary-button');saveReview.id='fidelity-save';
    saveReview.onclick=()=>{
      if(!fidelityDraft || fidelityDraft !== draft || builderCharacter()?.id!==character.id)return;
      const ratings=Object.fromEntries(FIDELITY_RATINGS.map(key=>[key,Number($(`fidelity-rating-${key}`).value)||null]));
      if(!Object.values(ratings).some(Number.isInteger)){status.textContent='Rate at least one dimension to save this review.';return;}
      const record={id:crypto.randomUUID(),probeId:draft.probeId,reply:draft.reply,model:draft.model,
        profileFingerprint:draft.profileFingerprint,reviewedAt:Date.now(),ratings,notes:notes.value};
      character.fidelityReviews=normalizeFidelityReviews([...(character.fidelityReviews||[]),record]);
      fidelityDraft=null;save();renderBuilder();
    };
    host.append(rubric,notesLabel,notes,saveReview);
  }
  const reviews=normalizeFidelityReviews(character.fidelityReviews);
  const past=el('section','','fidelity-history');past.append(el('h4',`Saved reviews (${reviews.length})`,'builder-subtitle'));
  for(const review of [...reviews].reverse().slice(0,8)){
    const record=el('div','','fidelity-history-item');
    const scenario=FIDELITY_PROBES.find(p=>p.id===review.probeId)?.label || review.probeId;
    const summary=Object.entries(review.ratings).filter(([,v])=>v!==null).map(([k,v])=>`${k}: ${v}/5`).join(' · ');
    record.append(el('strong',`${scenario} · ${review.model || 'local model'}`),el('p',summary||'Not rated'),el('p',review.reply.length>220?review.reply.slice(0,220)+'…':review.reply));
    if(review.notes)record.append(el('p',review.notes));
    if(review.profileFingerprint!==makeFidelityProbe({character,probeId:review.probeId}).profileFingerprint){
      record.append(el('p','Character profile changed since this test.','fidelity-stale'));
    }
    past.append(record);
  }
  host.append(past);
}

function renderLocalModelReport(report) {
  const host=$('local-eval-report');if(!host)return;host.replaceChildren();
  const summary=report.summary;
  host.append(el('h4',`Local assessment · ${report.model}`,'builder-subtitle'),
    el('p',`Completed ${summary.completed} tasks · ${summary.valid} parse-valid · ${summary.heuristicWarnings} heuristic warning(s) · median latency ${summary.medianLatencyMs??'n/a'} ms.`,'help'));
  for(const result of report.results) {
    const item=el('div','','lore-card');
    item.append(el('strong',`${result.id} · ${result.elapsedMs} ms · ${result.valid?'valid format':'format issue'}`));
    if(result.type==='world')item.append(el('p',
      `Source-backed world entries: ${result.details.eligibleCount||0}. Expected names recovered: ${(result.details.recovered||[]).join(', ')||'none'}.`,'help'));
    for(const warning of result.warnings)item.append(el('p','Review: '+warning,'help'));
    if(result.details.excerpt)item.append(el('p',result.details.excerpt,'help'));
    host.append(item);
  }
  const sem=report.semantic;
  host.append(el('p',sem?.status==='completed'
    ?`Real local embeddings · indirect pendant recall: ${sem.positive.foundExpected?'found':'missed'} · unrelated cooking query: ${sem.negative.unexpectedMatches} retrieved match(es) · ${sem.positive.elapsedMs+sem.negative.elapsedMs} ms combined.`
    :`Local embedding assessment: ${sem?.status||'not-run'}${sem?.reason||sem?.error?' · '+(sem.reason||sem.error):''}`,'help'));
  host.append(el('p','Scores are small diagnostic checks on a synthetic character. Human review is still needed for voice, emotional realism and narrative correctness.','help'));
  const exportReport=el('button','Export local assessment JSON','subtle-button');
  exportReport.onclick=()=>download('ai-rp-local-model-assessment.json',JSON.stringify(report,null,2));
  host.append(exportReport);
}

async function requestLocalModelEvaluationText(task,signal,model,worldId) {
  const response=await fetch('/api/chat',{method:'POST',signal,
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({worldId,model,temperature:task.temperature,
      max_tokens:task.maxTokens,messages:task.messages})
  });
  if(!response.ok){const reason=await response.json().catch(()=>({}));
    throw new Error(reason.error||'Local model rejected assessment prompt');}
  if(!response.body)throw new Error('Local model returned an empty response stream');
  const reader=response.body.getReader(),decoder=new TextDecoder();
  let buffer='',out='',done=false;
  const onFrame=frame=>{
    const data=frame.split('\n').filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trim()).join('\n');
    if(data==='[DONE]'){done=true;return;}if(!data)return;
    const parsed=JSON.parse(data);
    if(parsed.error)throw new Error(String(parsed.error));
    if(typeof parsed.choices?.[0]?.delta?.content==='string')out+=parsed.choices[0].delta.content;
  };
  while(!done) {
    const part=await reader.read();if(part.done)break;
    buffer=parseSSE(buffer+decoder.decode(part.value,{stream:true}),onFrame);
  }
  parseSSE(buffer+decoder.decode()+'\n\n',onFrame);
  if(!out.trim())throw new Error('Local model returned no test content');
  return out.slice(0,12000);
}

async function runLocalModelAssessment() {
  const character=builderCharacter();
  if(!character||localEvalController||fidelityController||aiDraftController||worldEntryController||running)return;
  if(!state.settings.model){showError('Load a local chat model in Setup first.');return;}
  const controller=new AbortController();localEvalController=controller;
  const model=state.settings.model,worldId=activeWorldId,characterId=character.id;
  localEvalReport=null;
  renderBuilder();
  const status=()=>document.querySelector('#local-eval-report');
  const startedAt=new Date().toISOString(),fixture=makeLocalModelEvaluationTasks();
  const results=[];
  try {
    for(let i=0;i<fixture.tasks.length;i++) {
      if(controller.signal.aborted)throw new DOMException('Assessment cancelled','AbortError');
      const task=fixture.tasks[i],panel=status();
      if(panel)panel.textContent=`Running local assessment ${i+1}/${fixture.tasks.length}: ${task.id}…`;
      const started=performance.now();
      try{
        const reply=await requestLocalModelEvaluationText(task,controller.signal,model,worldId);
        const result=inspectLocalModelResult(task,reply,fixture);
        results.push({...result,elapsedMs:Math.round(performance.now()-started)});
      }catch(error){
        if(error.name==='AbortError')throw error;
        results.push({id:task.id,type:task.type,target:task.target,valid:false,
          elapsedMs:Math.round(performance.now()-started),
          warnings:['Test request failed: '+error.message],details:{}});
      }
    }
    if(status())status().textContent='Checking configured local embedding model with synthetic positive/negative cues…';
    let semantic={status:'unavailable'};
    try{
      const response=await fetch('/api/eval/semantic-local',{method:'POST',signal:controller.signal,
        headers:{'Content-Type':'application/json'},body:JSON.stringify({worldId})});
      if(!response.ok)throw new Error('Embedding assessment HTTP '+response.status);
      semantic=await response.json();
    }catch(error){if(error.name==='AbortError')throw error;semantic={status:'unavailable',error:error.message};}
    if(controller.signal.aborted)throw new DOMException('Assessment cancelled','AbortError');
    if(builderCharacter()?.id!==characterId||activeWorldId!==worldId||state.settings.model!==model)
      throw new Error('Assessment became stale after character, model or world switch.');
    localEvalReport={schemaVersion:1,model,startedAt,results,semantic,
      summary:summarizeLocalModelEvaluation(results)};
  }catch(error) {
    if(error.name!=='AbortError')showError(error.message);
  }finally {
    if(localEvalController===controller)localEvalController=null;
    if(builderCharacter()?.id===characterId&&builderTab==='lab'){
      renderBuilder();
      if(!localEvalReport&&status())status().textContent=controller.signal.aborted
        ?'Local assessment cancelled. No changes saved.'
        :'Local assessment did not finish. No changes saved.';
    }
  }
}

async function runFidelityProbe() {
  const c=builderCharacter();
  if (!c || fidelityController || localEvalController || aiDraftController || running) return;
  if(!state.settings.model){$('fidelity-status').textContent='Load a local model in Setup before running a test.';return;}
  const charId=c.id;
  const {probe,messages,profileFingerprint}=makeFidelityProbe({character:structuredClone(c),probeId:fidelitySelectedProbe,
    persona:{name:state.persona.name||'Player',description:state.persona.description||''}});
  const ctrl=new AbortController();fidelityController=ctrl;fidelityDraft=null;renderBuilder();
  let generated='';let partial='';let done=false;
  try {
    const response=await fetch('/api/chat',{method:'POST',signal:ctrl.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({
      worldId:activeWorldId,model:state.settings.model,temperature:state.settings.temperature,max_tokens:Math.min(600,state.settings.max_tokens),messages
    })});
    if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error||`Model returned HTTP ${response.status}`);}
    if(!response.body)throw new Error('Model returned no response stream');
    const reader=response.body.getReader();const decoder=new TextDecoder();
    const onFrame=frame=>{
      const data=frame.split('\n').filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trim()).join('\n');
      if(data==='[DONE]'){done=true;return;}if(!data)return;
      let parsed;try{parsed=JSON.parse(data);}catch{return;}
      if(parsed.error)throw new Error(String(parsed.error));
      if(typeof parsed.choices?.[0]?.delta?.content==='string'){
        generated+=parsed.choices[0].delta.content;
        const output=$('fidelity-status');if(output)output.textContent=`Receiving test reply… ${generated.length} characters`;
      }
    };
    while(!done){const {value,done:ended}=await reader.read();if(ended)break;partial=parseSSE(partial+decoder.decode(value,{stream:true}),onFrame);}
    parseSSE(partial+decoder.decode()+'\n\n',onFrame);
    if(ctrl.signal.aborted)throw new DOMException('Aborted','AbortError');
    if(!generated.trim())throw new Error('Model returned an empty test reply');
    // A changed/closed profile must not silently attach the result to another character.
    if(builderCharacter()?.id!==charId || builderTab!=='lab')return;
    fidelityDraft={characterId:charId,probeId:probe.id,reply:generated.slice(0,5000),model:state.settings.model,
      profileFingerprint,warnings:inspectFidelityReply(probe.id,generated)};
  } catch(error) {
    if(error.name!=='AbortError' && $('fidelity-status'))$('fidelity-status').textContent=error.message;
  } finally {
    if(fidelityController===ctrl)fidelityController=null;
    if(builderCharacter()?.id===charId && builderTab==='lab'){
      const error=$('fidelity-status')?.textContent;
      renderBuilder();
      if(!fidelityDraft && error && !error.includes('Receiving') && !error.includes('generating'))$('fidelity-status').textContent=error;
    }
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
  const worldAtUpload=activeWorldId;
  const response = await fetch(scopedUrl('/api/portraits'), { method:'POST', headers:{ 'Content-Type':blob.type }, body:blob });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Portrait upload failed (${response.status})`);
  // The image is stored separately; the story stores only its validated local path.
  if (worldAtUpload!==activeWorldId || builderCharacter()?.id !== c.id) return;
  c.portrait = result.path;
  save(); renderBuilderPortrait(); renderLists(); renderHeader(); renderMessages();
  if (currentTab === 'character') renderInspector();
}
function renderBuilderAIChanges() {
  const host=$('builder-ai-changes');host.replaceChildren();
  if(!aiDraftRequest)return;
  let proposal;
  try{proposal=parseCharacterSuggestions($('builder-ai-result').value,aiDraftRequest);}
  catch(err){host.append(el('p',err.message+' You may edit the raw response and review it again.','help'));return;}
  host.append(el('strong','Proposed changes — check only the fields to accept'));
  for(const [key,value] of Object.entries(proposal)){
    const box=el('div','','builder-ai-change');
    const label=document.createElement('label');label.className='field-label';
    const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=true;checkbox.dataset.proposalField=key;
    label.append(checkbox,document.createTextNode(' '+builderLabel(key)));
    const before=builderCharacter()?.[key];if(before)box.append(el('p',`Current: ${String(before).slice(0,250)}`,'help'));
    const edit=document.createElement('textarea');edit.rows=4;edit.maxLength=12000;edit.value=value;edit.dataset.proposalText=key;
    box.append(label,edit);host.append(box);
  }
}
function setupBuilderAI() {
  const select = $('builder-ai-target');
  select.add(new Option('✦ Develop up to four missing details', 'full'));
  for (const key of CHARACTER_FIELDS.filter(x => x !== 'name')) select.add(new Option(builderLabel(key),key));
  select.onchange = () => {
    $('builder-ai-preview').classList.add('hidden'); aiDraftTarget=null; aiDraftRequest=null;
    const contract=CHARACTER_FIELD_CONTRACTS[select.value];
    $('builder-ai-reference').textContent=contract
      ? `Field purpose: ${contract.purpose} Boundary: ${contract.boundary}`
      : 'Develop four currently empty fields. Each receives its own rules and uses the established character as context.';
  };
  $('builder-close').onclick = () => $('character-builder').close();
  $('character-builder').addEventListener('close', () => { aiDraftController?.abort(); worldEntryController?.abort(); fidelityController?.abort(); localEvalController?.abort(); });
  document.querySelectorAll('[data-builder-tab]').forEach(btn => btn.onclick = () => { if (builderTab === 'lab' && btn.dataset.builderTab !== 'lab') {fidelityController?.abort();localEvalController?.abort();} builderTab = btn.dataset.builderTab; renderBuilder(); });
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
  $('builder-world-suggest').onclick = generateCharacterWorldEntries;
  $('builder-world-stop').onclick = () => worldEntryController?.abort();
  $('builder-world-links-refresh').onclick = () => void renderApprovedWorldRelationships();
  $('builder-ai-result').addEventListener('input',()=>renderBuilderAIChanges());
  $('builder-ai-stop').onclick = () => aiDraftController?.abort();
  $('builder-ai-apply').onclick = () => {
    const c=builderCharacter();if(!c||!aiDraftRequest)return;
    try{
      const proposals=parseCharacterSuggestions($('builder-ai-result').value,aiDraftRequest);
      const accepted={};
      for(const key of Object.keys(proposals)){
        const checkbox=$('builder-ai-changes').querySelector(`[data-proposal-field="${key}"]`);
        const field=$('builder-ai-changes').querySelector(`[data-proposal-text="${key}"]`);
        if(checkbox?.checked)accepted[key]=field?.value||proposals[key];
      }
      const patch=selectCharacterChanges({character:c,worldLibrary,worldId:activeWorldId,lore:state.lore,request:aiDraftRequest,changes:accepted});
      if(!confirm(`Apply ${Object.keys(patch).length} reviewed character detail(s)? No other fields or world facts will change.`))return;
      Object.assign(c,patch);save();renderBuilder();renderLists();renderHeader();renderMessages();
      worldEntryRequest=null;$('builder-world-items').replaceChildren();
      $('builder-world-status').textContent='Character updated. Find world entries again using the newly approved profile.';
      if(currentTab==='character')renderInspector();
      $('builder-ai-status').textContent=`Applied ${Object.keys(patch).join(', ')}. No world canon was modified.`;
      $('builder-ai-preview').classList.add('hidden');aiDraftTarget=null;aiDraftRequest=null;
    }catch(err){$('builder-ai-status').textContent=err.message;}
  };
}
function renderCharacterWorldCandidates(items,request,version) {
  const host=$('builder-world-items');host.replaceChildren();
  if(!items.length){host.append(el('p','No new named world entries supported by this character’s authored fields.','help'));return;}
  host.append(el('p','These are uncommitted proposals. Confirm each one individually; an existing place or person should be linked rather than duplicated.','help'));
  for(const source of items){
    const box=el('div','','lore-card');
    box.append(el('strong',source.type==='location'?'Proposed place':'Proposed world entity'));
    const name=document.createElement('input');name.value=source.name;name.maxLength=120;
    const kind=document.createElement('select');
    const choices=source.type==='location'
      ?['region','town','neighborhood','building','room','outdoor','other']
      :['character','faction','organization','object','concept'];
    for(const choice of choices)kind.add(new Option(choice,choice));
    kind.value=source.kind;
    const description=document.createElement('textarea');description.value=source.description;description.maxLength=800;description.rows=2;
    const sourceNote=el('p',`Source: ${source.sourceField} — “${source.sourceQuote}”`,'help');
    const approve=el('button','Add reviewed entry to World Atlas','primary-button');
    const status=el('p','','help');
    approve.onclick=async()=>{
      const character=builderCharacter();
      if(!character||character.id!==request.characterId||activeWorldId!==request.worldId||
        characterDraftVersion(character)!==request.profileVersion ||
        worldDraftVersion(worldLibrary)!==request.worldVersion ||
        revision!==version){
        status.textContent='Character or world changed. Regenerate these proposals before approving.';return;
      }
      const entry={...source,name:name.value,kind:kind.value,description:description.value};
      if(!confirm(`Add “${entry.name}” as a ${source.type} to the current world? This is persistent world canon, not a current event or character location.`))return;
      approve.disabled=true;
      try{
        await requireSavedStory();
        const reply=await fetch('/api/character/world-entries/approve',{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({approval:'approve',worldId:request.worldId,characterId:character.id,
            revision:version,profileVersion:request.profileVersion,worldVersion:request.worldVersion,entry})
        });
        const outcome=await reply.json();
        if(!reply.ok)throw new Error(outcome.error||'Could not add world entry');
        worldEntryRequest=null;host.replaceChildren();
        $('builder-world-status').textContent=`Added ${outcome.entry.name} to World Atlas from a reviewed ${outcome.sourceField} quote. Regenerate for further entries; no scene or current location was changed.`;
        await refreshWorldLibrary();
        await renderApprovedWorldRelationships();
        if(builderTab==='life')renderBuilder();
      }catch(err){status.textContent=err.message;approve.disabled=false;}
    };
    box.append(el('label','Name','field-label'),name,
      el('label','Entry kind','field-label'),kind,
      el('label','World description (review before committing)','field-label'),
      description,sourceNote,approve,status);
    host.append(box);
  }
}

async function renderApprovedWorldRelationships() {
  const host=$('builder-world-links'),character=builderCharacter();
  if(!host||!character||!activeWorldId)return;
  const charId=character.id,worldId=activeWorldId;
  host.replaceChildren(el('p','Checking approved people…','help'));
  try {
    await requireSavedStory();
    const request=await fetch(scopedUrl('/api/character/world-entries/sources')+
      '&characterId='+encodeURIComponent(charId));
    const data=await request.json();
    if(!request.ok)throw new Error(data.error||'Cannot read approved character-world sources');
    if(builderCharacter()?.id!==charId||activeWorldId!==worldId)return;
    host.replaceChildren();
    const available=(data.sources||[]).filter(x=>
      x.type==='entity'&&x.entityKind==='character'&&x.entryName&&
      proposedRelationshipKinds(x.sourceQuote).length);
    if(!available.length){
      host.append(el('p','No source-backed relationship candidates yet. First approve a named person from the character biography.','help'));
      return;
    }
    for(const source of available){
      const card=el('section','','lore-card reviewed-link');
      const kindOptions=proposedRelationshipKinds(source.sourceQuote);
      card.append(el('strong',source.relationshipId?'Linked · '+source.entryName:'Review · '+source.entryName),
        el('p',`Approved ${source.sourceField} source: “${source.sourceQuote}”`,'help'));
      if(source.relationshipId){
        card.append(el('p','Already connected in the directed World Relations graph.','help'));
      }else{
        const pick=document.createElement('select');
        pick.setAttribute('aria-label','Relationship of '+source.entryName+' to '+character.name);
        for(const kind of kindOptions)pick.add(new Option(kind,kind));
        const preview=el('p','','help');
        pick.onchange=()=>preview.textContent=`${source.entryName} → ${character.name}: ${pick.value} (directed relationship)`;
        pick.onchange();
        const approve=el('button','Approve directed relationship','subtle-button');
        const note=el('p','','help');
        approve.onclick=async()=>{
          if(!confirm(`Add ${source.entryName} → ${character.name} (${pick.value}) as an authored world relationship? This does not create a scene event or change the NPC's feelings.`))return;
          approve.disabled=true;
          try{
            await requireSavedStory();
            const library={...worldLibrary,activeWorldId:worldId};
            const body={approval:'approve',worldId,characterId:charId,entryId:source.entryId,
              kind:pick.value,revision,profileVersion:characterDraftVersion(character),
              worldVersion:worldDraftVersion(library)};
            const response=await fetch('/api/character/world-relationships/approve',{
              method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
            });
            const result=await response.json();
            if(!response.ok)throw new Error(result.error||'Relationship approval rejected');
            await refreshWorldLibrary();
            await renderApprovedWorldRelationships();
            $('builder-world-status').textContent=`Relationship approved: ${result.sourceName} → ${result.characterName} (${result.relationship.kind}). No timeline or mood changed.`;
          }catch(error){note.textContent=error.message;approve.disabled=false;}
        };
        card.append(pick,preview,approve,note);
      }
      host.append(card);
    }
  }catch(error){if(builderCharacter()?.id===charId)host.replaceChildren(el('p',error.message,'help'));}
}

async function generateCharacterWorldEntries() {
  const c=builderCharacter(),status=$('builder-world-status');
  if(!c||worldEntryController||localEvalController)return;
  if(!state.settings.model){status.textContent='Load a local model in Setup first.';return;}
  const aborter=new AbortController();worldEntryController=aborter;
  $('builder-world-suggest').disabled=true;
  $('builder-world-stop').classList.remove('hidden');
  $('builder-world-items').replaceChildren();
  status.textContent='Looking for named world details supported by the saved character…';
  try {
    await requireSavedStory();
    await refreshWorldLibrary();
    const request=makeWorldEntryDraftRequest({character:c,worldId:activeWorldId,worldLibrary});
    const savedRevision=revision;
    const response=await fetch('/api/chat',{method:'POST',signal:aborter.signal,
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({worldId:activeWorldId,model:state.settings.model,
        temperature:0.2,max_tokens:1000,messages:request.messages})
    });
    if(!response.ok){const reason=await response.json().catch(()=>({}));throw new Error(reason.error||'Local model could not suggest world entries');}
    if(!response.body)throw new Error('Local model returned no response stream');
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',out='',done=false;
    const onFrame=frame=>{
      const payload=frame.split('\n').filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trim()).join('\n');
      if(payload==='[DONE]'){done=true;return;}
      if(!payload)return;
      const obj=JSON.parse(payload);
      if(obj.error)throw new Error(String(obj.error));
      const text=obj.choices?.[0]?.delta?.content;
      if(typeof text==='string')out+=text;
    };
    while(!done){const part=await reader.read();if(part.done)break;
      buffer=parseSSE(buffer+decoder.decode(part.value,{stream:true}),onFrame);}
    parseSSE(buffer+decoder.decode()+'\n\n',onFrame);
    if(aborter.signal.aborted)throw new DOMException('Cancelled','AbortError');
    if(builderCharacter()?.id!==c.id||revision!==savedRevision||activeWorldId!==request.worldId||
      characterDraftVersion(c)!==request.profileVersion||
      worldDraftVersion(worldLibrary)!==request.worldVersion)
      throw new Error('Character or world changed; discard these stale suggestions.');
    const entries=parseWorldEntrySuggestions(out,{character:c,worldLibrary,worldId:request.worldId});
    worldEntryRequest=request;
    renderCharacterWorldCandidates(entries,request,savedRevision);
    status.textContent=entries.length
      ?`${entries.length} source-backed suggestion(s). Nothing will be added until you approve an entry.`
      :'No new named world entries were supported by the saved profile.';
  }catch(error){status.textContent=error.name==='AbortError'?'World discovery cancelled.':error.message;}
  finally{worldEntryController=null;$('builder-world-suggest').disabled=false;
    $('builder-world-stop').classList.add('hidden');}
}

async function generateBuilderDraft() {
  const c = builderCharacter(); if (!c || aiDraftController || localEvalController) return;
  if (!state.settings.model) { $('builder-ai-status').textContent = 'Load a model first in Setup.'; return; }
  const target = $('builder-ai-target').value;
  const guidance = $('builder-ai-guidance').value.trim();
  try{if(!worldLibrary)await refreshWorldLibrary();}catch(err){$('builder-ai-status').textContent=err.message;return;}
  let request;
  try{request=makeCharacterDraftRequest({character:c,target,guidance,worldLibrary,worldId:activeWorldId,lore:state.lore});}
  catch(err){$('builder-ai-status').textContent=err.message;return;}
  aiDraftRequest=request;
  $('builder-ai-reference').textContent=`Context supplied: ${worldLibrary.worlds.find(x=>x.id===activeWorldId)?.name||'world'} · ${request.referenceSummary.locations} places · ${request.referenceSummary.entities} entities · ${request.referenceSummary.relationships} direct social ties · ${request.referenceSummary.lore} lore records · ${request.referenceSummary.filledFields} established fields · ${request.referenceSummary.focusedFields} expanded references. Each requested field has its own purpose; nothing becomes canon until approved.`;
  const aiController = new AbortController(); aiDraftController = aiController;
  $('builder-ai-generate').disabled = true;
  $('builder-ai-stop').classList.remove('hidden');
  $('builder-ai-preview').classList.remove('hidden');
  const draft = $('builder-ai-result'); draft.value = '';
  aiDraftTarget = target;
  $('builder-ai-status').textContent = 'Asking the local model for a suggestion…';
  try {
    const response = await fetch('/api/chat', { method:'POST', signal:aiController.signal, headers:{'Content-Type':'application/json'},
      body: JSON.stringify({worldId:activeWorldId,model:state.settings.model,temperature:0.82,max_tokens:target==='full'?1100:700,
        messages:request.messages}),
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
    if(builderCharacter()?.id!==c.id || !validateCharacterDraftBasis({character:c,worldLibrary,worldId:activeWorldId,lore:state.lore,request}))throw new Error('Character or world changed; discard the stale suggestion.');
    renderBuilderAIChanges();
    $('builder-ai-status').textContent = 'Draft ready. Review individual fields; nothing has been applied.';
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
// Provisional NPC drafts are deliberately not part of state.sessions or SQLite.
// Flagged replies require explicit approval, and every approval rechecks the
// same immutable conversation basis used when the request was created.
let npcCommitInFlight=false;
async function persistNpcReply(record,reviewed=false){
  const target=state.sessions.find(s=>s.id===record.sessionId&&!s.trashedAt);
  if(npcCommitInFlight||!isReplyBasisCurrent(target,record.basis)){
    showError('Scene changed before the NPC reply could be committed. Generate again.');
    return false;
  }
  npcCommitInFlight=true;
  const originalWorld=activeWorldId;
  try{
    await requireSavedStory();
    if(activeWorldId!==originalWorld || !isReplyBasisCurrent(
      state.sessions.find(s=>s.id===record.sessionId&&!s.trashedAt),record.basis))
      throw Error('Scene or active world changed before reply confirmation');
    const savedRevision=revision,originalSnapshot=JSON.stringify(state);
    const response=await fetch('/api/actor/reply/commit',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({worldId:originalWorld,ticket:record.ticket,reviewed})
    });
    const data=await response.json();
    if(!response.ok)throw Error(data.error||'The NPC reply was not saved');
    // Never overwrite browser edits made while the commit was in flight.
    // If they race, preserve the local copy for export instead of erasing it.
    if(originalWorld!==activeWorldId||savedRevision!==revision||
      originalSnapshot!==JSON.stringify(state)||pendingSnapshot!==null){
      serverStorage=false;
      showError('Reply saved to SQLite, but browser edits raced its confirmation. Export this local copy before reloading the world.');
      return false;
    }
    clearTimeout(writeTimer);pendingSnapshot=null;
    revision=data.revision;state=normalizeState(data.state);
    try{
      localStorage.setItem(backupStateKey(),JSON.stringify(state));
      localStorage.removeItem(pendingBackupKey());
    }catch{/* Saved world remains authoritative */}
    pendingReply=null;streamingReply=null;
    render();showError();return true;
  }catch(error){
    showError(error.message+' The uncommitted NPC draft was not added to story history.');
    return false;
  }finally{npcCommitInFlight=false;}
}

function renderReplyReview() {
  const host=$('npc-reply-review'); if(!host)return;
  host.replaceChildren();
  const scene=activeSession();
  if (!pendingReply) {host.classList.add('hidden');return;}
  host.classList.remove('hidden');
  if(!scene || scene.id!==pendingReply.sessionId){
    const source=state.sessions.find(s=>s.id===pendingReply.sessionId && !s.trashedAt);
    host.append(el('strong','Unreviewed NPC draft in another scene','review-title'),
      el('p',`A provisional reply is waiting in ${source?.title||'an unavailable scene'}. It has not been saved.`,'review-help'));
    if(source){const open=el('button','Return to draft','subtle-button');open.onclick=()=>{state.activeSessionId=source.id;save();render();};host.append(open);}
    else{const discard=el('button','Discard unavailable draft','subtle-button');discard.onclick=()=>{pendingReply=null;renderMessages();};host.append(discard);}
    return;
  }
  host.append(el('strong','Review NPC draft before saving','review-title'),
    el('p','This reply may violate the selected interaction format or your player agency. It has NOT been saved to the story and will be lost if you reload.','review-help'));
  const warnings=el('ul','','review-warnings');
  for(const issue of pendingReply.issues)warnings.append(el('li',issue));
  host.append(warnings);
  const actions=el('div','','inline-actions');
  const accept=el('button','Keep reply anyway','subtle-button');
  accept.onclick=async()=>{
    const draft=pendingReply;if(!draft)return;
    accept.disabled=true;
    const saved=await persistNpcReply(draft,true);
    if(!saved) {pendingReply=null;renderMessages();}
    accept.disabled=false;
  };
  const again=el('button','Regenerate draft','primary-button');
  again.onclick=()=>{
    const draft=pendingReply;if(!draft)return;
    if(!isReplyBasisCurrent(activeSession(),draft.basis)){pendingReply=null;renderMessages();showError('The scene changed. Start another reply from its current state.');return;}
    pendingReply=null;renderMessages();void generate(draft.mode);
  };
  const discard=el('button','Discard draft','subtle-button');
  discard.onclick=()=>{pendingReply=null;renderMessages();showError();};
  actions.append(accept,again,discard);host.append(actions);
}

async function generate(mode = 'normal') {
  const session=activeSession(); const character=session ? sceneActor(session) : null;
  if (running || !session || !character) {if(!running)showError('Select a scene with an available cast member first.');return;}
  if(pendingReply){const origin=state.sessions.find(s=>s.id===pendingReply.sessionId);showError(`Resolve the unsaved NPC draft in ${origin?.title||'the previous scene'} before generating another reply.`);return;}
  if (!state.settings.model) {
    setWorkspace('tools');openDetailDesk('setup');
    showError('Choose a loaded local model in Settings & tools → Setup before generating.');
    return;
  }
  const previous = session.messages.at(-1);
  const retry = mode === 'retry' && previous?.role === 'assistant';
  if (mode === 'retry' && !retry) return;
  if (retry && !session.messages.slice(0,-1).some(m => m.role === 'user')) { showError('Write a player message before retrying.'); return; }
  if (retry) {
    try {
      await requireSavedStory();
      const check=await fetch(scopedUrl(`/api/events/proposals?sceneId=${encodeURIComponent(session.id)}`));
      const result=await check.json();if(!check.ok)throw Error(result.error);
      if(result.proposals?.some(p=>p.sourceMessageId===previous.id && p.status==='accepted'))
        return showError('Retry is locked by a committed world event. Start a fresh timeline from canon without this event for an alternative history.');
    }catch(err){showError(err.message);return;}
  }
  const actorId = retry ? (previous.speakerId || session.characterId) : character.id;
  const originalVariants = retry ? (Array.isArray(previous.variants) && previous.variants.length ? [...previous.variants] : [previous.content]) : [];
  const basis=replyBasis(session);
  running=true;controller=new AbortController();
  $('send').disabled=true; $('regenerate').disabled=true; $('continue').disabled=true;
  $('stop').classList.remove('hidden');showError();
  let assistantText='';let errorMessage='';let succeeded=false;let issues=[];
  let modelDone=false,replyTicket=null;
  const message={id:retry?previous.id:crypto.randomUUID(),role:'assistant',content:'',speakerId:actorId,
    channelId:retry?getChannel(previous.channelId).id:getChannel(session.channelId).id,sentAt:Date.now(),
    witnessIds:retry?[...(previous.witnessIds||[])]:channelAudience(session.channelId)==='cast'?[...session.castIds]:[actorId],provisional:true};
  try {
    // Acting context is resolved from authoritative SQLite state on the server.
    await requireSavedStory();
    const response=await fetch('/api/actor/reply',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({worldId:activeWorldId,sceneId:session.id,actorId,mode,
        revision,model:state.settings.model,temperature:state.settings.temperature,
        max_tokens:state.settings.max_tokens,contextWindow:state.settings.contextWindow||4096}),
      signal:controller.signal});
    $('lore-active').textContent='Actor memory: world-scoped retrieval active';
    if (!response.ok) {const issue=await response.json().catch(()=>({error:`HTTP ${response.status}`}));throw new Error(issue.error||`HTTP ${response.status}`);}
    if (!response.body) throw new Error('Model server returned no response stream');
    streamingReply={sessionId:session.id,message};
    renderMessages();
    const reader=response.body.getReader();const decode=new TextDecoder();let pending='';
    const onFrame=frame=>{
      const data=frame.split('\n').filter(line=>line.startsWith('data:'))
        .map(line=>line.slice(5).trimStart()).join('\n');
      if(!data)return;
      if(data==='[DONE]'){modelDone=true;return;}
      try{
        const obj=JSON.parse(data);
        if(frame.split('\n').some(line=>line.trim()==='event: rp_complete')){
          replyTicket=obj.ticket;return;
        }
        if(obj.error){errorMessage=typeof obj.error==='string'?obj.error:JSON.stringify(obj.error);return;}
        const delta=obj.choices?.[0]?.delta?.content;
        if(typeof delta==='string'&&delta){
          assistantText+=delta;message.content=assistantText;
          const messages=$('messages'),last=messages.lastElementChild?.querySelector('.message-text');
          if(last)last.textContent=assistantText;
          messages.scrollTop=messages.scrollHeight;
        }
      }catch{/* Incomplete/malformed frames cannot supply a completion ticket. */}
    };
    // The model's [DONE] is NOT proof the world stayed unchanged. Continue
    // reading until the local server issues a separate rp_complete ticket.
    while(true){const item=await reader.read();if(item.done)break;pending=parseSSE(pending+decode.decode(item.value,{stream:true}),onFrame);}
    parseSSE(pending+decode.decode()+'\n\n',onFrame);
    if(errorMessage)throw new Error(errorMessage);
    if(!modelDone||typeof replyTicket!=='string'||!replyTicket)
      throw new Error('World or scene changed while generating, or the model stream ended early. Nothing was saved.');
    if(!assistantText.trim())throw new Error('The model returned an empty reply. Try another model or generation preset.');
    issues=inspectNpcReply(message.channelId,assistantText,state.characters.find(c=>c.id===actorId)?.name||'');
    succeeded=true;
  } catch(err) {
    if(err.name!=='AbortError')showError(err.message);
  } finally {
    streamingReply=null;
    if(succeeded){
      const record={ticket:replyTicket,sessionId:session.id,basis,actorId,mode,retry,originalVariants,
        message:{...message,content:assistantText},issues};
      if(issues.length)pendingReply=record;
      else await persistNpcReply(record);
    }
    running=false;controller=null;$('send').disabled=false;$('regenerate').disabled=false;$('continue').disabled=false;
    $('stop').classList.add('hidden');renderLists();renderMessages();renderHeader();
  }
}

function send() {
  if (running) return;
  if(pendingReply){showError('Review or discard the pending NPC draft before sending another message.');return;}
  const message=$('message-input').value.trim();if(!message)return;
  if(!activeSession()){showError('Create or restore a scene first.');return;}
  const session=activeSession();const channel=getChannel(session.channelId);
  const target=sceneActor({...session,messages:[...session.messages,{role:'user',content:message}]});
  const recipients=channelAudience(channel.id)==='cast'?[...session.castIds]:target?[target.id]:[];
  session.messages.push({id:crypto.randomUUID(),role:'user',channelId:channel.id,content:message,sentAt:Date.now(),witnessIds:recipients});$('message-input').value='';session.updatedAt=Date.now();save();renderLists();renderMessages();generate();
}

for(const channel of CHANNEL_OPTIONS){
  for(const id of ['channel-select','new-scene-channel'])
    $(id).add(new Option(channel.icon+' '+channel.label,channel.id));
}
$('new-session').onclick=()=>openNewSceneDialog();
$('new-scene-cancel').onclick=()=>$('new-scene-dialog').close();
$('new-scene-confirm').onclick=()=>{
  const char=state.characters.find(c=>c.id===$('new-scene-character').value && !c.trashedAt);
  const encounter=(state.encounters||[]).find(e=>e.id===$('new-scene-encounter').value && e.characterIds.includes(char?.id));
  if(!char)return showError('Choose a character.');
  $('new-scene-dialog').close();
  startSession(char,encounter||null,$('new-scene-channel').value);
};
$('new-scene-manage-encounters').onclick=()=>{
  const templateId=$('new-scene-encounter').value||null;
  $('new-scene-dialog').close();
  openEncounterManager(templateId);
};
$('new-character').onclick=()=>{
  if(running)return;
  const c=createCharacter('New character');
  state.characters.push(c);
  selectedCharacterId=c.id;
  save();
  renderLists();
  setWorkspace('characters');
  openBuilder(c);
};
$('channel-select').onchange=()=>{
  const s=activeSession();if(!s||running||pendingReply?.sessionId===s.id){renderHeader();if(pendingReply?.sessionId===s?.id)showError('Resolve the pending draft before changing channels.');return;}
  const next=getChannel($('channel-select').value).id;
  s.channelId=next;
  if(channelAudience(next)==='directed'){const actor=sceneActor(s);if(actor){s.speakerId=actor.id;s.speakerMode='manual';}}
  save();renderHeader();renderMessages();
};
$('send').onclick=send;
$('stop').onclick=()=>controller?.abort();
$('regenerate').onclick=()=>generate('retry');
$('continue').onclick=()=>{if (!running && activeSession()?.messages.length) generate('continue');};
$('open-builder').onclick=()=>{if(!running)openBuilder(activeCharacter());};
$('reading-toggle').onclick=()=>{state.settings.readingMode=!state.settings.readingMode;save();renderReadingMode();};
$('open-inspector').onclick=()=>setDetailDeskOpen(!$('inspector').classList.contains('inspector-open'));
$('open-workspace-inspector').onclick=()=>setDetailDeskOpen(!$('inspector').classList.contains('inspector-open'));
$('open-command').onclick=openStudioCommands;
$('command-close').onclick=()=>$('command-palette').close();
$('command-search').oninput=renderStudioCommands;
$('command-search').onkeydown=event=>{
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){
    event.preventDefault();moveStudioCommand(event.key==='ArrowDown'?1:-1);
  }else if(event.key==='Enter'){
    event.preventDefault();performStudioCommand(commandResults[commandIndex]);
  }
};
$('command-palette').onclick=event=>{if(event.target===$('command-palette'))$('command-palette').close();};
document.addEventListener('keydown',event=>{
  if((event.ctrlKey||event.metaKey)&&event.key.toLocaleLowerCase()==='k'){
    if(document.querySelector('dialog[open]')&&!$('command-palette').open)return;
    event.preventDefault();
    if($('command-palette').open)$('command-palette').close();
    else openStudioCommands();
  }
});

$('expand-inspector').onclick=()=>{
  const focus=!document.body.classList.contains('detail-focus');
  document.body.classList.toggle('detail-focus',focus);
  setDetailDeskOpen(focus||window.matchMedia('(max-width:1100px)').matches);
};
$('close-inspector').onclick=()=>setDetailDeskOpen(false);
$('inspector-scrim').onclick=()=>setDetailDeskOpen(false);
$('message-input').addEventListener('keydown',(ev)=>{if(ev.key==='Enter'&&!ev.shiftKey&&!ev.isComposing){ev.preventDefault();send();}});
$('export-data').onclick=()=>download('ai-rp-studio-backup.json',JSON.stringify(state,null,2));
$('import-data').onclick=()=>$('import-data-file').click();
$('import-data-file').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;try{const candidate=JSON.parse(await file.text());if(!candidate||!Array.isArray(candidate.characters)||!Array.isArray(candidate.sessions))throw new Error('Not a valid studio backup');if(!confirm('Replace your current local stories with this backup? Export first if needed.'))return;state=normalizeState(candidate);pendingReply=null;streamingReply=null;save();render();showError();}catch(err){showError(err.message);}e.target.value='';};
document.querySelectorAll('[data-tab]').forEach(tab=>tab.addEventListener('click',()=>openDetailDesk(tab.dataset.tab)));
document.querySelectorAll('button[data-workspace]').forEach(tab=>tab.addEventListener('click',()=>setWorkspace(tab.dataset.workspace)));
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&$('inspector').classList.contains('inspector-open'))setDetailDeskOpen(false);});
window.addEventListener('resize',()=>{if(window.innerWidth>1100)setDetailDeskOpen(false);});
setupBuilderAI();
const quickTheme = $('quick-theme');
for (const theme of THEMES) quickTheme.add(new Option(theme.name, theme.id));
quickTheme.onchange = event => { state.settings.theme = event.target.value; state.settings.customAccent = ''; save(); applyTheme(); if (currentTab === 'setup') renderInspector(); };
window.addEventListener('beforeunload',()=>{controller?.abort();atmosphere('stop');});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden' && pendingSnapshot) flushState();});
bootstrapStorage();

$('world-home').onclick=()=>{setWorkspace('world');renderWorldLauncher();$('world-launcher').showModal();};
$('world-launcher-close').onclick=()=>{sessionStorage.setItem('ai-rp-world-opened','1');$('world-launcher').close();};
$('world-filter').addEventListener('input',renderWorldLauncher);
$('world-launcher-create').onclick=()=>{ $('world-launcher').close();setWorkspace('world');openDetailDesk('worlds');$('world-new-name')?.focus(); };
