import test from 'node:test';
import assert from 'node:assert/strict';
import { worldPath,loadWorldSnapshot,loadWorldCatalog } from '../public/world-client.mjs';
import { StudioStore } from '../storage.mjs';
import { createApp } from '../server.mjs';

test('world transport appends scope safely and rejects a mismatched-world response',async()=>{
  assert.equal(worldPath('/api/state','world 1'),'/api/state?worldId=world%201');
  assert.equal(worldPath('/api/state?page=2','world 1'),'/api/state?page=2&worldId=world%201');
  assert.equal(worldPath('/api/state',null),'/api/state');
  const fake=async()=>Response.json({worldId:'wrong',revision:7,state:{characters:[],sessions:[]}});
  await assert.rejects(loadWorldSnapshot(fake,'expected'),/different world/);
  await assert.rejects(loadWorldCatalog(async()=>Response.json({activeWorldId:'wrong',worlds:[]}),
    'expected'),/different world catalog/);
  await assert.rejects(loadWorldSnapshot(async()=>Response.json({error:'Missing world'},{status:404}),
    'expected'),error=>error.status===404&&/Missing world/.test(error.message));
});

test('world transport module is delivered as a real browser ES module',async()=>{
  const store=new StudioStore(':memory:');
  const app=createApp({store});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch('http://127.0.0.1:'+app.address().port+'/world-client.mjs');
    assert.equal(response.status,200);
    assert.match(response.headers.get('content-type'),/javascript/);
    assert.match(await response.text(),/export async function loadWorldSnapshot/);
  }finally{await new Promise(resolve=>app.close(resolve));}
});
