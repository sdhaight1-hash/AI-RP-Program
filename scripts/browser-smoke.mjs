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
  let modelAvailable=false;
  const browserReply='Ticketed NPC reply committed from the local-model stream.';
  const server=createApp({store,fetchImpl:async url=>{
    if(!modelAvailable)throw Error('Offline local model expected in browser QA');
    const target=String(url);
    if(target.endsWith('/models'))return Response.json({data:[{id:'browser-leased-model'}]});
    if(target.endsWith('/api/extra/true_max_context_length'))return Response.json({value:4096});
    if(target.endsWith('/api/extra/tokencount'))return Response.json({value:400});
    if(target.endsWith('/chat/completions'))
      return new Response('data: '+JSON.stringify({choices:[{delta:{content:browserReply}}]})+'\\n\\ndata: [DONE]\\n\\n');
    throw Error('Unexpected local model probe: '+target);
  }});
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
    await delay(650);
    const startup=await script(`return {
      ready:document.readyState,
      world:document.querySelector('#world-label')?.textContent,
      worldTop:document.querySelector('#top-world-name')?.textContent,
      error:document.querySelector('#error')?.textContent,
      title:document.title,
      resources:performance.getEntriesByType('resource').map(x=>x.name.split('/').at(-1))
    }`);
    console.log('Browser startup diagnostics:',JSON.stringify(startup));
    await screenshot('00-startup');
    await until(async()=>script("return document.querySelector('#world-label')?.textContent?.trim() && !document.querySelector('#world-label').textContent.includes('Loading')"),'world UI bootstrap',7000);
    // The first-run world launcher is modal. Close it explicitly before
    // exercising navigation controls behind the dialog.
    if(await script("return document.querySelector('#world-launcher').open")){
      await script("document.querySelector('#world-launcher-close').click();return true");
    }
    assert.equal(await script("return document.body.dataset.workspace"),'story');
    assert.ok(await script("return !!document.querySelector('#messages') && !!document.querySelector('#send')"));
    await screenshot('01-story-desktop');

    const world=await script(`
      document.querySelector('button[data-workspace="world"]').click();
      return {workspace:document.body.dataset.workspace,visible:getComputedStyle(
        document.querySelector('#workspace-overview')).display!=='none',
        sceneHidden:getComputedStyle(document.querySelector('#messages')).display==='none',
        cards:document.querySelectorAll('.workspace-card').length,
        selected:document.querySelector('button[data-workspace="world"]').getAttribute('aria-pressed')};
    `);
    assert.deepEqual(world,{workspace:'world',visible:true,sceneHidden:true,cards:4,selected:'true'});
    await screenshot('02-world-overview');

    for(const [workspace,title,filename] of [
      ['memory','What each character can remember','02a-memory-overview'],
      ['tools','Your private creative toolkit','02b-tools-overview']
    ]){
      const found=await script(`
        document.querySelector('button[data-workspace="${workspace}"]').click();
        return document.querySelector('#workspace-title').textContent;
      `);
      assert.equal(found,title);
      await screenshot(filename);
    }
    await script(`document.querySelector('button[data-workspace="world"]').click();return true`);

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
    await script(`document.querySelector('#close-inspector').click();document.querySelector('button[data-workspace="characters"]').click();return true`);
    assert.equal(await script("return document.querySelector('#workspace-title').textContent"),'People with lives beyond the scene');
    await screenshot('04-character-workspace');

    const priorCharacterSnapshot=(await(await fetch(base+'/api/state')).json()).state;
    const sceneCountBeforeCharacter=priorCharacterSnapshot.sessions.length;
    const characterCountBeforeCharacter=priorCharacterSnapshot.characters.length;
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
    assert.equal(await script("return document.body.dataset.workspace"),'characters',
      'Creating a profile must not automatically create an unrelated scene');
    await until(async()=>{
      const snapshot=(await(await fetch(base+'/api/state')).json()).state;
      return snapshot.characters.length===characterCountBeforeCharacter+1;
    },'profile saved independently of any new scene');
    assert.equal((await(await fetch(base+'/api/state')).json()).state.sessions.length,
      sceneCountBeforeCharacter,'creating character must not create a scene in SQLite');
    await screenshot('06-character-created-without-auto-scene');
    assert.equal(await script(`
      const button=[...document.querySelectorAll('.workspace-card button')]
        .find(x=>x.textContent==='Open active character');
      if(!button)return false;
      button.click();
      const name=document.querySelector('#builder-name')?.value;
      document.querySelector('#builder-close').click();
      return name==='New character';
    `),true,'character workspace must keep its selected draft instead of jumping back to the active scene NPC');
    await script("document.querySelector('button[data-workspace=story]').click();return true");
    const previousTheme=await script("return document.querySelector('#quick-theme').value");
    assert.equal(await script(`
      const theme=document.querySelector('#quick-theme');
      theme.value='parchment';theme.dispatchEvent(new Event('change',{bubbles:true}));
      return document.documentElement.dataset.theme;
    `),'parchment');
    await screenshot('06b-parchment-story');
    await script(`
      const theme=document.querySelector('#quick-theme');
      theme.value=${JSON.stringify(previousTheme)};
      theme.dispatchEvent(new Event('change',{bubbles:true}));
      return true;
    `);

    // End-to-end encounter authoring: the main workspace, not a hidden
    // detail-desk subpanel, creates a social-media template and reuses its
    // configured medium for a new scene.
    assert.equal(await script(`
      document.querySelector('button[data-workspace="encounters"]').click();
      document.querySelector('#encounter-save').click();
      return !!document.querySelector('#error')?.textContent.includes('Enter a title') &&
        getComputedStyle(document.querySelector('#error')).display!=='none';
    `),true,'encounter validation errors must be visible outside the hidden story composer');
    assert.equal(await script(`
      document.querySelector('button[data-workspace="encounters"]').click();
      const title=document.querySelector('#encounter-title');
      title.value='Browser Social DM';
      document.querySelector('#encounter-channel').value='social_dm';
      document.querySelector('#encounter-opening').value='hey, online now?';
      document.querySelector('#encounter-save').click();
      return document.body.dataset.workspace==='encounters' &&
        document.querySelector('#workspace-title').textContent==='Encounters & communication';
    `),true,'Encounters must be a directly navigable world-level editor');
    await until(async()=>{
      const result=await fetch(base+'/api/state');
      const snapshot=await result.json();
      return snapshot.state.encounters.some(e=>e.title==='Browser Social DM'&&e.channelId==='social_dm');
    },'browser social encounter saved');
    await screenshot('06b-social-encounter-workspace');
    assert.equal(await script(`
      const row=[...document.querySelectorAll('.encounter-card')].find(card=>
        card.querySelector('strong')?.textContent==='Browser Social DM');
      if(!row)return false;
      const start=[...row.querySelectorAll('button')].find(x=>x.textContent==='Start scene');
      if(!start)return false;
      start.click();
      return document.body.dataset.workspace==='story'&&
        document.querySelector('#channel-select').value==='social_dm';
    `),true,'starting the template must carry its social-media channel into the scene');
    await screenshot('06b-social-scene-started');
    assert.equal(await script(`
      document.querySelector('#continue').click();
      return document.body.dataset.workspace==='tools' &&
        document.querySelector('[data-tab="setup"]').classList.contains('active') &&
        getComputedStyle(document.querySelector('#error')).display!=='none' &&
        getComputedStyle(document.querySelector('#detail-error')).display!=='none' &&
        document.querySelector('#detail-error').textContent.includes('Choose a loaded local model');
    `),true,'an unconfigured model must navigate directly to visible Setup with global feedback');
    await script("document.querySelector('button[data-workspace=story]').click();return true");

    // Real headless browser tabs each retain their own selected world.
    // This catches browser/sessionStorage regressions that HTTP-only tests miss.
    const firstHandle=await request('GET','/session/'+sessionId+'/window');
    const parallel=store.worlds.createWorld({name:'Parallel Browser World'});
    const secondTab=await request('POST','/session/'+sessionId+'/window/new',{type:'tab'});
    await request('POST','/session/'+sessionId+'/window',{handle:secondTab.handle});
    await request('POST','/session/'+sessionId+'/url',{url:base});
    await until(async()=>script("return !!document.querySelector('#world-label')?.textContent"),'second tab bootstrap');
    await script("sessionStorage.setItem('ai-rp-selected-world',"+JSON.stringify(parallel.id)+");return true");
    await request('POST','/session/'+sessionId+'/refresh',{});
    await until(async()=>script("return document.querySelector('#world-label')?.textContent==='Parallel Browser World'"),'second tab world load');
    const secondLabel=await script("return {world:document.querySelector('#world-label')?.textContent,error:document.querySelector('#error')?.textContent}");
    assert.equal(secondLabel.world,'Parallel Browser World');
    assert.equal(secondLabel.error,'');
    await screenshot('06c-second-tab-separate-world');
    await request('POST','/session/'+sessionId+'/window',{handle:firstHandle});
    const firstLabel=await script("return document.querySelector('#world-label')?.textContent");
    assert.notEqual(firstLabel,'Parallel Browser World','the first tab must keep its own world');
    await request('POST','/session/'+sessionId+'/refresh',{});
    await until(async()=>script("return document.querySelector('#world-label')?.textContent==='My First World'"),'first tab world reload');
    await request('POST','/session/'+sessionId+'/window',{handle:secondTab.handle});
    await request('DELETE','/session/'+sessionId+'/window');
    await request('POST','/session/'+sessionId+'/window',{handle:firstHandle});


    // A real Character Studio input must persist in its own world database,
    // survive browser reload, and not appear in the other open world's story.
    const editableWorld=store.activeWorldId;
    const familyText='Her aunt Nessa ran the Lantern House near Seabrook.';
    const edited=await script(`
      document.querySelector('#new-character').click();
      document.querySelector('[data-builder-tab="history"]').click();
      const field=document.querySelector('#builder-familyHistory');
      field.value=${JSON.stringify(familyText)};
      field.dispatchEvent(new Event('input',{bubbles:true}));
      return {open:document.querySelector('#character-builder').open,value:field.value};
    `);
    assert.equal(edited.open,true);
    assert.equal(edited.value,familyText);
    await script("document.querySelector('#builder-close').click();return true");
    await until(async()=>{
      const response=await fetch(base+'/api/state?worldId='+encodeURIComponent(editableWorld));
      const story=await response.json();
      return story.state?.characters.some(c=>c.familyHistory===familyText);
    },'character field saved to original world');
    const otherWorldResponse=await fetch(base+'/api/state?worldId='+encodeURIComponent(parallel.id));
    const otherWorldState=await otherWorldResponse.json();
    assert.ok(!otherWorldState.state.characters.some(c=>c.familyHistory===familyText),
      'Character biography must not leak into the other world');
    await screenshot('06d-character-history-saved');
    await request('POST','/session/'+sessionId+'/refresh',{});
    await until(async()=>script("return document.querySelector('#world-label')?.textContent==='My First World'"),'world after character save reload');


    // The relationship codex must delete a real SQLite entry, not just hide a
    // client card or leave an orphaned world entity after refresh.
    const disposableName='Browser Deletion Regression Entity';
    await script(`
      document.querySelector('button[data-workspace="world"]').click();
      document.querySelector('[data-tab="relations"]').click();
      document.querySelector('#relations-entity-name').value=${JSON.stringify(disposableName)};
      document.querySelector('#relations-entity-kind').value='object';
      document.querySelector('#relations-add-entity').click();
      return true;
    `);
    await until(async()=>{
      const response=await fetch(base+'/api/worlds?worldId='+encodeURIComponent(editableWorld));
      const catalog=await response.json();
      return catalog.entities.some(x=>x.name===disposableName);
    },'browser world entity created');
    await screenshot('06e-world-entity-before-deletion');
    const deletedUi=await script(`
      window.confirm=()=>true;
      const card=[...document.querySelectorAll('#relations-list .lore-card')]
        .find(row=>row.querySelector('strong')?.textContent===${JSON.stringify(disposableName)});
      const button=card?.querySelector('button');
      if(!button)return false;
      button.click();
      return true;
    `);
    assert.equal(deletedUi,true,'relationship codex must expose a permanent entity delete');
    await until(async()=>{
      const response=await fetch(base+'/api/worlds?worldId='+encodeURIComponent(editableWorld));
      const catalog=await response.json();
      return !catalog.entities.some(x=>x.name===disposableName);
    },'browser world entity was purged from SQLite');
    await screenshot('06f-world-entity-after-deletion');
    assert.equal((await(await fetch(base+'/api/worlds?worldId='+encodeURIComponent(parallel.id))).json())
      .entities.some(x=>x.name===disposableName),false);
    await script("document.querySelector('button[data-workspace=story]').click();return true");

    // Exercise the exact archive → Trash → permanent-delete character flow in
    // Chrome, not just a direct HTTP request. The old bug left this profile's
    // world entity behind even after the character disappeared from the UI.
    const beforePurge=(await(await fetch(base+'/api/state?worldId='+encodeURIComponent(editableWorld))).json()).state;
    const existingCharacterIds=new Set(beforePurge.characters.map(c=>c.id));
    const existingSceneIds=new Set(beforePurge.sessions.map(scene=>scene.id));
    await script(`
      document.querySelector('#new-character').click();
      const name=document.querySelector('#builder-name');
      name.value='Browser Full Purge Target';
      name.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('#builder-close').click();
      const row=[...document.querySelectorAll('#character-list .character-row')]
        .find(item=>item.querySelector('strong')?.textContent==='Browser Full Purge Target');
      const start=row?.querySelector('button[title="Start scene with Browser Full Purge Target"]');
      if(!start)return false;
      start.click();
      window.confirm=()=>true;
      return true;
    `);
    let purgeTarget;
    await until(async()=>{
      const snapshot=await(await fetch(base+'/api/state?worldId='+encodeURIComponent(editableWorld))).json();
      const character=snapshot.state.characters.find(c=>!existingCharacterIds.has(c.id)&&c.name==='Browser Full Purge Target');
      const scene=snapshot.state.sessions.find(s=>!existingSceneIds.has(s.id)&&s.characterId===character?.id);
      if(!character||!scene)return false;
      purgeTarget={characterId:character.id,sceneId:scene.id,sceneTitle:scene.title};
      return true;
    },'browser disposable character and scene persisted');
    // Reproduce the real complaint: an archived character cannot be purged
    // because a hidden world template still references it. Encounters must
    // expose that template by name and offer a working return to Trash.
    await script(`
      document.querySelector('button[data-workspace="encounters"]').click();
      document.querySelector('#encounter-title').value='Browser Purge Blocker';
      document.querySelector('#encounter-character').value=${JSON.stringify(purgeTarget.characterId)};
      document.querySelector('#encounter-channel').value='video_call';
      document.querySelector('#encounter-premise').value='A camera call begins.';
      document.querySelector('#encounter-save').click();
      document.querySelector('button[data-workspace="story"]').click();
      return true;
    `);
    await until(async()=>{
      const snapshot=await(await fetch(base+'/api/state?worldId='+encodeURIComponent(editableWorld))).json();
      return snapshot.state.encounters.some(e=>e.title==='Browser Purge Blocker'&&
        e.characterIds.includes(purgeTarget.characterId)&&e.channelId==='video_call');
    },'blocking video encounter saved to world');
    await screenshot('06g-encounter-template-visible');

    const archivedUi=await script(`
      const archiveScene=document.querySelector('#session-list .session-row button[title="Move scene to Trash"]');
      if(!archiveScene)return false;
      archiveScene.click();
      const actorRow=[...document.querySelectorAll('#character-list .character-row')]
        .find(row=>row.querySelector('strong')?.textContent==='Browser Full Purge Target');
      const archiveActor=actorRow?.querySelector('button[title="Move Browser Full Purge Target to Trash"]');
      if(!archiveActor)return false;
      archiveActor.click();
      document.querySelector('[data-tab="library"]').click();
      return true;
    `);
    assert.equal(archivedUi,true,'both actor and dependent scene must be archivable');
    await until(async()=>{
      const snapshot=await(await fetch(base+'/api/state?worldId='+encodeURIComponent(editableWorld))).json();
      return snapshot.state.characters.some(c=>c.id===purgeTarget.characterId&&c.trashedAt)
        &&snapshot.state.sessions.some(s=>s.id===purgeTarget.sceneId&&s.trashedAt);
    },'browser archive saved before permanent purge');
    const scenePurgeClicked=await script(`
      const row=[...document.querySelectorAll('#library-trash .trash-row')]
        .find(item=>item.querySelector('span')?.textContent===
          'Scene: '+${JSON.stringify(purgeTarget.sceneTitle)});
      if(!row)return false;
      row.querySelector('button.mini-action').click();
      return true;
    `);
    assert.ok(scenePurgeClicked,'archived scene must have a permanent-delete action');
    await until(async()=>{
      const snapshot=await(await fetch(base+'/api/state?worldId='+encodeURIComponent(editableWorld))).json();
      return !snapshot.state.sessions.some(s=>s.id===purgeTarget.sceneId);
    },'scene permanent deletion committed');
    await until(async()=>script(`
      const rows=[...document.querySelectorAll('#library-trash .trash-row')];
      return !rows.some(row=>row.querySelector('span')?.textContent===
        'Scene: '+${JSON.stringify(purgeTarget.sceneTitle)})
        &&rows.some(row=>row.querySelector('span')?.textContent==='Character: Browser Full Purge Target');
    `),'Library refreshed after scene purge');
    assert.equal(await script(`
      const row=[...document.querySelectorAll('#library-trash .trash-row')]
        .find(item=>item.querySelector('span')?.textContent==='Character: Browser Full Purge Target');
      return !!row?.querySelector('.trash-dependency')?.textContent.includes('Browser Purge Blocker');
    `),true,'Trash must name the encounter template blocking permanent deletion');
    assert.equal(await script(`
      const row=[...document.querySelectorAll('#library-trash .trash-row')]
        .find(item=>item.querySelector('span')?.textContent==='Character: Browser Full Purge Target');
      row.querySelector('.trash-dependency button').click();
      return document.body.dataset.workspace==='encounters'&&
        document.querySelector('#encounter-title')?.value==='Browser Purge Blocker';
    `),true,'blocked character must link directly into the encounter editor');
    await screenshot('06h-encounter-blocker-editor');
    assert.equal(await script(`
      const row=[...document.querySelectorAll('.encounter-card')]
        .find(item=>item.querySelector('strong')?.textContent==='Browser Purge Blocker');
      if(!row)return false;
      [...row.querySelectorAll('button')].find(btn=>btn.textContent==='Delete').click();
      return true;
    `),true,'encounter editor must expose permanent template deletion');
    await until(async()=>{
      const snapshot=await(await fetch(base+'/api/state?worldId='+encodeURIComponent(editableWorld))).json();
      return !snapshot.state.encounters.some(e=>e.title==='Browser Purge Blocker');
    },'blocking encounter removed from world snapshot');
    assert.equal(await script(`
      const back=document.querySelector('#encounter-return-trash');
      if(!back)return false;
      back.click();
      return !!document.querySelector('#library-trash') &&
        document.body.dataset.workspace==='tools';
    `),true,'one-click return to Trash should be possible after cleanup');
    await screenshot('06i-deletion-blocker-resolved');
    const characterPurgeClicked=await script(`
      const row=[...document.querySelectorAll('#library-trash .trash-row')]
        .find(item=>item.querySelector('span')?.textContent==='Character: Browser Full Purge Target');
      if(!row)return false;
      row.querySelector('button.mini-action').click();
      return true;
    `);
    assert.ok(characterPurgeClicked,'archived character must have a permanent-delete action');
    await until(async()=>{
      const snapshot=await(await fetch(base+'/api/state?worldId='+encodeURIComponent(editableWorld))).json();
      const catalog=await(await fetch(base+'/api/worlds?worldId='+encodeURIComponent(editableWorld))).json();
      return !snapshot.state.characters.some(c=>c.id===purgeTarget.characterId)
        &&!catalog.entities.some(e=>e.sourceCharacterId===purgeTarget.characterId);
    },'character and world mirror permanent deletion committed');
    await screenshot('06j-character-and-scene-after-permanent-purge');
    await script("document.querySelector('button[data-workspace=story]').click();return true");

    for(const width of [900,720,390]){
      await size(width,width===390?760:850);
      await delay(130);
      const view=await script(`
        return {width:window.innerWidth,bodyWidth:document.documentElement.scrollWidth,
          workspaceNav:getComputedStyle(document.querySelector('.workspace-nav')).display,
          composer:getComputedStyle(document.querySelector('.composer-area')).display,
          navigation:[...document.querySelectorAll('button[data-workspace]')].map(node=>{
            const rect=node.getBoundingClientRect();
            return {left:rect.left,right:rect.right,top:rect.top,visible:getComputedStyle(node).display!=='none'};
          })};
      `);
      assert.ok(view.bodyWidth<=view.width+8,'Horizontal overflow at '+width+'px: '+JSON.stringify(view));
      assert.notEqual(view.workspaceNav,'none');
      assert.notEqual(view.composer,'none');
      if(width<=760){
        assert.equal(view.navigation.length,6);
        for(const [index,nav] of view.navigation.entries())
          assert.ok(nav.visible && nav.left>=-2 && nav.right<=view.width+2,
            'Mobile workspace '+index+' clipped at '+width+'px: '+JSON.stringify(view));
      }
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
    // The real browser must consume the server-owned rp_complete SSE trailer,
    // commit via /api/actor/reply/commit, and display canonical SQLite text.
    // Earlier smoke assertions deliberately ran with the model offline.
    await size(1440,900);
    modelAvailable=true;
    assert.equal(await script(`
      document.querySelector('button[data-workspace="tools"]').click();
      document.querySelector('[data-tab="setup"]').click();
      document.querySelector('#refresh-models').click();
      return true;
    `),true);
    await until(async()=>script(`
      return document.querySelector('#model-select')?.value==='browser-leased-model';
    `),'browser selected the available local mock model');
    await until(async()=>{
      const state=(await(await fetch(base+'/api/state?worldId='+encodeURIComponent(editableWorld))).json()).state;
      return state.settings.model==='browser-leased-model';
    },'model choice persisted before actor generation');
    await script(`
      document.querySelector('#close-inspector').click();
      document.querySelector('button[data-workspace="story"]').click();
      document.querySelector('#new-session').click();
      document.querySelector('#new-scene-confirm').click();
      return true;
    `);
    await until(async()=>script("return document.body.dataset.workspace==='story' && !!document.querySelector('#message-input')"),'live scene editor');
    await script(`
      document.querySelector('#message-input').value='Do you hear the character speaking?';
      document.querySelector('#send').click();
      return true;
    `);
    await until(async()=>{
      const state=(await(await fetch(base+'/api/state?worldId='+encodeURIComponent(editableWorld))).json()).state;
      return state.sessions.some(scene=>scene.messages.some(message=>
        message.role==='assistant'&&message.content===browserReply));
    },'browser generated reply committed via ticket',18000);
    assert.equal(await script(`
      return [...document.querySelectorAll('#messages .message-text')]
        .some(node=>node.textContent.includes('Ticketed NPC reply committed'));
    `),true,'browser must render the committed model response');
    await screenshot('08-ticketed-model-reply-committed');
    console.log('Browser UI smoke: deletion, responsive navigation, cross-world isolation, and server-ticketed NPC streaming commit passed.');
  }finally{
    if(sessionId)await request('DELETE','/session/'+sessionId).catch(()=>{});
    chrome.kill('SIGTERM');
    await new Promise(resolve=>server.close(resolve));
    rmSync(workDir,{recursive:true,force:true});
    if(chrome.exitCode&&chrome.exitCode!==0&& !sessionId)console.error(driverLog);
  }
}
main().catch(error=>{console.error(error);process.exitCode=1});
