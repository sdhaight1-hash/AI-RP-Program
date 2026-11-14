import test from 'node:test';
import assert from 'node:assert/strict';
import {getChannel,CHANNEL_OPTIONS,channelAudience,channelObservations,
  getChannelVoice} from '../interactions/channels.mjs';
import {createCharacter,createSession,normalizeState,makeEmptyWorldState} from '../engine.mjs';
import {createActorContext,purgeArchived,archiveCharacter} from '../harness.mjs';
import {removeEncounterTemplate,encounterDependencies} from '../encounters/library.mjs';
import {inspectNpcReply} from '../interactions/reply-review.mjs';

test('single channel catalog controls every supported scene and template medium',()=>{
  const modes=['in_person','phone_call','video_call','text_message','social_dm','social_thread','email'];
  assert.deepEqual(CHANNEL_OPTIONS.map(x=>x.id),modes);
  for(const mode of modes){
    const channel=getChannel(mode);
    assert.equal(channel.id,mode);
    assert.ok(channel.label&&channel.description&&channel.placeholder&&channel.direction);
    assert.ok(['cast','directed'].includes(channel.audience));
    assert.ok(['spoken','written'].includes(channel.kind));
  }
  assert.equal(getChannel('unsupported').id,'in_person');
  assert.equal(channelAudience('video_call'),'cast');
  assert.equal(channelAudience('social_thread'),'cast');
  assert.equal(channelAudience('social_dm'),'directed');
  assert.equal(channelAudience('email'),'directed');
});

test('webcam sees camera-transmitted gestures but never private off-camera or unseen room events',()=>{
  const events=[
    {witnessIds:['mara'],signal:'camera_visible',description:'A visible wave on webcam'},
    {witnessIds:['mara'],signal:'audible_sound',description:'A faint microphone crackle'},
    {witnessIds:['mara'],signal:'visible_action',description:'Off-camera person changes clothes'},
    {witnessIds:['mara'],signal:'shared_environment',description:'Entire off-camera apartment'},
    {witnessIds:['mara'],description:'Unclassified legacy scene entry'},
    {witnessIds:['other'],signal:'camera_visible',description:'Private video another actor sees'}
  ];
  assert.deepEqual(channelObservations(events,'video_call','mara').map(x=>x.description),
    ['A visible wave on webcam','A faint microphone crackle']);
  const actor=createCharacter('Mara'),session=createSession(actor);
  session.channelId='video_call';session.location='OFF_CAMERA_ROOM_SECRET';
  session.atmosphere='OFF_CAMERA_VISUAL_SECRET';
  session.sceneEvents=events.map((e,i)=>({...e,id:'event-'+i,kind:'observation',witnessIds:e.witnessIds.map(id=>id==='mara'?actor.id:id)}));
  const prompt=createActorContext({session,characters:[actor],actorId:actor.id,
    persona:{name:'Player'},lore:[],buildMessages:({sceneNotes,styleInstruction,channelVoice})=>({
      messages:[{role:'system',content:[sceneNotes,styleInstruction,channelVoice].join('\n')}]
    })}).messages[0].content;
  assert.match(prompt,/live webcam\/video call/i);
  assert.match(prompt,/camera-framed/i);
  assert.match(prompt,/visible wave on webcam/i);
  assert.doesNotMatch(prompt,/OFF_CAMERA_ROOM_SECRET|OFF_CAMERA_VISUAL_SECRET|Off-camera person|Entire off-camera apartment|Private video another actor/);
});

test('social feed, private DMs and email have distinct audience and no made-up non-player accounts',()=>{
  const actor=createCharacter('Etta');
  actor.textStyle='types in lowercase';
  const state=makeEmptyWorldState();
  const items=[];
  for(const mode of ['social_dm','social_thread','email']){
    const encounter={id:'template-'+mode,title:'Online '+mode,characterIds:[actor.id],
      channelId:mode,premise:'A pending exchange',opening:'hey, checking in',
      locationId:null,alternativeOpenings:[]};
    items.push(encounter);
    const scene=createSession(actor,encounter);
    assert.equal(scene.channelId,mode);
    assert.equal(scene.messages[0].channelId,mode);
    assert.deepEqual(scene.messages[0].witnessIds,[actor.id]);
    assert.equal(getChannelVoice(actor,mode),'types in lowercase');
    assert.match(getChannel(mode).direction,/other accounts|other users|player replies/i);
    assert.match(inspectNpcReply(mode,'*smiles* hello!',actor.name)[0],/stage directions/i);
    assert.deepEqual(inspectNpcReply(mode,'hello from the studio',actor.name),[]);
  }
  state.characters=[actor];state.encounters=items;
  const normalized=normalizeState(state);
  assert.deepEqual(normalized.encounters.map(e=>e.channelId),['social_dm','social_thread','email']);
});

