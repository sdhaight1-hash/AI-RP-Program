import test from 'node:test';
import assert from 'node:assert/strict';
import { measureStorageScale,runStorageScaleEvaluation } from '../eval/storage-scale.mjs';

test('disk-backed benchmark uses ephemeral worlds and verifies persisted actor memories',()=>{
  const row=measureStorageScale(120);
  assert.equal(row.turns,120);
  assert.equal(row.memoryRows,121);
  assert.equal(row.integrity,'ok');
  assert.ok(row.databaseBytes>0&&row.snapshotBytes>0);
  for(const key of ['initialSaveMs','loadMs','lexicalRetrievalMs','oneTurnResaveMs'])
    assert.ok(Number.isFinite(row[key])&&row[key]>=0);
  const report=runStorageScaleEvaluation([5]);
  assert.equal(report.rows.length,1);
  assert.equal(report.rows[0].memoryRows,6);
  assert.throws(()=>measureStorageScale(0),/Invalid/);
});

test('opt-in normalized-primary benchmark retains complete actor memory and revision integrity',()=>{
  const row=measureStorageScale(240,{primary:true});
  assert.equal(row.storageMode,'normalized-primary');
  assert.equal(row.turns,240);
  assert.equal(row.memoryRows,241);
  assert.equal(row.integrity,'ok');
  assert.ok(row.databaseBytes>row.snapshotBytes);
  const report=runStorageScaleEvaluation([50],{primary:true});
  assert.equal(report.rows[0].storageMode,'normalized-primary');
  assert.equal(report.rows[0].memoryRows,51);
});
