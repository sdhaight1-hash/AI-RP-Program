import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorldPartitionStore} from '../world/partition-store.mjs';
import {createApp} from '../server.mjs';
import {makeEmptyWorldState,createCharacter} from '../engine.mjs';
import {makeSourceMentionRequest,parseSourceMentionSuggestions} from '../world/assisted-extraction.mjs';

const source={
  type:'character',id:'character-5',field:'familyHistory',
  trust:'profile',fingerprint:'a'.repeat(64),
  text:'Long ago, the people called the Valley of Saffron their ancestral home. They traded with the Luminous Collective.'
};
test('optional model extraction is strictly grounded in an unchanged quoted source',()=>{
  const request=makeSourceMentionRequest({worldId:'a',focus:'locations',source,
    existingNames:['Other Valley']});
  assert.match(request.messages[0].content,/Return/);
  const good=JSON.stringify({candidates:[{
    name:'Valley of Saffron',kind:'other',
    quote:'the people called the Valley of Saffron their ancestral home'
  }]});
  const suggestions=parseSourceMentionSuggestions(good,request);
  assert.equal(suggestions.length,1);
  assert.equal(suggestions[0].name,'Valley of Saffron');
  assert.equal(suggestions[0].evidence[0].fingerprint,source.fingerprint);
  assert.equal(suggestions[0].evidence[0].id,source.id);
  assert.deepEqual(parseSourceMentionSuggestions('{"candidates":[]}',request),[]);
  assert.throws(()=>parseSourceMentionSuggestions('{"candidates":[{"name":"Moon Palace","kind":"other","quote":"Moon Palace"}]}',request),/ungrounded/);
  assert.throws(()=>parseSourceMentionSuggestions('{"candidates":[{"name":"Valley of Saffron","kind":"culture","quote":"Valley of Saffron"}]}',request),/ungrounded/);
  assert.throws(()=>parseSourceMentionSuggestions('{"candidates":[{"name":"Valley of Saffron","kind":"other","quote":"Valley of Saffron","worldId":"foreign"}]}',request),/ungrounded/);
  assert.throws(()=>makeSourceMentionRequest({worldId:'a',focus:'groups',source:{...source,fingerprint:'invalid'}}),/current/);
  assert.throws(()=>parseSourceMentionSuggestions('not json',request),/invalid candidate JSON/);
  const groups=makeSourceMentionRequest({worldId:'a',focus:'groups',source});
  const collective=parseSourceMentionSuggestions(JSON.stringify({candidates:[{
    name:'Luminous Collective',kind:'community',quote:'the Luminous Collective'
  }]}),groups);
  assert.equal(collective[0].kind,'community');
  const already=makeSourceMentionRequest({worldId:'a',focus:'groups',source,
    existingNames:['Luminous Collective']});
  assert.deepEqual(parseSourceMentionSuggestions(JSON.stringify({candidates:[{
    name:'Luminous Collective',kind:'community',quote:'the Luminous Collective'
  }]}),already),[]);
});

test('searchable source excerpts are scoped, bounded, and cannot leak a second universe',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rp-model-excerpt-'));
  const store=new WorldPartitionStore(dir);
  const first=store.activeWorldId;
  const second=store.worlds.createWorld({name:'Private other continuity'});
  const a=store.forWorld(first),b=store.forWorld(second.id);
  const sa=makeEmptyWorldState(),sb=makeEmptyWorldState();
  const character=createCharacter('Mara');
  character.familyHistory='The Valley of Saffron was the only settlement her grandmother knew.';
  sa.characters=[character];
  const foreign=createCharacter('Sable');
  foreign.backstory='Her hometown was Phantom Reach.';
  sb.characters=[foreign];
  a.save(sa,a.load().revision,{worldId:first});
  b.save(sb,b.load().revision,{worldId:second.id});
  const server=createApp({store,fetchImpl:async()=>{throw Error('No model needed')}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const base='http://127.0.0.1:'+server.address().port;
    const result=await fetch(base+'/api/worlds/discovery/sources?worldId='+
      encodeURIComponent(first)+'&query=Saffron');
    assert.equal(result.status,200,await result.clone().text());
    const data=await result.json();
    assert.ok(data.sources.some(x=>x.type==='character'&&x.field==='familyHistory'&&
      x.text.includes('Valley of Saffron')&&x.fingerprint));
    assert.ok(data.sources.every(x=>x.text.length<=1600&&
      !x.text.includes('Phantom Reach')));
    const foreignRequest=await fetch(base+'/api/worlds/discovery/sources?worldId='+
      encodeURIComponent(second.id)+'&query=Saffron');
    assert.deepEqual((await foreignRequest.json()).sources,[]);
    const invalid=await fetch(base+'/api/worlds/discovery/sources?worldId='+
      encodeURIComponent(first)+'&query='+'x'.repeat(121));
    assert.equal(invalid.status,400);
    const request=makeSourceMentionRequest({worldId:first,focus:'locations',
      source:data.sources[0]});
    assert.equal(request.source.id,character.id);
  }finally{await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
