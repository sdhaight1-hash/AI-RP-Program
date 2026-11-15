import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorldPartitionStore} from '../world/partition-store.mjs';
import {createApp} from '../server.mjs';

test('world creation accepts its full 4,000-character Unicode setting and stays world-isolated',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-unicode-world-create-'));
  const store=new WorldPartitionStore(dir);
  const original=store.activeWorldId;
  const app=createApp({store,fetchImpl:async()=>{throw Error('Model not needed')}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  try{
    const base='http://127.0.0.1:'+app.address().port;
    const description='🌌'.repeat(2000); // 4,000 UTF-16 code units, 8 KB of UTF-8.
    assert.equal(description.length,4000);
    const response=await fetch(base+'/api/worlds',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name:'A Unicode World 🌌',description})});
    assert.equal(response.status,201,await response.clone().text());
    const created=await response.json();
    assert.notEqual(created.id,original);
    assert.equal(created.description,description);
    assert.equal(store.activeWorldId,original,'creating a world must not silently activate it');
    const scoped=await(await fetch(base+'/api/state?worldId='+encodeURIComponent(created.id))).json();
    assert.equal(scoped.worldId,created.id);
    assert.deepEqual(scoped.state.characters,[]);
    assert.deepEqual(scoped.state.sessions,[]);
    assert.equal(store.forWorld(original).load().worldId,original);
    const rejected=await fetch(base+'/api/worlds',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name:'Too Long',description:description+'!'})
    });
    assert.equal(rejected.status,400,'model and form must use the same field limits');
    assert.equal(store.worlds.list().worlds.filter(w=>w.name==='Too Long').length,0);
  }finally{
    await new Promise(resolve=>app.close(resolve));
    rmSync(dir,{recursive:true,force:true});
  }
});
