// Character AI review DOM is presentation-only. The canonical authoring
// contract and the world/profile version checks remain in character/authoring.mjs.
import {parseCharacterSuggestions} from '../character/authoring.mjs';

export function reviewedCharacterSelections({request,raw,controls}){
  const proposed=parseCharacterSuggestions(raw,request);
  const changes={};
  for(const [key,value] of Object.entries(proposed)){
    const checkbox=controls.querySelector(`[data-proposal-field="${key}"]`);
    const field=controls.querySelector(`[data-proposal-text="${key}"]`);
    if(checkbox?.checked)changes[key]=field?.value||value;
  }
  return changes;
}

export function renderCharacterDraftReview({host,raw,request,character,label,makeElement,dom}){
  host.replaceChildren();
  if(!request)return;
  let proposal;
  try{proposal=parseCharacterSuggestions(raw,request);}
  catch(err){
    host.append(makeElement('p',err.message+' You may edit the raw response and review it again.','help'));
    return;
  }
  host.append(makeElement('strong','Proposed changes — check only the fields to accept'));
  for(const [key,value] of Object.entries(proposal)){
    const box=makeElement('div','','builder-ai-change');
    const caption=dom.createElement('label');caption.className='field-label';
    const checkbox=dom.createElement('input');checkbox.type='checkbox';checkbox.checked=true;
    checkbox.dataset.proposalField=key;
    caption.append(checkbox,dom.createTextNode(' '+label(key)));
    const before=character?.[key];
    if(before)box.append(makeElement('p',`Current: ${String(before).slice(0,250)}`,'help'));
    const edit=dom.createElement('textarea');edit.rows=4;edit.maxLength=12000;
    edit.value=value;edit.dataset.proposalText=key;
    box.append(caption,edit);host.append(box);
  }
}
