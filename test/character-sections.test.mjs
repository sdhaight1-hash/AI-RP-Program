import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILDER_SECTIONS } from '../character/sections.mjs';
import { CHARACTER_V2_FIELDS } from '../character/schema.mjs';
import { createApp } from '../server.mjs';
import { StudioStore } from '../storage.mjs';

test('character editor metadata covers every durable authoring field once',()=>{
  const rows=Object.values(BUILDER_SECTIONS).flat();
  const fieldIds=rows.map(x=>x[0]);
  assert.equal(new Set(fieldIds).size,fieldIds.length);
  assert.deepEqual(CHARACTER_V2_FIELDS.filter(x=>!fieldIds.includes(x)),[]);
  assert.deepEqual(fieldIds.filter(x=>!CHARACTER_V2_FIELDS.includes(x)),['color']);
  assert.ok(rows.every(x=>x.length>=4&&x.every(y=>typeof y==='string')));
});

test('character editor metadata is served from the allowlist for the actual browser',async()=>{
  const store=new StudioStore(':memory:');
  const server=createApp({store});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/character/sections.mjs');
    assert.equal(response.status,200);
    assert.match(await response.text(),/export const BUILDER_SECTIONS/);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
