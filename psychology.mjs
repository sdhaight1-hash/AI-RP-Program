// Deterministic fictional appraisal, not clinical psychology or sentiment analysis.
// An event must be explicitly confirmed, witnessed, and described with authorial
// appraisal fields. Language-model narration NEVER automatically mutates this state.
export const EMOTION_NAMES=Object.freeze(['joy','distress','fear','anger','relief','hope']);
export const DEFAULT_DISPOSITION=Object.freeze({reactivity:.5,threatSensitivity:.5,optimism:.5,expressiveness:.5,forgiveness:.5});
const clamp=(v,low,high)=>Math.max(low,Math.min(high,v));
const number=(v,low,high,otherwise)=>Number.isFinite(v)?clamp(v,low,high):otherwise;
const round=v=>Math.round(v*10000)/10000;
export function normalizeDisposition(value) {
  return Object.fromEntries(Object.entries(DEFAULT_DISPOSITION).map(([key,base])=>[key,number(value?.[key],0,1,base)]));
}
export function createMind() {
  return {mood:{valence:0,arousal:.2},emotions:Object.fromEntries(EMOTION_NAMES.map(k=>[k,0])),relationships:{},reasons:[]};
}
export function normalizeMind(value) {
  const def=createMind();
  const relationships={};
  for(const [id,v] of Object.entries(value?.relationships || {})) if(typeof id==='string' && id.length<120 && v && typeof v==='object') {
    relationships[id]={trust:number(v.trust,-1,1,0),affection:number(v.affection,-1,1,0),respect:number(v.respect,-1,1,0),tension:number(v.tension,0,1,0)};
  }
  return {
    mood:{valence:number(value?.mood?.valence,-1,1,0),arousal:number(value?.mood?.arousal,0,1,.2)},
    emotions:Object.fromEntries(EMOTION_NAMES.map(k=>[k,number(value?.emotions?.[k],0,1,0)])),
    relationships,
    reasons:Array.isArray(value?.reasons)?value.reasons.filter(x=>x && typeof x.eventId==='string' && typeof x.summary==='string').slice(-30):[],
  };
}
export function normalizeAppraisal(value) {
  return {
    desirability:number(value?.desirability,-1,1,0),
    significance:number(value?.significance,0,1,.5),
    surprise:number(value?.surprise,0,1,.5),
    control:number(value?.control,0,1,.5),
    actorResponsible:typeof value?.actorResponsible==='string' && value.actorResponsible.length<120 ? value.actorResponsible : null,
    future:Boolean(value?.future),
    threatResolved:Boolean(value?.threatResolved),
  };
}
export function appraiseConfirmedEvent({mind,disposition,event,appraisal,actorId}) {
  if(!event || typeof event.id!=='string' || !Array.isArray(event.witnessIds) || !event.witnessIds.includes(actorId))throw new Error('Character did not witness this confirmed event');
  const state=normalizeMind(mind);
  if(state.reasons.some(x=>x.eventId===event.id))throw new Error('Event already appraised by this character');
  const traits=normalizeDisposition(disposition);
  const a=normalizeAppraisal(appraisal);
  const intensity=clamp(a.significance*(.6+.4*a.surprise)*(.45+1.1*traits.reactivity),0,1);
  const sign=Math.sign(a.desirability);
  const magnitude=Math.abs(a.desirability)*intensity;
  const delta={joy:0,distress:0,fear:0,anger:0,relief:0,hope:0};
  if(sign>0) {
    if(a.threatResolved)delta.relief=magnitude;
    else if(a.future)delta.hope=magnitude*(.6+.4*traits.optimism);
    else delta.joy=magnitude*(.6+.4*traits.optimism);
  } else if(sign<0) {
    delta.distress=magnitude;
    delta.fear=magnitude*(1-a.control)*(.25+.75*traits.threatSensitivity);
    if(a.actorResponsible && a.actorResponsible!==actorId)delta.anger=magnitude*(.35+.65*a.control);
  }
  for(const key of EMOTION_NAMES)state.emotions[key]=round(clamp(state.emotions[key]+delta[key],0,1));
  state.mood.valence=round(clamp(state.mood.valence + a.desirability*intensity*.35,-1,1));
  state.mood.arousal=round(clamp(state.mood.arousal + intensity*(.25+.4*a.surprise)*(1-traits.expressiveness*.15),0,1));
  if(a.actorResponsible && a.actorResponsible!==actorId && a.desirability!==0) {
    const old=state.relationships[a.actorResponsible]||{trust:0,affection:0,respect:0,tension:0};
    const shift=a.desirability*intensity*.23*(a.desirability<0 ? 1.1-traits.forgiveness*.4:1);
    old.trust=round(clamp(old.trust+shift,-1,1));
    old.tension=round(clamp(old.tension+(-Math.sign(a.desirability))*Math.abs(shift)*.8,0,1));
    state.relationships[a.actorResponsible]=old;
  }
  const strongest=Object.entries(delta).sort((a,b)=>b[1]-a[1])[0];
  state.reasons.push({eventId:event.id,summary:String(event.description||'Event').slice(0,400),primary:strongest[1]?strongest[0]:'mixed',strength:round(strongest[1]),at:event.at||Date.now()});
  state.reasons=state.reasons.slice(-30);
  return state;
}
export function advanceMindTime(value,hours) {
  if(!Number.isFinite(hours) || hours<0 || hours>24000)throw new RangeError('Elapsed hours must be between 0 and 24000');
  const mind=normalizeMind(value);
  for(const name of EMOTION_NAMES){const halfLife=name==='anger'?8:name==='fear'?3:6;mind.emotions[name]=round(mind.emotions[name]*2**(-hours/halfLife));}
  mind.mood.valence=round(mind.mood.valence*2**(-hours/36));
  mind.mood.arousal=round(.2+(mind.mood.arousal-.2)*2**(-hours/5));
  // Relationships and remembered reasons do not vanish just because time passes.
  return mind;
}
export function describeMind(value,actorName='Character') {
  const mind=normalizeMind(value);
  const strong=Object.entries(mind.emotions).filter(([_,v])=>v>.12).sort((a,b)=>b[1]-a[1]).slice(0,3);
  const rel=mind.relationships.player;
  return [
    `${actorName}'s internal emotional state is a fictional simulation, not evidence about the player's intentions.`,
    `Mood valence ${mind.mood.valence.toFixed(2)}, arousal ${mind.mood.arousal.toFixed(2)}.`,
    strong.length?`Active feelings: ${strong.map(([key,v])=>`${key} (${v.toFixed(2)})`).join(', ')}. Mixed feelings are allowed.`:'No strong short-term emotional activation.',
    rel?`Relationship with player: trust ${rel.trust.toFixed(2)}, affection ${rel.affection.toFixed(2)}, respect ${rel.respect.toFixed(2)}, unresolved tension ${rel.tension.toFixed(2)}.`:'Relationship with player is not established.',
    mind.reasons.length?`Relevant last appraisal: ${mind.reasons.at(-1).summary}`:'',
    'Do not treat numbers as hard behavioral commands. The character can conceal emotions, behave against impulse, or have conflicting motives.',
  ].filter(Boolean).join(' ');
}
