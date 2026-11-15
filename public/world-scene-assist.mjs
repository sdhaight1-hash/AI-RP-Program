// Shared client-only preview widget. The model is a drafting assistant,
// never a writer to persisted world, scene or actor memory state.
import {AUTHORING_CONTRACTS,parseAuthoringSuggestions,selectReviewedSuggestions} from '../authoring/world-scene.mjs';

function make(tag,contents='',className=''){
  const node=document.createElement(tag);node.textContent=contents;node.className=className;return node;
}
function consumeFrames(text,emit){
  const frames=text.replace(/\r\n/g,'\n').split('\n\n');
  return {remaining:frames.pop(),frames:frames.filter(Boolean).map(frame=>
    frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n')).filter(Boolean)};
}
export function mountWorldSceneAssistant(host,{mode,getRequest,getModel,isCurrent,onApply,beforeGenerate=async()=>{},applyMessage='Approved fields applied to the editor. Save or create explicitly to persist them.'}){
  if(!AUTHORING_CONTRACTS[mode])throw Error('Unknown AI authoring mode');
  const contracts=AUTHORING_CONTRACTS[mode];
  let active=null,request=null;
  const panel=make('section','','ai-authoring-panel');
  panel.dataset.aiMode=mode;
  const title=make('h3','✦ AI co-author','ai-authoring-heading');
  const help=make('p','Grounded in the information you have already entered. Your choices remain authoritative.','help');
  const target=make('select');target.setAttribute('aria-label','AI generation focus');target.id=mode+'-ai-focus';
  target.add(new Option('Develop all fields','all'));
  for(const [key,contract] of Object.entries(contracts))target.add(new Option(contract.label,key));
  const guidance=make('textarea');guidance.rows=4;guidance.maxLength=1400;guidance.id=mode+'-ai-direction';
  guidance.placeholder='Optional creative direction…';
  const reference=make('p','','ai-authoring-purpose');
  const actions=make('div','','inline-actions');
  const generate=make('button','Generate suggestions','subtle-button');generate.type='button';generate.classList.add('ai-draft-generate');
  const stop=make('button','Stop','subtle-button');stop.type='button';stop.classList.add('hidden');
  actions.append(generate,stop);
  const status=make('p','','help');status.setAttribute('role','status');
  const preview=make('div','','ai-authoring-review');preview.hidden=true;
  const raw=make('textarea');raw.rows=5;raw.maxLength=16000;raw.setAttribute('aria-label','Editable model JSON');
  const changes=make('div','','ai-authoring-changes');
  const apply=make('button','Review and apply checked fields','primary-button');apply.type='button';apply.classList.add('ai-draft-apply');
  const rawDetails=make('details','','ai-authoring-advanced');
  rawDetails.append(make('summary','Advanced · Edit raw JSON'),
    make('label','Structured response (editable)','field-label'),raw);
  const reviewHeader=make('div','','ai-authoring-review-head');
  reviewHeader.append(make('strong','Review suggested changes'),
    make('p','Uncheck anything you do not want. Edit the rest before approving.','help'));
  preview.append(reviewHeader,changes,rawDetails,apply);
  const fields=make('div','','ai-authoring-fields');
  const focusLabel=make('label','Focus','field-label');focusLabel.htmlFor=target.id;
  const directionLabel=make('label','Creative direction','field-label');directionLabel.htmlFor=guidance.id;
  fields.append(focusLabel,target,reference,directionLabel,guidance,actions,status);
  panel.append(title,help,fields,preview);
  host.append(panel);
  const current=()=>panel.isConnected&&host.contains(panel)&&isCurrent();
  const showPurpose=()=>{
    reference.textContent=target.value==='all'
      ?Object.values(contracts).map(x=>x.label+': '+x.purpose+'.').join(' ')
      :contracts[target.value].purpose+'. '+contracts[target.value].boundary;
    preview.hidden=true;request=null;
  };
  target.onchange=showPurpose;showPurpose();
  const renderChanges=()=>{
    changes.replaceChildren();apply.disabled=true;
    if(!request)return;
    let suggestions;
    try{suggestions=parseAuthoringSuggestions(raw.value,request);}
    catch(error){changes.append(make('p',error.message,'help'));return;}
    for(const [key,value] of Object.entries(suggestions)){
      const contract=contracts[key],row=make('div','','ai-authoring-change');
      const label=make('label','','ai-authoring-checkbox'),toggle=make('input');
      toggle.type='checkbox';toggle.checked=true;toggle.dataset.reviewKey=key;
      label.append(toggle,document.createTextNode(' '+contract.label));
      const edit=make('textarea');edit.rows=key==='description'||key==='direction'?5:3;
      edit.maxLength=contract.max;edit.value=value;edit.dataset.editKey=key;
      row.append(label,edit,make('p',contract.boundary,'help'));changes.append(row);
    }
    apply.disabled=false;
  };
  raw.oninput=renderChanges;
  const resetActivity=controller=>{
    if(active!==controller)return;
    active=null;generate.disabled=false;stop.classList.add('hidden');
  };
  stop.onclick=()=>active?.abort();
  generate.onclick=async()=>{
    if(active||!current())return;
    const model=getModel();
    if(!model){status.textContent='Select a local model in Settings & tools first.';return;}
    const controller=new AbortController();active=controller;
    generate.disabled=true;stop.classList.remove('hidden');
    request=null;preview.hidden=true;status.textContent='Building context-aware suggestions…';
    try{
      await beforeGenerate();
      if(controller.signal.aborted||active!==controller||!current())return;
      const draft=getRequest(target.value,guidance.value);
      const response=await fetch('/api/chat',{method:'POST',signal:controller.signal,
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({worldId:draft.worldId,model,temperature:0.45,max_tokens:mode==='blueprint'?2048:1400,messages:draft.messages})});
      if(!response.ok){const error=await response.json().catch(()=>({}));throw Error(error.error||'Local model unavailable');}
      if(!response.body)throw Error('Model did not return a stream');
      const reader=response.body.getReader(),decoder=new TextDecoder();
      let buffer='',result='',finished=false;
      while(!finished){
        const chunk=await reader.read();if(chunk.done)break;
        const decoded=consumeFrames(buffer+decoder.decode(chunk.value,{stream:true}));
        buffer=decoded.remaining;
        for(const line of decoded.frames){
          if(line==='[DONE]'){finished=true;break;}
          const item=JSON.parse(line);
          if(item.error)throw Error(String(item.error));
          result+=item.choices?.[0]?.delta?.content||'';
        }
      }
      const tail=consumeFrames(buffer+decoder.decode()+'\n\n');
      for(const line of tail.frames)if(line!=='[DONE]'){
        const item=JSON.parse(line);if(item.error)throw Error(String(item.error));
        result+=item.choices?.[0]?.delta?.content||'';
      }
      if(controller.signal.aborted||active!==controller||!current())return;
      // A changed draft, cast, medium or world makes this output obsolete.
      if(getRequest(draft.target,guidance.value).basis!==draft.basis)
        throw Error('Context changed during generation; regenerate the draft.');
      parseAuthoringSuggestions(result,draft);
      request=draft;raw.value=result;preview.hidden=false;renderChanges();
      status.textContent='Suggestions ready. Select and edit the changes you want to apply.';
    }catch(error){
      if(active===controller&&current())status.textContent=controller.signal.aborted?'Generation canceled.':error.message;
    }finally{resetActivity(controller);}
  };
  apply.onclick=()=>{
    if(!request||!current())return;
    try{
      if(getRequest(request.target,guidance.value).basis!==request.basis)
        throw Error('The underlying world, cast or draft changed. Generate again.');
      const checked={},edits={};
      for(const control of changes.querySelectorAll('[data-review-key]'))checked[control.dataset.reviewKey]=control.checked;
      for(const control of changes.querySelectorAll('[data-edit-key]'))edits[control.dataset.editKey]=control.value;
      const patch=selectReviewedSuggestions({request,output:raw.value,checked,edits});
      if(!Object.keys(patch).length)throw Error('Check at least one field to apply.');
      if(!confirm('Apply '+Object.keys(patch).join(', ')+' to the editable draft? No other fields will change.'))return;
      onApply(patch,request);
      preview.hidden=true;request=null;
      status.textContent=applyMessage;
    }catch(error){status.textContent=error.message;}
  };
  return {cancel:()=>active?.abort(),element:panel};
}
