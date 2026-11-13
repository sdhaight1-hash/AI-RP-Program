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

import { DEFAULT_EMOTION, EMOTION_BEATS, normalizeEmotion, applyEmotionBeat, settleEmotion, describeEmotion } from '../engine.mjs';

test('emotional state is deterministic, bounded, and never inferred from dialogue keywords', () => {
  const start = { ...DEFAULT_EMOTION };
  const excited = applyEmotionBeat(start, 'danger');
  assert.ok(excited.valence < start.valence);
  assert.ok(excited.arousal > start.arousal);
  assert.equal(excited.trust, start.trust);
  assert.deepEqual(start, DEFAULT_EMOTION); // pure update, no mutation
  assert.throws(() => applyEmotionBeat(start, 'I love you'), /Unknown emotional event/);
  let bound = start;
  for (let n = 0; n < 100; n++) bound = applyEmotionBeat(bound, 'warmth');
  assert.deepEqual(bound, { valence: 1, arousal: 1, trust: 1 });
  assert.deepEqual(normalizeEmotion({ valence: Infinity, arousal: -1, trust: NaN }), { valence: 0, arousal: 0, trust: 0 });
  assert.ok(Object.keys(EMOTION_BEATS).length >= 4);
});

test('after a scene turn momentary intensity fades but relationship trust persists', () => {
  const affected = applyEmotionBeat(DEFAULT_EMOTION, 'friction');
  const next = settleEmotion(affected);
  assert.ok(Math.abs(next.valence) < Math.abs(affected.valence));
  assert.ok(Math.abs(next.arousal - 0.25) < Math.abs(affected.arousal - 0.25));
  assert.equal(next.trust, affected.trust);
  assert.match(describeEmotion(next), /player/);
});

test('emotion survives migration and appears in the actor prompt with its limits', () => {
  const state = makeInitialState();
  assert.deepEqual(state.sessions[0].emotion, DEFAULT_EMOTION);
  const moved = applyEmotionBeat(state.sessions[0].emotion, 'warmth');
  state.sessions[0].emotion = moved;
  const copy = normalizeState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(copy.sessions[0].emotion, moved);
  const prompt = buildMessages({ character: copy.characters[0], persona: copy.persona, emotion: moved, history: [{role:'user',content:'Hello'}] });
  assert.match(prompt.messages[0].content, /Simulated character emotion/);
  assert.match(prompt.messages[0].content, /not proof of the player's intent/);
});

import { THEMES, parseCharacterDraft, PORTRAIT_PATH } from '../engine.mjs';

test('theme preferences migrate safely with ten named palettes and a customizable accent', () => {
  assert.equal(THEMES.length, 10);
  const state = makeInitialState();
  assert.equal(state.settings.theme, 'nocturne');
  state.settings.theme = 'forest';
  state.settings.customAccent = '#Aa2299';
  const result = normalizeState(state);
  assert.equal(result.settings.theme, 'forest');
  assert.equal(result.settings.customAccent, '#Aa2299');
  state.settings.theme = '<script>'; state.settings.customAccent = 'url(javascript:evil)';
  const invalid = normalizeState(state);
  assert.equal(invalid.settings.theme,'nocturne');
  assert.equal(invalid.settings.customAccent, '');
});

test('character builder fields persist through JSON migration and affect actor identity', () => {
  const state = makeInitialState(); const c = state.characters[0];
  Object.assign(c, { tagline:'The vanished cartographer', motivations:'Recover a hidden chart', fears:'Being forgotten',
    boundaries:'Will never betray a friend', speechStyle:'Slow clipped sentences', exampleDialogue:'"Leave the map."',
    tags:['Mystery','Noir'], alternateGreetings:['Come inside.', 'It is late.'],
    portrait:'/portraits/9ad7faaf-3264-4232-88c3-927865ec430c.webp', });
  const cloned = normalizeState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(cloned.characters[0].tags,['Mystery','Noir']);
  assert.deepEqual(cloned.characters[0].alternateGreetings,['Come inside.','It is late.']);
  assert.equal(cloned.characters[0].portrait,c.portrait);
  const prompt = buildMessages({character:cloned.characters[0], persona:cloned.persona});
  assert.match(prompt.messages[0].content,/hidden chart/);
  assert.match(prompt.messages[0].content,/Slow clipped sentences/);
  assert.match(prompt.messages[0].content,/Will never betray/);
  assert.doesNotMatch(prompt.messages[0].content,/9ad7faaf/);
  c.portrait = 'https://example.com/tracking.jpg';
  assert.equal(normalizeState(state).characters[0].portrait,'');
  assert.ok(PORTRAIT_PATH.test('/portraits/9ad7faaf-3264-4232-88c3-927865ec430c.webp'));
});

test('AI profile suggestion is strictly an inert, reviewed patch', () => {
  const value = parseCharacterDraft('```json\n{"name":"Eve","personality":"Reserved","tags":["Magic",3],"portrait":"https://unsafe","id":"override"}\n```');
  assert.deepEqual(value,{name:'Eve',personality:'Reserved',tags:['Magic']});
  assert.throws(()=>parseCharacterDraft('Keep writing...'),/valid character JSON/);
  assert.throws(()=>parseCharacterDraft('{"id":"unsafe"}'),/recognized character fields/);
  const baseline = makeInitialState().characters[0];
  assert.equal(baseline.name,'Mara Vale'); // parsing did not mutate anything
});
