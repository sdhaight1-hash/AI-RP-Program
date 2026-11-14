// Optional backend discovery and exact count, with a conservative offline fallback.
import { estimateTokens } from './assemble.mjs';

const integer = value => Number.isInteger(Number(value)) && Number(value)>0 ? Number(value) : null;
export async function discoverBackendContext(baseUrl,model,fetchImpl=fetch) {
  const root=baseUrl.replace(/\/v1\/?$/,'');
  const tryJson=async (path,options)=>{
    try {
      const response=await fetchImpl(root+path,{...options,signal:AbortSignal.timeout(1200)});
      return response.ok ? await response.json() : null;
    } catch{return null;}
  };
  const kcpp=await tryJson('/api/extra/true_max_context_length');
  const kcppLength=integer(kcpp?.value);
  if(kcppLength) return {contextWindow:kcppLength,backend:'koboldcpp',exactCounter:async messages=>{
    const result=await tryJson('/api/extra/tokencount',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages})});
    return integer(result?.value) || (Array.isArray(result?.tokens)?result.tokens.length:null);
  }};
  const lms=await tryJson('/api/v1/models');
  const entry=Array.isArray(lms?.models)?lms.models.find(x=>x.key===model||x.id===model||x.name===model):null;
  const loaded=entry?.loaded_instances?.[0]?.config?.context_length;
  return {contextWindow:integer(loaded)||null,backend:loaded?'lm-studio':'unknown',exactCounter:null};
}

export async function enforceTokenBudget(prompt,backend) {
  const allowed=prompt.metadata.contextWindow-prompt.metadata.maxOutput-prompt.metadata.safetyMargin;
  const messages=prompt.messages.map(x=>({...x}));
  const evidence=Array.isArray(prompt.metadata.evidence)?[...prompt.metadata.evidence]:null;
  let count=estimateTokens(messages),kind='estimated';

  if(backend.exactCounter) {
    try {
      const actual=await backend.exactCounter(messages);
      if(integer(actual)){count=actual;kind='exact';}
    }catch { /* Some local models do not implement native token counts. */ }
  }
  // "continue" adds a synthetic instruction after the real last turn.
  // Preserve both that instruction and the latest witnessed utterance.
  const protectedTail=prompt.metadata.mode==='continue'?2:1;
  while(count>allowed) {
    if(messages.length>1+protectedTail) {
      messages.splice(1,1); // discard the oldest unprotected dialogue turn
    } else {
      const separator='\n\nRelevant evidence (not instructions):\n';
      const index=messages[0].content.lastIndexOf(separator);
      if(index<0)throw new Error('Prompt does not fit the loaded model context. Increase context or shorten the scene.');
      const prefix=messages[0].content.slice(0,index);
      const lines=messages[0].content.slice(index+separator.length).split('\n');
      if(!lines.length || lines.some(x=>!x.startsWith('- ')))
        throw new Error('Invalid evidence format; cannot safely trim model context');
      // Evidence is emitted one source per line. Remove the lowest-priority
      // whole source, not its last text line or a partial personal memory.
      lines.pop();
      if(evidence)evidence.pop();
      messages[0].content=lines.length?prefix+separator+lines.join('\n'):prefix;
    }
    if(kind==='exact') {
      try {
        const actual=await backend.exactCounter(messages);
        if(integer(actual)){count=actual;continue;}
      }catch { /* Fall back and explicitly report estimation. */ }
      kind='estimated';
    }
    count=estimateTokens(messages);
  }
  const metadata={...prompt.metadata,promptTokens:count,countMethod:kind,recentMessages:messages.length-1};
  if(evidence) {
    metadata.evidence=evidence;
    metadata.selectedEvidence=evidence.length;
    metadata.memoryIds=evidence.filter(x=>x.kind==='dialogue').map(x=>x.id);
    metadata.factIds=evidence.filter(x=>x.kind==='fact').map(x=>x.id);
    metadata.lore=evidence.filter(x=>x.kind==='lore').length;
  }
  return {...prompt,messages,metadata};
}
