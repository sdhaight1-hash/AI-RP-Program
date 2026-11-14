// Dedicated world-scoped encounter editor. No network access or hidden state:
// the app owns commits, confirmations, world selection, and scene starts.
import {CHANNEL_OPTIONS,getChannel} from '/interactions/channels.mjs';
import {encounterParticipantNames} from '/encounters/library.mjs';

const el=(tag,label='',className='')=>{
  const node=document.createElement(tag);
  node.className=className;
  node.textContent=label;
  return node;
};
const field=(parent,id,label,control,hint='')=>{
  const group=el('div','','group');
  const caption=el('label',label,'field-label');
  caption.htmlFor=id;control.id=id;group.append(caption,control);
  if(hint)group.append(el('p',hint,'help'));
  parent.append(group);
  return control;
};
const input=(max,placeholder='')=>{
  const x=document.createElement('input');x.type='text';x.maxLength=max;x.placeholder=placeholder;return x;
};
const area=(max,placeholder='',rows=4)=>{
  const x=document.createElement('textarea');x.maxLength=max;x.rows=rows;x.placeholder=placeholder;return x;
};
const select=values=>{
  const x=document.createElement('select');
  for(const [value,label] of values)x.add(new Option(label,value));
  return x;
};
const action=(name,onClick,className='subtle-button')=>{
  const button=el('button',name,className);button.type='button';button.onclick=onClick;return button;
};
const active=c=>!c.trashedAt;

