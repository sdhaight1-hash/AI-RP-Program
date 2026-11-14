import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve,dirname } from 'node:path';
import { StudioStore } from '../storage.mjs';
import { createApp } from '../server.mjs';

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
    'new-scene-dialog','new-scene-character','new-scene-confirm'
  ];
  for(const id of essentials)assert.ok(ids.includes(id),'Missing existing or new control: '+id);
});

test('every major workspace and all thirteen functional detail desk tools remain reachable',()=>{
  const workspaces=[...html.matchAll(/<button\b[^>]*data-workspace="([^"]+)"/g)].map(x=>x[1]);
  assert.deepEqual(workspaces,['world','characters','story','memory','tools']);
  const expected=['worlds','atlas','relations','character','cast','emotion',
    'scene','lore','memory','context','gallery','library','setup'];
  const tabs=[...html.matchAll(/<button\b[^>]*data-tab="([^"]+)"/g)].map(x=>x[1]);
  assert.deepEqual(tabs,expected);
  for(const mode of workspaces)
    assert.ok(javascript.includes(mode+':{name:'),'Missing dashboard descriptor: '+mode);
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
