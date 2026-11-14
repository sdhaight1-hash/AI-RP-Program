// Lightweight, conservative structural diagnostics for completed NPC replies.
// These are NOT a semantic classifier; ambiguous prose must remain reviewable.
// Only the player may approve a flagged draft. No content-category filtering.
import { getChannel } from './channels.mjs';

const PLAYER_LINE = /^\s*(?:player|user|you|\{\{user\}\})\s*:\s*\S/im;
const PLAYER_ACTION = /^\s*(?:\*\s*)?(?:you|your character)\s+(?:say|reply|answer|decide|think|feel|nod|smile|walk|reach|kiss|grab|leave)(?:s|ed|ing)?\b/im;
const TEXT_STAGE = /\*[^*\n]{0,160}\b(?:smil(?:e|es|ed)|nod(?:s|ded)?|walk(?:s|ed)?|look(?:s|ed)?|shrug(?:s|ged)?|gesture(?:s|d)?|wave(?:s|d)?|turn(?:s|ed)?\s+away)\b[^*\n]{0,160}\*/i;
const TEXT_SCENE = /^\s*(?:\[(?:narrator|scene|cut to|meanwhile)\]|(?:narrator|scene|cut to|meanwhile)\s*:)/im;
const TEXT_ROLE = /^\s*(?:assistant|npc|character|player|user|you)\s*:\s*\S/im;
const TEXT_TIMESTAMP = /^\s*\[?\d{1,2}:\d{2}(?:\s*[AP]M)?\]?\s+(?:@?[\p{L}\p{N}_]+\s*:)?/imu;
const PHONE_VISUAL = /(?:\*\s*[^*\n]{0,120}\b(?:nods?|smiles?|grins?|shrugs?|waves?|gestures?|points?|glances?|looks?)\b[^*\n]{0,120}\*|\b(?:she|he|they|the (?:woman|man|character))\s+(?:nods?|smiles?|grins?|shrugs?|waves?|gestures?|points?|glances?|looks?)\b|\b(?:you (?:can )?see|on (?:your|the) screen|the camera (?:shows|pans))\b)/i;

export function inspectNpcReply(channelId, value, characterName = '') {
  const text = String(value ?? '').trim();
  const channel = getChannel(channelId).id;
  const issues = [];
  const firstName = String(characterName).trim().split(/\s+/)[0];
  const escapedName = firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const roleLine = escapedName ? new RegExp('^\\s*@?' + escapedName + '\\s*:\\s*\\S', 'mi') : null;
  const visualName = escapedName ? new RegExp('\\b' + escapedName + '\\s+(?:smiles?|grins?|nods?|shrugs?|waves?|gestures?|glances?|looks?)\\b', 'i') : null;
  if (!text) return ['The model returned an empty reply.'];
  if (PLAYER_LINE.test(text) || PLAYER_ACTION.test(text))
    issues.push('Possible player-controlled dialogue or action. The AI must not decide for your character.');
  if (channel === 'text_message') {
    if (TEXT_STAGE.test(text) || TEXT_SCENE.test(text))
      issues.push('Possible stage directions or scene narration in a text message.');
    if (TEXT_ROLE.test(text) || TEXT_TIMESTAMP.test(text) || roleLine?.test(text))
      issues.push('Possible speaker label or timestamp; the messaging interface supplies these.');
  }
  if (channel === 'phone_call' && (PHONE_VISUAL.test(text) || visualName?.test(text)))
    issues.push('Possible untransmitted visual action during an audio-only call.');
  return issues;
}

// A provisional response belongs to one immutable conversation basis. It must
// not be approved after the cast, medium, current turn, or timeline changes.
export function replyBasis(session) {
  const last = session?.messages?.at(-1);
  return {
    sceneId: session?.id || null,
    timelineId: session?.timelineId || null,
    channelId: getChannel(session?.channelId).id,
    castIds: [...(session?.castIds || [])],
    speakerId: session?.speakerId || null,
    location: session?.location || '',
    worldTime: session?.worldTime || '',
    messageCount: session?.messages?.length || 0,
    lastMessageId: last?.id || null,
    lastMessageContent: last?.content || '',
    lastSpeakerId: last?.speakerId || null,
    lastWitnessIds: [...(last?.witnessIds || [])],
  };
}

export function isReplyBasisCurrent(session, basis) {
  return Boolean(session && basis && JSON.stringify(replyBasis(session)) === JSON.stringify(basis));
}
