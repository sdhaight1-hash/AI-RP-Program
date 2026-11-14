// Deterministic end-to-end semantic evidence funnel, not a live model score.
// Exercises the real SQLite authorization, bounded candidates and prompt packer
// with transparent, synthetic vectors. No external inference or user data.
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { StudioStore } from '../storage.mjs';
import { makeEmptyWorldState,createCharacter,createSession } from '../engine.mjs';
import { retrieveActorMemories } from '../memory/store.mjs';
import { createLocalSemanticRetriever } from '../memory/semantic.mjs';
import { buildActorContext } from '../context/assemble.mjs';

const percentile=(times,q)=>{
  const values=[...times].sort((a,b)=>a-b);
  return values.length?Math.round(values[Math.max(0,Math.ceil(q*values.length)-1)]*100)/100:0;
};
const vector=text=>{
  const x=String(text).toLocaleLowerCase();
  if(/space elevator|unrelated moon colony/.test(x))return [0.5,0.5,0.5,0.5];
  if(/jewelry|rain|opal locket|glass medallion/.test(x))return [1,0,0,0];
  if(/sundial|bronze clock/.test(x))return [0,1,0,0];
  if(/scarf|neckwear/.test(x))return [0,0,1,0];
  return [0,0,0,1];
};
function corpus(){
  const store=new StudioStore(':memory:');
  const actor=createCharacter('Mara'),privateActor=createCharacter('Private NPC');
  const scene=createSession(actor),state=makeEmptyWorldState();
  state.characters=[actor,privateActor];scene.castIds=[actor.id,privateActor.id];
  scene.messages=Array.from({length:281},(_,i)=>({
    id:'turn-'+i,role:'user',witnessIds:[actor.id],sentAt:i+10,
    content:i===0?'The glass medallion is hidden in an old cedar chest.'
      :i===132?'The opal locket was carefully wrapped in wool.'
      :i===190?'The bronze sundial is beside the greenhouse.'
      :i===271?'My red scarf was left next to the fountain.'
      :i===280?'Any news?':'Generic harbor diary entry '+i+' about ordinary errands.'
  }));
  scene.messages.push({id:'private',role:'user',
    content:'A hidden private code is black-comet.',witnessIds:[privateActor.id]});
  state.sessions=[scene];state.activeSessionId=scene.id;
  store.save(state,0);
  const saved=store.load().state.sessions[0];
  const worldId=store.worlds.list().timelines.find(t=>t.id===saved.timelineId).worldId;
  return {store,actor,sceneId:saved.id,timelineId:saved.timelineId,worldId};
}
function setCue(f,content){
  const current=f.store.load();
  current.state.sessions[0].messages.find(x=>x.id==='turn-280').content=content;
  f.store.save(current.state,current.revision);
}
const cases=[
  {id:'early-paraphrase',cue:'What happened to the old glass ornament?',gold:'turn-0',terms:'glass medallion'},
  {id:'middle-paraphrase',cue:'Could the rain damage my jewelry?',gold:'turn-132',terms:'opal locket'},
  {id:'middle-lexical',cue:'Where is the bronze sundial?',gold:'turn-190',terms:'bronze sundial'},
  {id:'recent-paraphrase',cue:'Have you seen my winter neckwear?',gold:'turn-271',terms:'red scarf'},
  {id:'irrelevant-negative',cue:'Do you know anything about the space elevator?',gold:null},
  {id:'different-negative',cue:'Tell me about an unrelated moon colony?',gold:null}
];
export async function evaluateSemanticFunnel(){
  const f=corpus(),timings=[],checks=[];let leaked=false,embedded=0;
  try{
    const retriever=createLocalSemanticRetriever({model:'transparent-test-vectors',
      baseUrl:'http://127.0.0.1:1234/v1',threshold:0.85,
      fetchImpl:async(url,options)=>{
        const input=JSON.parse(options.body).input;
        embedded+=input.length;
        if(input.some(x=>x.includes('black-comet')))leaked=true;
        return Response.json({data:input.map((value,index)=>({index,embedding:vector(value)}))});
      }});
    for(const item of cases){
      setCue(f,item.cue);
      const lexical=retrieveActorMemories(f.store.db,{timelineId:f.timelineId,
        actorId:f.actor.id,query:item.cue,limit:8});
      const start=performance.now();
      const selected=await retriever.retrieve({store:f.store,worldId:f.worldId,
        sceneId:f.sceneId,actorId:f.actor.id,query:item.cue});
      timings.push(performance.now()-start);
      const windows={};
      for(const size of [2048,4096,8192]){
        const prompt=buildActorContext({store:f.store,worldId:f.worldId,sceneId:f.sceneId,
          actorId:f.actor.id,contextWindow:size,maxOutput:350,semanticEvidence:selected});
        windows[size]={
          hasGold:item.gold?prompt.metadata.evidence.some(e=>e.sourceMessageId===item.gold):false,
          withinBudget:prompt.metadata.promptTokensEstimated<=
            size-prompt.metadata.maxOutput-prompt.metadata.safetyMargin,
          selectedEvidence:prompt.metadata.selectedEvidence
        };
        if(prompt.messages.some(m=>m.content.includes('black-comet')))leaked=true;
      }
      const selectedGold=item.gold?selected.some(e=>e.sourceMessageId===item.gold):false;
      checks.push({id:item.id,positive:Boolean(item.gold),gold:item.gold,
        lexicalGold:item.gold?lexical.some(e=>e.sourceMessageId===item.gold):false,
        semanticGold:selectedGold,selectedIds:selected.map(x=>x.sourceMessageId),
        falsePositive:!item.gold&&selected.length>0,windows});
    }
    const positives=checks.filter(c=>c.positive),negatives=checks.filter(c=>!c.positive);
    const support=positives.filter(c=>c.semanticGold).length;
    const gates=[
      {id:'no-private-source-in-embedding-or-prompts',pass:!leaked},
      {id:'all-positive-sources-found-in-semantic-recall',pass:support===positives.length},
      {id:'implicit-middle-source-survives-2048-tokens',pass:checks
        .find(c=>c.id==='middle-paraphrase').windows[2048].hasGold},
      {id:'negative-controls-do-not-trigger-memories',pass:negatives.every(c=>!c.falsePositive)},
      {id:'all-prompts-within-model-budget',pass:checks.every(c=>Object.values(c.windows)
        .every(w=>w.withinBudget))}
    ];
    return {kind:'synthetic-semantic-evidence-funnel-v1',cases:checks,
      metrics:{positives:positives.length,negatives:negatives.length,
        lexicalGold:positives.filter(c=>c.lexicalGold).length,
        semanticRecall:support/positives.length,
        falsePositiveRate:negatives.filter(c=>c.falsePositive).length/negatives.length,
        simulatedP50Ms:percentile(timings,0.5),simulatedP95Ms:percentile(timings,0.95),
        embeddedTexts:embedded,privateLeak:leaked},
      gates,passing:gates.every(x=>x.pass),
      note:'Transparent mock vectors test pipeline correctness, not real embedding quality or user hardware latency.'};
  }finally{f.store.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const result=await evaluateSemanticFunnel();
  console.log(JSON.stringify(result,null,2));
  if(!result.passing)process.exitCode=1;
}
