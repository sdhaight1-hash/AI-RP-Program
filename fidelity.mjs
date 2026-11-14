// Character fidelity probes are isolated experiments. They NEVER mutate live scenes,
// memories, relationships or the world-event ledger.
import { createSession, buildMessages } from './engine.mjs';
import { createActorContext } from './harness.mjs';
import { getChannel } from './interactions/channels.mjs';

export const FIDELITY_PROBES = Object.freeze([
  { id: 'everyday', label: 'Everyday check-in', channelId: 'text_message',
    objective: 'Casual texting style and individual voice, without melodrama.',
    playerMessage: 'hey, long day. how has yours been?' },
  { id: 'ordinary', label: 'Ordinary afternoon', channelId: 'in_person',
    objective: 'Natural small talk, initiative and believable everyday behavior.',
    playerMessage: 'So, what are you thinking about making for dinner?' },
  { id: 'disagreement', label: 'Friendly disagreement', channelId: 'in_person',
    objective: 'Personal values and boundaries without automatic agreement or hostility.',
    playerMessage: 'I think you are wrong about that, but I want to understand why you see it differently.' },
  { id: 'boundary', label: 'Respecting a boundary', channelId: 'in_person',
    objective: 'The character keeps their own preferences and agency, even when pressured.',
    playerMessage: 'You already said you would rather not discuss it. I still want an answer.' },
  { id: 'phone', label: 'Phone-only perception', channelId: 'phone_call',
    objective: 'Natural speech and audible cues, but no untransmitted visual observations.',
    playerMessage: 'Hey, you sound distracted. Is this a bad time to call?' },
  { id: 'repair', label: 'After a misunderstanding', channelId: 'text_message',
    objective: 'Emotional continuity, subtlety, and relationship-specific language.',
    playerMessage: 'I think we misunderstood each other earlier. can we talk about it?' },
]);

const ratingKeys = Object.freeze(['voice', 'consistency', 'naturalness', 'agency']);
export const FIDELITY_RATINGS = ratingKeys;
export function fidelityProfileFingerprint(character) {
  const source = ['name', 'tagline', 'handle', 'description', 'personality', 'backstory', 'motivations', 'fears', 'boundaries', 'speechStyle', 'inPersonStyle', 'phoneStyle', 'textStyle', 'exampleDialogue']
    .map(key => String(character?.[key] || '')).join('\u001f');
  // Non-security version marker, not a cryptographic hash.
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function makeFidelityProbe({ character, probeId, persona = { name: 'Player', description: '' } }) {
  if (!character?.id || !character?.name) throw new Error('Select an existing character');
  const probe = FIDELITY_PROBES.find(x => x.id === probeId);
  if (!probe) throw new Error('Unknown fidelity test scenario');
  // A repeatable behavioral probe is not the character's authored first encounter.
  const testActor = { ...character, scenario: '' };
  const session = createSession(testActor);
  session.messages = [{id: crypto.randomUUID(), role: 'user', content: probe.playerMessage,
    channelId: probe.channelId, witnessIds: [character.id]}];
  session.channelId = getChannel(probe.channelId).id;
  session.location = '';
  session.atmosphere = '';
  session.worldTime = '';
  session.summary = '';
  session.publicSummary = '';
  session.authorNote = '';
  session.direction = '';
  session.sceneEvents = [];
  session.director = { mode: 'sandbox', pace: .5, tension: .5, initiative: .5, narration: .5 };
  session.psychologyByActor = {}; // No live-session emotional baggage in this repeatable probe.
  const compiled = createActorContext({ session, characters: [testActor], actorId: character.id,
    persona, lore: [], buildMessages });
  return { probe, messages: compiled.messages, profileFingerprint: fidelityProfileFingerprint(character) };
}

export function inspectFidelityReply(probeId, reply) {
  const probe = FIDELITY_PROBES.find(x => x.id === probeId);
  if (!probe) throw new Error('Unknown fidelity test scenario');
  const text = String(reply ?? '');
  const warnings = [];
  if (!text.trim()) warnings.push('Empty response.');
  if (probe.channelId === 'text_message' && /\*(?:[^*]+)\*|\b(?:narrator|scene|the camera|cut to|meanwhile)\b\s*:/i.test(text))
    warnings.push('Possible scene narration or action formatting in a text message.');
  if (probe.channelId === 'phone_call' && /\b(?:looks? at|glances? at|nods?|smiles?|shrugs?|rolls? (?:her|his|their) eyes|waves?|gestures?)\b/i.test(text))
    warnings.push('Possible untransmitted visual cue in an audio-only call.');
  if (/\b(?:you think to yourself|you decide to|you say,?\s*["“]|your thoughts are)\b/i.test(text))
    warnings.push('Possible attribution of voluntary player thoughts, decisions, or speech.');
  if (text.length > 5000) warnings.push('Reply is unusually long for this quick interaction probe.');
  return warnings;
}

export function normalizeFidelityReviews(reviews) {
  if (!Array.isArray(reviews)) return [];
  return reviews.slice(-15).filter(r => r && FIDELITY_PROBES.some(p => p.id === r.probeId) && typeof r.reply === 'string')
    .map(r => ({
      id: typeof r.id === 'string' ? r.id.slice(0,80) : crypto.randomUUID(),
      probeId: r.probeId,
      reply: r.reply.slice(0,5000),
      model: typeof r.model === 'string' ? r.model.slice(0,250) : '',
      profileFingerprint: typeof r.profileFingerprint === 'string' ? r.profileFingerprint.slice(0,24) : '',
      reviewedAt: Number.isFinite(r.reviewedAt) ? r.reviewedAt : Date.now(),
      ratings: Object.fromEntries(ratingKeys.map(key => [key,
        Number.isInteger(r.ratings?.[key]) && r.ratings[key] >= 1 && r.ratings[key] <= 5 ? r.ratings[key] : null])),
      notes: typeof r.notes === 'string' ? r.notes.slice(0,1800) : '',
    }));
}
