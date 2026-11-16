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
  const newWorldDraft=JSON.stringify({description:'An independent harbor civilization shaped by seasonal trade.'});
  const locationDraft=JSON.stringify({name:'Browser AI Docks',description:'A salt-stained boat repair shed.'});
  const extractedSourceName=JSON.stringify({candidates:[{
    name:'Lantern House',kind:'other',
    quote:'Her aunt Nessa ran the Lantern House near Seabrook.'
  }]});
  const ongoingSceneDraft=JSON.stringify({direction:'Keep the harbor conversation grounded in Nessa’s independent decisions.'});
  const newSceneDraft=JSON.stringify({title:'Harbor Call at Dusk',
    direction:'The player calls Nessa about an unsigned harbor map.',
    atmosphere:'Muffled gull cries and a quiet electrical hum.',
    authorNote:'Keep the conversation grounded and exploratory.'});
  const worldProposal=JSON.stringify({entries:[{type:'entity',kind:'character',
    name:'Nessa',description:'The character’s aunt named in the saved family history.',
    sourceField:'familyHistory',
    sourceQuote:'Her aunt Nessa ran the Lantern House near Seabrook.'}]});
  const server=createApp({store,fetchImpl:async (url,options={})=>{
    if(!modelAvailable)throw Error('Offline local model expected in browser QA');
    const target=String(url);
    if(target.endsWith('/models'))return Response.json({data:[{id:'browser-leased-model'}]});
    if(target.endsWith('/api/extra/true_max_context_length'))return Response.json({value:4096});
    if(target.endsWith('/api/extra/tokencount'))return Response.json({value:400});
    if(target.endsWith('/chat/completions')){
      const payload=JSON.parse(options.body||'{}');
      const isWorld=String(payload.messages?.[0]?.content||'')
        .includes('OPTIONAL world-atlas additions');
      const system=String(payload.messages?.[0]?.content||'');
      const content=system.includes('Extract up to 5 explicitly named fictional places')?extractedSourceName:
        system.includes('ONE place inside an already established fictional world')?locationDraft:
        system.includes('NEW, isolated world')?newWorldDraft:
        system.includes('CURRENT direction of an ongoing')?ongoingSceneDraft:
        system.includes('STARTING CONFIGURATION')?newSceneDraft:
        isWorld?worldProposal:browserReply;
      return new Response('data: '+JSON.stringify({choices:[{delta:{content}}]})+'\n\ndata: [DONE]\n\n');
    }
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

    // Main-world inline Atlas and Relations editors must remain navigable,
    // persist real SQLite records, and never open the old overlay by default.
    const atlasName='Inline Atlas Browser Place';
    assert.equal(await script(`
      document.querySelector('[data-world-view="atlas"]').click();
      return !!document.querySelector('.world-editor-content #atlas-create') &&
        !!document.querySelector('[data-world-view="overview"]') &&
        !document.body.classList.contains('detail-focus');
    `),true,'World Places editor should be inline and retain section navigation');
    await script(`
      document.querySelector('#atlas-name').value=${JSON.stringify(atlasName)};
      document.querySelector('#atlas-kind').value='building';
      document.querySelector('#atlas-create').click();
      return true;
    `);
    await until(async()=>{
      const catalog=await(await fetch(base+'/api/worlds?worldId='+encodeURIComponent(store.activeWorldId))).json();
      return catalog.locations.some(l=>l.name===atlasName);
    },'inline Atlas place persisted');
    await until(async()=>script(`
      return document.querySelector('[data-world-view="atlas"]')?.getAttribute('aria-pressed')==='true' &&
        [...document.querySelectorAll('#atlas-places .lore-card strong')]
          .some(x=>x.textContent===${JSON.stringify(atlasName)});
    `),'inline Atlas refreshed with newly saved place');
    assert.equal(await script(`
      const card=[...document.querySelectorAll('#atlas-places .lore-card')]
        .find(x=>x.querySelector('strong')?.textContent===${JSON.stringify(atlasName)});
      return !!card?.querySelector('.entry-photo-gallery input[type="file"]')
        &&!!card?.querySelector('.entry-photo-gallery button');
    `),true,'Atlas photos must be attached to persisted place entries');
    await script(`
      const card=[...document.querySelectorAll('#atlas-places .lore-card')]
        .find(x=>x.querySelector('strong')?.textContent===${JSON.stringify(atlasName)});
      const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/+vXkAAAAASUVORK5CYII='),x=>x.charCodeAt(0));
      const file=new File([bytes],'atlas-reference.png',{type:'image/png'});
      const transfer=new DataTransfer();transfer.items.add(file);
      card.querySelector('.entry-photo-gallery input[type="file"]').files=transfer.files;
      card.querySelector('.entry-photo-gallery input[aria-label^="Caption"]').value='Local harbor reference';
      [...card.querySelectorAll('.entry-photo-gallery button')]
        .find(x=>x.textContent==='Add selected photos').click();
      return true;
    `);
    await until(async()=>store.worlds.list().photos.some(p=>p.entryType==='location'&&
      p.caption==='Local harbor reference'),'Atlas photo upload persisted in owning SQLite database');
    await until(async()=>script(`
      const row=[...document.querySelectorAll('#atlas-places .lore-card')]
        .find(x=>x.querySelector('strong')?.textContent===${JSON.stringify(atlasName)});
      return !!row?.querySelector('.entry-photo-gallery img[src^="/api/worlds/photos/"]');
    `),'Atlas gallery displays uploaded photo after refresh');
    await screenshot('02c1-inline-atlas-gallery');
    assert.equal(await script(`
      const row=[...document.querySelectorAll('#atlas-places .lore-card')]
        .find(x=>x.querySelector('strong')?.textContent===${JSON.stringify(atlasName)});
      const controls=row?.querySelector('.entry-photo-gallery');
      return !!controls?.querySelector('.entry-photo-drop-zone')
        &&!!controls?.querySelector('button')
        &&!!controls?.querySelector('.entry-photo-visibility');
    `),true,'gallery exposes drag-drop, cover, visibility and order controls');
    assert.equal(await script(`
      const row=[...document.querySelectorAll('#atlas-places .lore-card')]
        .find(x=>x.querySelector('strong')?.textContent===${JSON.stringify(atlasName)});
      const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/+vXkAAAAASUVORK5CYII='),x=>x.charCodeAt(0));
      const photo=new File([bytes],'dragged-photo.png',{type:'image/png'});
      const transfer=new DataTransfer();transfer.items.add(photo);
      row.querySelector('.entry-photo-drop-zone')
        .dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
      return true;
    `),true,'dropping a photo triggers an upload rather than only opening the file selector');
    await until(async()=>store.worlds.list().photos.filter(p=>p.entryType==='location'&&
      p.entryId===store.worlds.list().locations.find(x=>x.name===atlasName)?.id).length===2,
      'drag-and-drop photo appears as second entry media');
    await until(async()=>script(`
      const row=[...document.querySelectorAll('#atlas-places .lore-card')]
        .find(x=>x.querySelector('strong')?.textContent===${JSON.stringify(atlasName)});
      return row?.querySelectorAll('.entry-photo-item').length===2;
    `),'two photos appear after drag-and-drop');
    assert.equal(await script(`
      const row=[...document.querySelectorAll('#atlas-places .lore-card')]
        .find(x=>x.querySelector('strong')?.textContent===${JSON.stringify(atlasName)});
      const second=row?.querySelectorAll('.entry-photo-item')[1];
      const cover=[...second?.querySelectorAll('button')||[]]
        .find(x=>x.textContent==='Make cover');
      cover?.click();return !!cover;
    `),true,'user can choose the second photo as cover');
    await until(async()=>{
      const loc=store.worlds.list().locations.find(x=>x.name===atlasName);
      const photos=store.worlds.list().photos.filter(x=>x.entryId===loc?.id);
      return photos.length===2&&photos[1].isCover===1;
    },'cover selection persisted by stable photo ID');
    await until(async()=>script(`
      const row=[...document.querySelectorAll('#atlas-places .lore-card')]
        .find(x=>x.querySelector('strong')?.textContent===${JSON.stringify(atlasName)});
      return row?.querySelectorAll('.entry-photo-item')[0]?.querySelector('.entry-photo-visibility');
    `),'visibility control remains after cover refresh');
    await script(`
      const row=[...document.querySelectorAll('#atlas-places .lore-card')]
        .find(x=>x.querySelector('strong')?.textContent===${JSON.stringify(atlasName)});
      const select=row.querySelector('.entry-photo-item .entry-photo-visibility');
      select.value='spoiler';select.dispatchEvent(new Event('change',{bubbles:true}));
      return true;
    `);
    await until(async()=>{
      const loc=store.worlds.list().locations.find(x=>x.name===atlasName);
      return store.worlds.list().photos.some(x=>x.entryId===loc?.id&&x.visibility==='spoiler');
    },'spoiler visibility persists on selected photo');
    await screenshot('02c2-ordered-photos-and-spoiler-controls');

    await screenshot('02c-inline-atlas');

    const inlineEntityName='Inline Relations Test Entity';
    assert.equal(await script(`
      document.querySelector('[data-world-view="relations"]').click();
      return !!document.querySelector('.world-editor-content #relations-add-entity') &&
        !!document.querySelector('[data-world-view="atlas"]') &&
        !document.body.classList.contains('detail-focus');
    `),true,'World Relationships editor should be inline and retain section navigation');
    await script(`
      document.querySelector('#relations-entity-name').value=${JSON.stringify(inlineEntityName)};
      document.querySelector('#relations-entity-kind').value='organization';
      document.querySelector('#relations-add-entity').click();
      return true;
    `);
    await until(async()=>{
      const catalog=await(await fetch(base+'/api/worlds?worldId='+encodeURIComponent(store.activeWorldId))).json();
      return catalog.entities.some(e=>e.name===inlineEntityName);
    },'inline world entity persisted');
    await until(async()=>script(`
      return document.querySelector('[data-world-view="relations"]')?.getAttribute('aria-pressed')==='true' &&
        [...document.querySelectorAll('#relations-list .lore-card strong')]
          .some(x=>x.textContent===${JSON.stringify(inlineEntityName)});
    `),'inline Relations refreshed with newly saved entity');
    assert.equal(await script(`
      return !!document.querySelector('#relations-entity-kind option[value="culture"]')
        &&!!document.querySelector('#relations-entity-kind option[value="family"]')
        &&!!document.querySelector('#relations-entity-kind option[value="community"]')
        &&!!document.querySelector('.universe-mention-panel');
    `),true,'Worldbuilding editor must expose rich collective types and source-backed recommendations');
    assert.equal(await script(`
      const row=[...document.querySelectorAll('#relations-list .lore-card')]
        .find(x=>x.querySelector('strong')?.textContent===${JSON.stringify(inlineEntityName)});
      return !!row?.querySelector('.entry-photo-gallery input[type="file"]');
    `),true,'organizations, families, communities and cultures share entry photo galleries');
    await screenshot('02d-inline-relations');
    assert.equal(await script(`
      window.confirm=()=>true;
      const row=[...document.querySelectorAll('#relations-list .lore-card')]
        .find(x=>x.querySelector('strong')?.textContent===${JSON.stringify(inlineEntityName)});
      [...row.querySelectorAll('button')].find(b=>b.textContent==='Permanently delete entity')?.click();
      return !!row;
    `),true,'World inline entities must expose guarded deletion');
    await until(async()=>{
      const catalog=await(await fetch(base+'/api/worlds?worldId='+encodeURIComponent(store.activeWorldId))).json();
      return !catalog.entities.some(e=>e.name===inlineEntityName);
    },'inline world entity permanently deleted');
    assert.equal(await script(`
      document.querySelector('[data-world-view="overview"]').click();
      return document.querySelectorAll('.workspace-card').length===4 &&
        !document.querySelector('.world-editor-content');
    `),true,'World Overview should return without discarding editor state');

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

    const timelinesView=await script(`
      document.querySelector('.workspace-card.featured button').click();
      return {
        pane:document.body.dataset.worldPane,
        create:!!document.querySelector('.world-editor-content #world-create'),
        clock:!!document.querySelector('.world-editor-content #timeline-clock-save'),
        nav:!!document.querySelector('.world-editor-nav [data-world-view="overview"]'),
        focused:document.body.classList.contains('detail-focus')
      };
    `);
    assert.deepEqual(timelinesView,{pane:'timelines',create:true,clock:true,nav:true,focused:false},
      'World & timelines must be an inline editor, not a second focused overlay');
    const worldComposer=await script(`
      return {
        create:!!document.querySelector('.world-create-composer #world-create'),
        assistant:!!document.querySelector('.world-composer-assist .ai-authoring-panel'),
        library:!!document.querySelector('.world-existing-list #world-library-list'),
        administration:!!document.querySelector('.world-admin-tools #world-impact-preview'),
        columns:getComputedStyle(document.querySelector('.world-composer-layout')).gridTemplateColumns
      };
    `);
    assert.ok(worldComposer.create&&worldComposer.assistant&&worldComposer.library&&worldComposer.administration,
      'World creation, co-author, library and administration must be separate panels');
    // Editing universe identity must not allocate a replacement universe,
    // alter scene IDs, or change the user's active continuity.
    const initialUniverse=store.worlds.list().worlds.find(w=>w.id===store.activeWorldId);
    const initialWorldCount=store.worlds.list().worlds.length;
    assert.equal(await script(`
      const section=document.querySelector('#universe-identity-editor');
      const name=document.querySelector('#universe-edit-name');
      const description=document.querySelector('#universe-edit-description');
      if(!section||!name||!description)return false;
      name.value='Revised Browser Connical Universe';
      name.dispatchEvent(new Event('input',{bubbles:true}));
      description.value='A preserved continuity with a revised introductory foundation.';
      description.dispatchEvent(new Event('input',{bubbles:true}));
      return !document.querySelector('#universe-edit-save').disabled;
    `),true,'existing universe identity must be directly editable');
    await script("document.querySelector('#universe-edit-save').click();return true");
    await until(async()=>store.worlds.list().worlds.some(x=>x.id===initialUniverse.id&&
      x.name==='Revised Browser Connical Universe'),'universe rename persisted');
    assert.equal(store.worlds.list().worlds.length,initialWorldCount,
      'in-place revision cannot create another universe');
    assert.equal(store.activeWorldId,initialUniverse.id,
      'editing the universe must not switch or replace continuity');
    assert.equal(store.forWorld(initialUniverse.id).db.prepare(
      'SELECT name FROM worlds WHERE id=?').get(initialUniverse.id).name,'Revised Browser Connical Universe');
    // A universe blueprint changes only after the author explicitly saves it.
    const blueprintBefore=store.forWorld(initialUniverse.id).worlds.list().blueprint;
    assert.equal(await script(`
      const panel=document.querySelector('#universe-edit-blueprint');
      panel.open=true;
      const rules=document.querySelector('#edit-universe-rules');
      if(!rules)return false;
      rules.value='Magic cannot reverse an established historical event.';
      rules.dispatchEvent(new Event('input',{bubbles:true}));
      return !document.querySelector('#universe-blueprint-save').disabled;
    `),true,'structured universe rules are editable');
    assert.equal(store.forWorld(initialUniverse.id).worlds.list().blueprint.revision,
      blueprintBefore.revision,'typing blueprint fields never auto-commits');
    await script("document.querySelector('#universe-blueprint-save').click();return true");
    await until(async()=>store.forWorld(initialUniverse.id).worlds.list().blueprint.sections.rules
      .includes('Magic cannot reverse'),'universe blueprint rule persisted');
    assert.equal(store.forWorld(initialUniverse.id).worlds.list().blueprint.revision,
      blueprintBefore.revision+1);
    assert.equal(store.worlds.list().worlds.length,initialWorldCount,
      'blueprint editing cannot create a new universe');
    await screenshot('03c-reviewed-universe-blueprint');
    await screenshot('03b-in-place-universe-revision');
    assert.equal(await script(`
      return !!document.querySelector('#universe-photo-gallery .entry-photo-gallery input[type=file]');
    `),true,'existing universe identity supports visual references without creating another universe');
    assert.equal(await script(`
      const link=document.querySelector('#universe-export-sqlite');
      return !!link&&link.href.includes('/api/worlds/export?worldId=')
        &&link.textContent.includes('with photos');
    `),true,'full universe export is discoverable beside its photo gallery');
    await screenshot('03-world-timelines-editor');
    const beforeImpact=(await(await fetch(base+'/api/state?worldId='+
      encodeURIComponent(store.activeWorldId))).json()).revision;
    await script("document.querySelector('#world-impact-preview').click();return true");
    await until(async()=>script(`
      return document.querySelector('#world-impact-report')?.textContent
        .includes('Deletion is unavailable');
    `),'safe world deletion preview');
    assert.equal(await script(`
      return document.querySelector('#world-impact-report')?.textContent.includes('Scenes:')
        &&document.querySelector('#world-impact-report')?.textContent.includes('Blocked:');
    `),true,'world preview must report records and safety blockers without deleting');
    assert.equal((await(await fetch(base+'/api/state?worldId='+
      encodeURIComponent(store.activeWorldId))).json()).revision,beforeImpact,
      'deletion preview must not mutate SQLite');
    await screenshot('03a-read-only-world-impact');
    const timelineName='Browser Independent Timeline';
    await script(`
      document.querySelector('#timeline-new-name').value=${JSON.stringify(timelineName)};
      document.querySelector('#timeline-create').click();return true;
    `);
    let createdTimeline;
    await until(async()=>{
      const catalog=await(await fetch(base+'/api/worlds?worldId='+encodeURIComponent(store.activeWorldId))).json();
      createdTimeline=catalog.timelines.find(t=>t.worldId===store.activeWorldId&&t.name===timelineName);
      return !!createdTimeline;
    },'new timeline persisted within active world');
    await until(async()=>script(`
      return [...document.querySelector('#timeline-select')?.options||[]].some(
        x=>x.value===${JSON.stringify(createdTimeline.id)});
    `),'new timeline available in inline world editor');
    await script(`
      document.querySelector('#timeline-select').value=${JSON.stringify(createdTimeline.id)};
      document.querySelector('#timeline-clock-utc').value='2026-01-01T12:00';
      document.querySelector('#timeline-clock-zone').value='UTC';
      document.querySelector('#timeline-clock-save').click();return true;
    `);
    await until(async()=>{
      const catalog=await(await fetch(base+'/api/worlds?worldId='+encodeURIComponent(store.activeWorldId))).json();
      return catalog.clocks.some(c=>c.timelineId===createdTimeline.id&&c.isExplicit&&
        c.instantMs===Date.parse('2026-01-01T12:00:00Z')&&c.timeZone==='UTC');
    },'fictional timeline clock saved to SQLite');
    await screenshot('03a-timeline-clock-persisted');
    assert.equal(await script(`
      document.querySelector('.world-editor-nav [data-world-view="overview"]').click();
      return document.body.dataset.worldPane==='overview' &&
        document.querySelectorAll('.workspace-card').length===4;
    `),true,'return from timeline editor to World overview');

    const atlasCommandResult=await script(`
      document.querySelector('#open-command').click();
      document.querySelector('#command-search').value='atlas';
      document.querySelector('#command-search').dispatchEvent(new Event('input',{bubbles:true}));
      const choices=[...document.querySelectorAll('.command-item')].map(x=>x.textContent);
      document.querySelector('.command-item').click();
      return {choices,open:document.querySelector('#command-palette').open,
        workspace:document.body.dataset.workspace,pane:document.body.dataset.worldPane,
        editor:!!document.querySelector('.world-editor-content #atlas-create'),
        focus:document.body.classList.contains('detail-focus')};
    `);
    assert.ok(atlasCommandResult.choices.some(x=>x.includes('Atlas')) &&
      !atlasCommandResult.open && atlasCommandResult.workspace==='world' &&
      atlasCommandResult.pane==='atlas' && atlasCommandResult.editor &&
      !atlasCommandResult.focus,'command palette should navigate into inline Atlas');
    await script(`document.querySelector('button[data-workspace="characters"]').click();return true`);
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
    await until(async()=>script("return document.querySelector('#world-label')?.textContent==='Revised Browser Connical Universe'"),'first tab world reload');
    const firstTimelineCatalog=await(await fetch(base+'/api/worlds?worldId='+encodeURIComponent(store.activeWorldId))).json();
    const firstTimelineIds=firstTimelineCatalog.timelines
      .filter(t=>t.worldId===store.activeWorldId).map(t=>t.id).sort();
    const timelineChoices=await script(`
      document.querySelector('button[data-workspace="world"]').click();
      document.querySelector('.workspace-card.featured button').click();
      return [...document.querySelector('#timeline-select').options].map(x=>x.value).sort();
    `);
    assert.deepEqual(timelineChoices,firstTimelineIds,
      'first world must never offer a second world timeline for scene assignment or clock edits');
    await script("document.querySelector('button[data-workspace=story]').click();return true");
    await request('POST','/session/'+sessionId+'/window',{handle:secondTab.handle});
    await request('DELETE','/session/'+sessionId+'/window');
    await request('POST','/session/'+sessionId+'/window',{handle:firstHandle});


    // A real Character Studio input must persist in its own world database,
    // survive browser reload, and not appear in the other open world's story.
    const editableWorld=store.activeWorldId;
    const familyText='Her aunt Nessa ran the Lantern House near Seabrook. She visited Seabrook Pier. The Seabrook Guild organizes fairs.';
    const edited=await script(`
      document.querySelector('#new-character').click();
      document.querySelector('[data-builder-tab="history"]').click();
      const field=document.querySelector('#builder-familyHistory');
      field.value=${JSON.stringify(familyText)};
      field.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('[data-builder-tab="identity"]').click();
      const name=document.querySelector('#builder-name');
      name.value='Browser Source Review Character';
      name.dispatchEvent(new Event('input',{bubbles:true}));
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
    await until(async()=>script("return document.querySelector('#world-label')?.textContent==='Revised Browser Connical Universe'"),'world after character save reload');

    // The saved Character Studio family history is discoverable in Atlas,
    // and an explicitly reviewed entry retains its original source version.
    await script(`
      document.querySelector('button[data-workspace="world"]').click();
      document.querySelector('[data-tab="atlas"]').click();
      return true;
    `);
    await until(async()=>script(`
      return [...document.querySelectorAll('.universe-mention-item strong')]
        .some(x=>x.textContent==='Seabrook');
    `),'saved character family history indexed and recommended to Atlas');
    assert.equal(await script(`
      const row=[...document.querySelectorAll('.universe-mention-item')]
        .find(x=>x.querySelector('strong')?.textContent==='Seabrook');
      const evidenced=row?.textContent.includes('familyHistory');
      row?.querySelector('button')?.click();
      return evidenced && document.querySelector('#atlas-name')?.value==='Seabrook';
    `),true,'citation-backed recommendation must remain an explicit user choice');
    await script("document.querySelector('#atlas-create').click();return true");
    await until(async()=>{
      const catalog=await(await fetch(base+'/api/worlds?worldId='+encodeURIComponent(editableWorld))).json();
      const place=catalog.locations.find(x=>x.name==='Seabrook');
      return !!place&&catalog.entryProvenance?.some(p=>
        p.entryType==='location'&&p.entryId===place.id&&p.quote.includes('Seabrook'));
    },'reviewed Atlas candidate and its source proof persisted in SQLite');
    await screenshot('06d1-reviewed-family-source-atlas-entry');



    // An alias is a link to an existing canonical place, not a duplicate place.
    await until(async()=>script(`
      return [...document.querySelectorAll('.universe-mention-item strong')]
        .some(x=>x.textContent==='Seabrook Pier');
    `),'second sourced place recommendation available for resolution');
    assert.equal(await script(`
      const row=[...document.querySelectorAll('.universe-mention-item')]
        .find(x=>x.querySelector('strong')?.textContent==='Seabrook Pier');
      const picker=row?.querySelector('.universe-mention-link-target');
      if(!picker)return false;
      const target=[...picker.options].find(x=>x.textContent.startsWith('Seabrook ('));
      if(!target)return false;
      picker.value=target.value;
      [...row.querySelectorAll('button')].find(x=>x.textContent==='Link alias')?.click();
      return true;
    `),true,'Atlas offers explicit alias linking to existing canon');
    await until(async()=>{
      const catalog=await(await fetch(base+'/api/worlds?worldId='+encodeURIComponent(editableWorld))).json();
      const target=catalog.locations.find(x=>x.name==='Seabrook');
      return catalog.aliases?.some(a=>a.entryType==='location'&&
        a.alias==='Seabrook Pier'&&a.entryId===target?.id);
    },'verified place alias linked without allocating another location');
    await screenshot('06d2-alias-linked-in-atlas');

    // A group mention can be dismissed without creating canon, and should
    // disappear from this universe's discovery recommendations.
    await script("document.querySelector('[data-tab=relations]').click();return true");
    await until(async()=>script(`
      return [...document.querySelectorAll('.universe-mention-item strong')]
        .some(x=>x.textContent==='Seabrook Guild');
    `),'Character Studio social mentions available to Relationship Codex');
    assert.equal(await script(`
      const row=[...document.querySelectorAll('.universe-mention-item')]
        .find(x=>x.querySelector('strong')?.textContent==='Seabrook Guild');
      const dismiss=[...row?.querySelectorAll('button')||[]]
        .find(x=>x.textContent==='Dismiss mention');
      dismiss?.click();
      return !!dismiss;
    `),true,'social codex offers explicit source-backed dismissal');
    await until(async()=>{
      const url=base+'/api/worlds/discovery?worldId='+encodeURIComponent(editableWorld)+'&focus=groups';
      const found=await(await fetch(url)).json();
      return !found.suggestions?.some(x=>x.name==='Seabrook Guild');
    },'dismissed group mention removed from recommendations');
    await screenshot('06d3-dismissed-social-mention');
    assert.equal(await script(`
      const review=document.querySelector('.universe-claim-conflicts');
      if(!review?.querySelector('summary'))return false;
      review.open=true;
      return true;
    `),true,'Relations exposes optional, non-destructive claim conflict review');
    await until(async()=>script(`
      const review=document.querySelector('.universe-claim-conflicts');
      const status=review?.querySelector('[role="status"]')?.textContent||'';
      return status.includes('No conflicting explicit claims')||status.includes('potential discrepancies');
    `),'source-backed conflict review query completes in browser');
    await screenshot('06d4-claim-conflict-review');

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
      const button=[...card?.querySelectorAll('button')||[]].find(b=>b.textContent==='Permanently delete entity');
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

    // Exercise implicit source extraction only after the mock local model is
    // selected. Earlier world/deletion tests intentionally run offline.
    await script(`
      document.querySelector('#close-inspector')?.click();
      document.querySelector('button[data-workspace="world"]').click();
      document.querySelector('[data-tab="atlas"]').click();
      return true;
    `);
    // A name missed by the lexical place scanner can be extracted by an
    // opt-in local-model review of a selected, already-indexed family history.
    assert.equal(await script(`
      const panel=document.querySelector('.universe-mention-panel');
      const query=panel?.querySelector('.universe-mention-search');
      const details=panel?.querySelector('.universe-extract-panel');
      if(!query||!details)return false;
      query.value='Lantern House';query.dispatchEvent(new Event('input',{bubbles:true}));
      details.open=true;
      return true;
    `),true,'Atlas exposes optional local-model passage analysis');
    await until(async()=>script(`
      const select=document.querySelector('.universe-extract-source');
      return [...select?.options||[]].some(x=>x.textContent.includes('familyHistory'));
    `),'Character Studio family-history source found for opt-in extraction');
    assert.equal(await script(`
      const select=document.querySelector('.universe-extract-source');
      select.value=[...select.options].find(x=>x.textContent.includes('familyHistory')).value;
      select.dispatchEvent(new Event('change',{bubbles:true}));
      document.querySelector('.universe-extract-panel button')?.click();
      return true;
    `),true);
    await until(async()=>script(`
      return [...document.querySelectorAll('.universe-extract-panel .universe-mention-item strong')]
        .some(x=>x.textContent==='Lantern House');
    `),'source-quoted implicit location extracted with local model');
    assert.equal(await script(`
      const row=[...document.querySelectorAll('.universe-extract-panel .universe-mention-item')]
        .find(x=>x.querySelector('strong')?.textContent==='Lantern House');
      row?.querySelector('button')?.click();
      const set=document.querySelector('#atlas-name')?.value==='Lantern House';
      document.querySelector('#atlas-name').value='';
      return set;
    `),true,'local model extraction only fills reviewed editor and does not create canon');
    assert.equal(store.worlds.list().locations.some(x=>x.name==='Lantern House'),false,
      'unapproved local model names cannot write canon');
    await screenshot('07a-opt-in-model-source-extraction');

    // New-world generation is editable, reviewed, and cannot silently create canon.
    const countBeforeWorldDraft=store.worlds.list().worlds.length;
    await script(`
      document.querySelector('#close-inspector').click();
      document.querySelector('button[data-workspace="world"]').click();
      document.querySelector('[data-world-view="timelines"]').click();
      const name=document.querySelector('#world-new-name');
      name.value='Browser Saltlands';
      name.dispatchEvent(new Event('input',{bubbles:true}));
      const ai=document.querySelector('#world-ai-slot');
      const target=ai.querySelector('select[aria-label="AI generation focus"]');
      target.value='description';target.dispatchEvent(new Event('change'));
      ai.querySelector('.ai-draft-generate').click();
      return true;
    `);
    await until(async()=>script(`
      return document.querySelector('#world-ai-slot')?.querySelector('textarea[aria-label="Editable model JSON"]')
        ?.value.includes('independent harbor civilization');
    `),'new-world AI draft rendered for review');
    await script(`
      const ai=document.querySelector('#world-ai-slot');
      ai.querySelector('.ai-draft-apply').click();
      return true;
    `);
    assert.equal(await script(`
      return document.querySelector('#world-new-description').value;
    `),'An independent harbor civilization shaped by seasonal trade.');
    assert.equal(store.worlds.list().worlds.length,countBeforeWorldDraft,
      'AI approval must not create a world without separate Create world action');
    await screenshot('07b-ai-reviewed-new-world-draft');

    // Refreshing the catalog must not erase a typed, uncommitted world seed.
    await script(`
      document.querySelector('#timeline-new-name').value='Creation UI refresh test';
      document.querySelector('#timeline-create').click();
      return true;
    `);
    await until(async()=>{
      const catalog=await(await fetch(base+'/api/worlds?worldId='+encodeURIComponent(editableWorld))).json();
      return catalog.timelines.some(t=>t.worldId===editableWorld&&t.name==='Creation UI refresh test');
    },'timeline catalog refresh during world drafting');
    await until(async()=>script(`
      return document.querySelector('#world-new-name')?.value==='Browser Saltlands' &&
        document.querySelector('#world-new-description')?.value===
        'An independent harbor civilization shaped by seasonal trade.';
    `),'world creation inputs survive catalog re-render');
    assert.equal(store.worlds.list().worlds.length,countBeforeWorldDraft,
      'catalog refresh cannot commit an unapproved world');
    await screenshot('07b1-preserved-world-draft');

    // AI drafts an Atlas place against this world's existing locations;
    // reviewing the JSON alone must not create a persistent location.
    const locationBefore=store.worlds.list().locations.filter(x=>x.worldId===editableWorld).length;
    assert.equal(await script(`
      document.querySelector('[data-world-view="atlas"]').click();
      const ai=document.querySelector('#atlas-create').parentElement;
      document.querySelector('#atlas-kind').value='building';
      ai.querySelector('.ai-draft-generate').click();
      return true;
    `),true);
    await until(async()=>script(`
      return document.querySelector('#atlas-create')?.parentElement
        ?.querySelector('textarea[aria-label="Editable model JSON"]')
        ?.value.includes('Browser AI Docks');
    `),'Atlas model suggested location');
    assert.equal(store.worlds.list().locations.filter(x=>x.worldId===editableWorld).length,locationBefore,
      'model suggestions cannot create a place');
    assert.equal(await script(`
      document.querySelector('#atlas-create').parentElement.querySelector('.ai-draft-apply').click();
      return document.querySelector('#atlas-name').value==='Browser AI Docks'
        &&document.querySelector('#atlas-description').value==='A salt-stained boat repair shed.';
    `),true,'approving AI output only fills the Atlas location editor');
    assert.equal(store.worlds.list().locations.filter(x=>x.worldId===editableWorld).length,locationBefore);
    await script("document.querySelector('#atlas-create').click();return true");
    await until(async()=>{
      const catalog=await(await fetch(base+'/api/worlds?worldId='+encodeURIComponent(editableWorld))).json();
      return catalog.locations.some(x=>x.worldId===editableWorld&&x.name==='Browser AI Docks'&&
        x.description==='A salt-stained boat repair shed.');
    },'separately committed world-local Atlas location');
    const otherPlaces=(await(await fetch(base+'/api/worlds?worldId='+encodeURIComponent(parallel.id))).json()).locations;
    assert.ok(!otherPlaces.some(x=>x.name==='Browser AI Docks'),
      'new Atlas place must never leak into a different world');
    await screenshot('07d-reviewed-ai-atlas-place');

    // The Character Studio world bridge must retain human approval and source
    // provenance in an actual browser, not just a unit-test simulation.
    assert.equal(await script(`
      document.querySelector('#close-inspector').click();
      document.querySelector('button[data-workspace="characters"]').click();
      const row=[...document.querySelectorAll('#character-list .character-row')]
        .find(x=>x.querySelector('strong')?.textContent==='Browser Source Review Character');
      if(!row)return false;
      row.querySelector('button.character-item').click();
      return document.querySelector('#character-builder').open &&
        document.querySelector('#builder-familyHistory')===null;
    `),true,'open the existing world-bound source character');
    await script("document.querySelector('#builder-world-suggest').click();return true");
    await until(async()=>script(`
      return [...document.querySelectorAll('#builder-world-items .lore-card')]
        .some(x=>x.querySelector('input')?.value==='Nessa');
    `),'character-world source candidate in browser');
    assert.equal(await script(`
      const card=[...document.querySelectorAll('#builder-world-items .lore-card')]
        .find(x=>x.querySelector('input')?.value==='Nessa');
      if(!card)return false;
      const quote=card.querySelector('.help')?.textContent||'';
      if(!quote.includes('Her aunt Nessa ran the Lantern House'))return false;
      card.querySelector('button.primary-button').click();
      return true;
    `),true,'source-backed person requires explicit approval');
    await until(async()=>{
      const catalog=await(await fetch(base+'/api/worlds?worldId='+encodeURIComponent(editableWorld))).json();
      return catalog.entities.some(e=>e.worldId===editableWorld&&e.name==='Nessa'&&e.kind==='character');
    },'approved person entered only the intended World Atlas');
    await until(async()=>script(`
      return [...document.querySelectorAll('#builder-world-links .reviewed-link')]
        .some(x=>x.textContent.includes('Nessa')&&
          [...x.querySelectorAll('button')].some(b=>b.textContent.includes('Approve directed relationship')));
    `),'approved person exposes a relationship candidate');
    assert.equal(await script(`
      const card=[...document.querySelectorAll('#builder-world-links .reviewed-link')]
        .find(x=>x.textContent.includes('Nessa'));
      if(!card)return false;
      const selector=card.querySelector('select');
      if(selector?.value!=='aunt')return false;
      card.querySelector('button').click();
      return true;
    `),true,'approved biography explicitly supports an aunt relationship');
    await until(async()=>{
      const catalog=await(await fetch(base+'/api/worlds?worldId='+encodeURIComponent(editableWorld))).json();
      return catalog.relationships.some(edge=>edge.worldId===editableWorld&&edge.kind==='aunt');
    },'human-reviewed source relationship committed');
    const sourceCharacter=(await(await fetch(base+'/api/state?worldId='+encodeURIComponent(editableWorld))).json())
      .state.characters.find(c=>c.name==='Browser Source Review Character');
    const sourceResponse=await fetch(base+'/api/character/world-entries/sources?worldId='+
      encodeURIComponent(editableWorld)+'&characterId='+encodeURIComponent(sourceCharacter.id));
    assert.equal(sourceResponse.status,200);
    const sourceData=await sourceResponse.json();
    assert.ok(sourceData.sources.some(x=>x.entryName==='Nessa'&&x.relationshipId&&
      x.sourceQuote==='Her aunt Nessa ran the Lantern House near Seabrook.'));
    const otherCatalog=await(await fetch(base+'/api/worlds?worldId='+encodeURIComponent(parallel.id))).json();
    assert.ok(!otherCatalog.entities.some(x=>x.name==='Nessa'),
      'the approved person cannot leak to the second world');
    await screenshot('07a-reviewed-character-world-relationship');
    await script("document.querySelector('#builder-close').click();return true");
    await script(`
      document.querySelector('#close-inspector').click();
      document.querySelector('button[data-workspace="story"]').click();
      document.querySelector('#new-session').click();
      return document.querySelector('#new-scene-dialog').open;
    `);
    const composed=await script(`
      const dialog=document.querySelector('#new-scene-dialog');
      const parts=['scene-setup-panel','scene-draft-panel','scene-assist-panel'].every(name=>
        !!dialog.querySelector('.'+name));
      return {open:dialog.open,parts,footer:!!dialog.querySelector('.scene-composer-footer'),
        world:document.querySelector('#new-scene-world-context').textContent,
        context:document.querySelector('#new-scene-context-summary').textContent};
    `);
    assert.ok(composed.open&&composed.parts&&composed.footer,
      'Scene composition must clearly separate cast, writing and co-author');
    assert.ok(composed.world.length&&composed.context.length,'Scene setup should explain its active context');
    await screenshot('07c-new-scene-composer-desktop');
    await size(390,760);
    const narrow=await script(`
      const dialog=document.querySelector('#new-scene-dialog');
      const rect=dialog.getBoundingClientRect();
      const footer=dialog.querySelector('.scene-composer-footer').getBoundingClientRect();
      return {width:window.innerWidth,dialogWidth:rect.width,footerWidth:footer.width,
        bodyWidth:document.documentElement.scrollWidth,footerVisible:footer.top>=0&&footer.bottom<=window.innerHeight+5};
    `);
    assert.ok(narrow.dialogWidth<=narrow.width+3&&narrow.bodyWidth<=narrow.width+8&&narrow.footerVisible,
      'Mobile scene dialog must not overflow or hide creation actions: '+JSON.stringify(narrow));
    await screenshot('07d-new-scene-composer-mobile');
    await size(1440,900);
    await script(`
      const target=document.querySelector('#new-scene-ai-host select[aria-label="AI generation focus"]');
      if(!target)return false;
      document.querySelector('#new-scene-ai-host .ai-draft-generate').click();
      return true;
    `);
    await until(async()=>script(`
      return document.querySelector('#new-scene-ai-host textarea[aria-label="Editable model JSON"]')
        ?.value.includes('Harbor Call at Dusk');
    `),'scene AI draft rendered for review');
    assert.equal(await script(`
      document.querySelector('#new-scene-draft-title').value;
      const apply=document.querySelector('#new-scene-ai-host .ai-draft-apply');
      apply.click();
      return document.querySelector('#new-scene-draft-title').value==='Harbor Call at Dusk'
        &&document.querySelector('#new-scene-draft-direction').value.includes('unsigned harbor map');
    `),true,'reviewed scene AI must populate editable fields');
    const scenesBeforeStart=(await(await fetch(base+'/api/state?worldId='+
      encodeURIComponent(editableWorld))).json()).state.sessions.length;
    const locked=await script(`
      const button=document.querySelector('#new-scene-confirm');
      button.click();button.click();
      return button.disabled &&
        document.querySelector('#new-scene-cancel').disabled;
    `);
    assert.equal(locked,true,'Scene creation is locked during the SQLite commit');
    await until(async()=>script("return !document.querySelector('#new-scene-dialog').open"),'scene dialog closed only after durable save');
    await until(async()=>script("return document.body.dataset.workspace==='story' && !!document.querySelector('#message-input')"),'live scene editor');
    await until(async()=>{
      const state=(await(await fetch(base+'/api/state?worldId='+encodeURIComponent(editableWorld))).json()).state;
      return state.sessions.some(scene=>scene.title==='Harbor Call at Dusk');
    },'reviewed scene foundation persisted before model dialogue');
    const reviewedScene=(await(await fetch(base+'/api/state?worldId='+encodeURIComponent(editableWorld))).json()).state
      .sessions.find(scene=>scene.title==='Harbor Call at Dusk');
    assert.ok(reviewedScene,'reviewed title must be part of the created scene');
    assert.equal((await(await fetch(base+'/api/state?worldId='+encodeURIComponent(editableWorld))).json()).state.sessions.length,
      scenesBeforeStart+1,'rapid double submission cannot create two scenes');
    assert.equal(reviewedScene.direction,'The player calls Nessa about an unsigned harbor map.');
    assert.equal(reviewedScene.atmosphere,'Muffled gull cries and a quiet electrical hum.');
    assert.equal(reviewedScene.authorNote,'Keep the conversation grounded and exploratory.');
    assert.equal(reviewedScene.messages.length,0,'scene AI must not insert synthetic NPC dialogue');
    await screenshot('07c-ai-reviewed-scene-created');
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

    // Actor memory review uses actual witnessed source IDs, never the other
    // world's dialogue. Creating a subjective fact cannot mutate world canon.
    const witnessedState=(await(await fetch(base+'/api/state?worldId='+
      encodeURIComponent(editableWorld))).json()).state;
    const witnessedScene=witnessedState.sessions.find(scene=>
      scene.messages.some(m=>m.role==='assistant'&&m.content===browserReply));
    const witnessedPlayer=witnessedScene.messages.find(m=>m.role==='user'&&
      m.content==='Do you hear the character speaking?');
    const witnessedActor=witnessedScene.speakerId||witnessedScene.characterId;
    assert.ok(witnessedPlayer?.id,'the actor fact must cite a real message ID');
    await script(`
      document.querySelector('button[data-workspace="memory"]').click();
      document.querySelector('[data-tab="context"]').click();
      return true;
    `);
    await until(async()=>script("return !!document.querySelector('#fact-source') && !!document.querySelector('#context-text')"),
      'server-assembled actor context and witnessed source picker');
    assert.equal(await script(`
      return [...document.querySelector('#fact-source').options]
        .some(x=>x.value===${JSON.stringify(witnessedPlayer.id)});
    `),true,'player line actually witnessed by this actor must be a valid memory source');
    const foreignState=(await(await fetch(base+'/api/state?worldId='+
      encodeURIComponent(parallel.id))).json()).state;
    const foreignIds=foreignState.sessions.flatMap(scene=>scene.messages.map(m=>m.id));
    const candidateIds=await script(`
      return [...document.querySelector('#fact-source').options].map(option=>option.value);
    `);
    assert.ok(candidateIds.every(id=>!foreignIds.includes(id)),
      'actor memory source selector must not leak foreign-world message IDs');
    const reviewedMemory='This visitor asked whether I could hear my own voice.';
    assert.equal(await script(`
      const source=document.querySelector('#fact-source');
      source.value=${JSON.stringify(witnessedPlayer.id)};
      document.querySelector('#fact-kind').value='belief';
      document.querySelector('#fact-note').value=${JSON.stringify(reviewedMemory)};
      const button=[...document.querySelectorAll('#inspector-content button.primary-button')]
        .find(x=>x.textContent==='Remember this detail');
      if(!button)return false;
      button.click();return true;
    `),true,'reviewed actor memory requires explicit source selection');
    await until(async()=>{
      const query=base+'/api/actor/facts?worldId='+encodeURIComponent(editableWorld)+
        '&timelineId='+encodeURIComponent(witnessedScene.timelineId)+
        '&actorId='+encodeURIComponent(witnessedActor);
      const facts=await(await fetch(query)).json();
      return facts.facts?.some(f=>f.text===reviewedMemory&&f.sourceMessageId===witnessedPlayer.id&&f.validSource);
    },'source-verified subjective memory stored without world-canon mutation');
    await screenshot('09-source-verified-actor-memory');

    // Approved AI scene direction never inserts dialog or a witnessed event.
    const beforeSceneEdit=(await(await fetch(base+'/api/state?worldId='+
      encodeURIComponent(editableWorld))).json()).state;
    const beforeEditable=beforeSceneEdit.sessions.find(scene=>scene.title==='Harbor Call at Dusk');
    assert.ok(beforeEditable);
    const priorMessageIds=beforeEditable.messages.map(m=>m.id);
    const priorEvents=JSON.stringify(beforeEditable.sceneEvents);
    assert.equal(await script(`
      document.querySelector('button[data-workspace="story"]').click();
      document.querySelector('[data-tab="scene"]').click();
      const widget=document.querySelector('#inspector-content select[aria-label="AI generation focus"]');
      if(!widget)return false;
      widget.value='direction';widget.dispatchEvent(new Event('change'));
      document.querySelector('#inspector-content .ai-draft-generate').click();
      return true;
    `),true,'ongoing scene director exposes a field-scoped AI co-author');
    await until(async()=>script(`
      return document.querySelector('#inspector-content textarea[aria-label="Editable model JSON"]')
        ?.value.includes('grounded in Nessa');
    `),'ongoing scene AI reviewed result');
    assert.equal(await script(`
      document.querySelector('#inspector-content .ai-draft-apply').click();
      return document.querySelector('#field-direction')?.value
        .includes('Nessa’s independent decisions.');
    `),true,'scene direction must change only after review');
    await until(async()=>{
      const story=(await(await fetch(base+'/api/state?worldId='+encodeURIComponent(editableWorld))).json()).state;
      return story.sessions.some(x=>x.id===beforeEditable.id&&
        x.direction.includes('Nessa’s independent decisions.'));
    },'approved scene direction saved');
    const afterEditable=(await(await fetch(base+'/api/state?worldId='+
      encodeURIComponent(editableWorld))).json()).state.sessions.find(x=>x.id===beforeEditable.id);
    assert.deepEqual(afterEditable.messages.map(x=>x.id),priorMessageIds);
    assert.equal(JSON.stringify(afterEditable.sceneEvents),priorEvents);
    await screenshot('10-reviewed-ongoing-scene-direction');

    // Double-clicking Create world must register exactly one universe and
    // open it only once earlier world state has reached SQLite.
    const worldsBeforeCreate=store.worlds.list().worlds.length;
    assert.equal(await script(`
      document.querySelector('button[data-workspace="world"]').click();
      document.querySelector('[data-world-view="timelines"]').click();
      const field=document.querySelector('#world-new-name');
      if(!field)return false;
      field.value='Reliable Browser World';
      field.dispatchEvent(new Event('input',{bubbles:true}));
      const details=document.querySelector('#universe-new-blueprint');
      details.open=true;
      const rules=document.querySelector('#new-universe-rules');
      if(!rules)return false;
      rules.value='Astral travel is limited to one world at a time.';
      rules.dispatchEvent(new Event('input',{bubbles:true}));
      const button=document.querySelector('#world-create');
      button.click();button.click();
      return button.disabled;
    `),true,'world creation must lock immediately');
    await until(async()=>script(`
      return document.querySelector('#top-world-name')?.textContent==='Reliable Browser World';
    `),'newly created world opened after SQLite commit');
    assert.equal(store.worlds.list().worlds.length,worldsBeforeCreate+1,
      'rapid world submission cannot create duplicate universes');
    const resultingWorld=store.worlds.list().worlds.find(w=>w.name==='Reliable Browser World');
    assert.ok(resultingWorld,'world creation survives registry persistence');
    const seededBlueprint=store.forWorld(resultingWorld.id).worlds.list().blueprint;
    assert.equal(seededBlueprint.sections.rules,'Astral travel is limited to one world at a time.');
    assert.equal(seededBlueprint.revision,1,'creation seeds blueprint with its own revision');
    assert.equal(store.forWorld(initialUniverse.id).worlds.list().blueprint.sections.rules,
      'Magic cannot reverse an established historical event.');

    assert.deepEqual((await(await fetch(base+'/api/state?worldId='+
      encodeURIComponent(resultingWorld.id))).json()).state.sessions,[],
      'new world must not inherit old scene history');
    await screenshot('11-reliable-world-create');

    console.log('Browser UI smoke: world and scene creation survive refresh, double-clicks and verified SQLite persistence.');
  }finally{
    if(sessionId)await request('DELETE','/session/'+sessionId).catch(()=>{});
    chrome.kill('SIGTERM');
    await new Promise(resolve=>server.close(resolve));
    rmSync(workDir,{recursive:true,force:true});
    if(chrome.exitCode&&chrome.exitCode!==0&& !sessionId)console.error(driverLog);
  }
}
main().catch(error=>{console.error(error);process.exitCode=1});