export function renderEncounterStudio(host,{state,worldLibrary,worldId,selectedId=null,
  onSelect,onSave,onDelete,onStart,onCharacters,onBackToTrash=null}){
  const templates=state.encounters||[];
  const available=state.characters.filter(active);
  const selected=templates.find(e=>e.id===selectedId)||null;
  host.replaceChildren();
  const header=el('div','','encounter-header');
  const heading=el('div');
  heading.append(el('h2','Encounter templates'),el('p',
    'Reusable starting situations for this world. Templates are not character traits. Deleting one does not delete scenes already played.','help'));
  const controls=el('div','','encounter-header-actions');
  if(onBackToTrash){
    const back=action('← Back to Trash',onBackToTrash);
    back.id='encounter-return-trash';controls.append(back);
  }
  controls.append(action('＋ New template',()=>onSelect(null),'primary-button'));
  header.append(heading,controls);host.append(header);
  if(!available.length)host.append(el('p',
    'Create a character first. Existing archived-character templates remain visible below so you can remove their deletion blockers.','help'));
  const layout=el('div','','encounter-layout');
  const library=el('div','','encounter-library');
  const listTitle=el('h3',`Saved templates · ${templates.length}`,'encounter-subheading');
  library.append(listTitle);
  if(!templates.length)library.append(el('p',
    'No templates yet. Create a starting situation, or use New scene to start an unscripted conversation.','empty-note'));
  for(const item of templates){
    const linked=item.characterIds||[];
    const inactive=linked.filter(id=>!available.some(c=>c.id===id));
    const card=el('article','','encounter-card');
    card.dataset.encounterId=item.id;
    card.classList.toggle('selected',selected?.id===item.id);
    card.append(el('strong',item.title),el('p',
      `${getChannel(item.channelId).label} · ${encounterParticipantNames(state,item)}`,'encounter-card-meta'));
    if(inactive.length)card.append(el('p',
      'Includes archived character(s) · blocks permanent profile deletion until this template is removed or reassigned.',
      'encounter-dependency-warning'));
    if(item.premise)card.append(el('p',item.premise.slice(0,180),'encounter-excerpt'));
    const actions=el('div','','inline-actions');
    actions.append(
      action('Edit',()=>onSelect(item.id)),
      action('Start scene',()=>onStart(item),'subtle-button'),
      action('Delete',()=>onDelete(item),'encounter-danger')
    );
    card.append(actions);library.append(card);
  }
  layout.append(library);
  const editor=el('section','','encounter-editor');
  editor.append(el('h3',selected?'Edit template':'Create a template','encounter-subheading'));
  if(selected?.imported)editor.append(el('p',
    'Originally imported from a legacy character card. It is now a separate world template and can be edited or removed.','help'));
  const name=field(editor,'encounter-title','Title',
    input(120,'A late-night webcam conversation'));name.value=selected?.title||'';
  const primary=field(editor,'encounter-character','Starting character',
    select(available.map(c=>[c.id,c.name])),
    'The character who sends an optional opening message.');
  primary.value=selected?.characterIds?.find(id=>available.some(c=>c.id===id))||available[0]?.id||'';
  if(!available.length)primary.disabled=true;
  const castBox=el('fieldset','','encounter-cast-field');
  const legend=el('legend','Other scene participants');castBox.append(legend);
  const checkboxes=[];
  for(const character of available){
    const line=el('label','','encounter-cast-choice');
    const chk=document.createElement('input');
    chk.type='checkbox';chk.value=character.id;
    chk.checked=Boolean(selected?.characterIds?.includes(character.id));
    chk.disabled=character.id===primary.value;
    line.append(chk,el('span',character.name));
    castBox.append(line);checkboxes.push(chk);
  }
  if(!checkboxes.length)castBox.append(el('p','No active characters yet.','help'));
  primary.onchange=()=>{
    for(const chk of checkboxes){
      chk.disabled=chk.value===primary.value;
      if(chk.disabled)chk.checked=true;
    }
  };
  for(const chk of checkboxes)if(chk.value===primary.value)chk.checked=true;
  editor.append(castBox);
  const channel=field(editor,'encounter-channel','How they communicate',
    select(CHANNEL_OPTIONS.map(ch=>[ch.id,ch.icon+' '+ch.label])),
    'The selected medium controls what can be seen, heard and narrated.');
  channel.value=getChannel(selected?.channelId).id;
  const channelInfo=el('p','','encounter-channel-info');
  const updateMedium=()=>{channelInfo.textContent=getChannel(channel.value).description;};
  channel.onchange=updateMedium;updateMedium();editor.append(channelInfo);
  const locations=(worldLibrary?.locations||[]).filter(x=>x.worldId===worldId);
  const location=field(editor,'encounter-location','Optional place association',
    select([['','No fixed place'],...locations.map(l=>[l.id,l.name])]),
    'For a video call or online exchange, a place is background context—not a shared room.');
  location.value=selected?.locationId||'';
  const premise=field(editor,'encounter-premise','Starting circumstances',
    area(3000,'What happened just before the interaction? What is established?',4));
  premise.value=selected?.premise||'';
  const opening=field(editor,'encounter-opening','Optional opening message',
    area(3000,'Write the first words or post from the starting character…',4),
    'An opening is a transmitted message. It never grants the NPC knowledge they cannot perceive.');
  opening.value=selected?.opening||'';
  const submit=action(selected?'Save changes':'Save template',()=>{
    const title=name.value.trim(),lead=primary.value;
    if(!title||!lead)return onSave(null,'Enter a title and choose an active starting character.');
    const participants=[lead,...checkboxes.filter(c=>c.checked&&c.value!==lead).map(c=>c.value)];
    onSave({
      id:selected?.id||crypto.randomUUID(),title:title.slice(0,120),
      characterIds:[...new Set(participants)],
      channelId:getChannel(channel.value).id,locationId:location.value||null,
      premise:premise.value.slice(0,3000),opening:opening.value.slice(0,3000),
      alternativeOpenings:selected?.alternativeOpenings||[],imported:Boolean(selected?.imported)
    });
  },'primary-button');
  submit.id='encounter-save';submit.disabled=!available.length;
  editor.append(submit);
  if(!available.length)editor.append(action('Go to Characters',onCharacters));
  layout.append(editor);host.append(layout);
}
