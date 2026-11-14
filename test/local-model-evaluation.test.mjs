import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLocalModelEvaluationTasks,inspectLocalModelResult,summarizeLocalModelEvaluation,
  LOCAL_EVAL_EXPECTED_NAMES } from '../eval/local-model.mjs';
import { evaluateLocalSemanticModel } from '../eval/local-semantic.mjs';
import { createLocalSemanticRetriever } from '../memory/semantic.mjs';
import { createApp } from '../server.mjs';
import { StudioStore } from '../storage.mjs';

test('local-model assessment tasks use synthetic world context and preserve field compartments',()=>{
  const fixture=makeLocalModelEvaluationTasks(),tasks=fixture.tasks;
  assert.equal(tasks.length,7);
  assert.deepEqual(tasks.map(t=>t.id),[
    'field:phoneStyle','field:dailyRoutine','field:stressBehavior',
    'world:extraction','fidelity:everyday','fidelity:boundary','fidelity:phone'
  ]);
  const phone=tasks[0];
  assert.match(phone.messages[1].content,/Contemporary coastal trading city/);
  assert.match(phone.messages[1].content,/Short natural sentences/);
  assert.match(phone.messages[1].content,/No eye contact, clothing/);
  const world=tasks[3];
  assert.match(world.messages[1].content,/Her aunt Nessa ran the Lantern House in Seabrook/);
  assert.match(world.messages[0].content,/EXACT contiguous substring/);
  assert.ok(tasks.every(t=>t.messages.every(m=>typeof m.content==='string'&&m.content.length>0)));
});

test('local model rubric reports structural format, channel warnings and sourced world-entity coverage',()=>{
  const fixture=makeLocalModelEvaluationTasks(),[phone,daily,,world,,,,]=fixture.tasks;
  const bad=inspectLocalModelResult(phone,'She nods and makes eye contact during phone calls.',fixture);
  assert.equal(bad.valid,true);
  assert.ok(bad.warnings.some(x=>x.includes('visual cues')));
  const normal=inspectLocalModelResult(daily,'Usually repairs clocks before lunch and rests on Sunday.',fixture);
  assert.equal(normal.valid,true);
  assert.equal(normal.warnings.length,0);
  const entries=inspectLocalModelResult(world,JSON.stringify({entries:[
    {type:'entity',kind:'character',name:'Nessa',description:'Mara\'s aunt',
      sourceField:'familyHistory',sourceQuote:'Her aunt Nessa ran the Lantern House in Seabrook when Mara was young.'},
    {type:'location',kind:'building',name:'Lantern House',description:'A historic business',
      sourceField:'familyHistory',sourceQuote:'Her aunt Nessa ran the Lantern House in Seabrook when Mara was young.'},
    {type:'entity',kind:'character',name:'Imaginary King',description:'Invented',
      sourceField:'familyHistory',sourceQuote:'Her aunt Nessa ran the Lantern House in Seabrook when Mara was young.'}
  ]}),fixture);
  assert.equal(entries.valid,true);
  assert.equal(entries.details.eligibleCount,2);
  assert.deepEqual(entries.details.recovered,['Nessa','Lantern House']);
  assert.equal(LOCAL_EVAL_EXPECTED_NAMES.length,3);
  const invalid=inspectLocalModelResult(world,'invalid json',fixture);
  assert.equal(invalid.valid,false);
  const summary=summarizeLocalModelEvaluation([
    {...bad,elapsedMs:100},{...normal,elapsedMs:120},{...entries,elapsedMs:110}
  ]);
  assert.equal(summary.medianLatencyMs,110);
  assert.equal(summary.completed,3);
  assert.ok(summary.heuristicWarnings>=2);
});

test('optional live semantic probe uses only synthetic data and can report unrelated high-similarity matches',async()=>{
  const inputs=[];
  const fetchImpl=async (url,req)=>{
    const body=JSON.parse(req.body);
    assert.match(url,/\/embeddings$/);
    inputs.push(...body.input);
    return Response.json({data:body.input.map((s,index)=>({
      index,embedding:/jewelry|pendant/i.test(s)?[1,0,0]:
        /chickpeas|carrots/i.test(s)?[0,0,1]:[0,1,0]
    }))});
  };
  const semantic=createLocalSemanticRetriever({model:'synthetic-test',fetchImpl});
  const report=await evaluateLocalSemanticModel(semantic);
  assert.equal(report.status,'completed');
  assert.equal(report.positive.foundExpected,true);
  assert.equal(report.negative.unexpectedMatches,0);
  assert.ok(inputs.some(s=>s.includes('silver pendant')));
  assert.ok(!inputs.some(s=>s.includes('PRIVATE_USER_MESSAGE')));
  assert.deepEqual(await evaluateLocalSemanticModel(null),{
    status:'disabled',reason:'No local embedding model configured.'
  });
});

test('HTTP semantic assessment is opt-in and read-only when no embedding model is configured',async()=>{
  const store=new StudioStore(':memory:');
  const server=createApp({store,semanticModel:'',
    fetchImpl:async()=>{throw Error('No inference should run when model is disabled')}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/eval/semantic-local',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({worldId:'unused-test-world'})
    });
    assert.equal(response.status,200);
    const json=await response.json();
    assert.equal(json.status,'disabled');
    assert.equal(store.load().revision,0);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
