import { STORAGE_KEY, createCharacter, createSession, makeInitialState, normalizeState, buildMessages, getActiveLore, importCharacter } from '/engine.mjs';
import { initAtmosphere } from '/scene.js';

const $ = (id) => document.getElementById(id);
const el = (tag, text = '', className = '') => { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; };
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const text = (s) => String(s ?? '');
let state;
try { state = normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY))); } catch { state = makeInitialState(); }
let currentTab = 'character';
let running = false;
let controller = null;
let models = [];
let backend = 'the local model server';
const atmosphere = initAtmosphere($('scene-canvas'));
const activeSession = () => state.sessions.find(s => s.id === state.activeSessionId) || null;
const activeCharacter = () => state.characters.find(c => c.id === activeSession()?.characterId) || state.characters[0];
const save = () => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { showError('Browser storage is full. Export a backup before continuing.'); } };
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
  for (const s of [...state.sessions].sort((a,b) => b.updatedAt - a.updatedAt)) {
    const char = state.characters.find(c => c.id === s.characterId);
    const button = el('button', '', `session-item ${s.id === state.activeSessionId ? 'active' : ''}`);
    const badge = el('span', (char?.name || '?').slice(0,1).toUpperCase(), 'initial');
    badge.style.background = char?.color || '#655078';
    const info = el('span', '', 'session-details');
    info.append(el('strong', s.title || `With ${char?.name || 'unknown'}`), el('small', `${char?.name || 'Unknown'} · ${s.messages.length} messages`));
    button.append(badge, info);
    button.title = `Open ${s.title}`;
    button.addEventListener('click', () => { if (running) return; state.activeSessionId = s.id; save(); render(); });
    sessions.append(button);
  }
  const list = $('character-list');
  list.replaceChildren();
  for (const c of state.characters) {
    const button = el('button', '', `character-item ${c.id === activeCharacter()?.id ? 'active' : ''}`);
    const badge = el('span', c.name.slice(0,1).toUpperCase(), 'initial'); badge.style.background = c.color;
    const info = el('span', '', 'session-details'); info.append(el('strong', c.name), el('small', c.personality ? c.personality.slice(0,54) : 'Unwritten character'));
    button.append(badge, info);
    button.title = `Start a scene with ${c.name}`;
    button.addEventListener('click', () => { if (running) return; startSession(c); });
    list.append(button);
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
    const article = el('article','',`message ${m.role}`);
    const portrait = el('div', (m.role === 'assistant' ? char?.name : state.persona.name || 'Y').slice(0,1).toUpperCase(), 'portrait');
    const bubble = el('div','','bubble');
    bubble.append(el('div',m.role === 'user' ? state.persona.name || 'You' : char?.name || 'Character','speaker'));
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

function renderHeader() {
  const s = activeSession(); const c = activeCharacter();
  $('scene-title').textContent = s?.title || 'New story';
  $('scene-meta').textContent = c?.scenario || 'Choose a character and start a scene';
  $('stage-name').textContent = c?.name || 'Unknown';
  $('stage-avatar').textContent = (c?.name || '?').slice(0,1).toUpperCase();
  atmosphere(c?.color || '#a68dd6');
  const lore = s ? getActiveLore(state.lore, s.messages) : [];
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
function renderInspector() {
  const host = $('inspector-content'); const c = activeCharacter(); const s = activeSession();
  document.querySelectorAll('[data-tab]').forEach(btn => { btn.classList.toggle('active', btn.dataset.tab === currentTab); btn.setAttribute('aria-selected', String(btn.dataset.tab === currentTab)); });
  if (currentTab === 'character') {
    host.innerHTML = `<h2 class="panel-title">Character notes</h2><p class="help">Write the person, not a checklist of commands. Changes apply to their future replies.</p>${field('name','Name',c.name)}${field('description','Appearance & identity',c.description,{multiline:true,rows:3})}${field('personality','Personality & voice',c.personality,{multiline:true,rows:3})}${field('backstory','Backstory & knowledge',c.backstory,{multiline:true,rows:3})}${field('scenario','Scene premise',c.scenario,{multiline:true,rows:3})}${field('greeting','Opening message',c.greeting,{multiline:true,rows:4})}${field('color','Accent color',c.color,{type:'color'})}<div class="inline-actions"><button id="export-character" class="subtle-button">Export card JSON</button><button id="import-character" class="subtle-button">Import card JSON</button><input type="file" id="character-upload" accept="application/json,.json" hidden /></div><p class="footer-note">Native JSON cards are supported. SillyTavern PNG character cards are not yet supported.</p>`;
    attachFields((key, value) => { c[key] = value; });
    $('export-character').onclick = () => download(`${safeName(c.name)}.json`, JSON.stringify({character:c},null,2));
    $('import-character').onclick = () => $('character-upload').click();
    $('character-upload').onchange = async e => { const file = e.target.files?.[0]; if (!file) return; try { const cc = importCharacter(JSON.parse(await file.text())); state.characters.push(cc); startSession(cc); showError(); } catch(err) { showError(err.message); } };
  } else if (currentTab === 'lore') {
    host.innerHTML = `<h2 class="panel-title">World lore</h2><p class="help">Write concise facts and comma-separated trigger words. Relevant entries are brought into context only when a recent message matches.</p><button id="add-lore" class="subtle-button" style="margin-bottom:16px">＋ New lore entry</button><div id="lore-list"></div>`;
    $('add-lore').onclick = () => { state.lore.unshift({id:crypto.randomUUID(),title:'New entry',keywords:[],content:''}); save(); renderInspector(); };
    const list = $('lore-list');
    for (const entry of state.lore) {
      const card = el('div','','lore-card');
      card.innerHTML = `<label class="field-label">Title</label><input data-key="title" value="${escapeHtml(entry.title||'')}" maxlength="120"/><label class="field-label">Trigger words</label><input data-key="keywords" value="${escapeHtml(entry.keywords.join(', '))}" placeholder="harbor, bookshop, old town"/><label class="field-label">Canon fact</label><textarea data-key="content" rows="4" maxlength="12000">${escapeHtml(entry.content)}</textarea><div class="inline-actions"><button class="subtle-button" data-key="delete">Delete entry</button></div>`;
      card.querySelectorAll('[data-key]').forEach(input => { const key = input.dataset.key;
        if (key === 'delete') input.onclick = () => { if (!confirm('Delete this lore entry?')) return; state.lore = state.lore.filter(l => l.id !== entry.id); save(); renderInspector(); renderHeader(); };
        else input.oninput = () => { entry[key] = key === 'keywords' ? input.value.split(',').map(x => x.trim()).filter(Boolean) : input.value; save(); renderHeader(); };
      });
      list.append(card);
    }
    if (!state.lore.length) list.append(el('p','No lore entries yet. Add one when the world needs a fact to remember.','empty-note'));
  } else if (currentTab === 'memory') {
    host.innerHTML = `<h2 class="panel-title">Story direction</h2><p class="help">A NovelAI-inspired separation: permanent canon versus immediate creative guidance.</p>${field('title','Scene title',s?.title||'')}${field('summary','Scene memory · established canon',s?.summary||'',{multiline:true,rows:7,help:'Persistent facts, relationships, secrets revealed and important past events.'})}${field('authorNote','Author’s Note · tone and direction',s?.authorNote||'',{multiline:true,rows:5,help:'Temporary guidance for the next replies. It should steer storytelling, not invent established facts.'})}<h3 class="field-label">Pinned moments</h3><div id="pinned-moments"></div><div class="inline-actions"><button class="subtle-button" id="delete-session">Delete this scene</button></div><p class="footer-note">Pin up to five messages directly in the conversation. This browser stores your local sessions; export backups regularly.</p>`;
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
    $('delete-session').onclick = () => { if (!confirm('Delete this scene and its messages? This cannot be undone.')) return; state.sessions = state.sessions.filter(x=>x.id!==s.id); if (!state.sessions.length) state.sessions.push(createSession(activeCharacter())); state.activeSessionId = state.sessions[0].id; save(); render(); };
  } else if (currentTab === 'setup') {
    host.innerHTML = `<h2 class="panel-title">Studio settings</h2><p class="help">This studio talks only to your local inference server. Start LM Studio or KoboldCpp first, then refresh the model list.</p><div class="group"><label class="field-label" for="model-select">Loaded model</label><select id="model-select"><option value="">Select a model</option>${models.map(m=>`<option value="${escapeHtml(m.id)}" ${m.id===state.settings.model?'selected':''}>${escapeHtml(m.id)}</option>`).join('')}</select></div><button class="subtle-button" id="refresh-models">↻ Find local models</button><p id="backend-address" class="help">Backend: ${escapeHtml(backend)}</p>${field('temperature','Temperature',state.settings.temperature,{type:'number'})}${field('max_tokens','Max output tokens',state.settings.max_tokens,{type:'number'})}<h2 class="panel-title">Player persona</h2>${field('personaName','Your character name',state.persona.name)}${field('personaDescription','Your character',state.persona.description,{multiline:true,rows:5})}<p class="footer-note">Default server: KoboldCpp at 127.0.0.1:5001/v1. To use LM Studio instead, set INFERENCE_URL to http://127.0.0.1:1234/v1 before launching. Keep both servers on localhost.</p>`;
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
function render() { renderLists(); renderHeader(); renderMessages(); renderInspector(); renderReadingMode(); }
function renderReadingMode() {
  document.body.classList.toggle('reading-mode', Boolean(state.settings.readingMode));
  $('reading-toggle').textContent = state.settings.readingMode ? '◫ Chat view' : '◫ Story view';
  $('reading-toggle').setAttribute('aria-pressed', String(Boolean(state.settings.readingMode)));
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
    showError();
  } catch(err) { models=[]; status.className='connection offline';label.textContent='Model server offline'; if(currentTab==='setup')renderInspector(); }
}
function parseSSE(buffer, onFrame) {
  // Splits complete SSE frames. Retains partial JSON events across network chunks.
  const normalized=buffer.replace(/\r\n/g,'\n'); const pieces=normalized.split('\n\n');
  for (const frame of pieces.slice(0,-1)) onFrame(frame);
  return pieces.at(-1) || '';
}
async function generate(mode = 'normal') {
  const session=activeSession(); const character=activeCharacter();
  if (running || !session || !character) return;
  if (!state.settings.model) { currentTab='setup';renderInspector();showError('Load a model in KoboldCpp or LM Studio, then select it in Setup.');return; }
  const previous = session.messages.at(-1);
  const retry = mode === 'retry' && previous?.role === 'assistant';
  if (mode === 'retry' && !retry) return;
  if (retry && !session.messages.slice(0,-1).some(m => m.role === 'user')) { showError('Write a player message before retrying.'); return; }
  const history = retry ? session.messages.slice(0,-1) : session.messages;
  const originalContent = retry ? previous.content : '';
  const originalVariants = retry ? (Array.isArray(previous.variants) && previous.variants.length ? [...previous.variants] : [previous.content]) : [];
  const originalIndex = retry ? previous.variantIndex : undefined;
  running=true;controller=new AbortController();
  $('send').disabled=true; $('regenerate').disabled=true; $('continue').disabled=true;
  $('stop').classList.remove('hidden');showError();
  let assistantText=''; let errorMessage=''; let assistant=null; let succeeded=false;
  try {
    const prompt=buildMessages({character,persona:state.persona,summary:session.summary,authorNote:session.authorNote,lore:state.lore,history});
    if (mode === 'continue') prompt.messages.push({role:'user',content:'[Continue the current scene with a brief natural development. Do not determine the player character’s next action, speech or feelings.]'});
    $('lore-active').textContent=prompt.activatedLore.length ? `Active lore: ${prompt.activatedLore.map(e=>e.title||e.keywords.join(', ')).join(' · ')}`:'';
    const response=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:state.settings.model,messages:prompt.messages,temperature:state.settings.temperature,max_tokens:state.settings.max_tokens}),signal:controller.signal});
    if (!response.ok) {const issue=await response.json().catch(()=>({error:`HTTP ${response.status}`}));throw new Error(issue.error||`HTTP ${response.status}`);}
    if (!response.body) throw new Error('Model server returned no response stream');
    assistant=retry ? previous : {id:crypto.randomUUID(),role:'assistant',content:''};
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
    else if(assistant && !assistantText.trim())session.messages=session.messages.filter(m=>m!==assistant);
  } finally {
    if (retry && succeeded) {
      if (!originalVariants.includes(assistantText)) originalVariants.push(assistantText);
      assistant.variants=originalVariants.slice(-20);
      assistant.variantIndex=assistant.variants.indexOf(assistantText);
      if (assistant.variantIndex < 0) assistant.variantIndex=assistant.variants.length-1;
    }
    running=false;controller=null;$('send').disabled=false;$('regenerate').disabled=false;$('continue').disabled=false;
    $('stop').classList.add('hidden');session.updatedAt=Date.now();save();renderLists();renderMessages();renderHeader();
  }
}

