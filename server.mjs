import http from 'node:http';
import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { StudioStore } from './storage.mjs';
import { ComfyClient } from './comfy.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const DEFAULT_INFERENCE_URL = 'http://127.0.0.1:5001/v1';
const ALLOWED = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/scene.js', ['scene.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/engine.mjs', ['../engine.mjs', 'text/javascript; charset=utf-8']],
  ['/harness.mjs', ['../harness.mjs', 'text/javascript; charset=utf-8']],
  ['/psychology.mjs', ['../psychology.mjs', 'text/javascript; charset=utf-8']],
  ['/fidelity.mjs', ['../fidelity.mjs', 'text/javascript; charset=utf-8']],
  ['/interactions/channels.mjs', ['../interactions/channels.mjs', 'text/javascript; charset=utf-8']],
  ['/interactions/reply-review.mjs', ['../interactions/reply-review.mjs', 'text/javascript; charset=utf-8']],
]);
const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};

async function readBinary(req, limit = 1_500_000) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new RangeError('Portrait exceeds the 1.5 MB upload limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function verifiedImage(bytes, type) {
  if (type === 'image/jpeg' && bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (type === 'image/webp' && bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  throw new RangeError('Only valid JPEG or WebP portraits are accepted');
}
async function readJson(req, limit = 750_000) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk.toString();
    if (raw.length > limit) throw new Error('Request too large');
  }
  try { return JSON.parse(raw); } catch { throw new Error('Invalid JSON'); }
}

