import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorldPartitionStore } from '../world/partition-store.mjs';
import { StudioStore } from '../storage.mjs';
import { createApp } from '../server.mjs';
import { createCharacter, createSession, makeEmptyWorldState, makeInitialState } from '../engine.mjs';
import { duplicateSession, archiveSession, purgeArchived } from '../harness.mjs';
import { DatabaseSync } from 'node:sqlite';

async function fixture(t, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-rp-audit-'));
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  const store = new WorldPartitionStore(dir);
  const app = createApp({store});
  await new Promise(resolve => app.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try { await fn({store,base}); }
  finally { await new Promise(resolve => app.close(resolve)); }
}

const sceneState = (character) => {
  const state=makeEmptyWorldState();
  state.characters=[character];state.sessions=[createSession(character)];state.activeSessionId=state.sessions[0].id;
  return state;
};

test('server delivers all browser modules from their real source directories', async t => fixture(t,async({base})=>{
  for (const route of ['/character/context.mjs','/character/schema.mjs','/character/authoring.mjs','/harness.mjs','/interactions/channels.mjs']) {
    const response=await fetch(base+route);
    assert.equal(response.status,200,route);
    assert.match(response.headers.get('content-type'),/javascript/);
    assert.match(await response.text(),/export|import/,route);
  }
}));

test('FTS ranks only lore permitted for the selected NPC, even when private hits dominate', t=>{
  const db=new StudioStore(':memory:');t.after(()=>db.close());
  const state=makeInitialState();const npc=state.characters[0];
  state.lore=[...Array.from({length:160},(_,i)=>({id:`secret-${i}`,title:'Secret',content:'harbor harbor harbor harbor harbor',keywords:['harbor'],visibility:'private',knownBy:['someone-else']})),
    {id:'public-visible',title:'Public',content:'harbor gathering',keywords:['harbor'],visibility:'public'}];
  db.save(state,0);
  assert.deepEqual(db.searchLore('harbor',{actorId:npc.id,sessionId:state.sessions[0].id}).map(x=>x.id),['public-visible']);
});

test('world-local story saves reject foreign scene actors, witnesses and encounter participants',async t=>fixture(t,async({store})=>{
  const a=store.activeWorldId;
  const charA=createCharacter('A');const stateA=sceneState(charA);
  store.save(stateA,store.load().revision,{worldId:a});
  const b=store.worlds.createWorld({name:'World B'}).id;store.activateWorld(b);
  const charB=createCharacter('B');const stateB=sceneState(charB);
  stateB.sessions[0].castIds.push(charA.id);
  assert.throws(()=>store.save(stateB,store.load().revision,{worldId:b}),/outside this world/);
  stateB.sessions[0].castIds=[charB.id];
  stateB.sessions[0].messages.push({role:'user',content:'Hello',witnessIds:[charA.id]});
  assert.throws(()=>store.save(stateB,store.load().revision,{worldId:b}),/witness/);
  stateB.sessions[0].messages=[];
  stateB.encounters=[{id:'foreign-encounter',title:'Wrong person',characterIds:[charA.id],channelId:'in_person'}];
  assert.throws(()=>store.save(stateB,store.load().revision,{worldId:b}),/Encounter references/);
  assert.equal(store.load().state.characters.length,0);
}));

test('entity projection failures roll back story changes and revision together',async t=>fixture(t,async({store})=>{
  const worldId=store.activeWorldId;
  const initial=store.load();
  store.db.exec(`CREATE TRIGGER deny_entity BEFORE INSERT ON world_entities
    BEGIN SELECT RAISE(ABORT,'Entity write intentionally denied'); END;`);
  const state=sceneState(createCharacter('New NPC'));
  assert.throws(()=>store.save(state,initial.revision,{worldId}),/Entity write intentionally denied/);
  assert.equal(store.load().revision,initial.revision);
  assert.deepEqual(store.load().state.characters,[]);
  assert.deepEqual(store.worlds.list().entities,[]);
}));

test('world scope isolates assets and state without blocking simultaneous tabs',async t=>fixture(t,async({store,base})=>{
  const a=store.activeWorldId;
  const b=store.worlds.createWorld({name:'Other'}).id;
  store.activateWorld(b);
  const portrait=await fetch(`${base}/portraits/11111111-1111-4111-8111-111111111111.jpg?worldId=${a}`);
  assert.equal(portrait.status,404,'missing asset must not be fabricated by the other world');
  const stateA=await fetch(`${base}/api/state?worldId=${a}`);
  const stateB=await fetch(`${base}/api/state?worldId=${b}`);
  assert.equal(stateA.status,200);
  assert.equal(stateB.status,200);
  assert.equal((await stateA.json()).worldId,a);
  assert.equal((await stateB.json()).worldId,b);
  const lore=await fetch(`${base}/api/search/lore`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({worldId:a,sessionId:'x',actorId:'x',query:'secret'})});
  assert.equal(lore.status,400,'invalid actor must not gain lore access');
  const events=await fetch(`${base}/api/events/proposals?sceneId=x&worldId=${a}`);
  assert.equal(events.status,200);
  assert.deepEqual((await events.json()).proposals,[]);
  assert.equal((await fetch(`${base}/api/comfy/history?job=old&worldId=${a}`)).status,404);
  assert.equal((await fetch(`${base}/api/comfy/image?job=old&filename=x.png&worldId=${a}`)).status,404);
}));

