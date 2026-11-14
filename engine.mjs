import { CHARACTER_V2_FIELDS, normalizeCharacterV2, importedEncounter, normalizeEncounters } from './character/schema.mjs';
import { normalizeScene, canKnowLore } from './harness.mjs';
import { createMind,normalizeMind,normalizeDisposition,DEFAULT_DISPOSITION } from './psychology.mjs';
// Pure roleplay prompt and persistence helpers; no browser dependencies.
export const STORAGE_KEY = 'ai-rp-studio:v1';
export const THEMES = Object.freeze([
  { id: 'nocturne', name: 'Nocturne', accent: '#ad91cf' },
  { id: 'obsidian', name: 'Obsidian', accent: '#bab9c5' },
  { id: 'rosewood', name: 'Rosewood', accent: '#d48eaa' },
  { id: 'ember', name: 'Ember', accent: '#d6a076' },
  { id: 'forest', name: 'Forest', accent: '#97b89b' },
  { id: 'tidal', name: 'Tidal', accent: '#8fc7c6' },
  { id: 'sapphire', name: 'Sapphire', accent: '#9aafe6' },
  { id: 'amethyst', name: 'Amethyst', accent: '#b7a0e9' },
  { id: 'sepia', name: 'Sepia', accent: '#cdb18a' },
  { id: 'parchment', name: 'Parchment', accent: '#795b9f' },
]);
export const DEFAULT_SETTINGS = Object.freeze({ model: '', temperature: 0.95, max_tokens: 450, contextWindow: 4096, readingMode: false, theme: 'nocturne', customAccent: '' });
export const CHARACTER_FIELDS = CHARACTER_V2_FIELDS;
export const PORTRAIT_PATH = /^\/portraits\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:webp|jpg)$/i;

export const DEFAULT_EMOTION = Object.freeze({ valence: 0, arousal: 0.25, trust: 0 });

