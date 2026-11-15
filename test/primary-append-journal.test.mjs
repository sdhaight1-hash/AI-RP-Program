import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {StudioStore} from '../storage.mjs';
import {WorldPartitionStore} from '../world/partition-store.mjs';
import {createCharacter,createSession,makeEmptyWorldState,makeInitialState} from '../engine.mjs';
import {writeStoryProjection,enablePrimaryProjection,
  verifyStoryProjection,projectionPrimary,enableVerifiedAppendJournal} from '../storage/normalized.mjs';
import {enableAppendJournal,journalEnabled,appendVerifiedPlayerRow} from '../storage/append-journal.mjs';
import {readWorldEpoch} from '../world/epoch.mjs';

function activate(store){
  const db=store.db,current=store.load();
  db.exec('BEGIN IMMEDIATE');
  try{
    writeStoryProjection(db,current.state,current.revision);
    enablePrimaryProjection(db,current);
    assert.equal(verifyStoryProjection(db,current).status,'matched');
    enableVerifiedAppendJournal(db,current);
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  assert.equal(projectionPrimary(db),true);
  assert.equal(journalEnabled(db),true);
}

function append(store,{text='A newly witnessed message.',id='append-001',
  expectedRevision=store.load().revision,witnessIds,channelId,updatedAt=Date.now()}={}){
  const current=store.load(),scene=current.state.sessions[0],
    actor=current.state.characters[0],db=store.db;
  db.exec('BEGIN IMMEDIATE');
  try{
    const result=appendVerifiedPlayerRow(db,{
      sceneId:scene.id,expectedRevision,updatedAt,
      message:{id,role:'user',content:text,
        channelId:channelId||scene.channelId,witnessIds:witnessIds||[actor.id],
        sentAt:updatedAt}
    });
    db.exec('COMMIT');
    return result;
  }catch(error){db.exec('ROLLBACK');throw error;}
}

test('v1 normalized worlds do not activate or change data unless explicitly staged',()=>{
  const db=new StudioStore(':memory:');
  try{
    const first=db.save(makeInitialState(),0);
    assert.ok(first);
    assert.equal(journalEnabled(db.db),false);
    const original=db.load();
    assert.throws(()=>appendVerifiedPlayerRow(db.db,{
      sceneId:original.state.sessions[0].id,expectedRevision:original.revision
    }),/requires a SQLite transaction/);
    db.db.exec('BEGIN IMMEDIATE');
    try{
      assert.throws(()=>enableAppendJournal(db.db,original),
        /normalized-primary storage first/);
    }finally{db.db.exec('ROLLBACK');}
    assert.equal(db.load().revision,original.revision);
  }finally{db.close();}
});

test('append journal preserves source identity, actor FTS and unchanged sealed base',()=>{
  const store=new StudioStore(':memory:');
  try{
    store.save(makeInitialState(),0);
    activate(store);
    const before=store.load(),db=store.db,
      baseCount=db.prepare('SELECT count(*) AS n FROM story_projection_messages').get().n,
      beforeCompact=db.prepare('SELECT document FROM studio_state WHERE id=1').get().document,
      sourceEpoch=readWorldEpoch(db);
    const saved=append(store,{id:'journal-01',text:'The green lantern was locked away.'});
    assert.equal(saved.revision,before.revision+1);
    assert.equal(saved.message.id,'journal-01');
    assert.equal(saved.message.pinned,false);
    assert.ok(readWorldEpoch(db)>sourceEpoch);
    assert.equal(db.prepare('SELECT count(*) AS n FROM story_projection_messages').get().n,baseCount,
      'the sealed v1 base must not be rewritten for one appended message');
    assert.equal(db.prepare('SELECT count(*) AS n FROM story_append_rows').get().n,1);
    assert.equal(db.prepare('SELECT document FROM studio_state WHERE id=1').get().document,
      beforeCompact,'compact core metadata remains byte-identical');
    const current=store.load();
    assert.equal(current.revision,before.revision+1);
    assert.equal(current.state.sessions[0].messages.at(-1).content,
      'The green lantern was locked away.');
    assert.equal(verifyStoryProjection(db,current).status,'matched');
    const remembered=db.prepare("SELECT * FROM actor_memories WHERE source_message_id='journal-01'").all();
    assert.equal(remembered.length,1);
    assert.equal(remembered[0].text,'Player said: The green lantern was locked away.');
    assert.equal(db.prepare("SELECT count(*) AS n FROM actor_memories_fts WHERE actor_memories_fts MATCH 'lantern'").get().n>=1,true);
    assert.throws(()=>append(store,{id:'journal-01'}),/Duplicate source message ID/);
    assert.throws(()=>append(store,{id:'second',expectedRevision:before.revision}),/revision changed/i);
    assert.throws(()=>append(store,{id:'third',channelId:'phone_call'}),/communication medium changed/i);
    assert.equal(store.load().revision,current.revision);
  }finally{store.close();}
});

test('ordinary full-save compaction restores a standard sealed normalized-primary base',()=>{
  const store=new StudioStore(':memory:');
  try{
    store.save(makeInitialState(),0);
    activate(store);
    append(store,{id:'journal-02',text:'The river gate closed.'});
    const current=store.load();
    const draft=structuredClone(current.state);
    draft.sessions[0].authorNote='The NPC should speak cautiously.';
    const saved=store.save(draft,current.revision);
    assert.equal(saved.revision,current.revision+1);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM story_append_rows').get().n,0);
    assert.equal(store.db.prepare('SELECT revision FROM story_projection_meta WHERE id=1').get().revision,
      saved.revision);
    assert.equal(store.db.prepare('SELECT base_revision FROM story_append_meta WHERE id=1').get().base_revision,
      saved.revision);
    const reloaded=store.load();
    assert.equal(reloaded.state.sessions[0].authorNote,'The NPC should speak cautiously.');
    assert.ok(reloaded.state.sessions[0].messages.some(m=>m.id==='journal-02'));
    assert.equal(verifyStoryProjection(store.db,reloaded).status,'matched');
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{store.close();}
});

test('append and its projected memory/FTS roll back as one transaction on injected failure',()=>{
  const store=new StudioStore(':memory:');
  try{
    store.save(makeInitialState(),0);
    activate(store);
    const revision=store.load().revision,epoch=readWorldEpoch(store.db);
    store.db.exec(`CREATE TRIGGER injected_memory_failure BEFORE INSERT ON actor_memories
      BEGIN SELECT RAISE(ABORT,'intentional appended memory failure'); END;`);
    assert.throws(()=>append(store,{id:'rollback-01'}),/intentional appended memory failure/);
    store.db.exec('DROP TRIGGER injected_memory_failure');
    assert.equal(store.load().revision,revision);
    assert.equal(readWorldEpoch(store.db),epoch);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM story_append_rows').get().n,0);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM actor_memories WHERE source_message_id='rollback-01'").get().n,0);
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.equal(append(store,{id:'after-rollback'}).revision,revision+1);
  }finally{store.close();}
});

test('edited journal row is detected rather than normalized into alternate fiction',()=>{
  const store=new StudioStore(':memory:');
  try{
    store.save(makeInitialState(),0);activate(store);
    append(store,{id:'tamper-source',text:'Original accountable words.'});
    store.db.prepare("UPDATE story_append_rows SET document=replace(document,'Original','Altered') WHERE message_id='tamper-source'").run();
    assert.throws(()=>store.load(),/Append journal chain mismatch/);
  }finally{store.close();}
});

test('append journal and memory survive a world database close and reopen',()=>{
  const root=mkdtempSync(join(tmpdir(),'rp-append-restart-'));
  let store=null;
  try{
    const file=join(root,'story.sqlite');
    store=new StudioStore(file);
    store.save(makeInitialState(),0);
    activate(store);
    const sceneId=store.load().state.sessions[0].id;
    append(store,{id:'after-restart',text:'A story carried across restarts.'});
    store.close();store=null;
    store=new StudioStore(file);
    const restored=store.load();
    assert.equal(restored.state.sessions[0].id,sceneId);
    assert.equal(restored.state.sessions[0].messages.at(-1).id,'after-restart');
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM actor_memories WHERE source_message_id='after-restart'").get().n,1);
    assert.equal(verifyStoryProjection(store.db,restored).status,'matched');
  }finally{store?.close();rmSync(root,{recursive:true,force:true});}
});

test('journal remains scoped to its world and an ordinary save compacts only that world',()=>{
  const root=mkdtempSync(join(tmpdir(),'rp-append-worlds-'));
  const store=new WorldPartitionStore(root);
  try{
    const firstId=store.activeWorldId,second=store.worlds.createWorld({name:'Independent'}).id,
      one=store.forWorld(firstId),two=store.forWorld(second);
    const character=createCharacter('First World NPC'),
      state=makeEmptyWorldState(),scene=createSession(character);
    state.characters=[character];state.sessions=[scene];state.activeSessionId=scene.id;
    one.save(state,one.load().revision,{worldId:firstId});
    two.save(makeEmptyWorldState(),two.load().revision,{worldId:second});
    activate(one);
    const actor=one.load().state.characters[0],story=one.load().state.sessions[0];
    one.db.exec('BEGIN IMMEDIATE');
    try{
      appendVerifiedPlayerRow(one.db,{sceneId:story.id,expectedRevision:one.load().revision,
        message:{id:'world-only-message',role:'user',channelId:story.channelId,
          witnessIds:[actor.id],content:'Only first world',sentAt:Date.now()}});
      one.db.exec('COMMIT');
    }catch(error){one.db.exec('ROLLBACK');throw error;}
    assert.equal(one.load().state.sessions[0].messages.at(-1).id,'world-only-message');
    assert.equal(two.load().state.sessions.length,0);
    assert.equal(journalEnabled(two.db),false);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});


test('journal activation rejects a mismatched snapshot before any storage format change',()=>{
  const store=new StudioStore(':memory:');
  try{
    store.save(makeInitialState(),0);
    const db=store.db,current=store.load();
    db.exec('BEGIN IMMEDIATE');
    try{
      writeStoryProjection(db,current.state,current.revision);
      enablePrimaryProjection(db,current);
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    const fake=structuredClone(store.load());
    fake.state.sessions[0].messages[0].content='Tampered unreviewed replacement';
    db.exec('BEGIN IMMEDIATE');
    try{
      assert.throws(()=>enableVerifiedAppendJournal(db,fake),
        /Normalized projection differs from canonical story/i);
    }finally{db.exec('ROLLBACK');}
    assert.equal(journalEnabled(db),false);
    assert.equal(verifyStoryProjection(db,store.load()).status,'matched');
  }finally{store.close();}
});


test('full-save scene deletion removes journal heads before their parent rows',()=>{
  const store=new StudioStore(':memory:');
  try{
    store.save(makeInitialState(),0);activate(store);
    const source=store.load().state.sessions[0].id;
    append(store,{id:'deleted-source',text:'This scene will be deliberately purged.'});
    const latest=store.load();
    const without=structuredClone(latest.state);
    without.sessions=[];without.activeSessionId=null;
    assert.equal(store.save(without,latest.revision).revision,latest.revision+1);
    assert.equal(store.load().state.sessions.length,0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM story_append_rows').get().n,0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM story_append_heads').get().n,0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM actor_memories WHERE scene_id=?').get(source).n,0);
    assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length,0);
    assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{store.close();}
});


test('journal player turns cannot impersonate NPC events; existing accepted NPC sources remain locked',()=>{
  const store=new StudioStore(':memory:');
  try{
    store.save(makeInitialState(),0);activate(store);
    const original=store.load().state.sessions[0];
    const npc=original.messages.find(m=>m.role==='assistant');
    assert.ok(npc);
    // World events must cite the latest eligible NPC turn, not an older
    // assistant turn after the player has already continued the scene.
    const proposal=store.events.propose({sceneId:original.id,timelineId:original.timelineId,
      sourceMessageId:npc.id,description:'The NPC opened the encounter.'});
    store.events.decide({proposalId:proposal.id,decision:'accept'});
    append(store,{id:'journal-player',text:'The player describes a possible promise.'});
    const before=store.load(),scene=before.state.sessions[0];
    assert.throws(()=>store.events.propose({sceneId:scene.id,timelineId:scene.timelineId,
      sourceMessageId:'journal-player',description:'Unapproved player-origin event'}),
      /Source must be an NPC reply|Event must reference the latest selected NPC reply/);
    const altered=structuredClone(before.state);
    altered.sessions[0].messages.find(m=>m.id===npc.id).content='Contradictory rewritten NPC opening.';
    assert.throws(()=>store.save(altered,before.revision),/Accepted world event locks/i);
    assert.equal(store.load().revision,before.revision);
    assert.equal(store.load().state.sessions[0].messages.at(-1).content,
      'The player describes a possible promise.');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM story_append_rows').get().n,1);
  }finally{store.close();}
});
