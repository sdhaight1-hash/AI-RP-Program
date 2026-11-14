import test from 'node:test';
import assert from 'node:assert/strict';
import { createCharacter, createSession, normalizeState, buildMessages } from '../engine.mjs';
import { getChannel, channelObservations } from '../interactions/channels.mjs';
import { createActorContext } from '../harness.mjs';

test('interaction channels define distinct permitted signals and safe fallback', () => {
  assert.equal(getChannel('no-such-channel').id, 'in_person');
  assert.deepEqual(getChannel('text_message').perceptible, ['delivered_text']);
  assert.equal(getChannel('phone_call').perceptible.includes('visible_action'),false);
});

test('perceptual events require both actor witnessing and channel permission', () => {
  const events=[
    {witnessIds:['mara'],signal:'visible_action',description:'She adjusts the lampshade.'},
    {witnessIds:['mara'],signal:'audible_sound',description:'A door clicks.'},
    {witnessIds:['mara'],signal:'delivered_text',description:'ok, heading home now'},
    {witnessIds:['elise'],signal:'audible_sound',description:'Only Elise hears this.'},
    {witnessIds:['mara'],description:'Unclassified legacy event'},
  ];
  assert.deepEqual(channelObservations(events,'phone_call','mara').map(x=>x.description),['A door clicks.']);
  assert.deepEqual(channelObservations(events,'text_message','mara').map(x=>x.description),['ok, heading home now']);
  assert.equal(channelObservations(events,'in_person','mara').length,2);
});

test('phone and messaging prompts exclude untransmitted scene visuals but retain character voice and agency', () => {
  const mara=createCharacter('Mara');mara.scenario='UNSEEN_INITIAL_ROOM';mara.speechStyle='dry, funny';mara.handle='@mara';
  const scene=createSession(mara);scene.messages=[{role:'user',content:'Can you hear me?',witnessIds:[mara.id],channelId:'phone_call'}];
  scene.location='UNSEEN_ROOM';scene.atmosphere='UNSEEN_VISUAL_CUE';scene.publicSummary='UNSEEN_PUBLIC_VISUAL_SUMMARY';scene.summary='UNSEEN_PRIVATE_VISUAL_SUMMARY';scene.channelId='phone_call';
  scene.sceneEvents=[
    {id:'1',kind:'observation',description:'UNSEEN_ACTOR_GESTURE',signal:'visible_action',witnessIds:[mara.id]},
    {id:'2',kind:'observation',description:'A muffled knock',signal:'audible_sound',witnessIds:[mara.id]},
    {id:'3',kind:'observation',description:'THE_OTHER_SECRET',signal:'audible_sound',witnessIds:['other']},
    {id:'4',kind:'observation',description:'MESSAGE_CONTENT',signal:'delivered_text',witnessIds:[mara.id]},
  ];
  const make=()=>createActorContext({session:scene,characters:[mara],actorId:mara.id,persona:{name:'Player'},lore:[],buildMessages}).messages.map(m=>m.content).join('\n');
  let phone=make();
  assert.match(phone,/audio-only phone call/i);
  assert.match(phone,/dry, funny/);
  assert.match(phone,/muffled knock/);
  for (const forbidden of ['UNSEEN_INITIAL_ROOM','UNSEEN_ROOM','UNSEEN_VISUAL_CUE','UNSEEN_PUBLIC_VISUAL_SUMMARY','UNSEEN_PRIVATE_VISUAL_SUMMARY','UNSEEN_ACTOR_GESTURE','THE_OTHER_SECRET','MESSAGE_CONTENT'])assert.equal(phone.includes(forbidden),false,forbidden);
  scene.channelId='text_message';
  const msg=make();
  assert.match(msg,/ONLY the exact message text/i);
  assert.match(msg,/Do not invent messages from the player/i);
  assert.ok(msg.includes('MESSAGE_CONTENT'));
  assert.equal(msg.includes('muffled knock'),false);
  scene.channelId='in_person';
  assert.match(make(),/UNSEEN_VISUAL_CUE/);
});

