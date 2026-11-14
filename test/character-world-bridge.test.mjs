import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioStore } from '../storage.mjs';
import { makeInitialState } from '../engine.mjs';
import { makeCharacterDraftRequest,gatherCharacterWorldContext,worldDraftVersion,characterDraftVersion } from '../character/authoring.mjs';
import { makeWorldEntryDraftRequest,parseWorldEntrySuggestions,commitCharacterWorldEntry,
  verifyWorldEntrySource,listCharacterWorldSources } from '../character/world-bridge.mjs';

function fixture() {
  const store=new StudioStore(':memory:');
  const world=store.worlds.createWorld({name:'Coastal Republic',description:'A contemporary maritime society with no magic.'});
  const story=makeInitialState(),character=story.characters[0];
  character.worldId=world.id;
  character.name='Mara';
  character.familyHistory='Her aunt Nessa ran the Lantern House in Seabrook when Mara was young.';
  character.occupation='Mara repairs timepieces at the Lantern House.';
  character.personality='Quiet, methodical and cautious with strangers.';
  store.save(story,0);
  const saved=store.load().state.characters[0];
  const library={...store.worlds.list(),activeWorldId:world.id};
  return {store,worldId:world.id,character:saved,library};
}
const proposal={
  type:'location',kind:'town',name:'Seabrook',
  description:'A coastal settlement named in Mara\'s upbringing.',
  sourceField:'familyHistory',sourceQuote:'Her aunt Nessa ran the Lantern House in Seabrook when Mara was young.'
};
function approval(f,entry=proposal) {
  const basis=makeWorldEntryDraftRequest({
    character:f.store.load().state.characters[0],
    worldLibrary:{...f.store.worlds.list(),activeWorldId:f.worldId},
    worldId:f.worldId
  });
  return {approval:'approve',worldId:f.worldId,characterId:f.character.id,
    revision:f.store.load().revision,
    profileVersion:basis.profileVersion,worldVersion:basis.worldVersion,entry};
}

test('character to world generation uses approved fields and explicit named source quotes',()=>{
  const f=fixture();
  try {
    const req=makeWorldEntryDraftRequest({character:f.character,worldLibrary:f.library,worldId:f.worldId});
    const prompt=req.messages.map(x=>x.content).join('\n');
    assert.match(prompt,/Coastal Republic|contemporary maritime society/);
    assert.match(prompt,/Her aunt Nessa ran the Lantern House/);
    assert.match(prompt,/only.*approved|approved fictional character biography/i);
    assert.match(prompt,/EXACT contiguous substring/);
    const options=parseWorldEntrySuggestions(JSON.stringify({entries:[
      proposal,
      {type:'entity',kind:'character',name:'Nessa',description:'Mara\'s aunt.',
        sourceField:'familyHistory',sourceQuote:proposal.sourceQuote},
      {type:'entity',kind:'character',name:'Imaginary Stranger',description:'No source.',
        sourceField:'familyHistory',sourceQuote:proposal.sourceQuote},
      {type:'location',kind:'town',name:'Seabrook',description:'Duplicate',
        sourceField:'familyHistory',sourceQuote:proposal.sourceQuote},
      {type:'entity',kind:'character',name:'Evil Queen',description:'Example dialogue',
        sourceField:'exampleDialogue',sourceQuote:'Evil Queen'}
    ]}),{character:f.character,worldLibrary:f.library,worldId:f.worldId});
    assert.deepEqual(options.map(x=>x.name),['Seabrook','Nessa']);
    assert.equal(f.store.worlds.list().locations.length,0,
      'LLM draft parsing must never commit canon');
  }finally{f.store.close();}
});

test('explicit promotion creates an isolated atlas entry and provenance with no scene position changes',()=>{
  const f=fixture();
  try {
    assert.throws(()=>commitCharacterWorldEntry(f.store,{...approval(f),approval:'draft'}),/Explicit/);
    const before=f.store.worlds.list().positions.length;
    const result=commitCharacterWorldEntry(f.store,approval(f));
    assert.equal(result.entry.name,'Seabrook');
    assert.equal(result.entry.worldId,f.worldId);
    assert.equal(f.store.worlds.list().locations.length,1);
    assert.equal(f.store.worlds.list().positions.length,before);
    assert.equal(f.store.load().state.characters[0].homeLocationId,null);
    const provenance=listCharacterWorldSources(f.store,{worldId:f.worldId,characterId:f.character.id});
    assert.equal(provenance.length,1);
    assert.equal(provenance[0].entryId,result.entry.id);
    assert.equal(provenance[0].sourceQuote,proposal.sourceQuote);
    assert.equal(provenance[0].sourceField,'familyHistory');
    assert.throws(()=>commitCharacterWorldEntry(f.store,approval(f)),/already exists/);
    const next=makeCharacterDraftRequest({character:f.store.load().state.characters[0],
      target:'dailyRoutine',worldLibrary:{...f.store.worlds.list(),activeWorldId:f.worldId},
      worldId:f.worldId});
    assert.match(next.messages[1].content,/Seabrook/,'accepted world entry must become available to future character co-authoring');
  }finally{f.store.close();}
});

