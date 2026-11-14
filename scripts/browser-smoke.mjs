// Browser-level UI regression, no npm/browser automation dependency.
// GitHub's Ubuntu runner ships Chrome and ChromeDriver; run manually with
// `npm run test:browser` where ChromeDriver is installed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync,mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { WorldPartitionStore } from '../world/partition-store.mjs';
import { createApp } from '../server.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function openPort(){
  const server=createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}
const driverBinary=()=>{
  const configured=process.env.CHROMEWEBDRIVER;
  if(!configured)return 'chromedriver';
  const inDirectory=join(configured,'chromedriver');
  return existsSync(inDirectory)?inDirectory:configured;
};
async function main(){
  const workDir=mkdtempSync(join(tmpdir(),'rp-browser-smoke-'));
  const store=new WorldPartitionStore(join(workDir,'worlds'));
  const server=createApp({store,fetchImpl:async()=>{throw Error('Offline local model expected in browser QA')}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const driverPort=await openPort();
  const chrome=spawn(driverBinary(),['--port='+driverPort],{stdio:['ignore','pipe','pipe']});
  let driverLog='';
  chrome.stderr.on('data',chunk=>driverLog=(driverLog+chunk.toString()).slice(-5000));
  chrome.stdout.on('data',chunk=>driverLog=(driverLog+chunk.toString()).slice(-5000));
  const endpoint='http://127.0.0.1:'+driverPort;
  let sessionId;
  const request=async(method,path,body)=>{
    const response=await fetch(endpoint+path,{
      method,headers:{'Content-Type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)})
    });
    const result=await response.json();
    if(!response.ok||result.value?.error)throw Error('WebDriver '+path+': '+JSON.stringify(result.value).slice(0,650));
    return result.value;
  };
  async function until(check,label,timeout=12000){
    const start=Date.now();
    while(Date.now()-start<timeout){
      try{if(await check())return;}
      catch{}
      await delay(120);
    }
    throw Error('Timed out waiting for '+label);
  }
  const script=async source=>request('POST','/session/'+sessionId+'/execute/sync',{script:source,args:[]});
  const screenshot=async name=>{
    const b64=await request('GET','/session/'+sessionId+'/screenshot');
    mkdirSync('artifacts/ui-review',{recursive:true});
    writeFileSync('artifacts/ui-review/'+name+'.png',Buffer.from(b64,'base64'));
  };
  const size=async(width,height=900)=>request('POST','/session/'+sessionId+'/window/rect',{width,height});
  try{
    await until(async()=>{
      const response=await fetch(endpoint+'/status');return response.ok;
    },'ChromeDriver start');
    const session=await request('POST','/session',{capabilities:{alwaysMatch:{
      browserName:'chrome',
      'goog:chromeOptions':{args:[
        '--headless=new','--no-sandbox','--disable-dev-shm-usage',
        '--hide-scrollbars','--disable-background-networking',
        '--window-size=1440,900'
      ]}
    }}});
    sessionId=session.sessionId;
    await request('POST','/session/'+sessionId+'/url',{url:base});
    await until(async()=>script("return document.querySelector('#world-label')?.textContent?.includes('My First World')"),'world UI bootstrap');
    assert.equal(await script("return document.body.dataset.workspace"),'story');
    assert.ok(await script("return !!document.querySelector('#messages') && !!document.querySelector('#send')"));
    await screenshot('01-story-desktop');

    const world=await script(`
      document.querySelector('button[data-workspace="world"]').click();
      return {workspace:document.body.dataset.workspace,visible:getComputedStyle(
        document.querySelector('#workspace-overview')).display!=='none',
        sceneHidden:getComputedStyle(document.querySelector('#messages')).display==='none',
        cards:document.querySelectorAll('.workspace-card').length,
        selected:document.querySelector('[data-workspace="world"]').getAttribute('aria-pressed')};
    `);
    assert.deepEqual(world,{workspace:'world',visible:true,sceneHidden:true,cards:4,selected:'true'});
    await screenshot('02-world-overview');

    const focused=await script(`
      document.querySelector('.workspace-card.featured button').click();
      return {focus:document.body.classList.contains('detail-focus'),
        width:document.querySelector('#inspector').getBoundingClientRect().width,
        active:document.querySelector('[data-tab="worlds"]').classList.contains('active')};
    `);
    assert.equal(focused.focus,true);
    assert.equal(focused.active,true);
    assert.ok(focused.width>=600,'Atlas editor should expand beyond the original 338px detail column');
    await screenshot('03-focused-world-editor');
    assert.equal(await script("document.querySelector('#close-inspector').click();return document.body.classList.contains('detail-focus')"),false);

    assert.equal(await script(`
      document.querySelector('#open-command').click();
      document.querySelector('#command-search').value='atlas';
      document.querySelector('#command-search').dispatchEvent(new Event('input',{bubbles:true}));
      const choices=[...document.querySelectorAll('.command-item')].map(x=>x.textContent);
      document.querySelector('.command-item').click();
      return choices.some(x=>x.includes('Atlas'))&&!document.querySelector('#command-palette').open&&
        document.body.dataset.workspace==='world'&&document.body.classList.contains('detail-focus');
    `),true,'command palette should navigate into the real Atlas editor');
    await script("document.querySelector('#close-inspector').click();document.querySelector('button[data-workspace="characters"]').click();return true");
    assert.equal(await script("return document.querySelector('#workspace-title').textContent"),'People with lives beyond the scene');
    await screenshot('04-character-workspace');

    await script(`
      document.querySelector('button[data-workspace="story"]').click();
      document.querySelector('#new-character').click();
      return true;
    `);
    assert.equal(await script(`return document.querySelector('#character-builder').open&&
      document.querySelector('#builder-progress-label').textContent.includes('character fields')&&
      document.querySelector('#builder-world-context').textContent.includes('WORLD CONTEXT')`),true);
    await screenshot('05-character-workshop');
    await script("document.querySelector('#builder-close').click();return true");
    assert.equal(await script("return document.body.dataset.workspace"),'story');
    await screenshot('06-story-with-character');

    for(const width of [900,720,390]){
      await size(width,width===390?760:850);
      await delay(130);
      const view=await script(`
        return {width:window.innerWidth,bodyWidth:document.documentElement.scrollWidth,
          workspaceNav:getComputedStyle(document.querySelector('.workspace-nav')).display,
          composer:getComputedStyle(document.querySelector('.composer-area')).display};
      `);
      assert.ok(view.bodyWidth<=view.width+8,'Horizontal overflow at '+width+'px: '+JSON.stringify(view));
      assert.notEqual(view.workspaceNav,'none');
      assert.notEqual(view.composer,'none');
      await screenshot('07-story-'+width);
      if(width===900){
        const opened=await script(`
          document.querySelector('#open-workspace-inspector').click();
          return document.querySelector('#inspector').classList.contains('inspector-open')&&
            !document.querySelector('#inspector-scrim').classList.contains('hidden');
        `);
        assert.ok(opened,'responsive detail desk should open as a dismissible drawer');
        await script("document.querySelector('#close-inspector').click();return true");
      }
    }
    console.log('Browser UI smoke: desktop, focused editors, command palette, character workshop, and 3 responsive widths passed.');
  }finally{
    if(sessionId)await request('DELETE','/session/'+sessionId).catch(()=>{});
    chrome.kill('SIGTERM');
    await new Promise(resolve=>server.close(resolve));
    rmSync(workDir,{recursive:true,force:true});
    if(chrome.exitCode&&chrome.exitCode!==0&& !sessionId)console.error(driverLog);
  }
}
main().catch(error=>{console.error(error);process.exitCode=1});
