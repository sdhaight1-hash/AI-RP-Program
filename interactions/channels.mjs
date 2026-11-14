// A channel describes what participants can perceive, not who can see
// private actor memories. Visibility remains witness- and timeline-scoped.
// The same catalog drives prompts, scene composition, templates and UI.
export const CHANNELS = Object.freeze({
  in_person: Object.freeze({ id:'in_person',label:'In person',icon:'◉',
    audience:'cast',kind:'spoken',description:'Shared location · speech, actions and surroundings',
    placeholder:'Your character’s dialogue or observable actions…',
    perceptible:['speech','visible_action','audible_sound','shared_environment'],
    voiceField:'inPersonStyle',
    direction:'This is a face-to-face encounter. Write dialogue and physically observable actions grounded in the shared location. Do not invent the player’s actions, inner thoughts, or speech.' }),
  phone_call: Object.freeze({ id:'phone_call',label:'Phone call',icon:'☎',
    audience:'directed',kind:'spoken',description:'Audio only · no unseen gestures or rooms',
    placeholder:'Say something on the call…',
    perceptible:['speech','audible_sound'],voiceField:'phoneStyle',
    direction:'This is an audio-only phone call. Reply as the speaking character. Write dialogue with only clearly audible cues, such as pauses, muffled noises, breathing or laughter. NEVER narrate remote gestures, expressions, appearance, camera views, untransmitted actions or the player’s thoughts and speech.' }),
  video_call: Object.freeze({ id:'video_call',label:'Webcam / video call',icon:'▣',
    audience:'cast',kind:'spoken',description:'Live video · speech and what cameras actually show',
    placeholder:'Speak or describe what your own camera shows…',
    perceptible:['speech','audible_sound','camera_visible','shared_media'],
    voiceField:'inPersonStyle',
    direction:'This is a live webcam/video call, not a shared physical room. Write natural speech, audible cues, and only gestures, expressions, objects or background details visible through the active camera frame or explicitly shared on-screen. Never claim to see off-camera spaces, hidden activity, other participants’ untransmitted surroundings, or the player’s thoughts, speech or actions. Each participant occupies their own location.' }),
  text_message: Object.freeze({ id:'text_message',label:'Text messages',icon:'✉',
    audience:'directed',kind:'written',description:'Private text · only transmitted message content',
    placeholder:'Write a private text message…',
    perceptible:['delivered_text'],voiceField:'textStyle',
    direction:'This is a private text-message conversation. Write ONLY the exact message text the character sends, naturally in their established texting style. No scene narration, action paragraphs, speaker labels, timestamps, metadata or untransmitted private thoughts. Do not invent messages from the player or other accounts.' }),
  social_dm: Object.freeze({ id:'social_dm',label:'Social media DM',icon:'＠',
    audience:'directed',kind:'written',description:'Private direct message · handles, replies and shared posts',
    placeholder:'Write a direct message…',
    perceptible:['delivered_text','shared_media'],voiceField:'textStyle',
    direction:'This is a private social-media direct message, not a public post. Write ONLY the exact message the character sends, using their established online voice and appropriate social-platform conventions. Mention handles or shared media only when known in the conversation. Do not invent uploads, screenshots, feed activity, other users’ replies, timestamps, stage directions, or player actions.' }),
  social_thread: Object.freeze({ id:'social_thread',label:'Social feed / thread',icon:'#',
    audience:'cast',kind:'written',description:'Visible thread · authored posts are not private DMs',
    placeholder:'Write a post or reply for the current thread…',
    perceptible:['delivered_text','shared_media'],voiceField:'textStyle',
    direction:'This is a shared social-media comment thread or public-facing post. Write ONLY this character’s own post/reply in their established online voice. Do not write invented comments by other accounts, platform metrics, notifications, timestamps, offline actions, or unsupported outside-world audience reactions. Visibility to NPCs is limited to the explicitly witnessed participants in this scene; a public feed is NOT universal knowledge across the fictional world.' }),
  email: Object.freeze({ id:'email',label:'Email',icon:'✉',
    audience:'directed',kind:'written',description:'Asynchronous email · deliberate written correspondence',
    placeholder:'Compose the body of an email…',
    perceptible:['delivered_text','shared_media'],voiceField:'textStyle',
    direction:'This is an asynchronous email exchange. Write the email body in this character’s established voice, with an appropriate greeting/closing only if natural. Do not invent sent attachments, unseen inbox messages, delivery receipts, headers, subject lines, timestamps, stage directions, or player replies. The interface handles message attribution.' }),
});

export const CHANNEL_OPTIONS=Object.freeze(Object.values(CHANNELS));
export function getChannel(id) { return CHANNELS[id] || CHANNELS.in_person; }
export const channelReceivesSignal=(id,signal)=>getChannel(id).perceptible.includes(signal);
export const channelAudience=id=>getChannel(id).audience;
export const isWrittenChannel=id=>getChannel(id).kind==='written';

// No legacy untyped scene observations are disclosed in a remote conversation.
export function channelObservations(events, channelId, actorId) {
  return (events || []).filter(e =>
    e && Array.isArray(e.witnessIds) && e.witnessIds.includes(actorId) &&
    typeof e.signal === 'string' && channelReceivesSignal(channelId, e.signal));
}

export function getChannelVoice(character, channelId) {
  const key=getChannel(channelId).voiceField;
  return typeof character?.[key]==='string' ? character[key].slice(0,1600):'';
}
