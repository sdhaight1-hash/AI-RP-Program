// Deterministic evidence-funnel evaluation for the real SQLite memory pipeline.
// No external model, judge, vector server, network, or npm dependency.
import { pathToFileURL } from 'node:url';
import { StudioStore } from '../storage.mjs';
import { createCharacter, makeInitialState } from '../engine.mjs';
import { addActorFact, revokeActorFact, retrieveActorFacts } from '../memory/facts.mjs';
import { retrieveActorMemories } from '../memory/store.mjs';
import { buildActorContext, estimateTokens } from '../context/assemble.mjs';

const WINDOW_SIZES=[2048,4096];
const source=(id,content,witnessIds,sentAt,pinned=false)=>({
  id,role:'user',content,witnessIds,sentAt,pinned
});
const keyFor=e=>e.kind==='dialogue'?'dialogue:'+e.sourceMessageId:e.kind+':'+e.id;
const round=x=>Math.round(x*1000)/1000;
const average=values=>values.length?round(values.reduce((sum,x)=>sum+x,0)/values.length):0;

function makeCorpus() {
  const store=new StudioStore(':memory:');
  try {
    const state=makeInitialState();
    const actor=state.characters[0],other=createCharacter('Private correspondent');
    state.characters.push(other);
    const scene=state.sessions[0];
    scene.castIds=[actor.id,other.id];
    scene.messages=[
      source('attic','The blue ceramic compass was left in the old attic.',[actor.id],1001),
      source('gate','The greenhouse entrance code is amber-reed.',[actor.id],1002,true),
      source('pendant','The silver pendant rests beneath the old oak bench.',[actor.id],1003),
      source('secret','The vault passphrase is indigo-falcon.',[other.id],1004),
      source('promise','I promise to repair the copper lantern in the observatory.',[actor.id],1005),
      source('festival-old','The festival begins at noon.',[actor.id],1006),
      source('festival-new','Correction: the festival now begins at dusk.',[actor.id],1007),
      source('bridge','The wooden bridge lies east of the vineyard.',[actor.id],1008),
      source('revoked','Jasper is never to be trusted with the ledger.',[actor.id],1009)
    ];
    // Long session ensures gold dialogue is not trivially available in the
    // rolling conversation window or newest-12 fallback.
    for(let i=0;i<52;i++)scene.messages.push(
      source('distractor-'+i,'Ordinary harbor report '+i+': the weather remained calm.',
        [actor.id],2000+i));
    scene.messages.push(source('eval-cue','Do you remember the attic?', [actor.id],9000));
    store.save(state,0);

    const saved=store.load().state.sessions[0];
    const timelineId=saved.timelineId,sceneId=saved.id;
    const worldId=store.worlds.list().timelines.find(x=>x.id===timelineId).worldId;
    const promise=addActorFact(store,{sceneId,actorId:actor.id,
      sourceMessageId:'promise',kind:'promise',
      text:'The player promised to repair the copper lantern in the observatory.'});
    const oldFestival=addActorFact(store,{sceneId,actorId:actor.id,
      sourceMessageId:'festival-old',kind:'belief',text:'The festival begins at noon.'});
    const festival=addActorFact(store,{sceneId,actorId:actor.id,
      sourceMessageId:'festival-new',kind:'belief',
      text:'Correction: the festival now begins at dusk.',supersedesId:oldFestival.id});
    const bridge=addActorFact(store,{sceneId,actorId:actor.id,
      sourceMessageId:'bridge',kind:'observation',
      text:'The wooden bridge lies east of the vineyard.'});
    const revoked=addActorFact(store,{sceneId,actorId:actor.id,
      sourceMessageId:'revoked',kind:'belief',
      text:'Jasper must never be trusted with the ledger.'});
    revokeActorFact(store,{id:revoked.id,timelineId,actorId:actor.id});

    // Fork while the bridge memory is still source-valid. Inherited history
    // should remain frozen even after the parent changes the source.
    const child=store.worlds.forkTimeline({timelineId,name:'Earlier continuity'});
    const updated=store.load();
    updated.state.sessions[0].messages.find(m=>m.id==='bridge').content=
      'The wooden bridge was removed after the flood.';
    updated.state.sessions[0].messages.splice(-1,0,
      source('parent-only','The hidden telescope is stored in the harbor loft.',[actor.id],8500));
    store.save(updated.state,updated.revision);
    return {store,actorId:actor.id,otherId:other.id,worldId,sceneId,timelineId,
      childTimelineId:child.id,ids:{
        promise:promise.id,festival:festival.id,oldFestival:oldFestival.id,
        bridge:bridge.id,revoked:revoked.id
      }};
  }catch(error){store.close();throw error;}
}