test('channel migration preserves each message medium through switches', () => {
  const mara=createCharacter('Mara');const s=createSession(mara);
  s.channelId='text_message';s.messages=[
    {role:'user',content:'hey',channelId:'text_message',witnessIds:[mara.id]},
    {role:'assistant',speakerId:mara.id,content:'hey!',channelId:'text_message',witnessIds:[mara.id]},
    {role:'user',content:'calling now',channelId:'phone_call',witnessIds:[mara.id]},
  ];
  const normalized=normalizeState({characters:[mara],sessions:[s],activeSessionId:s.id,settings:{},lore:[],persona:{name:'Player'}});
  assert.equal(normalized.sessions[0].channelId,'text_message');
  assert.deepEqual(normalized.sessions[0].messages.map(m=>m.channelId),['text_message','text_message','phone_call']);
  assert.equal(normalizeState({...normalized,sessions:[{...s,channelId:'invalid'}]}).sessions[0].channelId,'in_person');
});

test('local server serves the channel rules module to the browser', async () => {
  const { createApp } = await import('../server.mjs');
  const { StudioStore } = await import('../storage.mjs');
  const server=createApp({store:new StudioStore(':memory:'),fetchImpl:async()=>{throw Error('Inference not needed');}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const resp=await fetch(`http://127.0.0.1:${server.address().port}/interactions/channels.mjs`);
    assert.equal(resp.status,200);
    assert.match(resp.headers.get('content-type'),/javascript/);
    const text=await resp.text();
    assert.match(text,/phone_call/);
    assert.match(text,/text_message/);
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('NPCs use channel-specific speaking habits while preserving their core identity', () => {
  const mara=createCharacter('Mara');
  Object.assign(mara,{
    personality:'INVARIANT_PERSONALITY quiet and kind',
    speechStyle:'GENERAL_VOICE dry humor',
    inPersonStyle:'INPERSON_STYLE makes small jokes and pauses',
    phoneStyle:'PHONE_STYLE slow pauses and soft laughter',
    textStyle:'TEXT_STYLE one-liners and careful punctuation',
  });
  const scene=createSession(mara);
  scene.messages=[{role:'user',content:'Hi there!',witnessIds:[mara.id],channelId:'text_message'}];
  const ctx=()=>createActorContext({session:scene,characters:[mara],actorId:mara.id,persona:{name:'Player'},lore:[],buildMessages}).messages[0].content;
  for(const [channel,expected,forbidden] of [
    ['text_message','TEXT_STYLE',['PHONE_STYLE','INPERSON_STYLE']],
    ['phone_call','PHONE_STYLE',['TEXT_STYLE','INPERSON_STYLE']],
    ['in_person','INPERSON_STYLE',['PHONE_STYLE','TEXT_STYLE']],
  ]) {
    scene.channelId=channel;
    const prompt=ctx();
    assert.match(prompt,/INVARIANT_PERSONALITY/);
    assert.match(prompt,/GENERAL_VOICE/);
    assert.ok(prompt.includes(expected),channel);
    for(const item of forbidden)assert.ok(!prompt.includes(item),`${channel} leaked ${item}`);
  }
});

test('channel voices survive native character import and save normalization', async () => {
  const { importCharacter }=await import('../engine.mjs');
  const imported=importCharacter({name:'Mara',phoneStyle:'gentle, slow',textStyle:'short with lowercase',inPersonStyle:'hand gestures'});
  assert.equal(imported.textStyle,'short with lowercase');
  const session=createSession(imported);
  const saved=normalizeState({characters:[imported],sessions:[session],activeSessionId:session.id,lore:[],settings:{},persona:{name:'Player'}});
  assert.equal(saved.characters[0].phoneStyle,'gentle, slow');
  const legacy=createCharacter('Original');
  assert.equal(legacy.phoneStyle,'');
});
