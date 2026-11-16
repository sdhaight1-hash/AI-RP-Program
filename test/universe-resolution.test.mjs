import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorldPartitionStore} from '../world/partition-store.mjs';
import {createApp} from '../server.mjs';
import {createCharacter,makeEmptyWorldState} from '../engine.mjs';
import {gatherCharacterWorldContext,worldDraftVersion} from '../character/authoring.mjs';
import {makeSceneAuthoringRequest} from '../authoring/world-scene.mjs';

test('existing canon aliases link only on explicit source-backed review and survive restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-alias-review-'));
  const store=new WorldPartitionStore(dir);
  const worldId=store.activeWorldId;
  const server=createApp({store,fetchImpl:async()=>{throw Error('No model required')}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const post=async(path,body)=>{
    const response=await fetch(base+path,{method:'POST',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    return {response,data:await response.json()};
  };
  const discovery=async(focus='locations')=>{
    const response=await fetch(base+'/api/worlds/discovery?worldId='+
      encodeURIComponent(worldId)+'&focus='+focus);
    assert.equal(response.status,200);
    return response.json();
  };
  try{
    const character=createCharacter('Mira');
    character.familyHistory='She lived in Harbor Annex and visited Birch Square. The Silver Guild taught navigation.';
    const state=makeEmptyWorldState();state.characters=[character];
    const current=store.forWorld(worldId).load();
    const saved=store.forWorld(worldId).save(state,current.revision,{worldId});
    const place=await post('/api/worlds/locations',{worldId,name:'Harbor District',
      kind:'neighborhood',description:'Historic port quarter'});
    assert.equal(place.response.status,201);
    const guild=await post('/api/worlds/entities',{worldId,name:'Dockworkers Association',
      kind:'organization',description:'Port labor guild'});
    assert.equal(guild.response.status,201);
    const places=await discovery();
    const annex=places.suggestions.find(x=>x.name==='Harbor Annex');
    assert.ok(annex);
    const groups=await discovery('groups');
    const silver=groups.suggestions.find(x=>x.name==='Silver Guild');
    assert.ok(silver);
    const link=await post('/api/worlds/discovery/review',{
      worldId,focus:'locations',action:'link',name:'Harbor Annex',
      targetId:place.data.id,sourceProof:annex.evidence[0]
    });
    assert.equal(link.response.status,200,JSON.stringify(link.data));
    assert.equal(link.data.entryId,place.data.id);
    const linkedGroup=await post('/api/worlds/discovery/review',{
      worldId,focus:'groups',action:'link',name:'Silver Guild',
      targetId:guild.data.id,sourceProof:silver.evidence[0]
    });
    assert.equal(linkedGroup.response.status,200,JSON.stringify(linkedGroup.data));
    const after=await discovery();
    assert.ok(!after.suggestions.some(x=>x.name==='Harbor Annex'));
    assert.ok(after.existingLinks.some(x=>x.status==='alias'&&x.name==='Harbor Annex'&&
      x.id===place.data.id&&x.canonicalName==='Harbor District'));
    const groupAfter=await discovery('groups');
    assert.ok(groupAfter.existingLinks.some(x=>x.status==='alias'&&x.name==='Silver Guild'&&
      x.id===guild.data.id));
    const catalog=store.forWorld(worldId).worlds.list();
    assert.equal(catalog.locations.filter(x=>x.name==='Harbor District').length,1);
    assert.equal(catalog.entities.filter(x=>x.name==='Dockworkers Association').length,1);
    assert.equal(catalog.aliases.length,2);
    const authored=store.forWorld(worldId).load().state.characters[0];
    const charContext=gatherCharacterWorldContext({worldLibrary:catalog,worldId,character:authored});
    assert.match(charContext.context,/Harbor Annex → Harbor District/);
    assert.match(charContext.context,/Silver Guild → Dockworkers Association/);
    const sceneContext=makeSceneAuthoringRequest({
      worldId,library:catalog,characters:[authored],characterId:authored.id,
      channelId:'in_person'
    });
    assert.match(sceneContext.messages[1].content,/Harbor Annex/);
    assert.match(sceneContext.messages[1].content,/Silver Guild/);
    assert.notEqual(worldDraftVersion(catalog),worldDraftVersion({...catalog,aliases:[]}),
      'alias review changes invalidate stale character authoring drafts');

    const collision=await post('/api/worlds/locations',{
      worldId,name:'Harbor Annex',kind:'building',description:'Would overlap existing alias'
    });
    assert.notEqual(collision.response.status,201);
    const entityCollision=await post('/api/worlds/entities',{
      worldId,name:'Silver Guild',kind:'organization',description:'Would duplicate an alias'
    });
    assert.notEqual(entityCollision.response.status,201);
    const renamed=await fetch(base+'/api/worlds/entities',{
      method:'PATCH',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        worldId,id:guild.data.id,name:'Silver Guild',kind:'organization',
        description:'Port labor guild',expectedName:'Dockworkers Association',
        expectedKind:'organization',expectedDescription:'Port labor guild'
      })
    });
    assert.equal(renamed.status,200,'own alias can be promoted to primary canon name');
    assert.equal(store.forWorld(worldId).worlds.list().aliases.length,1,
      'promoting alias removes its redundant alias record');

    const again=await post('/api/worlds/discovery/review',{
      worldId,focus:'locations',action:'link',name:'Harbor Annex',
      targetId:place.data.id,sourceProof:annex.evidence[0]
    });
    assert.notEqual(again.response.status,200);
    const other=store.worlds.createWorld({name:'Other independent universe'});
    const cross=await post('/api/worlds/discovery/review',{
      worldId:other.id,focus:'groups',action:'link',
      name:'Silver Guild',targetId:guild.data.id,sourceProof:silver.evidence[0]
    });
    assert.notEqual(cross.response.status,200);
    assert.deepEqual(store.forWorld(other.id).worlds.list().aliases,[]);
    const changed=store.forWorld(worldId).load().state;
    changed.characters[0].familyHistory='She lived in Harbor Annex and never joined the guild.';
    store.forWorld(worldId).save(changed,saved.revision,{worldId});
    const aliasesAfterRevision=store.forWorld(worldId).worlds.list().aliases;
    assert.equal(aliasesAfterRevision.some(x=>x.alias==='Silver Guild'),false,
      'an alias promoted to the primary name must not survive as duplicate metadata');
    assert.ok(aliasesAfterRevision.some(x=>x.alias==='Harbor Annex'));
    const stale=await post('/api/worlds/discovery/review',{
      worldId,focus:'locations',action:'link',name:'Birch Square',
      targetId:place.data.id,
      sourceProof:places.suggestions.find(x=>x.name==='Birch Square').evidence[0]
    });
    assert.notEqual(stale.response.status,200,'edited source evidence may not establish a new alias');
    store.forWorld(worldId).worlds.deleteEntry({worldId,kind:'location',id:place.data.id});
    store.forWorld(worldId).worlds.deleteEntry({worldId,kind:'entity',id:guild.data.id});
    assert.deepEqual(store.forWorld(worldId).worlds.list().aliases,[]);
    assert.equal(store.forWorld(worldId).db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{
    await new Promise(resolve=>server.close(resolve));
    rmSync(dir,{recursive:true,force:true});
  }
});

test('dismissed mentions hide only the reviewed source revision and resurface after new evidence',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-mention-dismiss-'));
  const store=new WorldPartitionStore(dir);
  const worldId=store.activeWorldId;
  const server=createApp({store,fetchImpl:async()=>{throw Error('Unused')}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const base='http://127.0.0.1:'+server.address().port;
    const character=createCharacter('Nia');
    character.backstory='Nia visited Birch Square.';
    const state=makeEmptyWorldState();state.characters=[character];
    const old=store.forWorld(worldId).load();
    const saved=store.forWorld(worldId).save(state,old.revision,{worldId});
    const discovery=async()=>{
      const response=await fetch(base+'/api/worlds/discovery?worldId='+worldId+'&focus=locations');
      assert.equal(response.status,200);
      return response.json();
    };
    const candidate=(await discovery()).suggestions.find(x=>x.name==='Birch Square');
    assert.ok(candidate);
    const dismiss=await fetch(base+'/api/worlds/discovery/review',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({worldId,action:'dismiss',focus:'locations',
        name:candidate.name,evidence:candidate.evidence})
    });
    assert.equal(dismiss.status,200,await dismiss.clone().text());
    assert.ok(!(await discovery()).suggestions.some(x=>x.name==='Birch Square'));
    const modified=store.forWorld(worldId).load().state;
    modified.characters[0].backstory='The old district is gone. Nia still visits Birch Square every Friday.';
    store.forWorld(worldId).save(modified,saved.revision,{worldId});
    const resurfaced=(await discovery()).suggestions.find(x=>x.name==='Birch Square');
    assert.ok(resurfaced,'source changed, so old dismissal cannot suppress new evidence');
    assert.notEqual(resurfaced.evidence[0].fingerprint,candidate.evidence[0].fingerprint);
    const other=store.worlds.createWorld({name:'Foreign universe'});
    assert.equal(store.forWorld(other.id).db.prepare(
      'SELECT count(*) AS n FROM universe_candidate_dismissals').get().n,0);
  }finally{
    await new Promise(resolve=>server.close(resolve));
    rmSync(dir,{recursive:true,force:true});
  }
});

test('review decisions persist across SQLite restart without importing another universe',()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-restart-reviews-'));
  const store=new WorldPartitionStore(dir);
  const worldId=store.activeWorldId;
  const scope=store.forWorld(worldId);
  const person=createCharacter('Marin');
  person.familyHistory='The Silver Guild guided trading vessels. The Rowan Family owned fishing boats.';
  const state=makeEmptyWorldState();state.characters=[person];
  scope.save(state,scope.load().revision,{worldId});
  const target=scope.worlds.createEntity({
    worldId,name:'Dockworkers Association',kind:'organization',description:'Boat labor and navigation'
  });
  const first=scope.worlds.discoverSources({worldId,focus:'groups'});
  const guild=first.suggestions.find(x=>x.name==='Silver Guild');
  const family=first.suggestions.find(x=>x.name==='Rowan Family');
  assert.ok(guild&&family);
  scope.worlds.reviewMention({worldId,action:'link',focus:'groups',name:guild.name,
    targetId:target.id,sourceProof:guild.evidence[0]});
  scope.worlds.reviewMention({worldId,action:'dismiss',focus:'groups',name:family.name,
    evidence:family.evidence});
  store.close();
  const reopened=new WorldPartitionStore(dir);
  try{
    const library=reopened.forWorld(worldId).worlds.list();
    assert.equal(library.aliases.find(x=>x.alias==='Silver Guild')?.entryId,target.id);
    const found=reopened.forWorld(worldId).worlds.discoverSources({worldId,focus:'groups'});
    assert.ok(!found.suggestions.some(x=>x.name==='Rowan Family'));
    assert.ok(found.existingLinks.some(x=>x.status==='alias'&&
      x.name==='Silver Guild'&&x.id===target.id));
    assert.equal(reopened.forWorld(worldId).db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{reopened.close();rmSync(dir,{recursive:true,force:true});}
});