// Explicit, story-level appraisal beats. Never guess a player's intentions by
// scanning their message for emotional keywords. These are simulation controls.
export const EMOTION_BEATS = Object.freeze({
  warmth: { label: 'Warmth', change: [0.23, 0.05, 0.18] },
  friction: { label: 'Friction', change: [-0.19, 0.16, -0.14] },
  danger: { label: 'Danger', change: [-0.26, 0.28, 0] },
  reassure: { label: 'Reassurance', change: [0.18, -0.17, 0.12] },
  quiet: { label: 'Quiet passage', change: [0, -0.20, 0] },
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export function normalizeEmotion(value) {
  const numeric = (key, low, high, fallback) =>
    typeof value?.[key] === 'number' && Number.isFinite(value[key]) ? clamp(value[key], low, high) : fallback;
  return {
    valence: numeric('valence', -1, 1, 0),
    arousal: numeric('arousal', 0, 1, 0.25),
    trust: numeric('trust', -1, 1, 0),
  };
}
export function applyEmotionBeat(current, kind) {
  const beat = EMOTION_BEATS[kind];
  if (!beat) throw new Error(`Unknown emotional event: ${kind}`);
  const before = normalizeEmotion(current);
  return normalizeEmotion({
    valence: before.valence + beat.change[0],
    arousal: before.arousal + beat.change[1],
    trust: before.trust + beat.change[2],
  });
}
export function settleEmotion(current) {
  const e = normalizeEmotion(current);
  // Feelings settle over narrative turns, but relationships do not reset.
  return normalizeEmotion({ valence: e.valence * 0.94, arousal: 0.25 + (e.arousal - 0.25) * 0.86, trust: e.trust });
}
export function describeEmotion(value) {
  const e = normalizeEmotion(value);
  const mood = e.valence < -0.35 ? 'unsettled and distressed' : e.valence > 0.35 ? 'pleasantly disposed' : 'emotionally mixed';
  const energy = e.arousal > 0.65 ? 'highly alert' : e.arousal > 0.35 ? 'attentive' : 'relatively calm';
  const connection = e.trust < -0.35 ? 'guarded toward the player' : e.trust > 0.35 ? 'open and trusting toward the player' : 'cautious about the player';
  return `${mood}; ${energy}; ${connection}`;
}


export function createCharacter(name = 'New character') {
  return {
    id: crypto.randomUUID(), name, handle: '', tagline: '', description: '', personality: '', backstory: '',
    motivations: '', fears: '', boundaries: '', speechStyle: '', inPersonStyle: '', phoneStyle: '', textStyle: '', exampleDialogue: '',
    ...normalizeCharacterV2({name}), tags: [], portrait: '',disposition:{...DEFAULT_DISPOSITION},
    homeLocationId: null, workLocationId: null, frequentPlaces: [], color: '#a68dd6',
  };
}

export function createSession(character, encounter = null) {
  return {
    id: crypto.randomUUID(), characterId: character.id, title: `With ${character.name}`,
    messages: encounter?.opening ? [{id:crypto.randomUUID(),role:'assistant',content:encounter.opening,speakerId:character.id,witnessIds:[character.id],channelId:encounter.channelId||'in_person'}] : [],
    summary: '', publicSummary: '', authorNote: '', emotion: { ...DEFAULT_EMOTION }, emotionByActor: {}, emotionEvents: [],
    castIds: [character.id], speakerId: character.id, speakerMode: 'natural', channelId: encounter?.channelId||'in_person', location: '', worldTime: '', atmosphere: '', direction: encounter?.premise || '', encounterId: encounter?.id || null, sceneEvents: [],
    psychologyByActor:{[character.id]:createMind()},director:{mode:'collaborative',pace:.5,tension:.5,initiative:.5,narration:.5},timeHoursElapsed:0, updatedAt: Date.now(),
  };
}

export function makeEmptyWorldState() {
  return normalizeState({ characters: [], sessions: [], lore: [], encounters: [], persona: {name: 'Player', description: ''}, settings: { ...DEFAULT_SETTINGS } });
}

export function makeInitialState() {
  const character = {
    ...createCharacter('Mara Vale'),
    description: 'A watchful antiquarian who runs a bookshop in a rain-soaked harbor town.',
    personality: 'Dry wit, careful with trust, curious, quietly compassionate. Never omniscient.',
    backstory: 'Mara inherited the shop from her missing mentor. She knows the town has secrets, but not their answers.',
    preferredEnvironment: 'Quiet bookshops, old harbor streets, and familiar spaces.',
  };
  const session = createSession(character);
  const opening='The bell above the door gives a tired chime. Mara looks up from an old photograph. "We are technically closed," she says, but makes no move to send you away.';
  const encounter={id:'demo-harbor-bookshop',title:'First visit to the harbor bookshop',
    characterIds:[character.id],locationId:null,channelId:'in_person',
    premise:'A stormy evening; the player has just entered the bookshop.',opening};
  session.messages.push({id:crypto.randomUUID(),role:'assistant',speakerId:character.id,witnessIds:[character.id],channelId:'in_person',content:opening});
  return {
    characters: [character], sessions: [session], encounters: [encounter], activeSessionId: session.id,
    lore: [], persona: { name: 'Player', description: '' }, settings: { ...DEFAULT_SETTINGS },
  };
}

export function normalizeState(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.characters) || !Array.isArray(value.sessions)) {
    return makeInitialState();
  }
  const legacyEncounters=value.characters.map(c=>importedEncounter(c)).filter(Boolean);
  const characters = value.characters.filter(c => c && typeof c.id === 'string' && typeof c.name === 'string')
    .map(c => ({ ...createCharacter(c.name), ...c, ...normalizeCharacterV2(c),
      portrait: typeof c.portrait === 'string' && PORTRAIT_PATH.test(c.portrait) ? c.portrait : '',
      disposition:normalizeDisposition(c.disposition),
      tags: Array.isArray(c.tags) ? c.tags.filter(x => typeof x === 'string').slice(0, 30) : [],
      frequentPlaces: normalizeCharacterV2(c).frequentPlaces,
      scenario: undefined, greeting: undefined, alternateGreetings: undefined,
    }));
  const sessions = value.sessions.filter(s => s && typeof s.id === 'string' && typeof s.characterId === 'string' && Array.isArray(s.messages))
    .map(s => ({ ...s, ...normalizeScene(s, characters),
      trashedAt: Number.isFinite(s.trashedAt) ? s.trashedAt : null,
      emotionByActor: s.emotionByActor && typeof s.emotionByActor === 'object' ? Object.fromEntries(Object.entries(s.emotionByActor).map(([id,v]) => [id, normalizeEmotion(v)])) : {},
      psychologyByActor:s.psychologyByActor && typeof s.psychologyByActor==='object' ? Object.fromEntries(Object.entries(s.psychologyByActor).map(([id,v])=>[id,normalizeMind(v)])) : {},
      director:{mode:['sandbox','collaborative','directed'].includes(s.director?.mode)?s.director.mode:'collaborative',...Object.fromEntries(['pace','tension','initiative','narration'].map(key=>[key,Math.max(0,Math.min(1,Number.isFinite(s.director?.[key])?s.director[key]:.5))]))},
      timeHoursElapsed:Number.isFinite(s.timeHoursElapsed) && s.timeHoursElapsed>=0 ? s.timeHoursElapsed:0,
      authorNote: typeof s.authorNote === 'string' ? s.authorNote : '',
      emotion: normalizeEmotion(s.emotion),
      emotionEvents: Array.isArray(s.emotionEvents) ? s.emotionEvents.filter(e => e && typeof e.kind === 'string' && EMOTION_BEATS[e.kind]).slice(-20).map(e => ({ id: typeof e.id === 'string' ? e.id : crypto.randomUUID(), kind: e.kind, before: normalizeEmotion(e.before), at: Number.isFinite(e.at) ? e.at : Date.now() })) : [],
      messages: s.messages.filter(m => ['user', 'assistant'].includes(m?.role) && typeof m?.content === 'string')
        .map(m => ({ ...m, id: typeof m.id === 'string' ? m.id : crypto.randomUUID(),
          pinned: Boolean(m.pinned),
          channelId: ['in_person','phone_call','text_message'].includes(m.channelId) ? m.channelId : 'in_person',
          sentAt: Number.isFinite(m.sentAt) ? m.sentAt : undefined,
          speakerId: m.role === 'assistant' ? (typeof m.speakerId === 'string' ? m.speakerId : s.characterId) : undefined,
          witnessIds: Array.isArray(m.witnessIds) ? [...new Set(m.witnessIds.filter(id => typeof id === 'string'))] : [s.characterId],
          variants: m.role === 'assistant' && Array.isArray(m.variants)
            ? m.variants.filter(v => typeof v === 'string').slice(0, 20) : undefined,
        })) }));
  // Empty libraries and fully trashed libraries are valid; don't recreate deleted stories.
  return {
    characters, sessions,
    encounters: normalizeEncounters([...(value.encounters||[]),...legacyEncounters.filter(e=>!(value.encounters||[]).some(x=>x.id===e.id))],characters.map(c=>c.id)),
    activeSessionId: sessions.some(s => s.id === value.activeSessionId && !s.trashedAt) ? value.activeSessionId : (sessions.find(s => !s.trashedAt)?.id || null),
    lore: Array.isArray(value.lore) ? value.lore.filter(l => l && typeof l.content === 'string' && Array.isArray(l.keywords))
      .map(l => ({...l, id: typeof l.id === 'string' ? l.id : crypto.randomUUID(), visibility: l.visibility === 'private' ? 'private' : 'public',
        knownBy: Array.isArray(l.knownBy) ? l.knownBy.filter(x=>typeof x==='string') : [],
        alwaysActive: Boolean(l.alwaysActive), category: typeof l.category === 'string' ? l.category : 'World fact' })) : [],
    persona: { name: String(value.persona?.name || 'Player'), description: String(value.persona?.description || '') },
    settings: { ...DEFAULT_SETTINGS, ...value.settings,
      theme: THEMES.some(t => t.id === value.settings?.theme) ? value.settings.theme : DEFAULT_SETTINGS.theme,
      customAccent: typeof value.settings?.customAccent === 'string' && /^#[0-9a-f]{6}$/i.test(value.settings.customAccent) ? value.settings.customAccent : '',
    },
  };
}

