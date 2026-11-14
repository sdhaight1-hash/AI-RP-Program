// Read-only integrity check for an existing AI-RP world catalog. Never opens
// the writer store or normalizes/saves user fiction during inspection.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectionEnabled,projectionPrimary,readPrimaryStory,verifyStoryProjection } from '../storage/normalized.mjs';
import { normalizeState } from '../engine.mjs';
import { bindTimelineIds } from '../world/canon.mjs';

const validWorldId=id=>typeof id==='string'&&
  /^(?:[0-9a-f]{8}-[0-9a-f-]{27,40}|imported-local-world)$/i.test(id)&&!id.includes('..');

export function inspectWorldStorage(dataDir) {
  const report={dataDir:resolve(dataDir),ok:true,worlds:[],errors:[],warnings:[]};
  const issue=(scope,detail)=>{report.ok=false;report.errors.push({scope,detail});};
  const registryPath=join(dataDir,'registry.sqlite');
  if(!existsSync(registryPath)){
    issue('registry','Missing registry.sqlite');return report;
  }
  let registry;
  try {
    registry=new DatabaseSync(registryPath,{readOnly:true});
    if(registry.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')
      issue('registry','SQLite integrity check failed');
    if(registry.prepare('PRAGMA foreign_key_check').all().length)
      issue('registry','Foreign key violations');
    const worldRows=registry.prepare('SELECT id,name FROM world_catalog ORDER BY id').all();
    const active=registry.prepare("SELECT value FROM registry_settings WHERE key='active_world'").get()?.value;
    if(!worldRows.length)issue('registry','No catalog worlds');
    if(active&&!worldRows.some(x=>x.id===active))issue('registry','Selected world is absent from catalog');
    for(const row of worldRows) {
      const entry={id:row.id,name:row.name,ok:true,revision:null};
      report.worlds.push(entry);
      const fail=detail=>{entry.ok=false;issue(row.id,detail);};
      if(!validWorldId(row.id)){fail('Invalid world ID in registry');continue;}
      const path=join(dataDir,'worlds',row.id,'world.sqlite');
      if(!existsSync(path)){fail('Missing world.sqlite');continue;}
      let db;
      try{
        db=new DatabaseSync(path,{readOnly:true});
        if(db.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')
          fail('SQLite integrity check failed');
        const foreign=db.prepare('PRAGMA foreign_key_check').all();
        if(foreign.length)fail(foreign.length+' foreign key violations');
        if(!db.prepare('SELECT 1 FROM worlds WHERE id=?').get(row.id))
          fail('World identity does not match catalog');
        if(db.prepare('SELECT 1 FROM worlds WHERE id!=? LIMIT 1').get(row.id))
          fail('Foreign world metadata appears in this partition');
        const state=db.prepare('SELECT revision,document FROM studio_state WHERE id=1').get();
        if(!state){fail('Missing story snapshot');continue;}
        entry.revision=state.revision;
        let parsed;
        try {
          parsed=projectionPrimary(db)
            ?readPrimaryStory(db,{revision:state.revision,document:state.document})
            :JSON.parse(state.document);
        }catch(error){fail('Could not reconstruct story: '+error.message);continue;}
        if(!Array.isArray(parsed.characters)||!Array.isArray(parsed.sessions)){
          fail('Story snapshot lacks character or scene arrays');continue;
        }
        if(parsed.characters.some(c=>c.worldId&&c.worldId!==row.id))
          fail('Foreign-world character in story snapshot');
        const knownCharacterIds=new Set(parsed.characters.map(c=>c.id));
        const orphaned=db.prepare(`SELECT id,source_character_id AS characterId
          FROM world_entities WHERE world_id=? AND source_character_id IS NOT NULL`)
          .all(row.id).filter(e=>!knownCharacterIds.has(e.characterId));
        entry.orphanedCharacterEntities=orphaned.length;
        if(orphaned.length)report.warnings.push({scope:row.id,
          detail:orphaned.length+' obsolete character projections; opening this world repairs them'});
        const duplicates=db.prepare(`SELECT source_character_id AS characterId,count(*) AS copies
          FROM world_entities WHERE world_id=? AND source_character_id IS NOT NULL
          GROUP BY source_character_id HAVING count(*)>1`).all(row.id);
        entry.duplicateCharacterMirrors=duplicates.length;
        if(duplicates.length)report.warnings.push({scope:row.id,
          detail:duplicates.length+' characters have duplicate world identities. Review and delete redundant entities in Relations; linked relationships may be affected.'});
        const timelineIds=new Set(db.prepare('SELECT id FROM timelines WHERE world_id=?').all(row.id).map(x=>x.id));
        if(parsed.sessions.some(s=>s.timelineId&&!timelineIds.has(s.timelineId)))
          fail('Scene references an unknown or foreign timeline');
        entry.projection='absent';
        if(projectionEnabled(db)) {
          try {
            entry.projection=verifyStoryProjection(db,{
              revision:state.revision,state:bindTimelineIds(normalizeState(parsed))
            }).status;
          }catch(error){entry.projection='invalid';fail('Normalized projection: '+error.message);}
        }
      }catch(error){fail('Could not inspect world database: '+error.message);}
      finally{db?.close();}
    }
  }catch(error){issue('registry','Could not inspect catalog: '+error.message);}
  finally{registry?.close();}
  return report;
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const report=inspectWorldStorage(resolve(process.argv[2]||'.data'));
  console.log(JSON.stringify(report,null,2));
  if(!report.ok)process.exitCode=1;
}
