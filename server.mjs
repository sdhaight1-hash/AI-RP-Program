import http from 'node:http';
import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { StudioStore } from './storage.mjs';
import { WorldPartitionStore } from './world/partition-store.mjs';
import { ComfyClient } from './comfy.mjs';
import { buildActorContext } from './context/assemble.mjs';
import { discoverBackendContext, enforceTokenBudget } from './context/backend.mjs';
import { addActorFact, listActorFacts, revokeActorFact } from './memory/facts.mjs';
import { suggestActorMemories } from './memory/suggestions.mjs';
import { createLocalSemanticRetriever } from './memory/semantic.mjs';
import { purgeArchived } from './harness.mjs';
import {assertExplicitPurges,DeletionConflictError} from './world/conflict-guards.mjs';
import { commitCharacterWorldEntry,listCharacterWorldSources } from './character/world-bridge.mjs';
import { approveCharacterWorldRelationship } from './character/relationship-bridge.mjs';
import { evaluateLocalSemanticModel } from './eval/local-semantic.mjs';
import {readWorldEpoch} from './world/epoch.mjs';
import {replyBasis,isReplyBasisCurrent} from './interactions/reply-review.mjs';
import {applyCompletedNpcReply} from './interactions/reply-commit.mjs';
import {createReplyStreamReader} from './interactions/stream-reader.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const DEFAULT_INFERENCE_URL = 'http://127.0.0.1:5001/v1';
const ALLOWED = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/scene.js', ['scene.js', 'text/javascript; charset=utf-8']],
  ['/world-client.mjs', ['world-client.mjs', 'text/javascript; charset=utf-8']],
  ['/studio-navigation.mjs', ['studio-navigation.mjs', 'text/javascript; charset=utf-8']],
  ['/encounter-studio.mjs', ['encounter-studio.mjs', 'text/javascript; charset=utf-8']],
  ['/encounters/library.mjs', ['../encounters/library.mjs', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/studio-shell.css', ['studio-shell.css', 'text/css; charset=utf-8']],
  ['/engine.mjs', ['../engine.mjs', 'text/javascript; charset=utf-8']],
  ['/harness.mjs', ['../harness.mjs', 'text/javascript; charset=utf-8']],
  ['/psychology.mjs', ['../psychology.mjs', 'text/javascript; charset=utf-8']],
  ['/fidelity.mjs', ['../fidelity.mjs', 'text/javascript; charset=utf-8']],
  ['/character/context.mjs', ['../character/context.mjs', 'text/javascript; charset=utf-8']],
  ['/character/schema.mjs', ['../character/schema.mjs', 'text/javascript; charset=utf-8']],
  ['/character/sections.mjs', ['../character/sections.mjs', 'text/javascript; charset=utf-8']],
  ['/character/authoring.mjs', ['../character/authoring.mjs', 'text/javascript; charset=utf-8']],
  ['/character/world-bridge.mjs', ['../character/world-bridge.mjs', 'text/javascript; charset=utf-8']],
  ['/character/relationship-bridge.mjs', ['../character/relationship-bridge.mjs', 'text/javascript; charset=utf-8']],
  ['/world/geography.mjs', ['../world/geography.mjs', 'text/javascript; charset=utf-8']],
  ['/eval/local-model.mjs', ['../eval/local-model.mjs', 'text/javascript; charset=utf-8']],
  ['/character/field-contracts.mjs', ['../character/field-contracts.mjs', 'text/javascript; charset=utf-8']],
  ['/interactions/channels.mjs', ['../interactions/channels.mjs', 'text/javascript; charset=utf-8']],
  ['/interactions/reply-review.mjs', ['../interactions/reply-review.mjs', 'text/javascript; charset=utf-8']],
]);
const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};

