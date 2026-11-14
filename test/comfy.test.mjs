import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComfyClient, prepareWorkflow, validateLocalUrl } from '../comfy.mjs';

const TEMPLATE={ '1': {class_type:'CLIPTextEncode',inputs:{text:'__RP_PROMPT__'}},'2':{class_type:'CLIPTextEncode',inputs:{text:'__RP_NEGATIVE__'}}};

test('ComfyUI rejects remote backends and malformed workflow graphs',()=>{
  assert.throws(()=>validateLocalUrl('https://example.com/'),/local HTTP/);
  assert.throws(()=>validateLocalUrl('http://192.168.1.4:8188/'),/local HTTP/);
  assert.throws(()=>prepareWorkflow({'1':{class_type:'KSampler',inputs:{seed:3}}},'test'),/placeholder/);
  assert.deepEqual(prepareWorkflow(TEMPLATE,'a portrait','blurry')['1'].inputs.text,'a portrait');
  assert.equal(TEMPLATE['1'].inputs.text,'__RP_PROMPT__'); // input template stays pristine
  assert.equal(prepareWorkflow({'1':{class_type:'CLIPTextEncode',inputs:{text:'__RP_PROMPT__ | __RP_NEGATIVE__'}}},'sunny','blur')['1'].inputs.text,'sunny | blur');
});

test('ComfyUI dispatches only installed local templates, returns own generated images',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'rp-comfy-'));
  const job='f17469a6-825a-4b63-bd90-315ab684e5bb';
  const calls=[];
  await writeFile(join(dir,'portrait.json'),JSON.stringify(TEMPLATE));
  const comfy=new ComfyClient({url:'http://127.0.0.1:8188/',templateDir:dir,fetchImpl:async (url,options={})=>{
    calls.push({url,options});
    if(url.endsWith('/prompt')) {const body=JSON.parse(options.body);assert.equal(body.prompt['1'].inputs.text,'stormy bookshop');return Response.json({prompt_id:job});}
    if(url.endsWith('/history/'+job))return Response.json({[job]:{outputs:{'5':{images:[{type:'output',filename:'portrait.png',subfolder:''},{type:'input',filename:'private.png',subfolder:''}]}}}});
    if(url.includes('/view?'))return new Response(new Uint8Array([137,80,78,71]),{headers:{'Content-Type':'image/png'}});
    if(url.endsWith('/system_stats'))return Response.json({devices:[{name:'GPU'}]});
    return new Response('not found',{status:404});
  }});
  try {
    assert.deepEqual(await comfy.templates(),[{id:'portrait'}]);
    assert.deepEqual(await comfy.status(),{connected:true,devices:[{name:'GPU',type:''}]});
    assert.deepEqual(await comfy.submit({templateId:'portrait',prompt:'stormy bookshop'}),{jobId:job});
    const history=await comfy.history(job);assert.equal(history.images.length,1);assert.equal(history.images[0].filename,'portrait.png');
    assert.equal((await comfy.image(job,'portrait.png')).type,'image/png');
    await assert.rejects(()=>comfy.image(job,'private.png'),/not part of/);
    await assert.rejects(()=>comfy.history('00000000-0000-4000-8000-000000000000'),/Unknown/);
    await assert.rejects(()=>comfy.submit({templateId:'../secret',prompt:'x'}),/Invalid workflow/);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('ComfyUI job previews and images are confined to their submitting world',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'rp-comfy-world-'));
  const job='8c3e81c1-595b-4c5d-91bf-2eb5bed57671';
  await writeFile(join(dir,'portrait.json'),JSON.stringify(TEMPLATE));
  const comfy=new ComfyClient({url:'http://127.0.0.1:8188/',templateDir:dir,fetchImpl:async url=>{
    if(url.endsWith('/prompt'))return Response.json({prompt_id:job});
    if(url.endsWith('/history/'+job))return Response.json({[job]:{outputs:{'5':{images:[{type:'output',filename:'scene.png',subfolder:''}]}}}});
    if(url.includes('/view?'))return new Response(new Uint8Array([137,80,78,71]),{headers:{'Content-Type':'image/png'}});
    return new Response('not found',{status:404});
  }});
  try {
    await comfy.submit({templateId:'portrait',prompt:'Greyhaven',worldId:'world-a'});
    await assert.rejects(()=>comfy.history(job,'world-b'),/different world/);
    await assert.rejects(()=>comfy.image(job,'scene.png','','world-b'),/different world/);
    assert.equal((await comfy.history(job,'world-a')).images.length,1);
    assert.equal((await comfy.image(job,'scene.png','','world-a')).type,'image/png');
  } finally {await rm(dir,{recursive:true,force:true});}
});
