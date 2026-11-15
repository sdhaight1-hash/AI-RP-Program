import test from 'node:test';
import assert from 'node:assert/strict';
import {createCharacter} from '../engine.mjs';
import {makeCharacterDraftRequest} from '../character/authoring.mjs';
import {reviewedCharacterSelections,renderCharacterDraftReview} from '../public/character-review.mjs';

const character=createCharacter('Mara');
const worldId='world-one';
const worldLibrary={worlds:[{id:worldId,name:'Harbor'}],locations:[],entities:[],relationships:[]};
const request=()=>makeCharacterDraftRequest({
  character,target:'personality',worldId,worldLibrary,lore:[]
});

test('review selection only accepts explicitly checked proposals and edited text',()=>{
  const r=request(),key=r.fields[0];
  const controls={querySelector:query=>{
    if(query===`[data-proposal-field="${key}"]`)return {checked:true};
    if(query===`[data-proposal-text="${key}"]`)return {value:'Quietly observant'};
    return null;
  }};
  assert.deepEqual(reviewedCharacterSelections({request:r,raw:'Outgoing',controls}),
    {[key]:'Quietly observant'});
  assert.deepEqual(reviewedCharacterSelections({request:r,raw:'Outgoing',
    controls:{querySelector:()=>({checked:false})}}),{});
  assert.throws(()=>reviewedCharacterSelections({request:r,raw:'',controls}),
    /empty suggestion/);
});

test('review renderer constructs field-specific labels and preserves approved proposal contents',()=>{
  class Node{
    constructor(type){this.type=type;this.children=[];this.dataset={};}
    append(...nodes){this.children.push(...nodes);}
    replaceChildren(...nodes){this.children=[...nodes];}
  }
  const dom={createElement:type=>new Node(type),createTextNode:value=>value};
  const makeElement=(type,value='',className='')=>{
    const node=new Node(type);node.textContent=value;node.className=className;return node;
  };
  const host=new Node('host'),r=request();
  renderCharacterDraftReview({host,raw:'Patient and curious.',request:r,
    character,label:key=>key,makeElement,dom});
  assert.equal(host.children.length,2);
  const box=host.children[1];
  assert.equal(box.children[0].children[0].dataset.proposalField,'personality');
  assert.equal(box.children[1].value,'Patient and curious.');
  renderCharacterDraftReview({host,raw:'',request:r,
    character,label:key=>key,makeElement,dom});
  assert.match(host.children[0].textContent,/empty suggestion/);
  renderCharacterDraftReview({host,raw:'',request:null,
    character,label:key=>key,makeElement,dom});
  assert.equal(host.children.length,0);
});