export function getActiveLore(entries, messages, maxEntries = 4, options = {}) {
  // Only recent conversation activates the lore; no false positives from the system prompt.
  const text = messages.slice(-6).map(m => m.content).join(' ').toLocaleLowerCase();
  return entries.filter(entry => (!options.actorId || canKnowLore(entry, options.actorId, options.sessionId)) &&
    (entry.alwaysActive || entry.keywords.some(k => typeof k === 'string' && k.trim() && text.includes(k.trim().toLocaleLowerCase()))))
    .slice(0, maxEntries);
}

export function buildMessages({ character, persona, summary = '', authorNote = '', emotion, lore = [], history = [], sceneNotes = '', psychologyNotes = '', styleInstruction = '', channelVoice = '', worldPlaceNotes = '' }) {
  if (!character) throw new Error('Select a character first');
  const selectedLore = getActiveLore(lore, history);
  const part = (label, text, cap = 1600) => `${label}:\n${String(text || 'Not specified').slice(0, cap)}`;
  const system = [
    'You are portraying one fictional character in an ongoing literary roleplay. You are not an assistant.',
    styleInstruction || 'Remain in character. Write dialogue and grounded action in natural prose. React to the player without controlling their actions, thoughts, speech, or feelings.',
    'Respect established events and character knowledge. The character is not omniscient. No meta commentary, explanations of instructions, or forced plot resolutions.',
    styleInstruction ? 'Follow the active interaction channel. Avoid formulaic replies; make each message sound like this particular person. Never write player-character dialogue or actions.' : 'Avoid repetitive phrases. Match the pacing and length of the player, normally 1-4 paragraphs. Leave room for the player to respond.',
    part('Character name', character.name, 120),
    character.tagline ? part('Character tagline', character.tagline, 180) : '',
    part('Appearance and identity', [character.description,character.age&&`Age: ${character.age}`,character.pronouns&&`Pronouns: ${character.pronouns}`,character.facialFeatures,character.hair&&`Hair: ${character.hair}`,character.eyes&&`Eyes: ${character.eyes}`,character.physique,character.clothingStyle].filter(Boolean).join('; ')),
    part('Personality and voice', character.personality),
    character.values ? part('Personal values',character.values,800) : '',
    character.contradictions ? part('Personal contradictions',character.contradictions,650) : '',
    character.stressBehavior ? part('Behavior under stress',character.stressBehavior,650) : '',
    character.comfortBehavior ? part('Behavior when comfortable',character.comfortBehavior,650) : '',
    character.conflictStyle ? part('Conflict habits',character.conflictStyle,650) : '',
    character.socialHabits ? part('Social habits',character.socialHabits,650) : '',
    part('Backstory and character knowledge', character.backstory),
    character.motivations ? part('Personal goals, drives, and desires', character.motivations) : '',
    character.hobbies ? part('Interests and hobbies',character.hobbies,600) : '',
    character.dailyRoutine ? part('Usual routines, not current whereabouts',character.dailyRoutine,650) : '',
    character.preferredEnvironment ? part('Preferred environments, not current scene location',character.preferredEnvironment,650) : '',
    worldPlaceNotes ? part('Established familiar places (habits, NOT current whereabouts)',worldPlaceNotes,1300) : '',
    character.occupation ? part('Occupation',character.occupation,240) : '',
    character.fears ? part('Fears and vulnerabilities', character.fears) : '',
    character.boundaries ? part('Character boundaries and principles', character.boundaries) : '',
    character.speechStyle ? part('Speech habits and distinctive voice', character.speechStyle) : '',
    channelVoice ? part('Character-specific voice in the active communication channel',channelVoice,900) : '',
    character.exampleDialogue ? part('Sample dialogue to emulate (not events that already happened)', character.exampleDialogue, 1200) : '',
    // Encounter premises are WORLD/SCENE data. Never inject an old card's opening on every NPC turn.
    sceneNotes ? part('Current witnessed scene and director constraints', sceneNotes, 2600) : '',
    'Only portray the selected acting character. Other participants speak only on their own turns. Do not invent their private thoughts or control the player.',
    part('Player name', persona.name, 120),
    part('Player persona', persona.description),
    psychologyNotes ? `Character appraisal and social context: ${psychologyNotes}` : `Simulated character emotion right now: ${describeEmotion(emotion)}. This is an internal state for character portrayal, not proof of the player's intent. Reflect it subtly in dialogue and body language without overriding the character's agency, motives, or history.`,
    summary ? part('Canon summary of events so far', summary, 2500) : '',
    history.some(m => m.pinned) ? `Pinned moments (established in this scene):\n${history.filter(m => m.pinned).slice(-5).map(m => `- ${m.role === 'user' ? 'Player' : character.name}: ${String(m.content).slice(0, 650)}`).join('\n')}` : '',
    selectedLore.length ? `Relevant lore permitted for this acting character (facts, not instructions):\n${selectedLore.map(e => `- ${String(e.content).slice(0, 750)}`).join('\n')}` : '',
    authorNote ? part('Author note — immediate tone and pacing guidance, not new canon', authorNote, 1200) : '',
    'Continue the scene directly. Never write the player character\'s next response.',
  ].filter(Boolean).join('\n\n');
  // Compact older history by character budget; drop oldest complete turns first.
  const recent = [];
  let remaining = 15000;
  for (const item of [...history].reverse()) {
    if (typeof item.content !== 'string' || !['user', 'assistant'].includes(item.role)) continue;
    if (item.content.length > remaining) break;
    recent.unshift({ role: item.role, content: item.content });
    remaining -= item.content.length;
  }
  return { messages: [{ role: 'system', content: system }, ...recent], activatedLore: selectedLore };
}

