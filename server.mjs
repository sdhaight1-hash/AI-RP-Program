import http from 'node:http';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { StudioStore } from './storage.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const DEFAULT_INFERENCE_URL = 'http://127.0.0.1:5001/v1';
const ALLOWED = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/scene.js', ['scene.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/engine.mjs', ['../engine.mjs', 'text/javascript; charset=utf-8']],
]);
const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};

async function readJson(req, limit = 750_000) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk.toString();
    if (raw.length > limit) throw new Error('Request too large');
  }
  try { return JSON.parse(raw); } catch { throw new Error('Invalid JSON'); }
}

export function createApp({ lmUrl = DEFAULT_INFERENCE_URL, fetchImpl = fetch, store = new StudioStore(join(root, '.data', 'studio.sqlite')) } = {}) {
  // The server binds localhost by default; this additional check rejects cross-site writes.
  const server = http.createServer(async (req, res) => {
    const path = (req.url || '/').split('?')[0];
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
