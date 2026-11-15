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
  inspectStoryProjectionInput,projectionEnabled,projectionPrimary,readPrimaryStory,
  enablePrimaryProjection,enableVerifiedAppendJournal,verifyStoryProjection,writeStoryProjection
} from '../storage/normalized.mjs';
import { inspectWorldStorage } from './storage-health.mjs';
import {journalEnabled} from '../storage/append-journal.mjs';
import { sha256 } from './backup-storage.mjs';

function snapshot(db) {
  const row=db.prepare('SELECT revision,document FROM studio_state WHERE id=1').get();
  if(!row)throw new Error('Story snapshot not found');
  if(projectionPrimary(db))return {revision:row.revision,
    state:bindTimelineIds(normalizeState(readPrimaryStory(db,{revision:row.revision,document:row.document}))),
    document:row.document};
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

export function normalizeStorage(dataDir,{apply=false,primary=false,journal=false,backupDir=null}={}){
  const root=resolve(dataDir),health=inspectWorldStorage(root);
  if(!health.ok)throw Error('Storage audit failed: '+JSON.stringify(health.errors));
  if([apply,primary,journal].filter(Boolean).length>1)throw Error('Use one migration operation per invocation');
  if(apply||primary||journal)matchingBackup(root,backupDir,health);
  const worlds=[];
  for(const world of health.worlds){
    const file=join(root,'worlds',world.id,'world.sqlite');
    const db=open(file,!(apply||primary||journal));
    try {
      const before=snapshot(db);
      const counts=inspectStoryProjectionInput(before.state);
      const present=projectionEnabled(db),isPrimary=projectionPrimary(db);
      if(present&&!isPrimary)verifyStoryProjection(db,before);
      if(primary&&!present)throw Error('Stage the normalized shadow projection before primary cutover');
      if(journal&&!isPrimary)throw Error('Enable and verify normalized-primary mode before append journaling');
      if((apply&&!present)||(primary&&!isPrimary)||(journal&&!journalEnabled(db))){
        db.exec('BEGIN IMMEDIATE');
        try{
          // Re-read under the write lock to avoid converting a changed story.
          const locked=snapshot(db);
          if(locked.revision!==before.revision||locked.document!==before.document)
            throw Error('Source changed during normalization');
          if(apply) {
            writeStoryProjection(db,locked.state,locked.revision);
            verifyStoryProjection(db,locked);
          } else if(primary) enablePrimaryProjection(db,locked);
          else enableVerifiedAppendJournal(db,locked);
          db.exec('COMMIT');
        }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
      }
      worlds.push({worldId:world.id,revision:before.revision,...counts,
        result:journal?(journalEnabled(db)?'append-journal-enabled':'journal-error'):
          isPrimary?'already-primary':primary?'normalized-primary':
          present?'already-normalized':apply?'normalized':'ready-to-normalize'});
    }finally{db.close();}
  }
  return {mode:journal?'journal':primary?'primary':apply?'apply':'dry-run',worlds,
    note:journal?'Append journal is opt-in and only player messages use the verified server endpoint. Browser sends still use normal save until separately enabled.':
      primary?'Opted-in normalized-primary worlds use SQLite projection as canonical story; keep the full backup.':
      'Shadow snapshots remain canonical until an explicit --primary conversion.'};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const dir=process.argv[2],flag=process.argv[3];
  if(!dir||flag&&!['--apply','--primary','--journal'].includes(flag)||((flag==='--apply'||flag==='--primary'||flag==='--journal')&&!process.argv[4])){
    console.error('Usage: node scripts/normalize-storage.mjs <.data directory> [--apply|--primary|--journal <existing backup folder>]');
    process.exitCode=1;
  }else{
    try{console.log(JSON.stringify(normalizeStorage(dir,{
      apply:flag==='--apply',primary:flag==='--primary',journal:flag==='--journal',backupDir:process.argv[4]||null
    }),null,2));}
    catch(error){console.error('Normalization refused:',error.message);process.exitCode=1;}
  }
}
