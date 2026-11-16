import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorldPartitionStore} from '../world/partition-store.mjs';
import {createApp} from '../server.mjs';
import {createCharacter,makeEmptyWorldState} from '../engine.mjs';
import {extractSourceClaims} from '../world/claim-conflicts.mjs';

test('explicit claims are extracted with exact text, source identity and no inferred truth',()=>{
  const source={type:'character',id:'a',field:'backstory',trust:'profile',fingerprint:'f',
    text:'The Harbor Council was founded in 1803. Mira Vale was born in 1901. The Harbor Council is headquartered in Old Quay.'};
  const claims=extractSourceClaims(source);
  assert.deepEqual(claims.map(x=>[x.subject,x.predicate,x.value]),[
    ['Harbor Council','founded_year','1803'],
    ['Mira Vale','birth_year','1901'],
    ['Harbor Council','headquarters','Old Quay']
  ]);
  assert.ok(claims.every(x=>source.text.includes(x.quote)&&x.sourceKey==='["character","a","backstory"]'));
  assert.deepEqual(extractSourceClaims({...source,text:'Some people falsely claim that the council was never founded.'}),[]);
});

test('current world claims surface potential dated conflicts, including aliases; edits/archive remove old reports',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-canon-claims-'));
  const store=new WorldPartitionStore(dir);
  const worldId=store.activeWorldId;
  const scope=store.forWorld(worldId);
  const entity=scope.worlds.createEntity({worldId,name:'Harbor Council',kind:'organization'});
  const first=createCharacter('Ada');first.backstory='The Harbor Council was founded in 1803.';
  const second=createCharacter('Bea');second.backstory='The Silver Guild was founded in 1864.';
  const original=makeEmptyWorldState();original.characters=[first,second];
  const saved=scope.save(original,scope.load().revision,{worldId});
  const raw=scope.worlds.claimConflicts({worldId,focus:'groups'});
  assert.deepEqual(raw.conflicts,[],'unreviewed alias cannot yet be equated with established canon');
  const candidate=scope.worlds.discoverSources({worldId,focus:'groups'})
    .suggestions.find(x=>x.name==='Silver Guild');
  assert.ok(candidate&&candidate.evidence[0].fingerprint);
  scope.worlds.reviewMention({worldId,action:'link',focus:'groups',
    name:'Silver Guild',targetId:entity.id,sourceProof:candidate.evidence[0]});
  const result=scope.worlds.claimConflicts({worldId,focus:'groups'});
  assert.equal(result.conflicts.length,1);
  const conflict=result.conflicts[0];
  assert.equal(conflict.entryId,entity.id);
  assert.equal(conflict.status,'potential_conflict');
  assert.equal(conflict.predicate,'founded_year');
  assert.deepEqual(conflict.values.map(x=>x.value).sort(),['1803','1864']);
  assert.ok(conflict.values.every(x=>x.evidence.every(e=>e.quote.includes(x.value))));
  assert.equal(scope.worlds.claimConflicts({worldId,focus:'locations'}).conflicts.length,0);
  const http=createApp({store,fetchImpl:async()=>{throw Error('No model needed')}});
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  try{
    const base='http://127.0.0.1:'+http.address().port;
    const response=await fetch(base+'/api/worlds/discovery/conflicts?worldId='+
      encodeURIComponent(worldId)+'&focus=groups');
    assert.equal(response.status,200);
    assert.equal((await response.json()).conflicts[0].entryId,entity.id);
    const invalid=await fetch(base+'/api/worlds/discovery/conflicts?worldId='+
      encodeURIComponent(worldId)+'&focus=untrusted');
    assert.equal(invalid.status,400);
    const secondWorld=store.worlds.createWorld({name:'Second universe'});
    assert.deepEqual(store.forWorld(secondWorld.id).worlds.claimConflicts({
      worldId:secondWorld.id,focus:'groups'
    }).conflicts,[]);
    const amended=scope.load().state;
    amended.characters[1].backstory='The Silver Guild was founded in 1803.';
    scope.save(amended,saved.revision,{worldId});
    assert.deepEqual(scope.worlds.claimConflicts({worldId,focus:'groups'}).conflicts,[],
      'a corrected source cannot leave a ghost contradiction');
    assert.equal(scope.db.prepare('SELECT count(*) AS n FROM universe_source_claims').get().n,2);
    // Upgrade/rebuild: source fingerprints are unchanged but the derived
    // claim cache is missing, so the next scoped reconciliation must fill it.
    scope.db.prepare('DELETE FROM universe_source_claims').run();
    scope.db.prepare('DELETE FROM universe_claim_source_versions').run();
    scope.worlds.claimConflicts({worldId,focus:'groups'});
    assert.equal(scope.db.prepare('SELECT count(*) AS n FROM universe_source_claims').get().n,2);
    const archived=scope.load().state;
    archived.characters[1].trashedAt=Date.now();
    scope.save(archived,saved.revision+1,{worldId});
    assert.equal(scope.db.prepare('SELECT count(*) AS n FROM universe_source_claims').get().n,1);
    assert.equal(scope.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{
    await new Promise(resolve=>http.close(resolve));
    rmSync(dir,{recursive:true,force:true});
  }
});
