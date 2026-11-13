// Optional local ComfyUI workflow adapter. Only explicitly installed API JSON
// templates are executable; browser requests cannot submit arbitrary node graphs.
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const SAFE_ID=/^[a-zA-Z0-9_-]{1,70}$/;
const SAFE_FILE=/^[a-zA-Z0-9._ ()-]{1,200}$/;
const SAFE_JOB=/^[0-9a-f-]{36}$/i;
const isObject = x => x && typeof x === 'object' && !Array.isArray(x);
export function validateLocalUrl(value) {
  const url = new URL(value);
  if(url.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/') {
    throw new Error('ComfyUI must use a local HTTP origin, e.g. http://127.0.0.1:8188/');
  }
  return url.origin;
}
export function prepareWorkflow(apiJson, prompt, negative = '') {
  const source = isObject(apiJson?.prompt) ? apiJson.prompt : apiJson;
  if(!isObject(source) || !Object.keys(source).length || Object.keys(source).length > 200) throw new Error('Expected a ComfyUI API-format workflow (1–200 nodes)');
  if(typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000 || typeof negative !== 'string' || negative.length > 2000) throw new Error('Invalid generation prompt');
  let replaced=0;
  function walk(x) {
    if(typeof x === 'string') {
      if(x.includes('__RP_PROMPT__')) {replaced++; return x.replaceAll('__RP_PROMPT__',prompt);}
      return x.replaceAll('__RP_NEGATIVE__',negative);
    }
    if(Array.isArray(x)) return x.map(walk);
    if(isObject(x)) return Object.fromEntries(Object.entries(x).map(([k,v])=>[k,walk(v)]));
    return x;
  }
  for(const node of Object.values(source)) if(!isObject(node) || typeof node.class_type !== 'string' || !isObject(node.inputs)) throw new Error('Invalid API workflow node; export using Save (API Format)');
  const graph=walk(source);
  if(!replaced) throw new Error('Workflow needs __RP_PROMPT__ placeholder in a text input');
  return graph;
}
export class ComfyClient {
  constructor({url='http://127.0.0.1:8188/',fetchImpl=fetch,templateDir}) {
    this.url=validateLocalUrl(url);this.fetch=fetchImpl;this.templateDir=templateDir;
    this.jobs=new Map(); // Only allow downloads for outputs of our own submitted jobs.
  }
  async status() {
    const response=await this.fetch(this.url+'/system_stats',{signal:AbortSignal.timeout(3500)});
    if(!response.ok)throw new Error(`ComfyUI HTTP ${response.status}`);
    const data=await response.json();
    return {connected:true,devices:Array.isArray(data?.devices)?data.devices.map(d=>({name:String(d.name||''),type:String(d.type||'')})):[]};
  }
  async templates() {
    const names=await readdir(this.templateDir).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
    return names.filter(n=>n.endsWith('.json') && SAFE_ID.test(n.slice(0,-5))).sort().map(name=>({id:name.slice(0,-5)}));
  }
  async install({id,workflow}) {
    if(!SAFE_ID.test(id || '')) throw new Error('Workflow ID must use letters, numbers, _ or -');
    if(!isObject(workflow))throw new Error('Expected a ComfyUI API JSON object');
    const size=Buffer.byteLength(JSON.stringify(workflow),'utf8');
    if(size>1_000_000)throw new Error('Workflow template too large');
    // This confirms API structure and our required prompt slot, not that arbitrary
    // custom ComfyUI nodes are safe. Users must trust the workflow they import.
    prepareWorkflow(workflow,'validation prompt');
    await mkdir(this.templateDir,{recursive:true});
    try { await writeFile(join(this.templateDir,id+'.json'),JSON.stringify(workflow,null,2),{flag:'wx'}); }
    catch(error){if(error.code==='EEXIST')throw new Error('Template exists. Choose a different name.');throw error;}
    return {id};
  }
  async submit({templateId,prompt,negative=''}) {
    if(!SAFE_ID.test(templateId||''))throw new Error('Invalid workflow template');
    let source;
    try {source=await readFile(join(this.templateDir,templateId+'.json'),'utf8');}
    catch(err){if(err.code==='ENOENT')throw new Error('Workflow template not installed');throw err;}
    if(source.length>1_000_000)throw new Error('Workflow template too large');
    const graph=prepareWorkflow(JSON.parse(source),prompt,negative);
    const response=await this.fetch(this.url+'/prompt',{method:'POST',signal:AbortSignal.timeout(12000),headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:graph,client_id:randomUUID()})});
    if(!response.ok)throw new Error(`ComfyUI rejected workflow (${response.status}): ${(await response.text()).slice(0,400)}`);
    const data=await response.json();
    if(!SAFE_JOB.test(data.prompt_id||''))throw new Error('ComfyUI returned an invalid job ID');
    this.jobs.set(data.prompt_id, {templateId,at:Date.now()});
    while(this.jobs.size>100)this.jobs.delete(this.jobs.keys().next().value);
    return {jobId:data.prompt_id};
  }
  async history(jobId) {
    if(!SAFE_JOB.test(jobId||'') || !this.jobs.has(jobId))throw new Error('Unknown ComfyUI job');
    const response=await this.fetch(this.url+'/history/'+jobId,{signal:AbortSignal.timeout(5500)});
    if(!response.ok)throw new Error(`ComfyUI history HTTP ${response.status}`);
    const data=await response.json();const result=data[jobId];
    const images=[];
    for(const output of Object.values(result?.outputs||{}))for(const image of output.images||[]) {
      if(image.type !== 'output' || !SAFE_FILE.test(image.filename||'') || ['.','..'].includes(image.filename) ||
         (image.subfolder && (!SAFE_FILE.test(image.subfolder) || ['.','..'].includes(image.subfolder))))continue;
      images.push({filename:image.filename,subfolder:image.subfolder||'',type:'output'});
    }
    return {jobId,done:Boolean(result),images:images.slice(0,30),error:result?.status?.status_str==='error'};
  }
  async image(jobId,filename,subfolder='') {
    const {images}=await this.history(jobId);
    if(!images.some(i=>i.filename===filename && i.subfolder===subfolder))throw new Error('Image not part of this completed job');
    const url=this.url+'/view?'+new URLSearchParams({filename,subfolder,type:'output'});
    const response=await this.fetch(url,{signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error(`ComfyUI image HTTP ${response.status}`);
    const type=String(response.headers.get('content-type')||'').split(';')[0];
    if(!['image/png','image/jpeg','image/webp'].includes(type))throw new Error('Unexpected ComfyUI image format');
    const length=Number(response.headers.get('content-length')||0);
    if(length>24_000_000)throw new Error('Generated image too large');
    const bytes=Buffer.from(await response.arrayBuffer());
    if(bytes.length>24_000_000)throw new Error('Generated image too large');
    return {bytes,type};
  }
}
