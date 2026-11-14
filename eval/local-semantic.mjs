// Optional local-embedding smoke benchmark using an isolated synthetic world.
// Never modify or send real user story data; use the configured localhost model.
import { StudioStore } from '../storage.mjs';
import { makeInitialState } from '../engine.mjs';

export async function evaluateLocalSemanticModel(semantic) {
  if(!semantic)return {status:'disabled',reason:'No local embedding model configured.'};
  const store=new StudioStore(':memory:');
  try {
    const state=makeInitialState(),actor=state.characters[0],scene=state.sessions[0];
    scene.messages=[
      {id:'jewelry-source',role:'user',content:'The silver pendant is tucked underneath the oak bench.',
        witnessIds:[actor.id],sentAt:1000},
      {id:'landmark-source',role:'user',content:'The copper lantern hangs outside the workshop.',
        witnessIds:[actor.id],sentAt:1001},
      {id:'routine-source',role:'user',content:'I file old shipping receipts on Sunday mornings.',
        witnessIds:[actor.id],sentAt:1002},
      {id:'garden-source',role:'user',content:'The herb garden is behind the stone wall.',
        witnessIds:[actor.id],sentAt:1003},
      // This is a long-term recall probe, not a search for the very last
      // observed turn already present in the active conversation.
      ...Array.from({length:12},(_,i)=>({id:'later-'+i,role:'user',
        content:'Ordinary shipping schedule update '+i+'.',
        witnessIds:[actor.id],sentAt:2000+i}))
    ];
    store.save(state,0);
    const saved=store.load().state.sessions[0],timelineId=saved.timelineId;
    const worldId=store.worlds.list().timelines.find(t=>t.id===timelineId).worldId;
    const run=async query=>{
      const before=performance.now();
      const results=await semantic.retrieve({store,worldId,sceneId:saved.id,actorId:actor.id,query});
      return {query,elapsedMs:Math.round(performance.now()-before),
        sourceMessageIds:results.map(x=>x.sourceMessageId),results:results.length};
    };
    const positive=await run('I worry the rain might ruin my jewelry.');
    const negative=await run('How should I cook chickpeas with carrots?');
    return {status:'completed',model:semantic.model,
      positive:{...positive,foundExpected:positive.sourceMessageIds.includes('jewelry-source')},
      negative:{...negative,unexpectedMatches:negative.results},
      note:'Only two synthetic probes; these counts are not a calibrated false-positive rate.'};
  }finally{store.close();}
}
