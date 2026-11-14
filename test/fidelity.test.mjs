import test from 'node:test';
import assert from 'node:assert/strict';
import { createCharacter, makeInitialState } from '../engine.mjs';
import { FIDELITY_PROBES, makeFidelityProbe, inspectFidelityReply, fidelityProfileFingerprint, normalizeFidelityReviews } from '../fidelity.mjs';
import { createApp } from '../server.mjs';
import { StudioStore } from '../storage.mjs';

test('fidelity probes cover ordinary, conflict, boundary and multiple mediums', () => {
  assert.equal(new Set(FIDELITY_PROBES.map(x=>x.id)).size, FIDELITY_PROBES.length);
  assert.ok(FIDELITY_PROBES.some(x=>x.channelId==='phone_call'));
  assert.ok(FIDELITY_PROBES.some(x=>x.channelId==='text_message'));
  assert.ok(FIDELITY_PROBES.some(x=>x.id==='boundary'));
});

test('fidelity probes reuse real character context without changing canonical or live state', () => {
  const world=makeInitialState();
  const before=structuredClone(world);
  const character=world.characters[0];character.speechStyle='Slow, clipped sentences and gentle sarcasm.';
  const snapshot=structuredClone(world);
  const result=makeFidelityProbe({character,probeId:'ordinary',persona:world.persona});
  assert.match(result.messages[0].content,/Slow, clipped sentences/);
  assert.equal(result.messages.at(-1).content,'Player: So, what are you thinking about making for dinner?');
  assert.equal(result.messages.at(-1).role,'user');
  assert.deepEqual(world,snapshot);
  assert.notDeepEqual(world,before);
  assert.equal(world.sessions[0].messages.length,1);
  assert.doesNotMatch(result.messages[0].content,/harbor bookshop/);
});

test('phone fidelity test includes perceptual constraints without visual scene leakage', () => {
  const character=createCharacter('Mara');character.scenario='She is visibly wearing a sparkling RED DRESS in the front room.';
  const testCase=makeFidelityProbe({character,probeId:'phone'});
  assert.match(testCase.messages[0].content,/audio-only phone call/i);
  assert.doesNotMatch(testCase.messages[0].content,/RED DRESS/);
  assert.doesNotMatch(testCase.messages[0].content,/front room/);
  assert.deepEqual(testCase.messages.slice(1).map(m=>m.role),['user']);
});

test('message fidelity test compiles message-only style', () => {
  const character=createCharacter('Mara'); character.speechStyle='Short, dry jokes.';
  const messages=makeFidelityProbe({character,probeId:'everyday'}).messages;
  assert.match(messages[0].content,/text-message conversation/);
  assert.match(messages[0].content,/Short, dry jokes/);
  assert.doesNotMatch(messages[0].content,/RED DRESS/);
});

test('diagnostics flag possible voice-medium and player agency errors only as warnings', () => {
  assert.equal(inspectFidelityReply('phone','She smiles at you. “Hello.”').length,1);
  assert.equal(inspectFidelityReply('everyday','*She walks across the apartment* Hey!').length,1);
  assert.equal(inspectFidelityReply('ordinary','You decide to leave.')[0].includes('player'),true);
  assert.deepEqual(inspectFidelityReply('phone','“Hello?” A faint clink on the line.'),[]);
  assert.throws(()=>inspectFidelityReply('unknown','Hey'),/Unknown/);
});

test('review normalization bounds data, strips invalid ratings, and tracks profile versions', () => {
  const c=createCharacter('Mara');const a=fidelityProfileFingerprint(c);c.personality='quiet but kind';
  assert.notEqual(a,fidelityProfileFingerprint(c));
  const bad={id:'x'.repeat(500),probeId:'phone',reply:'h'.repeat(15000),ratings:{voice:5,agency:10,consistency:2.5,naturalness:3},notes:'x'.repeat(3000),reviewedAt:1700000000000};
  const reviews=normalizeFidelityReviews([...Array(20).fill(bad),{probeId:'invalid',reply:'x'}]);
  assert.equal(reviews.length,14); // Keep last 15 inputs, then discard the invalid probe.
  assert.equal(reviews[0].id.length,80);
  assert.equal(reviews[0].reply.length,5000);
  assert.equal(reviews[0].notes.length,1800);
  assert.equal(reviews[0].ratings.agency,null);
  assert.equal(reviews[0].ratings.naturalness,3);
});

test('fidelity test module is served by the local application', async () => {
  const app=createApp({store:new StudioStore(':memory:')});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${app.address().port}/fidelity.mjs`);
    assert.equal(response.status,200);
    assert.match(await response.text(),/makeFidelityProbe/);
  } finally { await new Promise(resolve=>app.close(resolve)); }
});
