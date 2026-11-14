// Communication channels describe the player's and actor's shared perceptual medium.
// These rules constrain context and presentation; a natural-language model can still err.
export const CHANNELS = Object.freeze({
  in_person: Object.freeze({ id: 'in_person', label: 'In person', icon: '◉',
    perceptible: ['speech', 'visible_action', 'audible_sound', 'shared_environment'],
    direction: 'This is a face-to-face encounter. Write character dialogue and physically observable actions in grounded prose. Do not invent the player’s actions, inner thoughts, or speech.' }),
  phone_call: Object.freeze({ id: 'phone_call', label: 'Phone call', icon: '☎',
    perceptible: ['speech', 'audible_sound'],
    direction: 'This is an audio-only phone call. Reply as the speaking character. Write spoken dialogue with only clearly audible cues such as a pause, muffled noise, breath or laugh. NEVER narrate remote expressions, gestures, appearance, room details, camera views, or untransmitted actions. Do not invent the player’s actions or speech.' }),
  text_message: Object.freeze({ id: 'text_message', label: 'Messaging', icon: '✉',
    perceptible: ['delivered_text'],
    direction: 'This is a text-message conversation. Write ONLY the exact message text the character sends. Natural texting style, typically short, with punctuation, slang or emoji consistent with their established voice. No speaker labels, timestamps, meta commentary, scene narration, action paragraphs, markdown, or private thoughts. Do not invent messages from the player or other accounts.' }),
});

export function getChannel(id) { return CHANNELS[id] || CHANNELS.in_person; }

export function channelReceivesSignal(id, signal) {
  return getChannel(id).perceptible.includes(signal);
}

// Explicit signal filtering for current-channel observations. Legacy observations
// without signal metadata must NOT be disclosed as live phone/text perceptions.
export function channelObservations(events, channelId, actorId) {
  return (events || []).filter(e =>
    e && Array.isArray(e.witnessIds) && e.witnessIds.includes(actorId) &&
    typeof e.signal === 'string' && channelReceivesSignal(channelId, e.signal));
}

// Character-specific communication habits override generic channel formatting
// without replacing the actor's stable personality and boundaries.
const CHANNEL_VOICE_FIELDS = Object.freeze({ in_person: 'inPersonStyle', phone_call: 'phoneStyle', text_message: 'textStyle' });
export function getChannelVoice(character, channelId) {
  const key = CHANNEL_VOICE_FIELDS[getChannel(channelId).id];
  return typeof character?.[key] === 'string' ? character[key].slice(0,1600) : '';
}
