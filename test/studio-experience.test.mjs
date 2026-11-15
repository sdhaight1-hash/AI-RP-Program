import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve,dirname } from 'node:path';
import { StudioStore } from '../storage.mjs';
import { createApp } from '../server.mjs';
import { WORKSPACE_META,visibleDetailTabs,searchStudioCommands } from '../public/studio-navigation.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const html=readFileSync(resolve(root,'public/index.html'),'utf8');
const css=readFileSync(resolve(root,'public/studio-shell.css'),'utf8');
const javascript=readFileSync(resolve(root,'public/app.js'),'utf8');
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]);

test('studio shell has unique IDs and preserves every required scene and authoring entry point',()=>{
  assert.equal(new Set(ids).size,ids.length,'duplicate DOM IDs break event wiring');
  const essentials=[
    'world-home','world-label','session-list','new-session','character-list','new-character',
    'scene-title','scene-meta','messages','message-input','send','stop','continue','regenerate',
    'channel-select','reading-toggle','quick-theme','export-data','import-data',
    'inspector','inspector-content','scene-canvas','stage-name','stage-avatar','stage-portrait',
    'workspace-overview','workspace-title','workspace-content','top-world-name',
    'inspector-scrim','open-inspector','open-workspace-inspector','close-inspector','expand-inspector',
    'character-builder','builder-title','builder-fields','builder-portrait','builder-world-bridge',
    'builder-world-items','builder-world-links','builder-world-links-refresh',
    'builder-ai-target','builder-ai-generate','builder-ai-stop','builder-ai-result','builder-ai-apply',
    'builder-progress-label','builder-progress-track','builder-progress-fill','builder-world-context',
    'world-launcher','world-launcher-list','world-launcher-create','world-filter','world-list-count',
    'new-scene-dialog','new-scene-character','new-scene-confirm',
    'command-palette','open-command','command-close','command-search','command-items'
  ];
  for(const id of essentials)assert.ok(ids.includes(id),'Missing existing or new control: '+id);
});

test('redesigned HTML preserves every existing static DOM target referenced by the application',()=>{
  const declared=new Set([
    ...ids,
    ...[...javascript.matchAll(/\\bid="([^"]+)"/g)].map(x=>x[1]),
    ...[...javascript.matchAll(/\\.id\\s*=\\s*['"]([^'"]+)['"]/g)].map(x=>x[1])
  ]);
  const accessed=[...new Set([...javascript.matchAll(/\\$\\(['"]([^'"]+)['"]\\)/g)].map(x=>x[1]))];
  const missing=accessed.filter(id=>!declared.has(id));
  assert.deepEqual(missing,[],
    'A removed or renamed static shell element would break an existing feature: '+missing.join(', '));
});

test('every major workspace and all thirteen functional detail desk tools remain reachable',()=>{
  const workspaces=[...html.matchAll(/<button\b[^>]*data-workspace="([^"]+)"/g)].map(x=>x[1]);
  assert.deepEqual(workspaces,['world','characters','encounters','story','memory','tools']);
  const expected=['worlds','atlas','relations','character','cast','emotion',
    'scene','lore','memory','context','gallery','library','setup'];
  const tabs=[...html.matchAll(/<button\b[^>]*data-tab="([^"]+)"/g)].map(x=>x[1]);
  assert.deepEqual(tabs,expected);
  for(const mode of workspaces)
    assert.ok(Object.hasOwn(WORKSPACE_META,mode),'Missing dashboard descriptor: '+mode);
  assert.match(javascript,/function setWorkspace\(mode\)/);
  assert.match(javascript,/function openDetailDesk\(tab\)/);
  assert.match(javascript,/button\[data-workspace\]/);
  assert.match(javascript,/body\.dataset\.workspace=mode/);
  assert.match(javascript,/function renderWorkspace\(\)/);
});

test('responsive navigation exposes an explicit drawer close and focused editor without losing source guards',()=>{
  assert.match(css,/@media\(max-width:1100px\)/);
  assert.match(css,/@media\(max-width:760px\)/);
  assert.match(css,/prefers-reduced-motion/);
  assert.match(css,/body\.detail-focus \.inspector/);
  assert.match(css,/builder-dialog\[open\]/);
  assert.match(javascript,/setDetailDeskOpen\(false\)/);
  assert.match(javascript,/updateBuilderContext\(c\)/);
  assert.match(html,/aria-controls="inspector"/);
  assert.match(html,/role="progressbar"/);
  assert.match(css,/:focus-visible/);
});