export function createApp({ lmUrl = DEFAULT_INFERENCE_URL, fetchImpl = fetch, store = new StudioStore(join(root, '.data', 'studio.sqlite')), portraitDir = join(root, '.data', 'portraits'), comfyUrl = process.env.COMFYUI_URL || 'http://127.0.0.1:8188/', comfyFetchImpl = fetch, comfyTemplateDir = join(root,'.data','comfy-workflows') } = {}) {
  const comfy = new ComfyClient({url:comfyUrl,fetchImpl:comfyFetchImpl,templateDir:comfyTemplateDir});
  // The server binds localhost by default; this additional check rejects cross-site writes.
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const path = requestUrl.pathname;
    const origin = req.headers.origin;
    if (origin) {
      try {
        const u = new URL(origin);
        if (!['localhost', '127.0.0.1'].includes(u.hostname) || u.host !== req.headers.host) {
          return json(res, 403, { error: 'Cross-origin requests are blocked' });
        }
      } catch { return json(res, 403, { error: 'Invalid origin' }); }
    }
    try {
      if (req.method === 'POST' && path === '/api/portraits') {
        const type = (req.headers['content-type'] || '').toLowerCase();
        if (!['image/webp', 'image/jpeg'].includes(type)) return json(res, 415, { error: 'Portrait must be JPEG or WebP' });
        const bytes = await readBinary(req);
        const ext = verifiedImage(bytes, type);
        const filename = `${randomUUID()}.${ext}`;
        await mkdir(portraitDir, { recursive: true });
        await writeFile(join(portraitDir, filename), bytes, { flag: 'wx' });
        return json(res, 201, { path: `/portraits/${filename}` });
      }
      if (req.method === 'GET' && /^\/portraits\/[a-f0-9-]{36}\.(?:jpg|webp)$/.test(path)) {
        try {
          const image = await readFile(join(portraitDir, path.slice('/portraits/'.length)));
          res.writeHead(200, { 'Content-Type': path.endsWith('.webp') ? 'image/webp' : 'image/jpeg', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400' });
          return res.end(image);
        } catch (error) {
          if (error.code === 'ENOENT') return json(res, 404, { error: 'Portrait not found' });
          throw error;
        }
      }
      if (req.method === 'GET' && path === '/api/worlds') {
        return json(res,200,store.worlds.list());
      }
      if (req.method === 'POST' && path === '/api/worlds') {
        const data=await readJson(req,5000);
        try { return json(res,201,store.worlds.createWorld(data)); }
        catch(err) { if(err instanceof TypeError) return json(res,400,{error:err.message}); throw err; }
      }
      if (req.method === 'POST' && path === '/api/timelines') {
        const data=await readJson(req,3000);
        try { return json(res,201,store.worlds.createTimeline(data)); }
        catch(err) { return json(res,400,{error:err.message}); }
      }
      if (req.method === 'POST' && path === '/api/timelines/fork') {
        const input=await readJson(req,3000);
        try{return json(res,201,store.worlds.forkTimeline(input));}
        catch(err){return json(res,400,{error:err.message});}
      }
      if (req.method === 'POST' && path === '/api/worlds/locations') {
        const data=await readJson(req,6000);
        try {return json(res,201,store.worlds.createLocation(data));}
        catch(err){return json(res,400,{error:err.message});}
      }
      if (req.method === 'POST' && path === '/api/worlds/connections') {
        const data=await readJson(req,3000);
        try {return json(res,201,store.worlds.connectLocations(data));}
        catch(err){return json(res,400,{error:err.message});}
      }
      if (req.method === 'POST' && path === '/api/worlds/entities') {
        const data=await readJson(req,3000);
        try {return json(res,201,store.worlds.createEntity(data));}
        catch(err){return json(res,400,{error:err.message});}
      }
      if (req.method === 'POST' && path === '/api/worlds/relationships') {
        const data=await readJson(req,5000);
        try {return json(res,201,store.worlds.createRelationship(data));}
        catch(err){return json(res,400,{error:err.message});}
      }
      if (req.method === 'POST' && path === '/api/timelines/clock') {
        const data=await readJson(req,2500);
        try {return json(res,200,store.worlds.setClock(data));}
        catch(err){return json(res,400,{error:err.message});}
      }
      if (req.method === 'POST' && path === '/api/timelines/positions') {
        const data=await readJson(req,2500);
        try {return json(res,200,store.worlds.setActorLocation(data));}
        catch(err){return json(res,400,{error:err.message});}
      }
      if (req.method === 'GET' && path === '/api/timelines/actors') {
        const timelineId=requestUrl.searchParams.get('timelineId');
        if(!timelineId || timelineId.length>120) return json(res,400,{error:'Valid timelineId required'});
        return json(res,200,{actors:store.worlds.actors(timelineId)});
      }
      if (req.method === 'POST' && path === '/api/events/proposals') {
        const input=await readJson(req,5000);
        try {return json(res,201,store.events.propose(input));}
        catch(err){return json(res,422,{error:err.message});}
      }
      if (req.method === 'GET' && path === '/api/events/proposals') {
        try {return json(res,200,{proposals:store.events.list(requestUrl.searchParams.get('sceneId'))});}
        catch(err){return json(res,400,{error:err.message});}
      }
      if (req.method === 'POST' && path === '/api/events/decide') {
        const input=await readJson(req,2500);
        try {return json(res,200,store.events.decide(input));}
        catch(err){return json(res,409,{error:err.message});}
      }
      if (req.method === 'GET' && path === '/api/events/visible') {
        try {return json(res,200,{events:store.events.visible(requestUrl.searchParams.get('timelineId'),requestUrl.searchParams.get('actorId'))});}
        catch(err){return json(res,400,{error:err.message});}
      }
      if (req.method === 'GET' && path === '/api/state') {
        return json(res, 200, store.load());
      }
      if (req.method === 'PUT' && path === '/api/state') {
        const payload = await readJson(req, 4_500_000);
        if (!payload || !Number.isSafeInteger(payload.revision) || payload.revision < 0 ||
          !payload.state || !Array.isArray(payload.state.characters) || !Array.isArray(payload.state.sessions) ||
          !payload.state.characters.length ||
          !payload.state.characters.every(c => c && typeof c.id === 'string' && typeof c.name === 'string') ||
          !payload.state.sessions.every(s => s && typeof s.id === 'string' && Array.isArray(s.messages))) {
          return json(res, 400, { error: 'Invalid story document or revision' });
        }
        const result = store.save(payload.state, payload.revision);
        return result ? json(res, 200, result) : json(res, 409, { error: 'Story was changed in another tab; export local changes before reloading.' });
      }
      if (req.method === 'POST' && path === '/api/search/lore') {
        const {query,actorId,sessionId}=await readJson(req,4000);
        if(typeof query !== 'string' || query.length > 500 || typeof actorId !== 'string' || typeof sessionId !== 'string')return json(res,400,{error:'Invalid lore query'});
        const state=store.load().state;
        const session=state?.sessions?.find(s=>s.id===sessionId && !s.trashedAt);
        if(!session || !(session.castIds||[session.characterId]).includes(actorId) || !state.characters.some(c=>c.id===actorId && !c.trashedAt))return json(res,400,{error:'Actor not in this scene'});
        return json(res,200,{entries:store.searchLore(query,{actorId,sessionId,limit:6})});
      }
      if (req.method === 'GET' && path === '/api/comfy/status') {
        try{return json(res,200,await comfy.status());}catch(error){return json(res,200,{connected:false,error:error.message});}
      }
      if (req.method === 'GET' && path === '/api/comfy/templates') return json(res,200,{templates:await comfy.templates()});
      if (req.method === 'POST' && path === '/api/comfy/import') {
        const payload=await readJson(req,1_100_000);
        try{return json(res,201,await comfy.install(payload));}catch(error){return json(res,422,{error:error.message});}
      }
      if (req.method === 'POST' && path === '/api/comfy/generate') {
        const payload=await readJson(req,8000);
        if(typeof payload.templateId !== 'string' || typeof payload.prompt !== 'string' || payload.prompt.length > 4000 || typeof (payload.negative||'') !== 'string')return json(res,400,{error:'Invalid ComfyUI job'});
        try{return json(res,202,await comfy.submit(payload));}catch(error){return json(res,422,{error:error.message});}
      }
      if (req.method === 'GET' && path === '/api/comfy/history') {
        try{return json(res,200,await comfy.history(requestUrl.searchParams.get('job')));}catch(error){return json(res,404,{error:error.message});}
      }
      if (req.method === 'GET' && path === '/api/comfy/image') {
        try{
          const {bytes,type}=await comfy.image(requestUrl.searchParams.get('job'),requestUrl.searchParams.get('filename'),requestUrl.searchParams.get('subfolder')||'');
          res.writeHead(200,{'Content-Type':type,'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'});return res.end(bytes);
        }catch(error){return json(res,404,{error:error.message});}
      }
      if (req.method === 'GET' && path === '/api/harness/status') {
        return json(res,200,{local:true,backend:new URL(lmUrl).host,storage:'sqlite',retrieval:'SQLite FTS5',comfyUrl:new URL(comfy.url).host});
      }
      if (req.method === 'GET' && path === '/api/models') {
        const response = await fetchImpl(`${lmUrl}/models`, { signal: AbortSignal.timeout(3500) });
        if (!response.ok) throw new Error(`Model server returned ${response.status}`);
        const data = await response.json();
        return json(res, 200, { backend: new URL(lmUrl).host, models: Array.isArray(data.data) ? data.data.map(m => ({ id: m.id })).filter(m => typeof m.id === 'string') : [] });
      }
      if (req.method === 'POST' && path === '/api/chat') {
        const data = await readJson(req);
        const valid = typeof data.model === 'string' && data.model.length > 0 && data.model.length < 250 &&
          Array.isArray(data.messages) && data.messages.length > 0 && data.messages.length <= 200 &&
          data.messages.every(m => m && ['system', 'user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content.length <= 30_000) &&
          Number.isFinite(data.temperature) && data.temperature >= 0 && data.temperature <= 2 &&
          Number.isInteger(data.max_tokens) && data.max_tokens >= 32 && data.max_tokens <= 2048;
        if (!valid) return json(res, 400, { error: 'Invalid model, messages, or generation parameters' });
        const aborter = new AbortController();
        res.on('close', () => aborter.abort());
        let upstream;
        try {
          upstream = await fetchImpl(`${lmUrl}/chat/completions`, {
            method: 'POST', signal: aborter.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: data.model, messages: data.messages, temperature: data.temperature, max_tokens: data.max_tokens, stream: true }),
          });
        } catch (err) { return json(res, 502, { error: `Could not reach model server: ${err.message}` }); }
        if (!upstream.ok) return json(res, 502, { error: `Model server rejected request (${upstream.status}): ${(await upstream.text()).slice(0, 800)}` });
        if (!upstream.body) return json(res, 502, { error: 'Model server returned an empty stream' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Content-Type-Options': 'nosniff' });
        try {
          for await (const chunk of upstream.body) {
            if (res.destroyed) break;
            if (!res.write(chunk)) await new Promise(resolve => res.once('drain', resolve));
          }
        } catch (err) {
          if (!res.destroyed) res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
        }
        if (!res.destroyed) res.end();
        return;
      }
      if (req.method === 'GET' && ALLOWED.has(path)) {
        const [file, type] = ALLOWED.get(path);
        const content = await readFile(join(root, 'public', file));
        res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
        return res.end(content);
      }
      return json(res, 404, { error: 'Not found' });
    } catch (err) {
      if (!res.headersSent) json(res, err.message === 'Invalid JSON' || err.message === 'Request too large' || err instanceof RangeError ? 400 : 500, { error: err.message });
      else res.destroy(err);
    }
  });
  server.on('close', () => store.close());
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 4173);
  const server = createApp({ lmUrl: process.env.INFERENCE_URL || process.env.LM_STUDIO_URL || DEFAULT_INFERENCE_URL });
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    terminal.close();
    console.log('Stopping AI RP Studio...');
    server.close(err => {
      if (err) {
        console.error('Shutdown error:', err);
        process.exitCode = 1;
      } else console.log('AI RP Studio stopped.');
    });
  };
  terminal.on('line', line => {
    if (/^(quit|exit)$/i.test(line.trim())) shutdown();
  });
  terminal.on('SIGINT', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  server.listen(port, '127.0.0.1', () => {
    console.log(`AI RP Studio: http://127.0.0.1:${server.address().port}`);
    console.log('Type quit or exit and press Enter to stop.');
  });
}
