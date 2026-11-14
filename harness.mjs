import { describeMind } from './psychology.mjs';
import { getChannel, channelObservations } from './interactions/channels.mjs';
// Deterministic orchestration primitives. No LLM output can commit world events here.
const id = () => crypto.randomUUID();
const MODES = new Set(['manual', 'natural', 'round-robin']);
export const EVENT_KINDS = Object.freeze(['observation', 'action', 'revelation', 'relationship', 'world-change']);

export function normalizeScene(session, characters = []) {
  const known = new Set(characters.map(c => c.id));
  const raw = Array.isArray(session?.castIds) ? session.castIds : [session?.characterId];
  const castIds = [...new Set(raw.filter(cid => typeof cid === 'string' && known.has(cid)))];
  if (!castIds.length && known.has(session?.characterId)) castIds.push(session.characterId);
  return {
    castIds,
    speakerId: castIds.includes(session?.speakerId) ? session.speakerId : (castIds[0] || null),
    speakerMode: MODES.has(session?.speakerMode) ? session.speakerMode : 'natural',
    channelId: getChannel(session?.channelId).id,
    location: typeof session?.location === 'string' ? session.location.slice(0, 250) : '',
    worldTime: typeof session?.worldTime === 'string' ? session.worldTime.slice(0, 120) : '',
    atmosphere: typeof session?.atmosphere === 'string' ? session.atmosphere.slice(0, 1200) : '',
    direction: typeof session?.direction === 'string' ? session.direction.slice(0, 2000) : '',
    publicSummary: typeof session?.publicSummary === 'string' ? session.publicSummary.slice(0, 2500) : '',
    sceneEvents: Array.isArray(session?.sceneEvents) ? session.sceneEvents.filter(e => e && typeof e.id === 'string' && EVENT_KINDS.includes(e.kind)).slice(-120) : [],
  };
}

