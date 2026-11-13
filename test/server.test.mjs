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
