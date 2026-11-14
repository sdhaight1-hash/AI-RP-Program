import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateActorRecall } from '../eval/actor-recall.mjs';

test('actor memory evidence funnel gates privacy, source validity, contextual recall and prompt budget',()=>{
  const report=evaluateActorRecall();
  assert.equal(report.schemaVersion,1);
  assert.deepEqual(report.windows,[2048,4096]);
  assert.equal(report.cases.length,6);
  assert.equal(report.negatives.length,6);
  assert.ok(report.cases.some(c=>c.style==='implicit'),
    'semantic misses remain visible as diagnostics even without an embedding model');
  const failures=report.gates.filter(x=>!x.pass).map(x=>x.id);
  assert.deepEqual(failures,[],JSON.stringify({scores:report.scores,
    missed:report.cases.flatMap(c=>c.located
      .filter(x=>!x.rank).map(x=>({case:c.id,missing:x.key}))),
    negatives:report.negatives,budgetFailures:report.budgetFailures},null,2));
});

test('evaluator is repeatable with a fresh isolated SQLite fixture on each invocation',()=>{
  const a=evaluateActorRecall(),b=evaluateActorRecall();
  assert.deepEqual(a.scores,b.scores);
  assert.deepEqual(a.negatives,b.negatives);
  assert.deepEqual(a.gates,b.gates);
  assert.equal(a.passing,b.passing);
});
