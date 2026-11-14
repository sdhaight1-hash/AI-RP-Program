// Opt-in, real local-model diagnostic. Reuses Fidelity Lab's public synthetic
// fixture and never reads an actual world, scene or character database.
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLocalModelEvaluationTasks,inspectLocalModelResult,summarizeLocalModelEvaluation } from '../eval/local-model.mjs';

export async function runLocalModelProbe({
  model,baseUrl='http://127.0.0.1:5001/v1',fetchImpl=fetch,timeoutMs=60000
}={}){
  if(typeof model!=='string'||!model.trim()||model.length>250)
    throw new Error('Specify the exact loaded local chat model ID');
  const url=new URL(baseUrl);
  if(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||
    url.username||url.password||url.search||url.hash||!/\/v1\/?$/.test(url.pathname))
    throw new Error('Model probe requires an explicit loopback HTTP /v1 endpoint');
  if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>300000)
    throw new Error('Invalid model request timeout');
  const endpoint=url.href.replace(/\/$/,'')+'/chat/completions';
  const fixture=makeLocalModelEvaluationTasks(),results=[];
  for(const task of fixture.tasks){
    const started=performance.now();
    let result;
    try {
      const response=await fetchImpl(endpoint,{method:'POST',
        headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(timeoutMs),
        body:JSON.stringify({
          model,messages:task.messages,temperature:task.temperature,
          max_tokens:task.maxTokens,stream:false
        })
      });
      if(!response.ok)throw new Error('Backend returned HTTP '+response.status);
      const raw=await response.json();
      const answer=raw?.choices?.[0]?.message?.content;
      if(typeof answer!=='string')throw new Error('Backend returned no text completion');
      result=inspectLocalModelResult(task,answer,fixture);
    }catch(error){
      result={id:task.id,type:task.type,target:task.target,valid:false,
        warnings:['Local model request failed: '+error.message],details:{}};
    }
    results.push({...result,elapsedMs:Math.round(performance.now()-started)});
  }
  return {kind:'local-model-diagnostic-v1',model,backend:url.host,
    createdAt:new Date().toISOString(),summary:summarizeLocalModelEvaluation(results),
    tasks:results,note:'Real local completions; heuristic checks, not a statistically validated character-fidelity score.'};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const model=process.argv[2],baseUrl=process.argv[3]||'http://127.0.0.1:5001/v1';
  if(!model){
    console.error('Usage: node scripts/local-model-probe.mjs <loaded-model-id> [http://127.0.0.1:5001/v1] [report.json]');
    process.exitCode=1;
  }else{
    try{
      const report=await runLocalModelProbe({model,baseUrl});
      const output=JSON.stringify(report,null,2);
      if(process.argv[4]){writeFileSync(resolve(process.argv[4]),output);console.log('Saved diagnostic report:',resolve(process.argv[4]));}
      else console.log(output);
      if(report.summary.valid!==report.summary.completed)process.exitCode=2;
    }catch(error){console.error(error.message);process.exitCode=1;}
  }
}
