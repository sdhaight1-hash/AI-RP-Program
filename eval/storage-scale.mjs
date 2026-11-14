// Deterministic disk-backed storage scaling diagnostic. Creates only temporary
// worlds; no user .data file, live model, or network request is ever touched.
import { performance } from 'node:perf_hooks';
import { mkdtempSync,rmSync,statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorldPartitionStore } from '../world/partition-store.mjs';
import { makeEmptyWorldState,createCharacter,createSession } from '../engine.mjs';
import { retrieveActorMemories } from '../memory/store.mjs';
import { writeStoryProjection,enablePrimaryProjection,projectionPrimary } from '../storage/normalized.mjs';

const measure=fn=>{const started=performance.now();const value=fn();return {value,ms:Math.round((performance.now()-started)*100)/100};};
export function measureStorageScale(turns,{primary=false}={}){
  if(!Number.isInteger(turns)||turns<1||turns>30000)throw new Error('Invalid message count');
  const directory=mkdtempSync(join(tmpdir(),'ai-rp-scale-'));
  let store;
  try{
    store=new WorldPartitionStore(directory);
    const id=store.activeWorldId,scoped=store.forWorld(id),character=createCharacter('Measured NPC');
    const scene=createSession(character);
    scene.messages=Array.from({length:turns},(_,i)=>({
      id:'bench-'+i,role:'user',witnessIds:[character.id],
      content:`Harbor report ${i}: the copper lantern remains on its shelf after the rain.`,
      sentAt:1000+i
    }));
    const state=makeEmptyWorldState();
    state.characters=[character];state.sessions=[scene];state.activeSessionId=scene.id;
    const initial=scoped.load().revision;
    const first=measure(()=>scoped.save(state,initial,{worldId:id}));
    if(!first.value)throw new Error('First synthetic save was rejected');
    if(primary){
      const db=scoped.db,snapshot=scoped.load();
      db.exec('BEGIN IMMEDIATE');
      try{
        writeStoryProjection(db,snapshot.state,snapshot.revision);
        enablePrimaryProjection(db,snapshot);
        db.exec('COMMIT');
      }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
      if(!projectionPrimary(db))throw Error('Benchmark primary activation failed');
    }
    const reading=measure(()=>scoped.load());
    const timelineId=reading.value.state.sessions[0].timelineId;
    const retrieval=measure(()=>retrieveActorMemories(scoped.db,{
      timelineId,actorId:character.id,query:'copper lantern',limit:8
    }));
    if(!retrieval.value.length)throw new Error('Recall index lost the synthetic source');
    const appended=reading.value.state;
    appended.sessions[0].messages.push({
      id:'bench-last',role:'user',witnessIds:[character.id],
      content:'The newest copper lantern report has arrived.',sentAt:turns+1002
    });
    const incremental=measure(()=>scoped.save(appended,reading.value.revision,{worldId:id}));
    if(!incremental.value)throw new Error('Incremental synthetic save was rejected');
    const integrity=scoped.db.prepare('PRAGMA integrity_check').get()?.integrity_check;
    if(integrity!=='ok')throw new Error('Synthetic SQLite integrity failed');
    return {
      turns,storageMode:primary?'normalized-primary':'legacy-snapshot',
      initialSaveMs:first.ms,loadMs:reading.ms,
      lexicalRetrievalMs:retrieval.ms,oneTurnResaveMs:incremental.ms,
      databaseBytes:statSync(store.worldFile(id)).size,
      snapshotBytes:Buffer.byteLength(JSON.stringify(scoped.load().state),'utf8'),
      memoryRows:scoped.db.prepare('SELECT count(*) AS n FROM actor_memories').get().n,
      integrity
    };
  }finally{
    store?.close();
    rmSync(directory,{recursive:true,force:true});
  }
}
export function runStorageScaleEvaluation(counts=[1000,5000,10000],{primary=false}={}){
  const rows=counts.map(turns=>measureStorageScale(turns,{primary}));
  return {kind:'storage-scale-v1',node:process.version,
    rows,note:'Temporary disk-world measurements on this machine, not a portable latency guarantee. Normalized primary still accepts whole-story writes.'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const counts=process.argv.includes('--ci')?[1000,4000]:[1000,5000,10000];
  try{console.log(JSON.stringify(runStorageScaleEvaluation(counts,{primary:process.argv.includes('--primary')}),null,2));}
  catch(error){console.error('Storage scale evaluation failed:',error.message);process.exitCode=1;}
}