test('JSON body preserves multibyte UTF-8 characters split across transport chunks', async t=>{
  let seen;
  const store=new StudioStore(':memory:');
  const app=createApp({store,fetchImpl:async(url,options)=>{
    seen=JSON.parse(options.body).messages[0].content;
    return new Response('data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  }});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.close(resolve));});
  const payload=Buffer.from(JSON.stringify({model:'local',temperature:0.8,max_tokens:128,messages:[{role:'user',content:'café'}]}));
  const pos=payload.indexOf(Buffer.from('é'))+1;
  assert.ok(pos>1);
  const status=await new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:app.address().port,method:'POST',path:'/api/chat',headers:{'Content-Type':'application/json','Transfer-Encoding':'chunked'}},res=>{
      res.resume();res.on('end',()=>resolve(res.statusCode));
    });
    req.on('error',reject);req.write(payload.subarray(0,pos));
    setTimeout(()=>req.end(payload.subarray(pos)),10);
  });
  assert.equal(status,200);
  assert.equal(seen,'café');
});


test('failed registry insert cleans up the newly created world directory',async t=>fixture(t,async({store})=>{
  const before=readdirSync(join(store.dataDir,'worlds')).sort();
  store.registry.exec(`CREATE TRIGGER deny_catalog BEFORE INSERT ON world_catalog
    BEGIN SELECT RAISE(ABORT,'Registry intentionally denied'); END;`);
  assert.throws(()=>store.createWorld({name:'Unregistered world'}),/Registry intentionally denied/);
  assert.deepEqual(readdirSync(join(store.dataDir,'worlds')).sort(),before);
}));

test('pre-upgrade SQLite backup remains consistent when source has WAL pages', t=>{
  const dir=mkdtempSync(join(tmpdir(),'ai-rp-backup-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'legacy.sqlite');
  const legacy=new DatabaseSync(path);
  legacy.exec("PRAGMA journal_mode = WAL; CREATE TABLE markers(value TEXT); INSERT INTO markers VALUES ('durable WAL marker');");
  // Keep the writer connection open: VACUUM INTO must include committed WAL pages.
  const upgraded=new StudioStore(path);
  upgraded.close();legacy.close();
  const backup=`${path}.before-world-v1.bak`;
  assert.ok(existsSync(backup));
  const snapshot=new DatabaseSync(backup,{readOnly:true});
  try {
    assert.equal(snapshot.prepare('SELECT value FROM markers').get().value,'durable WAL marker');
    assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  } finally {snapshot.close();}
});

test('branches retain their original scene when copied replies depend on it',t=>{
  const original=makeInitialState(), source=original.sessions[0];
  const fork=duplicateSession(original,source.id);
  archiveSession(original,source.id);
  assert.throws(()=>purgeArchived(original,'scene',source.id),/branches depend on its history/);
  const store=new StudioStore(':memory:');t.after(()=>store.close());
  store.save(original,0);
  const forged=structuredClone(original);
  forged.sessions=forged.sessions.filter(x=>x.id!==source.id);
  assert.throws(()=>store.save(forged,1),/depends on its original scene history/);
  assert.equal(store.load().revision,1);
  assert.ok(store.load().state.sessions.some(x=>x.id===source.id));
});


test('failed active-world registry update leaves the original world open and writable',async t=>fixture(t,async({store})=>{
  const first=store.activeWorldId;
  const second=store.worlds.createWorld({name:'Switch destination'}).id;
  store.registry.exec(`CREATE TRIGGER reject_switch BEFORE UPDATE ON registry_settings
    WHEN NEW.key='active_world' AND NEW.value!=OLD.value
    BEGIN SELECT RAISE(ABORT,'Registry switch deliberately denied'); END;`);
  assert.throws(()=>store.activateWorld(second),/Registry switch deliberately denied/);
  assert.equal(store.activeWorldId,first);
  assert.equal(store.registry.prepare("SELECT value FROM registry_settings WHERE key='active_world'").get().value,first);
  assert.equal(store.load().worldId,first);
  store.save(sceneState(createCharacter('Still in the original world')),
    store.load().revision,{worldId:first});
  store.registry.exec('DROP TRIGGER reject_switch');
  store.activateWorld(second);
  assert.equal(store.load().worldId,second);
  assert.equal(store.load().state.characters.length,0);
}));

test('failed world activation entity repair rolls back without switching worlds',async t=>fixture(t,async({store})=>{
  const first=store.activeWorldId;
  const second=store.worlds.createWorld({name:'Needs entity repair'}).id;
  store.activateWorld(second);
  store.save(sceneState(createCharacter('Destination NPC')),
    store.load().revision,{worldId:second});
  store.activateWorld(first);
  const db=new DatabaseSync(store.worldFile(second));
  try {
    db.exec(`DELETE FROM world_entities WHERE source_character_id IS NOT NULL;
      CREATE TRIGGER reject_entity_repair BEFORE INSERT ON world_entities
      BEGIN SELECT RAISE(ABORT,'Entity repair deliberately denied'); END;`);
  } finally { db.close(); }
  assert.throws(()=>store.activateWorld(second),/Entity repair deliberately denied/);
  assert.equal(store.activeWorldId,first);
  assert.equal(store.registry.prepare("SELECT value FROM registry_settings WHERE key='active_world'").get().value,first);
  assert.equal(store.load().worldId,first);
  const check=new DatabaseSync(store.worldFile(second),{readOnly:true});
  try {assert.equal(check.prepare('SELECT count(*) AS count FROM world_entities').get().count,0);}
  finally {check.close();}
}));
