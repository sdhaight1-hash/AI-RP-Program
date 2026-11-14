import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,existsSync,mkdirSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { WorldPartitionStore } from '../world/partition-store.mjs';
import { createCharacter,createSession,makeEmptyWorldState } from '../engine.mjs';
import { inspectWorldStorage } from '../scripts/storage-health.mjs';
import { backupWorldStorage } from '../scripts/backup-storage.mjs';

const root=()=>mkdtempSync(join(tmpdir(),'rp-snapshot-'));
const createState=(name)=>{
  const actor=createCharacter(name),state=makeEmptyWorldState();
  state.characters=[actor];state.sessions=[createSession(actor)];return state;
};
test('offline backup retains independent worlds, story data and assets with valid SQLite files',t=>{
  const work=root();t.after(()=>rmSync(work,{recursive:true,force:true}));
  const data=join(work,'live'),target=join(work,'copy');
  const store=new WorldPartitionStore(data),a=store.activeWorldId;
  const b=store.worlds.createWorld({name:'Other canon'}).id;
  store.forWorld(a).save(createState('Original A'),store.forWorld(a).load().revision,{worldId:a});
  store.forWorld(b).save(createState('Original B'),store.forWorld(b).load().revision,{worldId:b});
  const imageDir=store.forWorld(a).assetDir('portraits');
  mkdirSync(imageDir,{recursive:true});
  writeFileSync(join(imageDir,'local-art.webp'),'local asset');
  store.close(); // Cross-database snapshots require the app to be stopped.
  const checked=inspectWorldStorage(data);
  assert.equal(checked.ok,true,JSON.stringify(checked.errors));
  const result=backupWorldStorage(data,target);
  assert.equal(result.worldCount,2);
  assert.equal(existsSync(join(target,'backup-manifest.json')),true);
  const manifest=JSON.parse(readFileSync(result.manifest,'utf8'));
  assert.equal(manifest.databases.length,3);
  assert.equal(readFileSync(join(target,'worlds',a,'portraits','local-art.webp'),'utf8'),'local asset');
  assert.equal(inspectWorldStorage(target).ok,true);
  const recovered=new WorldPartitionStore(target);
  try {
    assert.equal(recovered.forWorld(a).load().state.characters[0].name,'Original A');
    assert.equal(recovered.forWorld(b).load().state.characters[0].name,'Original B');
  } finally {recovered.close();}
  assert.throws(()=>backupWorldStorage(data,target),/already exists/);
});

test('read-only audit reports foreign key damage and refuses to create a backup',t=>{
  const work=root();t.after(()=>rmSync(work,{recursive:true,force:true}));
  const data=join(work,'damaged'),target=join(work,'should-not-exist');
  const store=new WorldPartitionStore(data),id=store.activeWorldId;
  const path=store.worldFile(id);
  store.close();
  const db=new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys=OFF');
    db.prepare(`INSERT INTO world_locations
      (id,world_id,parent_id,name,kind,description,created_at)
      VALUES (?,?,?,?,?,?,?)`).run('invalid-child',id,'missing-parent','Child','room','',Date.now());
  }finally{db.close();}
  const result=inspectWorldStorage(data);
  assert.equal(result.ok,false);
  assert.ok(result.errors.some(e=>e.detail.includes('foreign key')));
  assert.throws(()=>backupWorldStorage(data,target),/integrity check failed/);
  assert.equal(existsSync(target),false);
});