// Detect world canon/clock/actor-knowledge changes that do not increment the
// story snapshot revision. total_changes catches writes on this connection;
// data_version catches commits by another connection to the same world file.
const worldMutationStamp=store=>{
  const db=store.db;
  return db.prepare('SELECT total_changes() AS n').get().n+':'+
    db.prepare('PRAGMA data_version').get().data_version;
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
  // Decode only after collecting complete bytes. Per-chunk Buffer.toString()
  // corrupts multibyte UTF-8 split across TCP frames, and UTF-16 length is
  // not a reliable upload-size limit.
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new RangeError('Request too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Invalid JSON'); }
}

export function createApp({ lmUrl = DEFAULT_INFERENCE_URL, fetchImpl = fetch, store: baseStore = new WorldPartitionStore(join(root, '.data')), portraitDir = null, comfyUrl = process.env.COMFYUI_URL || 'http://127.0.0.1:8188/', comfyFetchImpl = fetch, comfyTemplateDir = join(root,'.data','comfy-workflows'),
  semanticModel = process.env.RP_EMBEDDING_MODEL || '',
  semanticUrl = process.env.RP_EMBEDDING_URL || 'http://127.0.0.1:1234/v1',
  semanticFetchImpl = fetchImpl
} = {}) {
  const comfy = new ComfyClient({url:comfyUrl,fetchImpl:comfyFetchImpl,templateDir:comfyTemplateDir});
  // Disabled by default: do not send private actor memory to a second model
  // unless the local user explicitly configures a loopback embedding model.
  const semantic=semanticModel?createLocalSemanticRetriever({
    baseUrl:semanticUrl,model:semanticModel,fetchImpl:semanticFetchImpl
  }):null;
  // One-use reply tickets exist only for the life of this server process.
  // A restart invalidates outstanding drafts; the world epoch remains durable.
  const replyLeases=new Map();
  const cleanReplyLeases=()=>{
    const now=Date.now();
    for(const [id,record] of replyLeases)
      if(record.expiresAt<=now)replyLeases.delete(id);
    while(replyLeases.size>=64)replyLeases.delete(replyLeases.keys().next().value);
  };
  // The server binds localhost by default; this additional check rejects cross-site writes.
  const server = http.createServer(async (req, res) => {
    // A scoped store belongs to this request, never to a process-global tab.
    // Async embedding/model calls retain the same view even if a tab switches.
    let store = baseStore;
    const requireWorldScope = worldId => {
      if (typeof baseStore.forWorld === 'function') {
        if(typeof worldId!=='string'||!worldId.trim())throw new RangeError('World ID required');
        store = baseStore.forWorld(worldId);
      } else if (typeof baseStore.activateWorld === 'function') baseStore.assertWorld(worldId);
    };
    try {
      const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const path = requestUrl.pathname;
      const origin = req.headers.origin;
      if (origin) {
        try {
          const u = new URL(origin);
          if (!['localhost', '127.0.0.1'].includes(u.hostname) || u.host !== req.headers.host)
            return json(res, 403, { error: 'Cross-origin requests are blocked' });
        } catch { return json(res, 403, { error: 'Invalid origin' }); }
      }
      if (req.method === 'POST' && path === '/api/portraits') {
        requireWorldScope(requestUrl.searchParams.get('worldId'));
        const type = (req.headers['content-type'] || '').toLowerCase();
        if (!['image/webp', 'image/jpeg'].includes(type)) return json(res, 415, { error: 'Portrait must be JPEG or WebP' });
        const bytes = await readBinary(req);
        const ext = verifiedImage(bytes, type);
        const filename = `${randomUUID()}.${ext}`;
        const assetDir = portraitDir || store.assetDir?.('portraits') || join(root,'.data','portraits');
        await mkdir(assetDir, { recursive: true });
        await writeFile(join(assetDir, filename), bytes, { flag: 'wx' });
        return json(res, 201, { path: `/portraits/${filename}` });
      }
      if (req.method === 'GET' && /^\/portraits\/[a-f0-9-]{36}\.(?:jpg|webp)$/.test(path)) {
        requireWorldScope(requestUrl.searchParams.get('worldId'));
        try {
          const assetDir = portraitDir || store.assetDir?.('portraits') || join(root,'.data','portraits');
          const image = await readFile(join(assetDir, path.slice('/portraits/'.length)));
          res.writeHead(200, { 'Content-Type': path.endsWith('.webp') ? 'image/webp' : 'image/jpeg', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
          return res.end(image);
        } catch (error) {
          if (error.code === 'ENOENT') return json(res, 404, { error: 'Portrait not found' });
          throw error;
        }
      }
      if (req.method === 'GET' && path === '/api/worlds') {
        if(requestUrl.searchParams.has('worldId')) requireWorldScope(requestUrl.searchParams.get('worldId'));
        return json(res,200,store.worlds.list());
      }
      if (req.method === 'POST' && path === '/api/worlds/activate') {
        const { worldId }=await readJson(req,1500);
        if (!store.activateWorld) return json(res,501,{error:'This storage backend does not support world switching'});
        try {return json(res,200,store.activateWorld(worldId));}
        catch(err){return json(res,400,{error:err.message});}
      }
      if (req.method === 'POST' && path === '/api/worlds') {
        const data=await readJson(req,5000);
        try { return json(res,201,store.worlds.createWorld(data)); }
        catch(err) { return json(res,400,{error:err.message}); }
      }
      if (req.method === 'POST' && path === '/api/timelines') {
        const data=await readJson(req,3000);
        requireWorldScope(data.worldId);
        try { return json(res,201,store.worlds.createTimeline(data)); }
        catch(err) { return json(res,400,{error:err.message}); }
      }
      if (req.method === 'POST' && path === '/api/timelines/fork') {
        const input=await readJson(req,3000);
        requireWorldScope(input.worldId);
        try{return json(res,201,store.worlds.forkTimeline(input));}
        catch(err){return json(res,400,{error:err.message});}
      }
      if (req.method === 'POST' && path === '/api/worlds/locations') {
        const data=await readJson(req,6000);
        requireWorldScope(data.worldId);
        try {return json(res,201,store.worlds.createLocation(data));}
        catch(err){return json(res,400,{error:err.message});}
      }
      if (req.method === 'POST' && path === '/api/worlds/connections') {
        const data=await readJson(req,3000);
        requireWorldScope(data.worldId);
        try {return json(res,201,store.worlds.connectLocations(data));}
        catch(err){return json(res,400,{error:err.message});}
      }
      if (req.method === 'POST' && path === '/api/worlds/entities') {
        const data=await readJson(req,3000);
        requireWorldScope(data.worldId);
        try {return json(res,201,store.worlds.createEntity(data));}
        catch(err){return json(res,400,{error:err.message});}
      }
      if (req.method === 'POST' && path === '/api/eval/semantic-local') {
        const input=await readJson(req,1000);
        requireWorldScope(input.worldId);
        // Evaluate only a synthetic in-memory fixture. Never embed the user's
        // live scenes as part of diagnostics or mutate their active world.
        try {
          const result=await evaluateLocalSemanticModel(semantic);
          requireWorldScope(input.worldId);
          return json(res,200,result);
        }catch(error){
          requireWorldScope(input.worldId);
          return json(res,200,{status:'unavailable',error:error.message});
        }
      }
      if (req.method === 'POST' && path === '/api/character/world-relationships/approve') {
        const data=await readJson(req,5000);
        requireWorldScope(data.worldId);
        try{return json(res,201,approveCharacterWorldRelationship(store,data));}
        catch(error){
          const stale=/changed|Wrong world|reload approved/.test(error.message);
          return json(res,stale?409:422,{error:error.message});
        }
      }
      if (req.method === 'POST' && path === '/api/character/world-entries/approve') {
        const input=await readJson(req,6000);
        requireWorldScope(input.worldId);
        try{return json(res,201,commitCharacterWorldEntry(store,input));}
        catch(error){
          const stale=/changed since|changed; regenerate|Wrong world/.test(error.message);
          return json(res,stale?409:422,{error:error.message});
        }
      }
      if (req.method === 'GET' && path === '/api/character/world-entries/sources') {
        const worldId=requestUrl.searchParams.get('worldId');
        const characterId=requestUrl.searchParams.get('characterId');
        requireWorldScope(worldId);
        if(!characterId||characterId.length>160)return json(res,400,{error:'Valid character required'});
        const actor=store.load().state?.characters?.find(c=>c.id===characterId&&!c.trashedAt);
        if(!actor||(actor.worldId&&actor.worldId!==worldId))return json(res,404,{error:'Character not found in this world'});
        return json(res,200,{sources:listCharacterWorldSources(store,{worldId,characterId})});
      }
      if (req.method === 'POST' && path === '/api/worlds/relationships') {
        const data=await readJson(req,5000);
        requireWorldScope(data.worldId);
        try {return json(res,201,store.worlds.createRelationship(data));}
        catch(err){return json(res,400,{error:err.message});}
      }
      if (req.method === 'POST' && path === '/api/worlds/entries/delete') {
        const input=await readJson(req,1500);
        requireWorldScope(input?.worldId);
        try{return json(res,200,store.worlds.deleteEntry(input));}
        catch(error){
          const conflict=/referenced|linked|first|used by|unlink|belongs to|Wrong world/.test(error.message);
          return json(res,conflict?409:422,{error:error.message});
        }
      }
      if (req.method === 'POST' && path === '/api/timelines/clock') {
        const data=await readJson(req,2500);
        requireWorldScope(data.worldId);
        try {return json(res,200,store.worlds.setClock(data));}
        catch(err){return json(res,400,{error:err.message});}
      }
      if (req.method === 'POST' && path === '/api/timelines/positions') {
        const data=await readJson(req,2500);
        requireWorldScope(data.worldId);
        try {return json(res,200,store.worlds.setActorLocation(data));}
        catch(err){return json(res,400,{error:err.message});}
      }
      if (req.method === 'GET' && path === '/api/timelines/actors') {
        requireWorldScope(requestUrl.searchParams.get('worldId'));
        const timelineId=requestUrl.searchParams.get('timelineId');
        if(!timelineId || timelineId.length>120) return json(res,400,{error:'Valid timelineId required'});
        return json(res,200,{actors:store.worlds.actors(timelineId)});
      }
      if (req.method === 'POST' && path === '/api/events/proposals') {
        const input=await readJson(req,5000);
        requireWorldScope(input.worldId);
        try {return json(res,201,store.events.propose(input));}
        catch(err){return json(res,422,{error:err.message});}
      }
      if (req.method === 'GET' && path === '/api/events/proposals') {
        requireWorldScope(requestUrl.searchParams.get('worldId'));
        try {return json(res,200,{proposals:store.events.list(requestUrl.searchParams.get('sceneId'))});}
        catch(err){return json(res,400,{error:err.message});}
      }
      if (req.method === 'POST' && path === '/api/events/decide') {
        const input=await readJson(req,2500);
        requireWorldScope(input.worldId);
        try {return json(res,200,store.events.decide(input));}
        catch(err){return json(res,409,{error:err.message});}
      }
      if (req.method === 'GET' && path === '/api/events/visible') {
        requireWorldScope(requestUrl.searchParams.get('worldId'));
        try {return json(res,200,{events:store.events.visible(requestUrl.searchParams.get('timelineId'),requestUrl.searchParams.get('actorId'))});}
        catch(err){return json(res,400,{error:err.message});}
      }
      if (req.method === 'POST' && path === '/api/library/purge') {
        const input=await readJson(req,1600);
        requireWorldScope(input?.worldId);
        if(!input || !Number.isSafeInteger(input.revision)||input.revision<0 ||
          !['character','scene'].includes(input.kind) ||
          typeof input.id!=='string'||!input.id||input.id.length>160)
          return json(res,400,{error:'Invalid library purge request'});
        const snapshot=store.load();
        if(snapshot.revision!==input.revision)
          return json(res,409,{error:'Story revision changed; reload before permanently deleting.'});
        const next=structuredClone(snapshot.state);
        try{
          purgeArchived(next,input.kind,input.id);
          const saved=store.save(next,input.revision,{
            worldId:input.worldId,
            purgedSceneId:input.kind==='scene'?input.id:null,
            purgedCharacterId:input.kind==='character'?input.id:null
          });
          if(!saved)return json(res,409,{error:'Story changed before permanent deletion'});
          return json(res,200,{...saved,worldId:input.worldId,state:store.load().state});
        }catch(error){return json(res,422,{error:error.message});}
      }
      if (req.method === 'GET' && path === '/api/state') {
        if (requestUrl.searchParams.has('worldId')) requireWorldScope(requestUrl.searchParams.get('worldId'));
        return json(res, 200, store.load());
      }
      if (req.method === 'PUT' && path === '/api/state') {
        // Opt-in normalized-primary worlds can carry larger histories in the
        // existing full-document browser protocol. The store still enforces a
        // stricter world-specific size limit after the payload is validated.
        const payload = await readJson(req, 17_000_000);
        if (typeof baseStore.forWorld === 'function' || payload?.worldId !== undefined) requireWorldScope(payload?.worldId);
        if (!payload || !Number.isSafeInteger(payload.revision) || payload.revision < 0 ||
          !payload.state || !Array.isArray(payload.state.characters) || !Array.isArray(payload.state.sessions) ||
          (!payload.state.characters.length && !store.activateWorld) ||
          !payload.state.characters.every(c => c && typeof c.id === 'string' && typeof c.name === 'string') ||
          !payload.state.sessions.every(s => s && typeof s.id === 'string' && Array.isArray(s.messages))) {
          return json(res, 400, { error: 'Invalid story document or revision' });
        }
        try {
          // Even the legacy single-file backend must not allow a normal PUT
          // to bypass explicit archival/dependency checks. Partitioned stores
          // revalidate under their SQLite write lock as well.
          if(typeof baseStore.forWorld!=='function'){
            const before=store.load();
            if(before.revision===payload.revision)
              assertExplicitPurges(before.state,payload.state);
          }
          const result = store.save(payload.state, payload.revision, { worldId: payload.worldId });
          return result ? json(res, 200, result) : json(res, 409, { error: 'Story was changed in another tab; export local changes before reloading.' });
        } catch(err) {
          if(err instanceof DeletionConflictError)return json(res,409,{error:err.message});
          if (/World changed;/.test(err.message)) return json(res,409,{error:err.message});
          if (/belongs to another world|not a location in this world|not in this world/.test(err.message))return json(res,422,{error:err.message});
          throw err;
        }
      }
      if (req.method === 'POST' && path === '/api/search/lore') {
        const {query,actorId,sessionId,worldId}=await readJson(req,4000);
        requireWorldScope(worldId);
        if(typeof query !== 'string' || query.length > 500 || typeof actorId !== 'string' || typeof sessionId !== 'string')return json(res,400,{error:'Invalid lore query'});
        const state=store.load().state;
        const session=state?.sessions?.find(s=>s.id===sessionId && !s.trashedAt);
        if(!session || !(session.castIds||[session.characterId]).includes(actorId) || !state.characters.some(c=>c.id===actorId && !c.trashedAt))return json(res,400,{error:'Actor not in this scene'});
        return json(res,200,{entries:store.searchLore(query,{actorId,sessionId,worldId,limit:6})});
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
        requireWorldScope(payload.worldId);
        if(typeof payload.templateId !== 'string' || typeof payload.prompt !== 'string' || payload.prompt.length > 4000 || typeof (payload.negative||'') !== 'string')return json(res,400,{error:'Invalid ComfyUI job'});
        try{return json(res,202,await comfy.submit(payload));}catch(error){return json(res,422,{error:error.message});}
      }
      if (req.method === 'GET' && path === '/api/comfy/history') {
        requireWorldScope(requestUrl.searchParams.get('worldId'));
        try{return json(res,200,await comfy.history(requestUrl.searchParams.get('job'),requestUrl.searchParams.get('worldId')));}catch(error){return json(res,404,{error:error.message});}
      }
      if (req.method === 'GET' && path === '/api/comfy/image') {
        requireWorldScope(requestUrl.searchParams.get('worldId'));
        try{
          const {bytes,type}=await comfy.image(requestUrl.searchParams.get('job'),requestUrl.searchParams.get('filename'),requestUrl.searchParams.get('subfolder')||'',requestUrl.searchParams.get('worldId'));
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
      if (req.method === 'POST' && path === '/api/actor/facts/suggest') {
        const data=await readJson(req,2500);
        requireWorldScope(data.worldId);
        const startingRevision=store.load().revision;
        const startingMutation=worldMutationStamp(store);
        if(!Number.isSafeInteger(data.revision) || data.revision!==startingRevision)
          return json(res,409,{error:'Save the current scene before suggesting memories'});
        let suggestions;
        try {
          suggestions=await suggestActorMemories({
            store,sceneId:data.sceneId,actorId:data.actorId,model:data.model,
            lmUrl,fetchImpl
          });
        }catch(error){return json(res,422,{error:error.message});}
        requireWorldScope(data.worldId);
        if(store.load().revision!==startingRevision||
          worldMutationStamp(store)!==startingMutation)
          return json(res,409,{error:'The scene or world knowledge changed while suggesting memories; try again'});
        // Suggestions are not persisted and do not become world canon.
        return json(res,200,{suggestions});
      }
      if (req.method === 'GET' && path === '/api/actor/facts') {
        requireWorldScope(requestUrl.searchParams.get('worldId'));
        try {
          return json(res,200,{facts:listActorFacts(store,{
            timelineId:requestUrl.searchParams.get('timelineId'),
            actorId:requestUrl.searchParams.get('actorId')})});
        }catch(error){return json(res,422,{error:error.message});}
      }
      if (req.method === 'POST' && (path === '/api/actor/facts' || path === '/api/actor/facts/revoke')) {
        const data=await readJson(req,3500);
        requireWorldScope(data.worldId);
        if(Number.isSafeInteger(data.revision) && data.revision!==store.load().revision)
          return json(res,409,{error:'The scene changed before this memory was submitted'});
        try {
          if(path.endsWith('/revoke'))return json(res,200,revokeActorFact(store,data));
          return json(res,201,addActorFact(store,data));
        }catch(error){return json(res,422,{error:error.message});}
      }
      if (req.method === 'POST' && path === '/api/actor/reply/commit') {
        const data=await readJson(req,1200);
        requireWorldScope(data?.worldId);
        if(typeof data?.ticket!=='string'||data.ticket.length>100||typeof data.reviewed!=='boolean')
          return json(res,400,{error:'Valid completed reply ticket and review choice required'});
        const lease=replyLeases.get(data.ticket);
        if(!lease||lease.expiresAt<=Date.now()||lease.worldId!==data.worldId)
          return json(res,409,{error:'NPC reply ticket expired or belongs to another world. Generate again.'});
        // Consume regardless of the result: no replay or concurrent duplicate
        // commits, including a failed conflict-validation attempt.
        replyLeases.delete(data.ticket);
        const verify=(previous)=>{
          if(previous.revision!==lease.revision)
            throw new Error('Story revision changed since generation. The stale NPC reply was not saved.');
          if(readWorldEpoch(store.db)!==lease.epoch)
            throw new Error('World knowledge changed since generation. The stale NPC reply was not saved.');
          if(!isReplyBasisCurrent(previous.state?.sessions?.find(s=>s.id===lease.sceneId),lease.basis))
            throw new Error('Acting scene context changed since generation. The stale NPC reply was not saved.');
        };
        try{
          const existing=store.load();
          verify(existing);
          const next=structuredClone(existing.state);
          applyCompletedNpcReply(next,lease,{reviewed:data.reviewed});
          const saved=typeof baseStore.forWorld==='function'
            ?store.save(next,lease.revision,{worldId:data.worldId,
              verifyBeforeReplace:verify})
            :store.save(next,lease.revision,{beforeReplace:verify});
          if(!saved)return json(res,409,{error:'Story was edited in another tab before the NPC reply could be saved'});
          return json(res,200,{...saved,worldId:data.worldId,state:store.load().state});
        }catch(error){return json(res,409,{error:error.message});}
      }
      if (req.method === 'POST' && (path === '/api/actor/context' || path === '/api/actor/reply')) {
        const data=await readJson(req,3000);
        requireWorldScope(data.worldId);
        if (!data.sceneId || !data.actorId || typeof data.sceneId !== 'string' || typeof data.actorId !== 'string')
          return json(res,400,{error:'Scene and actor are required'});
        if (Number.isSafeInteger(data.revision) && data.revision !== store.load().revision)
          return json(res,409,{error:'Story was changed. Save and reload the scene before generating.'});
        const responseTokens=Number.isInteger(data.max_tokens) && data.max_tokens>=32 && data.max_tokens<=2048 ? data.max_tokens : 450;
        const contextRequested=Number.isInteger(data.contextWindow) && data.contextWindow>=2048 && data.contextWindow<=32768 ? data.contextWindow : 4096;
        // The configured context cannot override the local backend's real allocation.
        const backend=await discoverBackendContext(lmUrl,data.model,fetchImpl);
        requireWorldScope(data.worldId);
        const contextArgs={store,worldId:data.worldId,sceneId:data.sceneId,actorId:data.actorId,
          mode:data.mode||'normal',contextWindow:Math.min(contextRequested,backend.contextWindow||contextRequested),
          maxOutput:responseTokens};
        const startingRevision=store.load().revision;
        const startingMutation=worldMutationStamp(store);
        const startingEpoch=readWorldEpoch(store.db);
        let prompt,semanticEvidence=[],semanticStatus=semantic?'no-match':'disabled';
        try {
          prompt=buildActorContext(contextArgs);
          if(semantic && prompt.metadata.retrievalCue.trim()){
            try{
              semanticEvidence=await semantic.retrieve({
                store,worldId:data.worldId,sceneId:data.sceneId,actorId:data.actorId,
                query:prompt.metadata.retrievalCue
              });
              semanticStatus=semanticEvidence.length?'available':'no-match';
            }catch{
              // An unavailable embedding model is never a reason to block an
              // otherwise valid lexical actor reply. Never trust partial data.
              semanticEvidence=[];semanticStatus='fallback';
            }
            // Asynchronous embedding can outlive a scene edit or world switch.
            requireWorldScope(data.worldId);
            if(store.load().revision!==startingRevision||
              worldMutationStamp(store)!==startingMutation)
              return json(res,409,{error:'The scene or world knowledge changed during memory retrieval; retry'});
            if(semanticEvidence.length)prompt=buildActorContext({...contextArgs,semanticEvidence});
          }
          prompt=await enforceTokenBudget(prompt,backend);
          const finalEvidence=prompt.metadata.evidence||[];
          prompt.metadata.semantic={status:semanticStatus,candidates:semanticEvidence.length,
            selected:finalEvidence.filter(e=>semanticEvidence.some(s=>s.kind===e.kind&&s.id===e.id)).length};
        } catch(error) {return json(res,422,{error:error.message});}
        // Native token counting and embeddings may await local models. Reject
        // stale world/revision after those awaits before exposing any context.
        requireWorldScope(data.worldId);
        if(store.load().revision!==startingRevision||
          worldMutationStamp(store)!==startingMutation)
          return json(res,409,{error:'The scene or world knowledge changed during context assembly; retry'});
        if (path === '/api/actor/context') return json(res,200,prompt);
        if (typeof data.model !== 'string' || !data.model || data.model.length>250 ||
            !Number.isFinite(data.temperature) || data.temperature<0 || data.temperature>2)
          return json(res,400,{error:'Select a valid local model and temperature'});
        if(!['normal','retry','continue'].includes(data.mode||'normal'))
          return json(res,400,{error:'Unsupported NPC reply mode'});
        const basisScene=store.load().state?.sessions?.find(s=>s.id===data.sceneId);
        if(!basisScene)return json(res,409,{error:'Scene disappeared during context assembly'});
        const basis=replyBasis(basisScene);
        const streamCurrent=()=>store.load().revision===startingRevision &&
          readWorldEpoch(store.db)===startingEpoch &&
          worldMutationStamp(store)===startingMutation;
        const aborter=new AbortController();
        res.on('close',()=>aborter.abort());
        let upstream;
        try {
          upstream=await fetchImpl(lmUrl+'/chat/completions',{
            method:'POST',signal:aborter.signal,headers:{'Content-Type':'application/json'},
            body:JSON.stringify({model:data.model,messages:prompt.messages,temperature:data.temperature,
              max_tokens:responseTokens,stream:true})
          });
        } catch(error) {return json(res,502,{error:'Local model unavailable: '+error.message});}
        if(!streamCurrent()){
          aborter.abort();
          return json(res,409,{error:'World or scene changed while waiting for the model; generate again'});
        }
        if(!upstream.ok)return json(res,502,{error:'Model server returned '+upstream.status+': '+(await upstream.text()).slice(0,800)});
        if(!upstream.body)return json(res,502,{error:'Model server returned an empty stream'});
        res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','X-Content-Type-Options':'nosniff'});
        const reader=createReplyStreamReader();
        const streamError=message=>{
          if(!res.destroyed)res.write('event: error\ndata: '+JSON.stringify({error:message})+'\n\n');
          aborter.abort();
        };
        try {
          for await(const chunk of upstream.body) {
            if(res.destroyed)break;
            if(!streamCurrent()){
              streamError('World or actor knowledge changed while the NPC was replying. This draft was not saved; generate again.');
              break;
            }
            reader.feed(chunk);
            if(reader.error){streamError(reader.error);break;}
            if(!res.write(chunk))await new Promise(resolve=>{
              const done=()=>{res.off('drain',done);res.off('close',done);resolve();};
              res.once('drain',done);res.once('close',done);
            });
          }
        } catch(error) {if(!res.destroyed)streamError(error.message);}
        // The terminal event is issued ONLY after a completed model stream
        // with unchanged world epoch and story revision. Even a partial reply
        // already shown in the UI cannot become authoritative without it.
        if(!res.destroyed&&reader.completed()&&streamCurrent()&&!aborter.signal.aborted){
          cleanReplyLeases();
          const ticket=randomUUID();
          const completedAt=Date.now();
          replyLeases.set(ticket,{
            worldId:data.worldId,sceneId:data.sceneId,actorId:data.actorId,
            mode:data.mode||'normal',revision:startingRevision,epoch:startingEpoch,
            basis,text:reader.text,messageId:randomUUID(),completedAt,
            expiresAt:completedAt+15*60_000
          });
          res.write('event: rp_complete\ndata: '+JSON.stringify({ticket})+'\n\n');
        }else if(!res.destroyed&&!aborter.signal.aborted){
          streamError('Local model did not finish with a valid, current response. Nothing was saved.');
        }
        if(!res.destroyed)res.end();
        return;
      }
      if (req.method === 'POST' && path === '/api/chat') {
        const data = await readJson(req);
        // Legacy standalone inference clients may omit worldId. They cannot
        // read or write fiction state through this stateless endpoint.
        if (data.worldId !== undefined) requireWorldScope(data.worldId);
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
            if (!res.write(chunk)) await new Promise(resolve => {
              const done=()=>{res.off('drain',done);res.off('close',done);resolve();};
              res.once('drain',done);res.once('close',done);
            });
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
      if (!res.headersSent && /Open that world before editing it/.test(err.message)) return json(res, 409, { error: 'Another tab opened a different world. Reload this world before continuing.' });
      if (!res.headersSent) json(res, err.message === 'World not found' ? 404 : err.message === 'Invalid JSON' || err.message === 'Request too large' || err instanceof RangeError ? 400 : 500, { error: err.message });
      else res.destroy(err);
    }
  });
  server.on('close', () => baseStore.close());
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
