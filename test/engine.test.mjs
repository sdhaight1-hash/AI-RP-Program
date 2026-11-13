import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, createSession, getActiveLore, importCharacter, makeInitialState, normalizeState } from '../engine.mjs';

test('a new scene has a stable character, greeting and independent story fields', () => {
  const state = makeInitialState();
  assert.equal(state.characters.length, 1);
  assert.equal(state.sessions[0].messages[0].role, 'assistant');
  assert.equal(state.sessions[0].authorNote, '');
  assert.equal(state.settings.readingMode, false);
  assert.ok(state.sessions[0].messages[0].id);
  assert.equal(createSession(state.characters[0]).authorNote, '');
});

test('old session backups migrate without losing dialogue', () => {
  const base = makeInitialState();
  base.sessions[0].messages = [{ role: 'user', content: 'Hello there.' }, { role: 'assistant', content: 'Good evening.' }];
  delete base.sessions[0].authorNote;
  const migrated = normalizeState(base);
  assert.equal(migrated.sessions[0].messages.length, 2);
  assert.equal(migrated.sessions[0].authorNote, '');
  assert.ok(migrated.sessions[0].messages.every(m => typeof m.id === 'string'));
  assert.ok(migrated.sessions[0].messages.every(m => m.pinned === false));
});

test('world lore activates from recent player speech, not always-on character text', () => {
  const lore = [
    { title: 'Lantern', keywords: ['lantern'], content: 'The lantern is enchanted.' },
    { title: 'Harbor', keywords: ['harbor'], content: 'The harbor closes at dusk.' },
  ];
  assert.deepEqual(getActiveLore(lore, [{ role: 'user', content: 'Look at that lantern' }]).map(l=>l.title), ['Lantern']);
  assert.deepEqual(getActiveLore(lore, [{ role: 'user', content: 'I am at home' }]), []);
});

test('actor prompt includes canonical summary, pinned beats, author note and triggered lore', () => {
  const state = makeInitialState();
  const messages = [
    { role:'user', content:'I enter the shop.', pinned:true },
    { role:'assistant', content:'The bell rings.' },
    { role:'user', content:'I look at the red lantern.' },
  ];
  const result = buildMessages({
    character:state.characters[0], persona:state.persona,
    history:messages, summary:'The door was locked yesterday.',
    authorNote:'Slow tension, minimal exposition.',
    lore:[{title:'Lamp',keywords:['lantern'],content:'A lantern reveals ghosts.'}],
  });
  const system=result.messages[0].content;
  assert.match(system,/locked yesterday/);
  assert.match(system,/Pinned moments/);
  assert.match(system,/I enter the shop/);
  assert.match(system,/Slow tension/);
  assert.match(system,/reveals ghosts/);
  assert.equal(result.messages.length, 4);
  assert.equal(result.activatedLore.length, 1);
});

test('import accepts native character JSON, rejects malformed cards', () => {
  const imported = importCharacter({character:{name:'Liora',personality:'Precise and curious',greeting:'Welcome.'}});
  assert.equal(imported.name,'Liora');
  assert.equal(imported.greeting,'Welcome.');
  assert.throws(()=>importCharacter({name:''}),/character name/);
});
