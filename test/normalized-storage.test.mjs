import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioStore } from '../storage.mjs';
import { makeInitialState,createSession } from '../engine.mjs';
import {
  inspectStoryProjectionInput,writeStoryProjection,readStoryProjection,
  verifyStoryProjection,projectionEnabled
} from '../storage/normalized.mjs';

function stage(store) {
  const snapshot=store.load();
  store.db.exec('BEGIN IMMEDIATE');
  try {
    writeStoryProjection(store.db,snapshot.state,snapshot.revision);
    const check=verifyStoryProjection(store.db,snapshot);
    store.db.exec('COMMIT');
    return check;
  }catch(error){store.db.exec('ROLLBACK');throw error;}
}
test('normalized shadow is opt-in, parity-verified, and follows edits/reorders/deletions',()=>{
  const store=new StudioStore(':memory:');
  try{
    const initial=makeInitialState();
    store.save(initial,0);
    assert.equal(projectionEnabled(store.db),false);
    assert.equal(stage(store).status,'matched');
    let snapshot=store.load();
    assert.deepEqual(readStoryProjection(store.db).state,JSON.parse(JSON.stringify(snapshot.state)));
    // JSON persistence discards undefined legacy fields; their absence is not data loss.
    const first=snapshot.state.sessions[0];
    const old=first.messages[0];
    first.messages.push({
      id:'second-message',role:'user',content:'A source with precise witnesses.',
      witnessIds:[snapshot.state.characters[0].id],channelId:'phone_call',sentAt:501
    });
    first.messages.reverse();
    first.title='An updated room';
    store.save(snapshot.state,snapshot.revision);
    snapshot=store.load();
    assert.equal(verifyStoryProjection(store.db,snapshot).messages,2);
    assert.equal(readStoryProjection(store.db).state.sessions[0].messages[1].id,old.id);
    assert.equal(readStoryProjection(store.db).state.sessions[0].title,'An updated room');
    const secondScene=createSession(snapshot.state.characters[0]);
    secondScene.messages=[{id:'child-message',role:'assistant',content:'An answer.',
      speakerId:snapshot.state.characters[0].id,witnessIds:[snapshot.state.characters[0].id]}];
    snapshot.state.sessions.unshift(secondScene);
    store.save(snapshot.state,snapshot.revision);
    snapshot=store.load();
    assert.deepEqual(readStoryProjection(store.db).state.sessions.map(x=>x.id),
      snapshot.state.sessions.map(x=>x.id));
    snapshot.state.sessions= snapshot.state.sessions.filter(x=>x.id===secondScene.id);
    store.save(snapshot.state,snapshot.revision);
    snapshot=store.load();
    assert.equal(verifyStoryProjection(store.db,snapshot).scenes,1);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM story_projection_messages').get().n,1);
    assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length,0);
  }finally{store.close();}
});
test('projection failure rolls back canonical snapshot, revision, FTS and derived memories',()=>{
  const store=new StudioStore(':memory:');
  try{
    store.save(makeInitialState(),0);
    stage(store);
    const before=store.load();
    const beforeMemory=store.db.prepare('SELECT count(*) AS n FROM actor_memories').get().n;
    store.db.exec(`CREATE TRIGGER stop_projection BEFORE UPDATE ON story_projection_messages
      BEGIN SELECT RAISE(ABORT,'shadow write refused'); END;`);
    const changed=structuredClone(before.state);
    changed.sessions[0].messages[0].content='Changed evidence that must roll back.';
    assert.throws(()=>store.save(changed,before.revision),/shadow write refused/);
    assert.equal(store.load().revision,before.revision);
    assert.equal(store.load().state.sessions[0].messages[0].content,
      before.state.sessions[0].messages[0].content);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM actor_memories').get().n,beforeMemory);
    assert.equal(verifyStoryProjection(store.db,store.load()).status,'matched');
    store.db.exec('DROP TRIGGER stop_projection');
    const duplicates=structuredClone(before.state);
    duplicates.sessions[0].messages.push({...duplicates.sessions[0].messages[0]});
    assert.throws(()=>store.save(duplicates,before.revision),/Duplicate or invalid message ID/);
    assert.equal(store.load().revision,before.revision);
    assert.equal(verifyStoryProjection(store.db,store.load()).status,'matched');
  }finally{store.close();}
});
test('projection fingerprint detects altered sources and persists across restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-normalized-'));
  const file=join(dir,'world.sqlite');
  try{
    let store=new StudioStore(file);
    store.save(makeInitialState(),0);
    stage(store);
    store.close();
    store=new StudioStore(file);
    try{
      assert.equal(verifyStoryProjection(store.db,store.load()).status,'matched');
      store.db.prepare('UPDATE story_projection_messages SET document=? WHERE position=0')
        .run(JSON.stringify({id:'tampered',role:'user',content:'False memory'}));
      assert.throws(()=>readStoryProjection(store.db),/identity mismatch/);
      assert.throws(()=>store.save(store.load().state,store.load().revision),/identity mismatch/);
      assert.equal(store.load().revision,1);
    }finally{store.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('projection rejects invalid source keys before creating any schema',()=>{
  const store=new StudioStore(':memory:');
  try{
    const invalid=makeInitialState();
    invalid.characters.push({...invalid.characters[0]});
    assert.throws(()=>inspectStoryProjectionInput(invalid),/Duplicate or invalid character ID/);
    assert.equal(projectionEnabled(store.db),false);
  }finally{store.close();}
});
