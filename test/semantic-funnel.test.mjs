import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSemanticFunnel } from '../eval/semantic-recall.mjs';

test('semantic funnel measures source provenance, negatives and 2K/4K/8K packing',async()=>{
  const result=await evaluateSemanticFunnel();
  assert.equal(result.passing,true,JSON.stringify(result.gates));
  assert.equal(result.metrics.positives,4);
  assert.equal(result.metrics.negatives,2);
  assert.equal(result.metrics.semanticRecall,1);
  assert.equal(result.metrics.falsePositiveRate,0);
  assert.equal(result.metrics.privateLeak,false);
  assert.ok(result.metrics.embeddedTexts>0);
  assert.ok(result.metrics.simulatedP95Ms>=result.metrics.simulatedP50Ms);
  assert.ok(result.cases.every(c=>Object.keys(c.windows).length===3));
});
