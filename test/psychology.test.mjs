import test from 'node:test';
import assert from 'node:assert/strict';
import { createMind,normalizeMind,normalizeDisposition,appraiseConfirmedEvent,advanceMindTime,describeMind } from '../psychology.mjs';
const event={id:'event-one',kind:'revelation',description:'The player concealed the map',witnessIds:['mara','elise'],at:1};
const bad={desirability:-.8,significance:.9,surprise:.9,control:.2,actorResponsible:'player'};

test('different dispositions appraise the exact same confirmed event differently',()=>{
  const reactive=appraiseConfirmedEvent({mind:createMind(),disposition:{reactivity:1,threatSensitivity:1,forgiveness:0},actorId:'mara',event,appraisal:bad});
  const restrained=appraiseConfirmedEvent({mind:createMind(),disposition:{reactivity:0,threatSensitivity:0,forgiveness:1},actorId:'elise',event,appraisal:bad});
  assert.ok(reactive.emotions.distress>restrained.emotions.distress);
  assert.ok(reactive.emotions.fear>restrained.emotions.fear);
  assert.ok(reactive.relationships.player.trust<restrained.relationships.player.trust);
  assert.match(describeMind(reactive,'Mara'),/distress/);
  assert.throws(()=>appraiseConfirmedEvent({mind:reactive,disposition:{},actorId:'mara',event,appraisal:bad}),/already appraised/);
});

test('unwitnessed event cannot affect actor; every state field remains bounded',()=>{
  assert.throws(()=>appraiseConfirmedEvent({mind:createMind(),disposition:{},event,appraisal:bad,actorId:'absent'}),/did not witness/);
  const mind=appraiseConfirmedEvent({mind:createMind(),disposition:{reactivity:100},event,appraisal:{desirability:-10,significance:10,surprise:10,control:-5,actorResponsible:'player'},actorId:'mara'});
  for(const value of Object.values(mind.emotions)) assert.ok(value>=0 && value<=1);
  assert.ok(mind.mood.valence>=-1 && mind.mood.valence<=1);
  assert.ok(mind.relationships.player.trust>=-1 && mind.relationships.player.trust<=1);
});

test('short feelings decay over elapsed fictional time; relationships persist',()=>{
  const original=appraiseConfirmedEvent({mind:createMind(),disposition:{},event,appraisal:bad,actorId:'mara'});
  const after=advanceMindTime(original,12);
  assert.ok(after.emotions.distress<original.emotions.distress);
  assert.deepEqual(after.relationships,original.relationships);
  assert.deepEqual(after.reasons,original.reasons);
  assert.throws(()=>advanceMindTime(original,-1),/Elapsed hours/);
});
