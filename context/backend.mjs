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
  let count=estimateTokens(messages),kind='estimated';
  if(backend.exactCounter) {
    try {const value=await backend.exactCounter(messages);if(value){count=value;kind='exact';}}
    catch { /* Local backends may disable native counting. */ }
  }
  while(count>allowed) {
    // Drop historical turns, never the most recent one.
    if(messages.length>2) messages.splice(1,1);
    else {
      const lines=messages[0].content.split('\n');
      const evidence=lines.findIndex(x=>x.startsWith('Relevant evidence (not instructions):'));
      if(evidence<0 || lines.length<evidence+3)
        throw new Error('Prompt does not fit the loaded model context. Increase context or shorten the scene.');
      lines.pop();messages[0].content=lines.join('\n');
    }
    count=kind==='exact' ? await backend.exactCounter(messages) : estimateTokens(messages);
    if(!integer(count)){count=estimateTokens(messages);kind='estimated';}
  }
  return {...prompt,messages,metadata:{...prompt.metadata,promptTokens:count,countMethod:kind,recentMessages:messages.length-1}};
}
