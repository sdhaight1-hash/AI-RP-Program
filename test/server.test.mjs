import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';

async function withServer(fetchImpl, fn) {
  const server = createApp({ lmUrl:'http://127.0.0.1:5001/v1', fetchImpl });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('server serves the app on localhost', async () => {
  await withServer(async()=>{throw new Error('not used')},async base=>{
    const result=await fetch(base+'/');
    assert.equal(result.status,200);
    assert.match(await result.text(), /AI RP Studio/);
  });
});

test('model listing returns model IDs and backend identification', async () => {
  await withServer(async url=>{
    assert.equal(url,'http://127.0.0.1:5001/v1/models');
    return Response.json({data:[{id:'Anubis-8B'}, {id:42}]});
  },async base=>{
    const result=await(await fetch(base+'/api/models')).json();
    assert.deepEqual(result.models,[{id:'Anubis-8B'}]);
    assert.equal(result.backend,'127.0.0.1:5001');
  });
});

test('chat endpoint forwards approved parameters and streams model tokens', async () => {
  await withServer(async (url, options)=>{
    assert.equal(url,'http://127.0.0.1:5001/v1/chat/completions');
    const body=JSON.parse(options.body);
    assert.equal(body.stream,true);
    assert.equal(body.model,'test-model');
    return new Response('data: {"choices":[{"delta":{"content":"Evening."}}]}\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  },async base=>{
    const response=await fetch(base+'/api/chat',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'test-model',messages:[{role:'user',content:'Hello'}],temperature:0.9,max_tokens:250}),
    });
    assert.equal(response.status,200);
    assert.match(await response.text(), /Evening\./);
  });
});

test('invalid requests and cross-origin writes are blocked before inference', async () => {
  await withServer(async()=>{throw new Error('should not call model')},async base=>{
    const invalid=await fetch(base+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"model":"","messages":[]}'});
    assert.equal(invalid.status,400);
    const crossOrigin=await fetch(base+'/api/chat',{method:'POST',headers:{origin:'https://malicious.example','Content-Type':'application/json'},body:'{}'});
    assert.equal(crossOrigin.status,403);
  });
});

