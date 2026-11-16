import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {discoverUniverseMentions} from '../world/discovery.mjs';
import {WorldPartitionStore} from '../world/partition-store.mjs';
import {createApp} from '../server.mjs';

const worldId='salt-world';
const library={
  activeWorldId:worldId,
  worlds:[{id:worldId,name:'Salt City',description:'The harbor district is called Eastbank.'}],
  locations:[{id:'south',worldId,name:'South Quay',kind:'outdoor'}],
  entities:[{id:'council',worldId,name:'Harbor Council',kind:'organization'},
    {id:'foreign',worldId:'other-world',name:'Copper Guild',kind:'organization'}],
  blueprint:{worldId,revision:2,sections:{society:'The Arden Culture retains old rituals.'}}
};
const state={
  characters:[
    {id:'mara',worldId,name:'Mara',backstory:'She grew up in South Quay. Her aunt worked at Lantern House. The Rowan Family managed the ferries, and the Tidekeepers Guild controlled the crossings.'},
    {id:'foreign',worldId:'other-world',name:'Other',backstory:'She lives in Foreign Palace and joined the Copper Guild.'}
  ],
  sessions:[{id:'scene',worldId,messages:[
    {id:'msg-1',role:'assistant',content:'I heard about the Silver Observatory near Eastbank.'}
  ]}],
  lore:[{id:'lore',worldId,content:'The Harbor Council rules the old docks.'}]
};

test('unregistered places are suggested with exact, inspectable evidence; existing places are not duplicated',()=>{
  const found=discoverUniverseMentions({worldId,library,state,focus:'locations'});
  const names=found.suggestions.map(item=>item.name);
  assert.ok(names.includes('Lantern House'),names.join(','));
  assert.ok(names.includes('Silver Observatory'),names.join(','));
  assert.ok(names.includes('Eastbank'),names.join(','));
  assert.ok(!names.includes('South Quay'));
  assert.ok(!names.includes('Foreign Palace'));
  assert.ok(found.existingLinks.some(x=>x.name==='South Quay'));
  assert.ok(found.suggestions.every(item=>item.status==='unverified'));
  assert.ok(found.suggestions.find(x=>x.name==='Silver Observatory').evidence
    .some(e=>e.type==='dialogue'&&e.trust==='unverified'&&
      e.quote.includes('Silver Observatory')));
  assert.ok(found.suggestions.find(x=>x.name==='Lantern House').evidence
    .some(e=>e.type==='character'&&e.quote.includes('Lantern House')));
});

test('groups, families and cultures share a single index without cross-world leakage',()=>{
  const found=discoverUniverseMentions({worldId,library,state,focus:'groups'});
  assert.deepEqual(
    Object.fromEntries(found.suggestions.map(x=>[x.name,x.kind])),
    {'Arden Culture':'culture','Rowan Family':'family','Tidekeepers Guild':'organization'}
  );
  assert.ok(found.existingLinks.some(x=>x.name==='Harbor Council'));
  assert.ok(!found.suggestions.some(x=>x.name.includes('Copper')));
  assert.throws(()=>discoverUniverseMentions({worldId:'other-world',library,state}),/correct/);
  assert.throws(()=>discoverUniverseMentions({worldId,library,state,focus:'random'}),/Unsupported/);
});

test('canon group entries are independently editable with scoped optimistic conflict checks and atomic descriptions',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-canon-groups-'));
  const store=new WorldPartitionStore(dir);
  const world=store.activeWorldId;
  const app=createApp({store,fetchImpl:async()=>{throw Error('Not needed')}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  try {
    const base='http://127.0.0.1:'+app.address().port;
    const post=async(endpoint,input,method='POST')=>fetch(base+endpoint,{method,
      headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    const created=await post('/api/worlds/entities',{
      worldId:world,name:'Rowan Family',kind:'family',description:'Runs the ferry trade.'
    });
    assert.equal(created.status,201,await created.clone().text());
    const person=await created.json();
    assert.equal(person.kind,'family');
    const catalog=store.worlds.list();
    assert.equal(catalog.entities.find(e=>e.id===person.id).description,'Runs the ferry trade.');
    const updated=await post('/api/worlds/entities',{
      worldId:world,id:person.id,name:'Rowan Household',kind:'community',
      description:'A multigenerational cooperative.',
      expectedName:'Rowan Family',expectedKind:'family',
      expectedDescription:'Runs the ferry trade.'
    },'PATCH');
    assert.equal(updated.status,200,await updated.clone().text());
    assert.equal((await updated.json()).kind,'community');
    const stale=await post('/api/worlds/entities',{
      worldId:world,id:person.id,name:'Stale Rewrite',kind:'group',
      description:'Wrong',expectedName:'Rowan Family',expectedKind:'family',
      expectedDescription:'Runs the ferry trade.'
    },'PATCH');
    assert.equal(stale.status,409);
    const duplicate=await post('/api/worlds/entities',{
      worldId:world,name:'Rowan Household',kind:'family',description:'Duplicate'
    });
    assert.equal(duplicate.status,400);
    assert.equal(store.worlds.list().entities.filter(e=>e.name==='Rowan Household').length,1);
    for(const kind of ['culture','organization','faction','group']){
      const added=await post('/api/worlds/entities',{
        worldId:world,name:kind+' example',kind,description:'Validated rich canon'
      });
      assert.equal(added.status,201,await added.clone().text());
    }
    const second=store.worlds.createWorld({name:'Other universe'});
    assert.equal(store.forWorld(second.id).worlds.list().entities.length,0);
    const invalid=await post('/api/worlds/entities',{
      worldId:world,name:'Overlong',kind:'culture',description:'x'.repeat(1_000_001)
    });
    assert.equal(invalid.status,400);
    assert.equal(store.forWorld(world).db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{
    await new Promise(resolve=>app.close(resolve));
    rmSync(dir,{recursive:true,force:true});
  }
});
