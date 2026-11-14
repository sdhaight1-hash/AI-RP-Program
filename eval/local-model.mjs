// Read-only synthetic local-model evaluation. No real character, world,
// scene or memory is modified by running these controlled prompts.
import { createCharacter } from '../engine.mjs';
import { makeCharacterDraftRequest,parseCharacterSuggestions } from '../character/authoring.mjs';
import { makeWorldEntryDraftRequest,parseWorldEntrySuggestions } from '../character/world-bridge.mjs';
import { makeFidelityProbe,inspectFidelityReply } from '../fidelity.mjs';

export const LOCAL_EVAL_WORLD_ID='synthetic-local-eval-world';
export const LOCAL_EVAL_EXPECTED_NAMES=Object.freeze(['Nessa','Seabrook','Lantern House']);
const profile=()=>{
  const char=createCharacter('Mara Vale');
  return {...char,id:'synthetic-mara',worldId:LOCAL_EVAL_WORLD_ID,age:'31',
    personality:'Measured, cautiously warm, observant, with dry humor rather than grand speeches.',
    values:'Keeps promises and does not deceive customers about the quality of a repair.',
    motivations:'Wants to keep her workshop independent and restore her grandmother’s damaged clock.',
    stressBehavior:'Becomes quiet, checks details twice, and asks for time before deciding.',
    familyHistory:'Her aunt Nessa ran the Lantern House in Seabrook when Mara was young.',
    backstory:'Mara apprenticed as a clock restorer before moving to Port Arlen.',
    occupation:'Clock restoration specialist at Harbor Clockworks.',
    speechStyle:'Short natural sentences, deliberate pauses, gentle ironic humor.',
    hobbies:'Repairs old radios and reads maritime histories.'};
};
const world=()=>({activeWorldId:LOCAL_EVAL_WORLD_ID,
  worlds:[{id:LOCAL_EVAL_WORLD_ID,name:'Port Arlen',description:
    'Contemporary coastal trading city. Ordinary technology only, no supernatural magic or teleportation.'}],
  locations:[{id:'market-pier',worldId:LOCAL_EVAL_WORLD_ID,
    name:'Market Pier',kind:'outdoor',description:'A working commercial waterfront.'}],
  entities:[{id:'harbor-clocks',worldId:LOCAL_EVAL_WORLD_ID,
    name:'Harbor Clockworks',kind:'organization'}],
  relationships:[]});

export function makeLocalModelEvaluationTasks() {
  const character=profile(),worldLibrary=world(),worldId=LOCAL_EVAL_WORLD_ID;
  const fields=['phoneStyle','dailyRoutine','stressBehavior'].map(target=>{
    const request=makeCharacterDraftRequest({character,target,worldLibrary,worldId});
    return {id:'field:'+target,type:'field',target,request,messages:request.messages,
      maxTokens:320,temperature:0.65};
  });
  const bridge=makeWorldEntryDraftRequest({character,worldLibrary,worldId});
  const extraction={id:'world:extraction',type:'world',target:'world entries',
    request:bridge,messages:bridge.messages,maxTokens:780,temperature:0.25};
  const fidelity=['everyday','boundary','phone'].map(probeId=>{
    const probe=makeFidelityProbe({character,probeId});
    return {id:'fidelity:'+probeId,type:'fidelity',target:probeId,probeId,
      messages:probe.messages,maxTokens:220,temperature:0.7};
  });
  return {character,worldLibrary,worldId,tasks:[...fields,extraction,...fidelity]};
}

export function inspectLocalModelResult(task,text,{character,worldLibrary,worldId}) {
  const raw=String(text||'').trim();
  const warnings=[];
  let valid=true,details={};
  if(!raw){return {id:task.id,type:task.type,target:task.target,valid:false,
    warnings:['Model returned empty output.'],details:{}};}
  if(task.type==='field'){
    let value='';
    try {value=parseCharacterSuggestions(raw,task.request)[task.target];}
    catch(error){valid=false;warnings.push('Field format error: '+error.message);}
    if(value){
      if(value.length>1400)warnings.push('Field text may be too verbose for a compact character profile.');
      if(task.target==='phoneStyle'&&/\b(?:makes eye contact|nods|shrugs|glances at|looks at|gestures|waves)\b/iu.test(value))
        warnings.push('Phone-style suggestion includes physical or visual cues unavailable during an audio call.');
      if(task.target==='dailyRoutine'&&/\b(?:right now|currently standing|at this exact moment|currently walking)\b/iu.test(value))
        warnings.push('Routine suggestion risks confusing a typical habit with current timeline position.');
      if(/\b(?:casts? a spell|dragon|teleport(?:s|ation)?|supernatural magic|wizard)\b/iu.test(value))
        warnings.push('Suggestion may contradict the synthetic contemporary, nonmagical world.');
      if([character.personality,character.values,character.backstory].some(x=>x===value))
        warnings.push('Suggestion repeats an existing field rather than filling the requested compartment.');
      details={field:task.target,characters:value.length,excerpt:value.slice(0,900)};
    }
  }else if(task.type==='world'){
    let entries=[];
    try{entries=parseWorldEntrySuggestions(raw,{character,worldLibrary,worldId});}
    catch(error){valid=false;warnings.push('World proposal format error: '+error.message);}
    const found=new Set(entries.map(e=>e.name.toLocaleLowerCase()));
    const matched=LOCAL_EVAL_EXPECTED_NAMES.filter(name=>found.has(name.toLocaleLowerCase()));
    details={eligibleCount:entries.length,expectedNames:LOCAL_EVAL_EXPECTED_NAMES,
      recovered:matched,sourceBackedRate:'Only structurally and quote-verified entries survive',
      entries:entries.map(e=>({name:e.name,type:e.type,kind:e.kind,sourceField:e.sourceField}))};
    if(!entries.length)warnings.push('No source-verified named world entries recovered.');
    if(entries.length&&matched.length<LOCAL_EVAL_EXPECTED_NAMES.length)
      warnings.push('Some explicitly named source entities were not recovered.');
  }else if(task.type==='fidelity'){
    warnings.push(...inspectFidelityReply(task.probeId,raw));
    details={probeId:task.probeId,characters:raw.length,excerpt:raw.slice(0,900)};
  }else throw new Error('Unknown local evaluation task');
  return {id:task.id,type:task.type,target:task.target,valid,warnings,details};
}

export function summarizeLocalModelEvaluation(results) {
  const valid=results.filter(x=>x.valid).length;
  const elapsed=results.filter(x=>Number.isFinite(x.elapsedMs)).map(x=>x.elapsedMs);
  const warnings=results.reduce((n,x)=>n+x.warnings.length,0);
  return {completed:results.length,valid,heuristicWarnings:warnings,
    medianLatencyMs:elapsed.length?[...elapsed].sort((a,b)=>a-b)[Math.floor(elapsed.length/2)]:null,
    note:'Synthetic, narrow checks only; warnings are not an LLM-judged personality score.'};
}