export function chooseSpeaker(session, characters, history = session.messages || []) {
  const eligible = (session.castIds || [session.characterId]).filter(cid => characters.some(c => c.id === cid && !c.trashedAt));
  if (!eligible.length) return null;
  if (session.speakerMode === 'manual') return eligible.includes(session.speakerId) ? session.speakerId : eligible[0];
  const lastUser = [...history].reverse().find(m => m.role === 'user');
  if (session.speakerMode !== 'round-robin' && lastUser) {
    // Explicit @mention wins. Do not interpret general sentiment or intentions.
    for (const cid of eligible) {
      const name = characters.find(c => c.id === cid).name;
      const mentions = [name, name.split(' ')[0]].filter(Boolean);
      if (mentions.some(n => new RegExp(`@${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(lastUser.content))) return cid;
    }
  }
  const lastActor = [...history].reverse().find(m => m.role === 'assistant' && eligible.includes(m.speakerId));
  const pos = lastActor ? eligible.indexOf(lastActor.speakerId) : -1;
  return eligible[(pos + 1) % eligible.length];
}

export function actorVisibleHistory(session, actorId, characters, history = session.messages) {
  const cast = new Set(session.castIds || [session.characterId]);
  return history.filter(m => !Array.isArray(m.witnessIds) || m.witnessIds.includes(actorId))
    .map(m => {
      if (m.role === 'user') return { role: 'user', content: `Player: ${m.content}`, pinned: m.pinned };
      const speakerId = m.speakerId || session.characterId;
      if (speakerId === actorId) return { role: 'assistant', content: m.content, pinned: m.pinned };
      if (!cast.has(speakerId)) return null;
      const name = characters.find(c => c.id === speakerId)?.name || 'Another character';
      const observation = m.channelId === 'text_message' ? `Received text from ${name}` : m.channelId === 'phone_call' ? `Heard ${name} on the call` : `Observed ${name} speaking or acting`;
      return { role: 'user', content: `[${observation}]\n${m.content}`, pinned: m.pinned };
    }).filter(Boolean);
}

export function canKnowLore(entry, actorId, sessionId = null) {
  if (entry?.disabled) return false;
  if (entry?.sessionIds?.length && !entry.sessionIds.includes(sessionId)) return false;
  if (entry?.visibility === 'private') return Array.isArray(entry.knownBy) && entry.knownBy.includes(actorId);
  return true;
}

export function createSceneEvent({ kind = 'observation', description, witnessIds = [], at = Date.now(), sourceMessageId = null }) {
  if (!EVENT_KINDS.includes(kind)) throw new Error('Unknown world event kind');
  if (typeof description !== 'string' || !description.trim() || description.length > 3000) throw new Error('Event description must contain 1–3000 characters');
  return { id: id(), kind, description: description.trim(), witnessIds: [...new Set(witnessIds.filter(x => typeof x === 'string'))], at, sourceMessageId };
}

export function actorVisibleEvents(session, actorId, limit = 8) {
  return (session.sceneEvents || []).filter(e => Array.isArray(e.witnessIds) && e.witnessIds.includes(actorId)).slice(-limit);
}

export function archiveCharacter(state, characterId) {
  const c = state.characters.find(x => x.id === characterId);
  if (!c) throw new Error('Character not found');
  c.trashedAt = Date.now();
  // Keep the original character record and speaker IDs for historical continuity.
  for (const s of state.sessions) if (s.speakerId === characterId) {
    s.speakerId = s.castIds?.find(cid => cid !== characterId && !state.characters.find(ch => ch.id === cid)?.trashedAt) || null;
  }
  return c;
}

export function archiveSession(state, sessionId) {
  const session = state.sessions.find(s => s.id === sessionId);
  if (!session) throw new Error('Scene not found');
  session.trashedAt = Date.now();
  if (state.activeSessionId === sessionId) state.activeSessionId = state.sessions.find(s => !s.trashedAt)?.id || null;
  return session;
}

export function duplicateSession(state, sessionId) {
  const source = state.sessions.find(s => s.id === sessionId);
  if (!source || source.trashedAt) throw new Error('Scene not available');
  const copy = structuredClone(source);
  copy.id = id(); copy.title = `${source.title} (branch)`; copy.updatedAt = Date.now();
  copy.messages = copy.messages.map(m => ({ ...m, id: id() }));
  copy.sceneEvents = (copy.sceneEvents || []).map(e => ({ ...e, id: id(), sourceMessageId: null }));
  copy.trashedAt = null; copy.parentSceneId = source.id;
  state.sessions.unshift(copy); state.activeSessionId = copy.id;
  return copy;
}

export function createActorContext({ session, characters, actorId, persona, lore, buildMessages, rememberedEvents = [] }) {
  const actor = characters.find(c => c.id === actorId && !c.trashedAt);
  if (!actor || !(session.castIds || [session.characterId]).includes(actor.id)) throw new Error('Actor is not eligible for this scene');
  const history = actorVisibleHistory(session, actorId, characters);
  const candidateLore = lore.filter(entry => canKnowLore(entry, actorId, session.id));
  const castNames = (session.castIds || []).filter(cid => cid !== actorId).map(cid => characters.find(c => c.id === cid)?.name).filter(Boolean);
  const channel = getChannel(session.channelId);
  const inPerson = channel.id === 'in_person';
  const seenEvents = inPerson ? actorVisibleEvents(session,actorId) : channelObservations(session.sceneEvents,channel.id,actorId);
  const actingCharacter = inPerson ? actor : { ...actor, scenario: '' };
  const director=session.director || {mode:'collaborative'};
  const directorNotes=director.mode==='sandbox'?'Sandbox: avoid forcing planned plot turns or conveniently timed interruptions.':director.mode==='directed'?'Directed: favor established scene goals and authored beats when plausible; never force player decisions.':'Collaborative: offer plausible opportunities and balanced pacing without railroading.';
  const sceneNotes = [inPerson ? `Shared location: ${session.location || 'Unspecified'}` : 'Remote communication: participants stay in their own physical locations; do not assume they can see each other.', `Time: ${session.worldTime || 'Unspecified'}`,
    `Interaction channel: ${channel.label}. Perception limits: ${channel.perceptible.join(', ')}.`,
    inPerson && session.atmosphere && `Atmosphere: ${session.atmosphere}`, castNames.length && `Other present characters: ${castNames.join(', ')}`,
    directorNotes,
    `Scene controls (0-1): pacing ${Number(director.pace??.5).toFixed(2)}, tension ${Number(director.tension??.5).toFixed(2)}, initiative ${Number(director.initiative??.5).toFixed(2)}, narration ${Number(director.narration??.5).toFixed(2)}. Treat as tendencies, not quotas.`,
    session.direction && `Scene direction (style and pacing, never overriding agency): ${session.direction}`,
    seenEvents.length && `Events this character actually witnessed:\n${seenEvents.map(e => `- ${e.description}`).join('\n')}`,
    rememberedEvents.length && `Previously committed events this character knows (not necessarily visible through the current channel):\n${rememberedEvents.slice(-12).map(e=>`- ${String(e.description).slice(0,450)}`).join('\n')}`].filter(Boolean).join('\n');
  const summary = inPerson ? ((session.castIds || []).length > 1 ? session.publicSummary : (session.summary || '')) : ''; // Do not inject unseen shared-scene narration in remote channels.
  const assembled = buildMessages({ character: actingCharacter, persona, summary, authorNote: session.authorNote,
    emotion: session.emotionByActor?.[actorId] || session.emotion,
    lore: candidateLore, history, sceneNotes, styleInstruction: channel.direction,
    psychologyNotes: session.psychologyByActor?.[actorId] ? describeMind(session.psychologyByActor[actorId],actor.name) : '' });
  assembled.actorId = actorId;
  return assembled;
}

export function purgeArchived(state, kind, objectId) {
  if (kind === 'scene') {
    const item=state.sessions.find(s=>s.id===objectId && s.trashedAt);
    if(!item) throw new Error('Archive the scene before permanent removal');
    state.sessions=state.sessions.filter(s=>s.id!==objectId);
    if(state.activeSessionId===objectId) state.activeSessionId=state.sessions.find(s=>!s.trashedAt)?.id||null;
    return;
  }
  if (kind !== 'character') throw new Error('Invalid library item type');
  const ch=state.characters.find(c=>c.id===objectId && c.trashedAt);
  if(!ch) throw new Error('Archive the character before permanent removal');
  if(state.sessions.some(s=>s.characterId===objectId || s.castIds?.includes(objectId) || s.messages?.some(m=>m.speakerId===objectId || m.witnessIds?.includes(objectId)))) {
    throw new Error('Character is still referenced by a scene. Purge those scenes first or keep this character archived.');
  }
  state.characters=state.characters.filter(c=>c.id!==objectId);
}
