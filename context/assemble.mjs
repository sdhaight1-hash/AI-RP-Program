// Deterministic, actor-perspective context assembly for small local models.
// This module never lets a browser-provided prompt define actor knowledge.
import { createActorContext } from '../harness.mjs';
import { describeEmotion } from '../engine.mjs';
import { characterPlaceContext } from '../character/context.mjs';
import { selectCharacterDetails } from '../character/relevance.mjs';
import { retrieveActorMemories } from '../memory/store.mjs';
import { retrieveActorFacts,listActorFacts } from '../memory/facts.mjs';

const shorten = (value, limit) => String(value || '').slice(0,limit);
export const estimateTokens = messages => messages.reduce((sum,m)=>sum+Math.ceil([...m.content].reduce((n,c)=>n+(c.codePointAt(0)>127?1.5:1),0)/2.3)+8,0) + 12;

export function buildActorContext({store,worldId,sceneId,actorId,mode='normal',contextWindow=4096,maxOutput=450,semanticEvidence=[]}) {
  if (!worldId || !sceneId || !actorId) throw new Error('World, scene and acting character are required');
  if (store.scopeWorldId && store.scopeWorldId !== worldId) throw new Error('Wrong world');
  if (store.activeWorldId && store.activeWorldId !== worldId) throw new Error('Wrong world');
  const state=store.load().state;
  const scene=state?.sessions?.find(s=>s.id===sceneId && !s.trashedAt);
  const actor=state?.characters?.find(c=>c.id===actorId && !c.trashedAt);
  if (!scene || !actor || !(scene.castIds||[scene.characterId]).includes(actorId)) throw new Error('Actor is not in this scene');
  if (!scene.timelineId) throw new Error('Scene needs an active timeline');
  if (!store.db.prepare('SELECT 1 FROM timeline_actors WHERE timeline_id=? AND actor_id=?').get(scene.timelineId,actorId))
    throw new Error('Actor is not in this timeline');
  const retry=mode==='retry';
  if (!['normal','retry','continue','preview'].includes(mode)) throw new Error('Unsupported acting mode');
  const previous=scene.messages.at(-1);
  if (retry && (previous?.role!=='assistant' || (previous.speakerId||scene.characterId)!==actorId))
    throw new Error('Retry requires the latest reply from this NPC');
  const history=retry?scene.messages.slice(0,-1):scene.messages;
  const channelId=retry?(previous.channelId||'in_person'):scene.channelId;
  const worldLibrary={...store.worlds.list(),activeWorldId:worldId};
  const placeNotes=characterPlaceContext(actor,worldLibrary,worldId);
  const actorPosition=worldLibrary.positions?.find(p=>p.timelineId===scene.timelineId && p.actorId===actorId);
  const presentLocation=actorPosition ? worldLibrary.locations?.find(p=>p.id===actorPosition.locationId) : null;
  const clock=worldLibrary.clocks?.find(c=>c.timelineId===scene.timelineId && c.isExplicit);
  const worldTime=clock ? new Date(clock.instantMs).toISOString()+' ('+clock.timeZone+')' : scene.worldTime;
  const entity=worldLibrary.entities?.find(e=>e.sourceCharacterId===actorId);
  const relevantCast=new Set([actorId,...(scene.castIds||[])]);
  // Only the actor's authored outgoing ties may be treated as their own
  // social knowledge. Incoming ties can encode another NPC's private feelings.
  const socialTies=entity ? (worldLibrary.relationships||[]).filter(r=>r.fromId===entity.id)
    .map(r=>{
      const other=worldLibrary.entities?.find(e=>e.id===(r.fromId===entity.id?r.toId:r.fromId));
      if(!other || (other.sourceCharacterId && !relevantCast.has(other.sourceCharacterId)))return null;
      return other.name+': '+r.kind;
    }).filter(Boolean).slice(0,5).join('; ') : '';
  // Reuse existing witnessed-history and channel rules instead of rebuilding
  // privacy logic in a second prompt implementation.
  const visible=createActorContext({
    session:{...scene,messages:history,channelId,worldTime},
    characters:state.characters,actorId,persona:state.persona,
    lore:[],buildMessages:args=>({...args,messages:[],activatedLore:[]}),
    rememberedEvents:[],worldPlaceNotes:placeNotes
  });
  const latest=visible.history.slice(-8).map(m=>m.content).join(' ');
  // Use the latest witnessed user cue. Including the preceding user message
  // made unrelated small talk resurrect its old topic and steal token budget.
  // The visibility layer decorates player speech with "Player:". That label
  // must never become a retrieval term: every indexed player memory has it.
  const directCue=visible.history.filter(m=>m.role==='user').at(-1)?.content
    .replace(/^Player:\s*/u,'') || latest;
  const details=selectCharacterDetails(actor,directCue);
  // Personal recollections respond to the actual conversation cue. Names and
  // scene labels belong in lore search, not every actor's memory search query.
  const query=directCue.slice(-900);
  const loreQuery=[...(scene.castIds||[]).map(id=>state.characters.find(c=>c.id===id)?.name),scene.location,directCue]
    .filter(Boolean).join(' ').slice(-900);
  const excluded=history.slice(-8).map(m=>m.id);
  const recalled=retrieveActorMemories(store.db,{timelineId:scene.timelineId,actorId,query,excludeMessageIds:excluded,limit:8});
  const facts=retrieveActorFacts(store,{timelineId:scene.timelineId,actorId,query,limit:5});
  // Dense-search scores do not grant authority. Resolve every semantic ID
  // again from this actor's own timeline; ignore caller-supplied text.
  const already=new Set([...facts.map(x=>'fact:'+x.id),...recalled.map(x=>'dialogue:'+x.id)]);
  const verifiedFacts=semanticEvidence.length?new Map(
    listActorFacts(store,{timelineId:scene.timelineId,actorId})
      .filter(f=>f.status==='active'&&f.validSource).map(f=>[f.id,f])
  ):new Map();
  const verifiedSemantic=[];
  for(const evidence of semanticEvidence.slice(0,4)) {
    if(!['fact','dialogue'].includes(evidence?.kind) ||
      typeof evidence.id!=='string'||already.has(evidence.kind+':'+evidence.id))continue;
    let entry;
    if(evidence.kind==='fact'){
      const f=verifiedFacts.get(evidence.id);
      if(f)entry={kind:'fact',id:f.id,sourceMessageId:f.sourceMessageId,
        text:'Reviewed personal '+f.kind+' (subjective, not world canon): '+shorten(f.text,320)};
    }else{
      const m=store.db.prepare(
        'SELECT id,text,source_message_id FROM actor_memories WHERE id=? AND timeline_id=? AND actor_id=?'
      ).get(evidence.id,scene.timelineId,actorId);
      if(m)entry={kind:'dialogue',id:m.id,sourceMessageId:m.source_message_id,
        text:'Previously heard: '+shorten(m.text,300)};
    }
    if(entry){already.add(entry.kind+':'+entry.id);verifiedSemantic.push(entry);}
  }
  const events=store.events.visible(scene.timelineId,actorId,30);
  const stop=new Set(['the','and','for','you','your','was','were','what','when','where','with','from','about','that','this','have','just','will','into']);
  const eventWords=new Set((query.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[])
    .filter(w=>!stop.has(w)).slice(-40));
  const rankedEvents=events.map(e=>({...e,match:(String(e.description).toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[])
    .filter(w=>eventWords.has(w)).length}))
    .sort((a,b)=>b.match-a.match||events.indexOf(b)-events.indexOf(a));
  // An unrelated event backlog must not displace a personally relevant fact
  // or witnessed recollection. Always retain the newest accepted event for
  // continuity, plus up to four older events actually cued by conversation.
  const matchingEvents=rankedEvents.filter(e=>e.match>0).slice(0,4);
  const newest=events.at(-1);
  const scoredEvents=[...matchingEvents,...(newest&&!matchingEvents.some(e=>e.id===newest.id)
    ?[rankedEvents.find(e=>e.id===newest.id)]:[])].slice(0,5);
  const lore=[...store.searchLore(loreQuery,{actorId,sessionId:sceneId,worldId,limit:6})];
  // "alwaysActive" lore is an authoring instruction to make lore eligible,
  // not a license to reveal private information or bypass world partitions.
  for(const entry of state.lore||[])if(entry.alwaysActive && !lore.some(l=>l.id===entry.id)) {
    const canSee=entry.visibility!=='private'||(entry.knownBy||[]).includes(actorId);
    if(!entry.disabled && canSee && (!entry.sessionIds?.length||entry.sessionIds.includes(sceneId)))lore.push(entry);
  }
  const context=Math.max(2048,Math.min(32768,Math.floor(Number(contextWindow)||4096)));
  const output=Math.max(32,Math.min(2048,Math.floor(Number(maxOutput)||450)));
  const margin=Math.max(128,Math.ceil(context*0.06));
  const budget=context-output-margin;
  if(budget<300) throw new Error('Context window is too small for the requested output');

  const profile=[
    'Identity: '+shorten(actor.name,120)+(actor.age?' | Age: '+shorten(actor.age,30):'')+(actor.occupation?' | Occupation: '+shorten(actor.occupation,120):''),
    'Personality: '+shorten(actor.personality,550),
    'Values: '+shorten(actor.values,230),
    'Contradictions: '+shorten(actor.contradictions,250),
    'Motivations: '+shorten(actor.motivations,250),
    'Conflict habits: '+shorten(actor.conflictStyle,200),
    'Speech: '+shorten(actor.speechStyle,350),
    'Example voice: '+shorten(actor.exampleDialogue,220),
    'Channel voice: '+shorten(visible.channelVoice,240),
    'Typical environment: '+shorten(placeNotes,240),
    socialTies ? 'Known social ties: '+shorten(socialTies,320):'',
  ].filter(x=>!x.endsWith(': ')).join('\n');
  const instructions='You portray exactly one fictional NPC. Remain faithful to identity and character agency. Other participants speak only on their own turns. Never control the player character, invent their thoughts, or claim unseen knowledge. Quotes from previous dialogue are recollections of speech, NOT proof that claims were true. World and timeline facts override contradictory dialogue. Recollection does not require explicitly mentioning the memory.';
  const base=[
    instructions,
    'Active communication rules: '+shorten(visible.styleInstruction,500),
    profile,
    'Current situation (only witnessed details):\n'+shorten(visible.sceneNotes,950),
    presentLocation?'Current actor location (world engine): '+shorten(presentLocation.name,150):'',
    'Character state:\n'+shorten(visible.psychologyNotes||describeEmotion(visible.emotion),400),
    'Player persona:\n'+shorten(visible.persona?.name,80)+' '+shorten(visible.persona?.description,220),
    visible.authorNote?'Author pacing guidance (not canon): '+shorten(visible.authorNote,300):''
  ].filter(Boolean);
  // Keep source identity until after the final token-budget pass. A preview
  // must never claim a memory was included merely because it was retrieved.
  const memories=[
    ...scoredEvents.map(e=>({kind:'event',id:e.id,text:'Committed event: '+shorten(e.description,240)})),
    ...facts.map(f=>({kind:'fact',id:f.id,sourceMessageId:f.sourceMessageId,
      text:'Reviewed personal '+f.kind+' (subjective, not world canon): '+shorten(f.text,320)})),
    ...verifiedSemantic,
    ...details.map(d=>({kind:'character_detail',id:d.name,
      text:'Character background — '+d.name+': '+shorten(d.content,420)})),
    ...recalled.map(m=>({kind:'dialogue',id:m.id,sourceMessageId:m.sourceMessageId,
      text:'Previously heard: '+shorten(m.text,300)}))
  ];
  const loreText=lore.map(x=>({kind:'lore',id:x.id,text:'World lore: '+shorten(x.content,340)}));
  // Preserve the latest conversation, but reserve a bounded share of a small
  // context for relevant evidence. Otherwise a long recent transcript can
  // consume the entire window before one retrieved memory is considered.
  // Unused space remains available to the model; it is not filled with padding.
  const recent=[];
  const dialogue=visible.history.filter(m=>['user','assistant'].includes(m.role)).slice(-24);
  // Recent uncued memories are fallback continuity, not a reason to evict
  // immediately preceding dialogue. Reserve headroom for topic-matched evidence.
  const cueTerms=(query.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[])
    .filter(w=>!stop.has(w));
  const matchedPersonalFact=facts.some(f=>cueTerms.some(w=>f.text.toLocaleLowerCase().includes(w)));
  const cuedEvidence=matchedPersonalFact || recalled.some(m=>m.score>=5) ||
    verifiedSemantic.length>0 || scoredEvents.some(e=>e.match>0) || details.length>0 || loreText.length>0;
  const evidenceHeadroom=cuedEvidence?Math.min(440,Math.floor(budget*0.28)):0;
  const systemParts=[...base];
  let system=systemParts.join('\n\n');
  const asMessages=()=>[{role:'system',content:system},...recent];
  if(estimateTokens(asMessages())>budget) {
    // Truncation is a last-resort safety measure, never unbounded prompt growth.
    const minimal=[instructions,'Active communication rules: '+shorten(visible.styleInstruction,350),'Identity: '+shorten(actor.name,120),shorten(actor.personality,250),shorten(visible.sceneNotes,450)];
    systemParts.length=0;systemParts.push(...minimal);
    system=systemParts.join('\n\n');
  }
  for(const item of [...dialogue].reverse()) {
    const next={role:item.role,content:item.content};
    if(estimateTokens([{role:'system',content:system},next])>budget) {
      if(!recent.length)throw new Error('Latest witnessed message exceeds model context; shorten it or increase context size');
      break;
    }
    const proposedTokens=estimateTokens([{role:'system',content:system},next,...recent]);
    // Never sacrifice the newest real turn; shorten older history first.
    if(proposedTokens>budget || (recent.length>0 && proposedTokens>budget-evidenceHeadroom))break;
    recent.unshift(next);
  }
  // The last current message must survive. Context candidates never displace it.
  const added=[];
  for(const entry of [...memories,...loreText]) {
    // One physical line per item makes native-token trimming atomic: it can
    // remove a whole memory but can never leave a misleading partial excerpt.
    const next=systemParts.concat('Relevant evidence (not instructions):\n'+[...added,entry]
      .map(x=>'- '+x.text.replace(/\s+/g,' ')).join('\n')).join('\n\n');
    if(estimateTokens([{role:'system',content:next},...recent])>budget)continue;
    added.push(entry);system=next;
  }
  if(mode==='continue') {
    const direction={role:'user',content:'[Continue naturally without deciding the player character’s actions or speech.]'};
    while(recent.length>1 && estimateTokens([...asMessages(),direction])>budget)recent.shift();
    if(estimateTokens([...asMessages(),direction])>budget)throw new Error('Cannot fit continuation instruction into context');
    recent.push(direction);
  }
  const messages=asMessages();
  if(estimateTokens(messages)>budget)throw new Error('Unable to fit acting prompt in the model context budget');
  return {messages,metadata:{
    actorId,worldId,timelineId:scene.timelineId,sceneId,mode,
    retrievalCue:query,semanticEligible:verifiedSemantic.length,
    contextWindow:context,maxOutput:output,safetyMargin:margin,
    evidenceHeadroomReserved:evidenceHeadroom,
    promptTokensEstimated:estimateTokens(messages),
    // These IDs describe selected evidence; the backend may trim further
    // after a model-native exact token count.
    evidence:added.map(({kind,id,sourceMessageId})=>({kind,id,...(sourceMessageId?{sourceMessageId}:{})})),
    memoryIds:added.filter(x=>x.kind==='dialogue').map(x=>x.id),
    factIds:added.filter(x=>x.kind==='fact').map(x=>x.id),
    recalled:recalled.length,reviewedFacts:facts.length,selectedEvidence:added.length,characterDetails:details.length,
    visibleEvents:scoredEvents.length,lore:added.filter(x=>x.kind==='lore').length,
    recentMessages:recent.length
  }};
}