function setCue(f,query) {
  const current=f.store.load();
  const cue=current.state.sessions[0].messages.find(x=>x.id==='eval-cue');
  cue.content=query;
  f.store.save(current.state,current.revision);
}

function rawCandidates(f,query) {
  const facts=retrieveActorFacts(f.store,{timelineId:f.timelineId,
    actorId:f.actorId,query,limit:5}).map(x=>'fact:'+x.id);
  const dialogue=retrieveActorMemories(f.store.db,{timelineId:f.timelineId,
    actorId:f.actorId,query,excludeMessageIds:['eval-cue'],limit:8})
    .map(x=>'dialogue:'+x.sourceMessageId);
  return {facts,dialogue};
}

function inStore(f,expectedKey) {
  const [kind,id]=expectedKey.split(':');
  if(kind==='fact')return Boolean(f.store.db.prepare(
    "SELECT id FROM actor_facts WHERE id=? AND timeline_id=? AND actor_id=? AND status='active'"
  ).get(id,f.timelineId,f.actorId));
  return Boolean(f.store.db.prepare(
    'SELECT id FROM actor_memories WHERE timeline_id=? AND actor_id=? AND source_message_id=?'
  ).get(f.timelineId,f.actorId,id));
}

function evaluateQuestion(f,definition) {
  setCue(f,definition.query);
  const raw=rawCandidates(f,definition.query);
  const windows={};
  for(const size of WINDOW_SIZES) {
    const prompt=buildActorContext({store:f.store,worldId:f.worldId,sceneId:f.sceneId,
      actorId:f.actorId,contextWindow:size,maxOutput:350});
    const included=new Set(prompt.metadata.evidence.map(keyFor));
    const estimate=estimateTokens(prompt.messages);
    const allowed=prompt.metadata.contextWindow-prompt.metadata.maxOutput-prompt.metadata.safetyMargin;
    windows[size]={
      supported:definition.gold.filter(k=>included.has(k)),
      promptTokens:estimate,allowed,withinBudget:estimate<=allowed,
      selectedEvidence:prompt.metadata.selectedEvidence
    };
  }
  const located=definition.gold.map(k=>{
    const [kind]=k.split(':');
    const rank=(kind==='fact'?raw.facts:raw.dialogue).indexOf(k)+1;
    return {key:k,stored:inStore(f,k),rank:rank||null,
      packed:WINDOW_SIZES.filter(size=>windows[size].supported.includes(k))};
  });
  return {id:definition.id,style:definition.style,query:definition.query,
    gold:definition.gold,located,windows};
}

function measure(cases,style,stage,window) {
  const subset=cases.filter(c=>c.style===style);
  const ranks=subset.map(c=>c.located.map(x=>x.rank).filter(Boolean));
  const values=subset.map(c=>c.located.filter(x=>
    stage==='stored'?x.stored:stage==='retrieved'?x.rank!==null:x.packed.includes(window)).length/c.gold.length);
  return {questions:subset.length,evidence:subset.reduce((n,c)=>n+c.gold.length,0),
    recall:average(values),allSupport:average(values.map(v=>Number(v===1))),
    mrr:stage==='retrieved'?average(ranks.map(rs=>rs.length?1/Math.min(...rs):0)):null};
}

function runNegatives(f) {
  const cuePrompt=query=>{
    setCue(f,query);
    return buildActorContext({store:f.store,worldId:f.worldId,
      sceneId:f.sceneId,actorId:f.actorId,contextWindow:4096,maxOutput:350});
  };
  let p=cuePrompt('What is the vault passphrase?');
  const privateRaw=rawCandidates(f,'vault passphrase');
  const privateLeak=privateRaw.dialogue.includes('dialogue:secret')||
    p.metadata.evidence.some(e=>keyFor(e)==='dialogue:secret')||
    p.messages.some(m=>m.content.includes('indigo-falcon'));

  p=cuePrompt('Where was the bridge east of the vineyard?');
  const staleLeak=retrieveActorFacts(f.store,{timelineId:f.timelineId,
    actorId:f.actorId,query:'bridge vineyard'}).some(x=>x.id===f.ids.bridge)||
    p.metadata.factIds.includes(f.ids.bridge);

  p=cuePrompt('What time does the festival begin?');
  const supersededLeak=retrieveActorFacts(f.store,{timelineId:f.timelineId,
    actorId:f.actorId,query:'festival'}).some(x=>x.id===f.ids.oldFestival)||
    p.metadata.factIds.includes(f.ids.oldFestival);

  p=cuePrompt('Should we trust Jasper with the ledger?');
  const revokedLeak=retrieveActorFacts(f.store,{timelineId:f.timelineId,
    actorId:f.actorId,query:'Jasper ledger'}).some(x=>x.id===f.ids.revoked)||
    p.metadata.factIds.includes(f.ids.revoked);

  const fork=retrieveActorMemories(f.store.db,{timelineId:f.childTimelineId,
    actorId:f.actorId,query:'hidden telescope harbor loft',limit:12});
  const forkLeak=fork.some(x=>x.sourceMessageId==='parent-only');
  const forkFrozen=retrieveActorFacts(f.store,{timelineId:f.childTimelineId,
    actorId:f.actorId,query:'wooden bridge vineyard'}).some(x=>
      x.text.includes('east of the vineyard'));

  const negatives=[
    {id:'private-message-to-other-actor',pass:!privateLeak},
    {id:'edited-source-invalidates-reviewed-fact',pass:!staleLeak},
    {id:'superseded-fact-does-not-reappear',pass:!supersededLeak},
    {id:'revoked-fact-does-not-reappear',pass:!revokedLeak},
    {id:'future-parent-turn-does-not-enter-fork',pass:!forkLeak},
    {id:'fork-preserves-previously-valid-memory',pass:forkFrozen}
  ];
  return negatives;
}

