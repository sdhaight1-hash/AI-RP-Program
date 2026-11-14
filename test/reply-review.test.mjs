import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectNpcReply, replyBasis, isReplyBasisCurrent } from '../interactions/reply-review.mjs';
import { createCharacter, createSession } from '../engine.mjs';

test('ordinary messages are not withheld merely for casual style or audible behavior', () => {
  assert.deepEqual(inspectNpcReply('text_message','lol just got back 😅','Mara Vale'),[]);
  assert.deepEqual(inspectNpcReply('text_message','I was there at 8:30, sorry!','Mara Vale'),[]);
  assert.deepEqual(inspectNpcReply('phone_call','*sighs* Sorry, it has been a long day.','Mara Vale'),[]);
  assert.deepEqual(inspectNpcReply('in_person','Mara looks over the book, smiling warmly. "Welcome back."','Mara Vale'),[]);
});

test('the messaging channel flags stage directions, source labels, and timestamps', () => {
  assert.match(inspectNpcReply('text_message','*smiles* hey :)','Mara')[0],/stage directions/i);
  assert.match(inspectNpcReply('text_message','Narrator: the screen fades','Mara')[0],/scene narration/i);
  assert.match(inspectNpcReply('text_message','Mara: hey!','Mara Vale')[0],/speaker label/i);
  assert.match(inspectNpcReply('text_message','[08:42] hey!','Mara Vale')[0],/timestamp/i);
  assert.deepEqual(inspectNpcReply('text_message','hey, did you say "Mara: hello"?','Mara Vale'),[]);
});

test('the phone channel flags untransmitted visuals but allows transmitted audio cues', () => {
  assert.match(inspectNpcReply('phone_call','She smiles and nods before speaking.','Mara')[0],/visual/i);
  assert.match(inspectNpcReply('phone_call','Mara grins at the window.','Mara Vale')[0],/visual/i);
  assert.match(inspectNpcReply('phone_call','*nods* Yeah, sure.','Mara Vale')[0],/visual/i);
  assert.deepEqual(inspectNpcReply('phone_call','I hear the rain tapping against the glass.','Mara'),[]);
});

test('player dialogue and voluntary actions are flagged regardless of channel', () => {
  for(const channel of ['in_person','phone_call','text_message']) {
    assert.match(inspectNpcReply(channel,'Player: I agree.','Mara')[0],/player-controlled/i);
    assert.match(inspectNpcReply(channel,'You decide to leave.','Mara')[0],/player-controlled/i);
    assert.match(inspectNpcReply(channel,'*You smile*','Mara')[0],/player-controlled/i);
  }
});

test('reply review basis rejects changed timelines, casts, channels, turns, speakers, and witnesses', () => {
  const mara=createCharacter('Mara');const s=createSession(mara);
  s.timelineId='timeline-1';s.messages.push({id:'player-1',role:'user',content:'hey',witnessIds:[mara.id]});
  const original=structuredClone(s);const basis=replyBasis(s);
  assert.equal(isReplyBasisCurrent(s,basis),true);
  const mutations=[
    obj=>{obj.timelineId='timeline-2';},
    obj=>{obj.channelId='phone_call';},
    obj=>{obj.castIds.push('new-person');},
    obj=>{obj.speakerId='new-person';},
    obj=>{obj.messages.push({id:'player-2',role:'user',content:'a new message'});},
    obj=>{obj.messages.at(-1).content='an edited player message';},
    obj=>{obj.messages.at(-1).witnessIds=[];},
    obj=>{obj.location='Another location';},
  ];
  for(const change of mutations){const changed=structuredClone(original);change(changed);assert.equal(isReplyBasisCurrent(changed,basis),false);}
  assert.equal(isReplyBasisCurrent(null,basis),false);
  s.updatedAt=Date.now()+1000; // Storage timestamps are not scene-content edits.
  assert.equal(isReplyBasisCurrent(s,basis),true);
});

test('reply review module is served by the local application', async () => {
  const { createApp }=await import('../server.mjs');
  const { StudioStore }=await import('../storage.mjs');
  const app=createApp({store:new StudioStore(':memory:'),fetchImpl:async()=>{throw Error('model not needed');}});
  await new Promise(ok=>app.listen(0,'127.0.0.1',ok));
  try {
    const r=await fetch(`http://127.0.0.1:${app.address().port}/interactions/reply-review.mjs`);
    assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/javascript/);
    assert.match(await r.text(),/isReplyBasisCurrent/);
  } finally {await new Promise(ok=>app.close(ok));}
});