function send() {
  if (running) return;
  const message=$('message-input').value.trim();if(!message)return;
  activeSession().messages.push({id:crypto.randomUUID(),role:'user',content:message});$('message-input').value='';activeSession().updatedAt=Date.now();save();renderLists();renderMessages();generate();
}

$('new-session').onclick=()=>{if(!running)startSession();};
$('new-character').onclick=()=>{if(running)return;const c=createCharacter('New character');state.characters.push(c);startSession(c);currentTab='character';renderInspector();$('field-name')?.focus();};
$('send').onclick=send;
$('stop').onclick=()=>controller?.abort();
$('regenerate').onclick=()=>generate('retry');
$('continue').onclick=()=>{if (!running && activeSession()?.messages.length) generate('continue');};
$('reading-toggle').onclick=()=>{state.settings.readingMode=!state.settings.readingMode;save();renderReadingMode();};
$('open-inspector').onclick=()=>{$('inspector').classList.toggle('inspector-open');};
$('message-input').addEventListener('keydown',(ev)=>{if(ev.key==='Enter'&&!ev.shiftKey&&!ev.isComposing){ev.preventDefault();send();}});
$('export-data').onclick=()=>download('ai-rp-studio-backup.json',JSON.stringify(state,null,2));
$('import-data').onclick=()=>$('import-data-file').click();
$('import-data-file').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;try{const candidate=JSON.parse(await file.text());if(!candidate||!Array.isArray(candidate.characters)||!Array.isArray(candidate.sessions))throw new Error('Not a valid studio backup');if(!confirm('Replace your current local stories with this backup? Export first if needed.'))return;state=normalizeState(candidate);save();render();showError();}catch(err){showError(err.message);}e.target.value='';};
document.querySelectorAll('[data-tab]').forEach(tab=>tab.addEventListener('click',()=>{currentTab=tab.dataset.tab;renderInspector();}));
window.addEventListener('beforeunload',()=>{controller?.abort();atmosphere('stop');});
render();refreshModels();
