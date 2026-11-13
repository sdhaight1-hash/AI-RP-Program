import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioStore } from '../storage.mjs';
import { makeInitialState, applyEmotionBeat } from '../engine.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-rp-test-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  return join(dir, 'studio.sqlite');
}

test('SQLite state persists across restarts with sessions and character emotions intact', t => {
  const file = fixture(t);
  const a = new StudioStore(file);
  assert.deepEqual(a.load(), { revision: 0, updatedAt: null, state: null });
  const value = makeInitialState();
  value.sessions[0].messages.push({ role: 'user', content: 'A rustling behind the door.' });
  value.sessions[0].emotion = applyEmotionBeat(value.sessions[0].emotion, 'danger');
  assert.equal(a.save(value, 0).revision, 1);
  a.close();
  const b = new StudioStore(file);
  const saved = b.load();
  assert.equal(saved.revision, 1);
  assert.equal(saved.state.sessions[0].messages.at(-1).content, 'A rustling behind the door.');
  assert.deepEqual(saved.state.sessions[0].emotion, value.sessions[0].emotion);
  b.close();
});

test('SQLite rejects stale writes and preserves newer story state', t => {
  const a = new StudioStore(fixture(t));
  t.after(() => a.close());
  const initial = makeInitialState();
  assert.equal(a.save(initial, 0).revision, 1);
  initial.sessions[0].summary = 'The key has been found.';
  assert.equal(a.save(initial, 1).revision, 2);
  const stale = makeInitialState();
  stale.sessions[0].summary = 'Old and wrong.';
  assert.equal(a.save(stale, 1), null);
  assert.equal(a.load().state.sessions[0].summary, 'The key has been found.');
  assert.equal(a.save(stale, 0), null);
  assert.throws(() => a.save(stale, -3), /Invalid revision/);
});
