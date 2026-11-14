// Offline, non-overwriting world snapshots. Stop AI RP Studio first:
// each SQLite file is internally consistent (VACUUM INTO includes WAL pages),
// but separate registry/world databases cannot be snapshotted atomically while
// another process is changing the world catalog.
import { DatabaseSync } from 'node:sqlite';
import { createHash,randomUUID } from 'node:crypto';
import { cpSync,existsSync,mkdirSync,openSync,readSync,closeSync,renameSync,rmSync,writeFileSync,lstatSync } from 'node:fs';
import { dirname,join,resolve,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectWorldStorage } from './storage-health.mjs';

const escapeSql=s=>"'"+s.replaceAll("'","''")+"'";
function snapshotDb(source,destination){
  mkdirSync(dirname(destination),{recursive:true});
  const db=new DatabaseSync(source,{readOnly:true});
  try{db.exec('VACUUM INTO '+escapeSql(destination));}
  finally{db.close();}
}
function copyAssets(source,target){
  for(const category of ['portraits','locations','maps','generated-images']){
    const from=join(source,category);
    if(!existsSync(from))continue;
    cpSync(from,join(target,category),{
      recursive:true,force:false,errorOnExist:true,dereference:false,
      filter(path){
        if(lstatSync(path).isSymbolicLink())
          throw new Error('Refusing to back up linked asset path: '+path);
        return true;
      }
    });
  }
}
function sha256(file){
  const hash=createHash('sha256'),fd=openSync(file,'r'),chunk=Buffer.allocUnsafe(1024*1024);
  try {
    let size;
    while((size=readSync(fd,chunk,0,chunk.length,null))>0)
      hash.update(chunk.subarray(0,size));
  } finally {closeSync(fd);}
  return hash.digest('hex');
}
export function backupWorldStorage(dataDir,outputDir) {
  const src=resolve(dataDir),dest=resolve(outputDir);
  if(dest===src||dest===join(src,'worlds')||dest.startsWith(join(src,'worlds')+sep))
    throw new Error('Backup destination must not replace a world partition');
  if(existsSync(dest))throw new Error('Backup destination already exists; never overwrite existing backups');
  const sourceAudit=inspectWorldStorage(src);
  if(!sourceAudit.ok)throw new Error('Storage integrity check failed; inspect before backup: '+JSON.stringify(sourceAudit.errors));
  mkdirSync(dirname(dest),{recursive:true});
  const stage=dest+'.staging-'+randomUUID();
  mkdirSync(stage,{recursive:false});
  try {
    const backedUp=[];
    const registrySource=join(src,'registry.sqlite'),registryDest=join(stage,'registry.sqlite');
    snapshotDb(registrySource,registryDest);
    backedUp.push({path:'registry.sqlite',sha256:sha256(registryDest)});
    for(const world of sourceAudit.worlds){
      const relativePath=join('worlds',world.id,'world.sqlite');
      const source=join(src,relativePath),target=join(stage,relativePath);
      snapshotDb(source,target);
      copyAssets(dirname(source),dirname(target));
      backedUp.push({path:relativePath.replaceAll('\\','/'),sha256:sha256(target)});
    }
    const restored=inspectWorldStorage(stage);
    if(!restored.ok)throw new Error('Staged backup failed integrity check: '+JSON.stringify(restored.errors));
    const manifest={format:'ai-rp-offline-backup-v1',createdAt:new Date().toISOString(),
      worlds:sourceAudit.worlds.map(w=>({id:w.id,revision:w.revision})),databases:backedUp,
      note:'Back up with AI RP Studio stopped. Restore by copying this entire folder to an empty .data directory.'};
    writeFileSync(join(stage,'backup-manifest.json'),JSON.stringify(manifest,null,2));
    renameSync(stage,dest);
    return {destination:dest,worldCount:sourceAudit.worlds.length,
      manifest:join(dest,'backup-manifest.json')};
  } catch(error) {
    rmSync(stage,{recursive:true,force:true});
    throw error;
  }
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(!process.argv[3]){
    console.error('Usage: node scripts/backup-storage.mjs <existing .data directory> <new backup folder> (stop the app first)');
    process.exitCode=1;
  }else {
    try {console.log(JSON.stringify(backupWorldStorage(process.argv[2],process.argv[3]),null,2));}
    catch(error){console.error(error.message);process.exitCode=1;}
  }
}