test('quick navigation keeps every workspace, editor and primary creator action discoverable',()=>{
  assert.match(html,/id="open-command"/);
  assert.match(html,/aria-keyshortcuts="Control\+K Meta\+K"/);
  assert.match(javascript,/function openStudioCommands\(\)/);
  assert.match(javascript,/function renderStudioCommands\(\)/);
  assert.match(javascript,/command-search/);
  assert.match(javascript,/event\.ctrlKey\|\|event\.metaKey/);
  for(const feature of [
    'World & canon','Characters','Story room','Memory & review','Models & lab',
    'World Library & timelines','Atlas & places','World relationships',
    'Scene direction & event review','Authored lore','Actor memory trace',
    'Character Studio · edit active character','Character Fidelity Lab',
    'Local model setup','Create a character','Start a new scene'
  ])assert.ok(javascript.includes(feature),'Command not discoverable: '+feature);
  assert.match(css,/\.command-palette/);
  assert.match(css,/\.command-item\.selected/);
});

test('new stylesheet and current app are served from the real allowlisted local server',async()=>{
  const store=new StudioStore(':memory:');
  const server=createApp({store,fetchImpl:async()=>{throw Error('No inference required')}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const base='http://127.0.0.1:'+server.address().port;
    const page=await fetch(base+'/');
    assert.equal(page.status,200);
    assert.match(await page.text(),/href="\/studio-shell\.css"/);
    const sheet=await fetch(base+'/studio-shell.css');
    assert.equal(sheet.status,200);
    assert.match(sheet.headers.get('content-type'),/text\/css/);
    assert.match(await sheet.text(),/workspace-stat-grid/);
    const app=await fetch(base+'/app.js');
    assert.equal(app.status,200);
    assert.match(await app.text(),/function renderWorkspace/);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('navigation search is deterministic, bounded and works without DOM state',()=>{
  const commands=[
    {label:'World Atlas',detail:'World',keywords:'places map'},
    {label:'Actor memory',detail:'Memory',keywords:'recall private'},
    {label:'Fidelity Lab',detail:'Tools',keywords:'model testing'}
  ];
  assert.deepEqual(searchStudioCommands(commands,'ATLAS map').map(x=>x.label),['World Atlas']);
  assert.deepEqual(searchStudioCommands(commands,'private').map(x=>x.label),['Actor memory']);
  assert.deepEqual(searchStudioCommands(commands,'unrelated'),[]);
  assert.equal(searchStudioCommands(commands,'',2).length,2);
  assert.deepEqual(Object.keys(WORKSPACE_META),['world','characters','encounters','story','memory','tools']);
});


test('new encounter workspace is reachable without hunting through world inspector tabs',()=>{
  assert.match(javascript,/renderEncounterStudio\(host/);
  assert.match(javascript,/openEncounterManager\(/);
  assert.match(javascript,/Manage linked encounters/);
  assert.match(html,/data-workspace="encounters"/);
  assert.match(html,/id="new-scene-channel"/);
  assert.match(html,/id="new-scene-manage-encounters"/);
  assert.ok(visibleDetailTabs('world').includes('atlas'));
  assert.ok(visibleDetailTabs('characters').includes('library'));
  assert.ok(!visibleDetailTabs('story').includes('setup'));
  assert.match(css,/\.encounter-layout/);
  assert.match(css,/grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.ok(ids.includes('detail-error')&&ids.includes('error'));
  assert.match(javascript,/\['error','detail-error'\]/);
  assert.match(css,/\.detail-error/);
});


test('world editors are independently served and available inline, not bound to the hidden inspector',async()=>{
  assert.match(javascript,/renderAtlasPanel\(editor,scene\)/);
  assert.match(javascript,/renderRelationsPanel\(editor\)/);
  assert.match(javascript,/worldEditorView='overview'/);
  assert.match(javascript,/world-editor-nav/);
  assert.match(css,/\.world-editor-content/);
  const store=new StudioStore(':memory:');
  const app=createApp({store,fetchImpl:async()=>{throw Error('Offline testing only');}});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  try{
    const r=await fetch('http://127.0.0.1:'+app.address().port+'/world-editors.mjs');
    assert.equal(r.status,200);
    assert.match(r.headers.get('content-type'),/javascript/);
    const module=await r.text();
    assert.match(module,/export function renderAtlasPanel/);
    assert.match(module,/export function renderRelationsPanel/);
    assert.match(module,/permanentlyDeleteWorldEntry/);
  }finally{await new Promise(resolve=>app.close(resolve));}
});
