// Optional local dense retrieval. Embeddings are derived, replaceable cache
// entries, never canonical knowledge. Only actor-authorized source text may be
// sent to the explicitly configured loopback embeddings service.
import { createHash } from 'node:crypto';
import { listActorFacts } from './facts.mjs';
import { selectSemanticDialogueCandidates } from './candidates.mjs';

const cap=(x,min,max)=>Math.min(max,Math.max(min,x));
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const member=(db,timelineId,actorId)=>Boolean(db.prepare(
  'SELECT 1 FROM timeline_actors WHERE timeline_id=? AND actor_id=?'
).get(timelineId,actorId));

function normalizedVector(vector) {
  if(!Array.isArray(vector)||vector.length<2||vector.length>4096||
    !vector.every(x=>typeof x==='number'&&Number.isFinite(x)))throw new Error('Embedding backend returned an invalid vector');
  const size=Math.hypot(...vector);
  if(!Number.isFinite(size)||size<=0)throw new Error('Embedding backend returned a zero vector');
  return vector.map(x=>x/size);
}

export function cosine(a,b) {
  if(!Array.isArray(a)||!Array.isArray(b)||a.length!==b.length)return 0;
  return a.reduce((n,v,i)=>n+v*b[i],0);
}

// The server never accepts an embeddings endpoint from the browser.
export function createLocalSemanticRetriever({
  baseUrl='http://127.0.0.1:1234/v1',model,fetchImpl=fetch,
  maxCandidates=96,threshold=0.62,timeoutMs=9000
}={}) {
  if(typeof model!=='string'||!model.trim()||model.length>250)throw new Error('Select a local embedding model');
  const url=new URL(baseUrl);
  if(url.username||url.password||url.search||url.hash)
    throw new Error('Embedding URL must not contain credentials or query parameters');
  if(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname))
    throw new Error('Semantic memory requires an explicit loopback HTTP embedding endpoint');
  if(!/^\/?v1\/?$/.test(url.pathname.replace(/^\//,'')) && !url.pathname.endsWith('/v1'))
    throw new Error('Embedding endpoint must use a /v1 base URL');
  const endpoint=url.href.replace(/\/$/,'')+'/embeddings';
  const memoryCache=new Map();
  const bound=cap(Math.floor(maxCandidates)||96,1,160);
  const minimum=cap(Number(threshold)||0.62,0,1);
  const embed=async input=>{
    const response=await fetchImpl(endpoint,{
      method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},
      signal:AbortSignal.timeout(timeoutMs),
      body:JSON.stringify({model,input})
    });
    if(!response.ok)throw new Error('Local embedding service unavailable ('+response.status+')');
    const parsed=await response.json();
    const rows=parsed?.data;
    if(!Array.isArray(rows)||rows.length!==input.length)throw new Error('Unexpected local embedding batch');
    const ordered=[...rows].sort((a,b)=>a.index-b.index);
    if(!ordered.every((x,i)=>x.index===i))throw new Error('Embedding response indices do not match inputs');
    const vectors=ordered.map(x=>normalizedVector(x.embedding));
    if(vectors.some(x=>x.length!==vectors[0].length))throw new Error('Embedding dimensions are inconsistent');
    return vectors;
  };
  return {
    model,
    async retrieve({store,worldId,sceneId,actorId,query}) {
      if(typeof query!=='string'||!query.trim()||query.length>900)return [];
      if((store.activeWorldId&&store.activeWorldId!==worldId)||
         (store.scopeWorldId&&store.scopeWorldId!==worldId))throw new Error('Wrong world');
      const startingRevision=store.load().revision;
      const scene=store.load().state?.sessions?.find(x=>x.id===sceneId&&!x.trashedAt);
      if(!scene||(scene.castIds||[scene.characterId]).includes(actorId)===false ||
        !member(store.db,scene.timelineId,actorId))throw new Error('Actor is not in this scene and timeline');
      const timelineId=scene.timelineId;
      // Authorization is applied before vector generation / ranking. No
      // foreign-actor text is embedded, even for candidate retrieval.
      const facts=listActorFacts(store,{timelineId,actorId}).filter(x=>x.status==='active'&&x.validSource)
        .slice(0,40).map(x=>({kind:'fact',id:x.id,sourceMessageId:x.sourceMessageId,
          text:'Reviewed personal '+x.kind+' (subjective, not world canon): '+x.text,
          embeddingText:x.text}));
      const room=Math.max(0,bound-facts.length);
      // Pure recency loses every old unpinned memory once an actor has enough
      // turns. Reserve bounded candidate slots for lexical cues, pinned items
      // and the earliest experiences; spend the remainder on recent dialogue.
      // This is not a complete vector index: intermediate uncued memories can
      // still be missed, and the evaluation must measure that limitation.
      const mem=selectSemanticDialogueCandidates(store.db,{
        timelineId,actorId,query,limit:room
      });
      const candidates=[...facts,...mem];
      if(!candidates.length)return [];
      const queryVector=(await embed([query.slice(0,480)]))[0];
      for(let i=0;i<candidates.length;i+=12){
        const chunk=candidates.slice(i,i+12);
        const pending=chunk.filter(x=>!memoryCache.has(digest([
          model,worldId,timelineId,actorId,x.kind,x.id,x.embeddingText
        ])));
        if(!pending.length)continue;
        const vectors=await embed(pending.map(x=>x.embeddingText.slice(0,700)));
        pending.forEach((x,j)=>{
          const k=digest([model,worldId,timelineId,actorId,x.kind,x.id,x.embeddingText]);
          // Do not retain unbounded old vectors or any raw transcript text.
          if(memoryCache.size>=600)memoryCache.delete(memoryCache.keys().next().value);
          memoryCache.set(k,vectors[j]);
        });
      }
      if((store.activeWorldId&&store.activeWorldId!==worldId)||
        (store.scopeWorldId&&store.scopeWorldId!==worldId)||
        store.load().revision!==startingRevision)throw new Error('World or scene changed during embedding');
      // Revocations, supersessions and source edits do not necessarily change
      // the story revision. Revalidate active facts after awaiting the model.
      const stillValid=new Set(listActorFacts(store,{timelineId,actorId}).filter(x=>
        x.status==='active'&&x.validSource).map(x=>x.id));
      return candidates.filter(x=>x.kind!=='fact'||stillValid.has(x.id)).map(x=>{
        const vec=memoryCache.get(digest([model,worldId,timelineId,actorId,x.kind,x.id,x.embeddingText]));
        return {...x,similarity:cosine(queryVector,vec)};
      }).filter(x=>x.similarity>=minimum)
        .sort((a,b)=>b.similarity-a.similarity||(a.kind==='fact'?-1:1))
        .slice(0,3).map(({kind,id,sourceMessageId,text,similarity})=>({
          kind,id,sourceMessageId,text,similarity
        }));
    }
  };
}
