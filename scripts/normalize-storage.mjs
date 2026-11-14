// Opt-in normalized shadow migration. No schema cutover or snapshot deletion.
// Dry-run is read-only. Apply requires a verified, matching offline backup.
// Stop AI RP Studio before using --apply: registry and per-world databases
// cannot be migrated as one atomic cross-database transaction.
import { DatabaseSync } from 'node:sqlite';
import { existsSync,readFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeState } from '../engine.mjs';
import { bindTimelineIds } from '../world/canon.mjs';
import {
  inspectStoryProjectionInput,projectionEnabled,verifyStoryProjection,writeStoryProjection
} from '../storage/normalized.mjs';
import { inspectWorldStorage } from './storage-health.mjs';
import { sha256 } from './backup-storage.mjs';

function snapshot(db) {
  const row=db.prepare('SELECT revision,document FROM studio_state WHERE id=1').get();
  if(!row)throw new Error('Story snapshot not found');
  const normalize=()=>bindTimelineIds(normalizeState(JSON.parse(row.document)));
  const state=normalize();
  // Some very old exports omit message IDs or emotion-event IDs. Their
  // normalization generates random IDs each load; never project one arbitrary
  // interpretation and then block every future save on a fingerprint mismatch.
  if(JSON.stringify(state)!==JSON.stringify(normalize()))
    throw Error('Legacy snapshot produces unstable IDs when loaded; save it once through the current application before staging the projection');
  return {revision:row.revision,state,document:row.document};
}
function open(file,readonly=true){return new DatabaseSync(file,{readOnly:readonly});}
function matchingBackup(dataDir,backupDir,health){
  if(typeof backupDir!=='string'||!backupDir.trim())throw Error('An existing offline backup is required for --apply');
  const backup=resolve(backupDir);
  if(backup===resolve(dataDir))throw Error('Backup cannot be the source directory');
  const report=inspectWorldStorage(backup);
  if(!report.ok)throw Error('Backup failed integrity check: '+JSON.stringify(report.errors));
  const manifestPath=join(backup,'backup-manifest.json');
  if(!existsSync(manifestPath))throw Error('Backup manifest is missing');
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  if(manifest.format!=='ai-rp-offline-backup-v1'||!Array.isArray(manifest.databases)||!Array.isArray(manifest.worlds))
    throw Error('Unsupported backup manifest');
  const expected=new Map(health.worlds.map(x=>[x.id,x.revision]));
  if(manifest.worlds.length!==expected.size||report.worlds.length!==expected.size)
    throw Error('Backup world count differs from current registry');
  for(const item of manifest.worlds)
    if(!expected.has(item.id)||expected.get(item.id)!==item.revision)
      throw Error('Backup does not match the current world revisions');
  for(const row of manifest.databases){
    if(typeof row.path!=='string'||!/^registry\.sqlite$|^worlds\/[\w-]+\/world\.sqlite$/.test(row.path))
      throw Error('Unsafe file path in backup manifest');
    const path=join(backup,row.path);
    if(!existsSync(path)||sha256(path)!==row.sha256)
      throw Error('Backup database checksum mismatch: '+row.path);
  }
  const expectedFiles=new Set(['registry.sqlite',...health.worlds.map(w=>'worlds/'+w.id+'/world.sqlite')]);
  if(manifest.databases.length!==expectedFiles.size||
    manifest.databases.some(x=>!expectedFiles.delete(x.path))||expectedFiles.size)
    throw Error('Backup manifest is incomplete or has duplicate database paths');
  for(const world of health.worlds){
    const original=open(join(dataDir,'worlds',world.id,'world.sqlite'));
    const copied=open(join(backup,'worlds',world.id,'world.sqlite'));
    try {
      const one=snapshot(original),two=snapshot(copied);
      if(one.revision!==two.revision||one.document!==two.document)
        throw Error('Backup story differs from current world: '+world.id);
    }finally{original.close();copied.close();}
  }
}

export function normalizeStorage(dataDir,{apply=false,backupDir=null}={}){
  const root=resolve(dataDir),health=inspectWorldStorage(root);
  if(!health.ok)throw Error('Storage audit failed: '+JSON.stringify(health.errors));
  if(apply)matchingBackup(root,backupDir,health);
  const worlds=[];
  for(const world of health.worlds){
    const file=join(root,'worlds',world.id,'world.sqlite');
    const db=open(file,!apply);
    try {
      const before=snapshot(db);
      const counts=inspectStoryProjectionInput(before.state);
      const present=projectionEnabled(db);
      if(present)verifyStoryProjection(db,before);
      if(apply&&!present){
        db.exec('BEGIN IMMEDIATE');
        try{
          // Re-read inside the write lock in case the source was edited since
          // the preliminary inspection. An offline backup must match exactly.
          const locked=snapshot(db);
          if(locked.revision!==before.revision||locked.document!==before.document)
            throw Error('Source changed during normalization');
          writeStoryProjection(db,locked.state,locked.revision);
          verifyStoryProjection(db,locked);
          db.exec('COMMIT');
        }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
      }
      worlds.push({worldId:world.id,revision:before.revision,...counts,
        result:present?'already-normalized':apply?'normalized':'ready-to-normalize'});
    }finally{db.close();}
  }
  return {mode:apply?'apply':'dry-run',worlds,
    note:'Canonical snapshots remain authoritative; normalized tables are optional, verified projections.'};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const dir=process.argv[2],flag=process.argv[3];
  if(!dir||flag&&flag!=='--apply'||(flag==='--apply'&&!process.argv[4])){
    console.error('Usage: node scripts/normalize-storage.mjs <.data directory> [--apply <existing backup folder>]');
    process.exitCode=1;
  }else{
    try{console.log(JSON.stringify(normalizeStorage(dir,{
      apply:flag==='--apply',backupDir:process.argv[4]||null
    }),null,2));}
    catch(error){console.error('Normalization refused:',error.message);process.exitCode=1;}
  }
}