export function evaluateActorRecall() {
  const f=makeCorpus();
  try {
    const questions=[
      {id:'compass',style:'lexical',query:'Do you remember the blue ceramic compass?',
        gold:['dialogue:attic']},
      {id:'entrance',style:'lexical',query:'What was the greenhouse entrance code?',
        gold:['dialogue:gate']},
      {id:'promise',style:'lexical',query:'What did I promise about the copper lantern?',
        gold:['fact:'+f.ids.promise]},
      {id:'correction',style:'lexical',query:'When does the festival begin?',
        gold:['fact:'+f.ids.festival]},
      {id:'two-source',style:'composed',
        query:'What was the greenhouse entrance code, and my copper lantern promise?',
        gold:['dialogue:gate','fact:'+f.ids.promise]},
      // This deliberately probes meaning, not FTS word overlap; diagnostic
      // only until a semantic retrieval implementation is evaluated.
      {id:'jewelry-in-rain',style:'implicit',
        query:"I'm concerned my jewelry could be damaged by tonight's rain.",
        gold:['dialogue:pendant']}
    ];
    const cases=questions.map(q=>evaluateQuestion(f,q));
    const negatives=runNegatives(f);
    const scores={};
    for(const style of ['lexical','composed','implicit']) {
      scores[style]={stored:measure(cases,style,'stored'),
        retrieved:measure(cases,style,'retrieved'),
        packed2048:measure(cases,style,'packed',2048),
        packed4096:measure(cases,style,'packed',4096)};
    }
    const budgetFailures=cases.flatMap(c=>Object.entries(c.windows)
      .filter(([,w])=>!w.withinBudget).map(([size])=>c.id+':'+size));
    const gates=[
      {id:'all-gold-evidence-stored',pass:cases.every(c=>c.located.every(x=>x.stored))},
      {id:'lexical-recall-at-five',pass:scores.lexical.retrieved.recall>=0.75},
      {id:'lexical-packed-at-2048',pass:scores.lexical.packed2048.recall>=0.75},
      {id:'composed-support-at-4096',pass:scores.composed.packed4096.allSupport===1},
      {id:'no-budget-overflow',pass:budgetFailures.length===0},
      {id:'no-stale-private-or-fork-leaks',pass:negatives.every(x=>x.pass)}
    ];
    return {schemaVersion:1,kind:'deterministic-evidence-funnel',
      windows:WINDOW_SIZES,counts:{seededDistractors:52,positiveQuestions:cases.length,
        negatives:negatives.length},scores,cases,negatives,budgetFailures,gates,
      passing:gates.every(x=>x.pass)};
  }finally{f.store.close();}
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const report=evaluateActorRecall();
  if(process.argv.includes('--json'))console.log(JSON.stringify(report,null,2));
  else {
    console.log('AI-RP memory evidence funnel (deterministic; no model inference)');
    for(const [style,s] of Object.entries(report.scores))
      console.log(style+': stored='+s.stored.recall+
        ' retrieved@5='+s.retrieved.recall+
        ' packed@2048='+s.packed2048.recall+
        ' packed@4096='+s.packed4096.recall);
    for(const gate of report.gates)console.log((gate.pass?'PASS ':'FAIL ')+gate.id);
    for(const check of report.negatives)console.log((check.pass?'PASS ':'FAIL ')+check.id);
  }
  if(!report.passing)process.exitCode=1;
}