test('source change, wrong world, missing names, out of scope fields and stale canon are rejected',()=>{
  const f=fixture();
  try {
    const base=approval(f);
    assert.throws(()=>verifyWorldEntrySource(f.character,{
      ...proposal,name:'Not Mentioned Anywhere'}),/appear in the quoted source/);
    assert.throws(()=>verifyWorldEntrySource(f.character,{
      ...proposal,sourceField:'exampleDialogue'}),/factual character field/);
    assert.throws(()=>commitCharacterWorldEntry(f.store,{...base,worldId:'another-world'}),/Wrong world|World not found|not in this world/);
    const updated=f.store.load();
    updated.state.characters[0].familyHistory='Her aunt moved away many years ago.';
    f.store.save(updated.state,updated.revision);
    assert.throws(()=>commitCharacterWorldEntry(f.store,base),/changed since/);
    const fresh=approval(f);
    assert.throws(()=>commitCharacterWorldEntry(f.store,fresh),/quote an unchanged character source/);
    assert.equal(f.store.worlds.list().locations.length,0);
  }finally{f.store.close();}
});

test('duplicate world entities and creator-added entries are never silently overwritten',()=>{
  const f=fixture();
  try{
    f.store.worlds.createEntity({worldId:f.worldId,name:'Nessa',kind:'character'});
    const same={type:'entity',kind:'character',name:'Nessa',description:'Aunt',
      sourceField:'familyHistory',sourceQuote:proposal.sourceQuote};
    const liveLibrary={...f.store.worlds.list(),activeWorldId:f.worldId};
    const list=parseWorldEntrySuggestions(JSON.stringify({entries:[same]}),
      {character:f.character,worldLibrary:liveLibrary,worldId:f.worldId});
    assert.deepEqual(list,[]);
    assert.throws(()=>commitCharacterWorldEntry(f.store,approval(f,same)),/already exists/);
    assert.equal(f.store.worlds.list().entities.length,1);
  }finally{f.store.close();}
});

test('provenance insertion and atlas creation are a single rollback-safe transaction',()=>{
  const f=fixture();
  try {
    f.store.db.exec(`CREATE TRIGGER block_source_insert BEFORE INSERT ON character_world_sources
      BEGIN SELECT RAISE(ABORT,'test provenance failure'); END;`);
    assert.throws(()=>commitCharacterWorldEntry(f.store,approval(f)),/test provenance failure/);
    assert.equal(f.store.worlds.list().locations.length,0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM character_world_sources').get().count,0);
  }finally{f.store.close();}
});

test('world-specific character links and relationships precede generic catalogs in short prompts',()=>{
  const f=fixture();
  try{
    const place=f.store.worlds.createLocation({worldId:f.worldId,name:'Nessa Clockworks',kind:'building',description:'Mara works here.'});
    for(let i=0;i<40;i++)f.store.worlds.createLocation({worldId:f.worldId,name:'Unrelated place '+i,kind:'building',
      description:'An unrelated warehouse with an extensive catalog description designed to exceed the prompt cap.'});
    const old=f.store.load();
    old.state.characters[0].workLocationId=place.id;
    f.store.save(old.state,old.revision);
    const c=f.store.load().state.characters[0],lib={...f.store.worlds.list(),activeWorldId:f.worldId};
    const context=gatherCharacterWorldContext({character:c,worldLibrary:lib,worldId:f.worldId});
    assert.ok(context.context.indexOf('Nessa Clockworks')>=0);
    assert.ok(context.context.indexOf('Nessa Clockworks')<context.context.indexOf('Other places'));
    const req=makeCharacterDraftRequest({character:c,target:'dailyRoutine',worldLibrary:lib,worldId:f.worldId});
    assert.match(req.messages[1].content,/Nessa Clockworks/);
    assert.match(req.messages[1].content,/NOT their current position/);
  }finally{f.store.close();}
});
