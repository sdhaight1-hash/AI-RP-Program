import test from 'node:test';
import assert from 'node:assert/strict';
import { runLocalModelProbe } from '../scripts/local-model-probe.mjs';

test('real local-model probe submits seven synthetic tasks and records request outcomes',async()=>{
  let calls=0;
  const result=await runLocalModelProbe({model:'test-local',baseUrl:'http://127.0.0.1:5001/v1',
    fetchImpl:async(url,options)=>{
      calls++;
      assert.equal(url,'http://127.0.0.1:5001/v1/chat/completions');
      const body=JSON.parse(options.body);
      assert.equal(body.model,'test-local');
      assert.equal(body.stream,false);
      assert.equal(body.messages[0].role,'system');
      assert.ok(body.messages.every(x=>!String(x.content).includes('WORLD_ONE_PASSPHRASE')));
      return Response.json({choices:[{message:{content:'Keeps her replies brief and calm.'}}]});
    }});
  assert.equal(calls,7);
  assert.equal(result.summary.completed,7);
  assert.equal(result.tasks.length,7);
  assert.ok(result.tasks.every(t=>Number.isFinite(t.elapsedMs)&&t.elapsedMs>=0));
  assert.equal(result.tasks.find(x=>x.id==='world:extraction').valid,false,
    'a malformed world-entry response must not be called valid');
});

test('real local probe rejects remote backends and reports unavailable service without fabricated success',async()=>{
  await assert.rejects(runLocalModelProbe({model:'x',baseUrl:'https://example.org/v1'}),/loopback/);
  await assert.rejects(runLocalModelProbe({model:'x',baseUrl:'http://127.0.0.1:5001/other'}),/loopback/);
  const r=await runLocalModelProbe({model:'offline',fetchImpl:async()=>{throw new Error('No local runtime');}});
  assert.equal(r.summary.valid,0);
  assert.equal(r.summary.completed,7);
  assert.equal(r.tasks.every(x=>x.warnings.some(w=>w.includes('No local runtime'))),true);
});
