import test from 'node:test';
import assert from 'node:assert/strict';
import { measureEvidenceStage,measureEvidenceFunnel } from '../eval/evidence-metrics.mjs';
import { evaluateSemanticFunnel } from '../eval/semantic-recall.mjs';

test('annotated source metrics count irrelevant retrieved evidence even alongside correct evidence',()=>{
  const rows=[
    {id:'first',gold:'a',lexicalIds:['a','noise'],selectedIds:['a'],
      windows:{2048:{evidenceIds:['a']},4096:{evidenceIds:['a']}}},
    {id:'middle',gold:'b',lexicalIds:[],selectedIds:['b','noise'],
      windows:{2048:{evidenceIds:[]},4096:{evidenceIds:['b']}}},
    {id:'unrelated',gold:null,lexicalIds:[],selectedIds:['wrong'],
      windows:{2048:{evidenceIds:[]},4096:{evidenceIds:['wrong']}}}
  ];
  const data=measureEvidenceFunnel(rows,[2048,4096]);
  assert.equal(data.lexical.sourceRecall,0.5);
  assert.equal(data.lexical.sourcePrecision,0.5);
  assert.equal(data.semantic.sourceRecall,1);
  assert.equal(data.semantic.sourcePrecision,0.5);
  assert.equal(data.semantic.negativeQueryFalsePositiveRate,1);
  assert.equal(data.postTrim[2048].sourceRecall,0.5);
  assert.equal(data.postTrim[2048].negativeQueryFalsePositiveRate,0);
  assert.equal(data.postTrim[4096].sourceRecall,1);
  assert.equal(data.postTrim[4096].sourcePrecision,2/3);
  assert.equal(data.postTrim[4096].negativeCasesWithRetrieval,1);
});

test('source scoring deduplicates repeated IDs, validates annotation and handles no predictions',()=>{
  assert.deepEqual(measureEvidenceStage([{id:'a',gold:'x'}],()=>[]).sourceRecall,0);
  const single=measureEvidenceStage([{id:'a',gold:'x'}],()=>['x','x','x']);
  assert.equal(single.returnedSources,1);
  assert.equal(single.sourcePrecision,1);
  assert.throws(()=>measureEvidenceStage([{id:'a'}],()=>[]),/Invalid annotated/);
  assert.throws(()=>measureEvidenceFunnel([],[-1]),/Invalid context/);
});

test('SQLite-backed semantic funnel reports post-trim source IDs at 2K, 4K and 8K',async()=>{
  const outcome=await evaluateSemanticFunnel();
  assert.ok(outcome.passing,JSON.stringify(outcome.gates));
  const stages=outcome.evidenceMetrics;
  assert.equal(stages.semantic.sourceRecall,1);
  assert.equal(stages.semantic.negativeQueryFalsePositiveRate,0);
  for(const budget of [2048,4096,8192]){
    assert.ok(stages.postTrim[budget].sourceRecall>0);
    assert.ok(stages.postTrim[budget].sourcePrecision>=0);
    assert.ok(outcome.cases.every(c=>Array.isArray(c.windows[budget].evidenceIds)));
  }
});