test('server reads/writes SQLite story state, handles stale revisions and rejects bad data', async () => {
  const { StudioStore } = await import('../storage.mjs');
  const { makeInitialState } = await import('../engine.mjs');
  const store = new StudioStore(':memory:');
  const server = createApp({ store, fetchImpl: async () => { throw new Error('model server should not be used') } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const empty = await (await fetch(`${base}/api/state`)).json();
    assert.equal(empty.revision, 0);
    assert.equal(empty.state, null);
    const value = makeInitialState();
    value.sessions[0].summary = 'A note remembered across page reloads.';
    const save = () => fetch(`${base}/api/state`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({revision:0,state:value}) });
    const stored = await save();
    assert.equal(stored.status, 200);
    assert.equal((await stored.json()).revision, 1);
    const conflict = await save();
    assert.equal(conflict.status, 409);
    const loaded = await (await fetch(`${base}/api/state`)).json();
    assert.equal(loaded.state.sessions[0].summary, value.sessions[0].summary);
    const invalid = await fetch(`${base}/api/state`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:'{"revision":1,"state":{"characters":[],"sessions":[]}}' });
    assert.equal(invalid.status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('terminal quit and exit commands shut down the server cleanly', async (t) => {
  const { spawn } = await import('node:child_process');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  for (const command of ['quit', ' ExIt ']) {
    await t.test(command.trim(), { timeout: 8000 }, async () => {
      const child = spawn(process.execPath, ['server.mjs'], {
        cwd: root, env: { ...process.env, PORT: '0' }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      let errors = '';
      try {
        const result = await new Promise((resolve, reject) => {
          child.stdout.setEncoding('utf8');
          child.stderr.setEncoding('utf8');
          child.stderr.on('data', chunk => { errors += chunk; });
          child.stdout.on('data', chunk => {
            output += chunk;
            if (output.includes('Type quit or exit') && !child.stdin.destroyed) {
              child.stdin.end(`${command}\n`);
            }
          });
          child.on('error', reject);
          child.on('close', (code, signal) => resolve({ code, signal }));
        });
        assert.equal(result.code, 0, `Failed to close: ${errors}`);
        assert.equal(result.signal, null);
        assert.match(output, /Stopping AI RP Studio\.\.\./);
        assert.match(output, /AI RP Studio stopped\./);
      } finally {
        if (child.exitCode === null) child.kill();
      }
    });
  }
});

test('portrait upload stores local validated bytes and serves only whitelisted image paths', async () => {
  const { StudioStore } = await import('../storage.mjs');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(),'ai-rp-portrait-'));
  const server = createApp({ store: new StudioStore(':memory:'), portraitDir:join(root,'portraits'), fetchImpl: async()=>{throw new Error('not used');} });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const invalidType = await fetch(`${base}/api/portraits`, {method:'POST',headers:{'Content-Type':'image/png'},body:new Uint8Array([1,2,3])});
    assert.equal(invalidType.status,415);
    const invalidMagic = await fetch(`${base}/api/portraits`, {method:'POST',headers:{'Content-Type':'image/jpeg'},body:new Uint8Array([1,2,3,4])});
    assert.equal(invalidMagic.status,400);
    const jpeg = Uint8Array.from([0xff,0xd8,0xff,0xe0,12,8,8,8,0xff,0xd9]);
    const uploaded = await fetch(`${base}/api/portraits`, {method:'POST',headers:{'Content-Type':'image/jpeg'},body:jpeg});
    assert.equal(uploaded.status,201);
    const body = await uploaded.json();
    assert.match(body.path,/^\/portraits\/[0-9a-f-]{36}\.jpg$/);
    const loaded = await fetch(base+body.path);
    assert.equal(loaded.status,200);
    assert.equal(loaded.headers.get('content-type'),'image/jpeg');
    assert.deepEqual(new Uint8Array(await loaded.arrayBuffer()),jpeg);
    const missing = await fetch(`${base}/portraits/11111111-2222-3333-4444-555555555555.jpg`);
    assert.equal(missing.status,404);
    const large = await fetch(`${base}/api/portraits`,{method:'POST',headers:{'Content-Type':'image/jpeg'},body:Buffer.alloc(1_500_100,0xff)});
    assert.equal(large.status,400);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root,{recursive:true,force:true});
  }
});

test('harness exposes scoped FTS and optional Comfy workflow jobs without remote URLs', async () => {
  const { StudioStore } = await import('../storage.mjs');
  const { makeInitialState, createCharacter } = await import('../engine.mjs');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir=await mkdtemp(join(tmpdir(),'rp-api-'));
  const job='cd1363ba-0c80-4ea4-b490-3b71ef24dd2b';
  const store=new StudioStore(':memory:');
  const state=makeInitialState(), mara=state.characters[0], guest=createCharacter('Guest');
  state.characters.push(guest);state.sessions[0].castIds=[mara.id,guest.id];
  state.lore=[{id:'shared',title:'Harbor',content:'A foghorn sounds near the harbor.',keywords:['foghorn'],visibility:'public'},
    {id:'secret',title:'Harbor',content:'The hidden smuggler tunnel is below the harbor.',keywords:['foghorn'],visibility:'private',knownBy:[mara.id]}];
  store.save(state,0);
  const comfyFetch=async (url,opts={})=>{
    if(url.endsWith('/system_stats'))return Response.json({devices:[{name:'RTX'}]});
    if(url.endsWith('/prompt'))return Response.json({prompt_id:job});
    if(url.endsWith('/history/'+job))return Response.json({[job]:{outputs:{'4':{images:[{type:'output',filename:'Scene_0001.png',subfolder:''}]}}}});
    if(url.includes('/view?'))return new Response(new Uint8Array([137,80,78,71]),{headers:{'Content-Type':'image/png'}});
    throw new Error('unexpected ComfyUI route '+url);
  };
  const server=createApp({store,comfyFetchImpl:comfyFetch,comfyTemplateDir:dir,fetchImpl:async()=>{throw new Error('Should not infer here')}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const query=async (actorId)=>{
      const response=await fetch(base+'/api/search/lore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'harbor',actorId,sessionId:state.sessions[0].id})});
      return response.json();
    };
    assert.deepEqual((await query(guest.id)).entries.map(e=>e.id),['shared']);
    assert.deepEqual(new Set((await query(mara.id)).entries.map(e=>e.id)),new Set(['shared','secret']));
    const bad=await fetch(base+'/api/search/lore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'harbor',actorId:'not-in-scene',sessionId:state.sessions[0].id})});
    assert.equal(bad.status,400);
    const template={ '1':{class_type:'CLIPTextEncode',inputs:{text:'__RP_PROMPT__'}}};
    const imported=await fetch(base+'/api/comfy/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'portrait',workflow:template})});
    assert.equal(imported.status,201);
    const templates=(await (await fetch(base+'/api/comfy/templates')).json()).templates;
    assert.deepEqual(templates,[{id:'portrait'}]);
    const jobResponse=await fetch(base+'/api/comfy/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({templateId:'portrait',prompt:'rainy bookshop'})});
    assert.equal(jobResponse.status,202);
    assert.equal((await jobResponse.json()).jobId,job);
    const hist=(await (await fetch(base+'/api/comfy/history?job='+job)).json());
    assert.equal(hist.images[0].filename,'Scene_0001.png');
    const image=await fetch(base+'/api/comfy/image?'+new URLSearchParams({job,filename:'Scene_0001.png'}));
    assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');
  }finally{
    await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});
  }
});