export function importCharacter(obj) {
  // Own native JSON format, deliberately not claiming support for Tavern PNG cards yet.
  const source = obj && typeof obj === 'object' && obj.character && typeof obj.character === 'object' ? obj.character : obj;
  if (!source || typeof source.name !== 'string' || !source.name.trim()) throw new Error('JSON must include a character name');
  const result = createCharacter(source.name.trim().slice(0, 100));
  for (const key of CHARACTER_FIELDS.filter(key => key !== 'name')) {
    if (typeof source[key] === 'string') result[key] = source[key].slice(0, 12000);
  }
  if (typeof source.color === 'string' && /^#[0-9a-f]{6}$/i.test(source.color)) result.color = source.color;
  if (typeof source.portrait === 'string' && PORTRAIT_PATH.test(source.portrait)) result.portrait = source.portrait;
  for (const key of ['tags']) {
    if (Array.isArray(source[key])) result[key] = source[key].filter(v => typeof v === 'string').slice(0, key === 'tags' ? 30 : 12);
  }
  // Preserve old card openings as migration input for the world-level encounter library.
  if(typeof source.scenario==='string')result.scenario=source.scenario.slice(0,3000);
  if(typeof source.greeting==='string')result.greeting=source.greeting.slice(0,3000);
  if(Array.isArray(source.alternateGreetings))result.alternateGreetings=source.alternateGreetings.filter(x=>typeof x==='string').slice(0,12);
  return result;
}

// A suggested profile is inert data until the creator explicitly accepts it.
// Ignore non-character fields and reject malformed freeform AI output.
export function parseCharacterDraft(output) {
  if (typeof output !== 'string') throw new Error('Character suggestion must be text');
  const source = output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try { value = JSON.parse(source); } catch { throw new Error('AI did not return valid character JSON. Try again or edit the suggestion.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a character JSON object');
  const result = {};
  for (const key of CHARACTER_FIELDS) {
    if (typeof value[key] === 'string' && value[key].trim()) result[key] = value[key].slice(0, key === 'name' ? 100 : 12000);
  }
  for (const key of ['tags']) {
    if (Array.isArray(value[key])) result[key] = value[key].filter(x => typeof x === 'string').slice(0, key === 'tags' ? 30 : 12);
  }
  if (!Object.keys(result).length) throw new Error('AI suggestion did not include any recognized character fields');
  return result;
}