test('video and public-thread templates witness the actual scene cast, while direct messages stay restricted',()=>{
  const a=createCharacter('First'),b=createCharacter('Second');
  for(const [channel,allCast] of [['video_call',true],['social_thread',true],
    ['phone_call',false],['social_dm',false]]){
    const encounter={id:'m-'+channel,title:'Multi actor call',characterIds:[a.id,b.id],
      channelId:channel,opening:'Hello from the starting speaker',premise:'',locationId:null};
    const scene=createSession(a,encounter);
    assert.deepEqual(scene.castIds,[a.id,b.id]);
    assert.deepEqual(scene.messages[0].witnessIds,allCast?[a.id,b.id]:[a.id]);
  }
});

test('template deletion preserves played transcripts and unblocks archived character purge',()=>{
  const actor=createCharacter('Blocked Test'),state=makeEmptyWorldState();
  const template={id:'enc-template-1',title:'An old webcam invitation',characterIds:[actor.id],
    channelId:'video_call',premise:'An invitation',opening:'Are you there?',locationId:null};
  state.characters=[actor];state.encounters=[template];
  assert.deepEqual(encounterDependencies(state,actor.id).map(x=>x.title),[template.title]);
  archiveCharacter(state,actor.id);
  assert.throws(()=>purgeArchived(state,'character',actor.id),/An old webcam invitation.*Open Encounters/);
  state.sessions=[createSession(actor,template)];
  const firstMessage=structuredClone(state.sessions[0].messages[0]);
  const removed=removeEncounterTemplate(state,template.id);
  assert.equal(removed.id,template.id);
  assert.equal(state.encounters.length,0);
  assert.equal(state.sessions[0].encounterId,null);
  assert.deepEqual(state.sessions[0].messages[0],firstMessage);
  assert.throws(()=>purgeArchived(state,'character',actor.id),/scene/i,
    'a live or archived scene still requires its own explicit purge');
  assert.throws(()=>removeEncounterTemplate(state,'nonexistent'),/not found/i);
});

test('every authored message medium survives story normalization rather than silently becoming in-person',()=>{
  const actor=createCharacter('Avery'),scene=createSession(actor);
  scene.channelId='video_call';
  scene.messages=CHANNEL_OPTIONS.map((channel,index)=>({
    id:'message-'+index,role:index%2?'assistant':'user',
    speakerId:index%2?actor.id:undefined,channelId:channel.id,
    content:'Author explicitly chose '+channel.label,witnessIds:[actor.id]
  }));
  const state=normalizeState({characters:[actor],sessions:[scene],
    activeSessionId:scene.id,encounters:[],lore:[],settings:{},persona:{name:'Player'}});
  assert.equal(state.sessions[0].channelId,'video_call');
  assert.deepEqual(state.sessions[0].messages.map(x=>x.channelId),
    CHANNEL_OPTIONS.map(channel=>channel.id));
  const again=normalizeState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(again.sessions[0].messages.map(x=>x.channelId),
    CHANNEL_OPTIONS.map(channel=>channel.id));
});


test('SQLite round-trip preserves webcam and social medium of every authored message',async()=>{
  const {StudioStore}=await import('../storage.mjs');
  const store=new StudioStore(':memory:');
  try{
    const actor=createCharacter('Noah'),scene=createSession(actor);
    scene.channelId='video_call';
    scene.messages=['video_call','social_dm','social_thread','email'].map((channelId,i)=>({
      id:'persist-'+i,role:i%2?'assistant':'user',
      speakerId:i%2?actor.id:undefined,content:'Line from '+channelId,
      channelId,witnessIds:[actor.id],sentAt:1000+i
    }));
    const state=makeEmptyWorldState();
    state.characters=[actor];state.sessions=[scene];state.activeSessionId=scene.id;
    assert.equal(store.save(state,0).revision,1);
    const reloaded=store.load().state.sessions[0];
    assert.equal(reloaded.channelId,'video_call');
    assert.deepEqual(reloaded.messages.map(m=>m.channelId),
      ['video_call','social_dm','social_thread','email']);
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{store.close();}
});
