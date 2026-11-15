// Read-only, evidence-backed universe codex discovery. Never promotes text
// (especially NPC dialogue) into canon; suggestions are editorial starting points.
const SPACES=/\s+/gu;
const keyOf=s=>String(s||'').normalize('NFKC').toLocaleLowerCase().replace(/[’]/gu,"'").replace(SPACES,' ').trim();
const NAME="([A-Z][\\p{L}\\p{N}’'-]*(?:[ \\t]+(?:[A-Z][\\p{L}\\p{N}’'-]*|of|the|and|&)){0,3})";
const PLACE=new RegExp("(?:\\b(?:at|in|near|about|from|inside|visited|visits|located in|based in|works at|lives in|grew up in)\\s+(?:the\\s+)?|\\b(?:place called|town named|district called|building named)\\s+)"+NAME,"gu");
const COLLECTIVE=new RegExp("\\b(?:[Tt]he[ \\t]+)?"+NAME+"[ \\t]+(Family|Clan|Guild|Council|Circle|Order|Society|Company|Corporation|Collective|Union|Community|Faction|Cult|Club|School|Syndicate|Network|Culture|People)\\b","gu");
const STOP=new Set(['I','We','She','He','They','The','This','That','Her','His','Their','It','My','Our','A','An','And','But','When','Then','After','Before','Because','At','In','On','From','To','With','There','Here','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday','Today','Tomorrow','Yesterday']);
const suffixKinds={Family:'family',Clan:'family',Guild:'organization',Council:'organization',Circle:'group',Order:'organization',Society:'organization',Company:'organization',Corporation:'organization',Collective:'community',Union:'organization',Community:'community',Faction:'faction',Cult:'organization',Club:'group',School:'organization',Syndicate:'organization',Network:'group',Culture:'culture',People:'culture'};
const quotesFrom=(text,start,end)=>String(text).slice(Math.max(0,start-65),Math.min(text.length,end+85)).trim();
const normalizeName=s=>String(s||'').trim().replace(/[.,!?;:]+$/gu,'')
  .replace(SPACES,' ').replace(/(?:\s+(?:and|of|the)|\s+&)$/iu,'').trim();
const likelyName=s=>{
  const tokens=s.split(' ');
  return s.length>=3&&s.length<=120&&tokens.length<=5&&
    !STOP.has(tokens[0])&&!tokens.every(t=>STOP.has(t))&&
    !/[<>\n\r]/u.test(s);
};
export function sourcesFor({state={},library={},worldId}){
  const sources=[];
  const add=(type,id,field,value,trust)=>{if(typeof value==='string'&&value.trim())
    sources.push({type,id,field,text:value.slice(0,9000),trust});};
  const world=library.worlds?.find(w=>w.id===worldId);
  if(world)add('universe',worldId,'description',world.description,'established');
  if(library.blueprint?.worldId===worldId)
    for(const [field,value] of Object.entries(library.blueprint.sections||{}))
      add('blueprint',worldId,field,value,'established');
  for(const person of (state.characters||[]).filter(c=>!c.trashedAt&&(!c.worldId||c.worldId===worldId)).slice(0,1000)){
    for(const field of ['description','backstory','familyHistory','formativeEvents','personality','occupation','family','relationships','preferredEnvironment','dailyRoutine','socialHabits','hobbies','frequentPlacesText','history','goals','fears','secrets']){
      add('character',person.id,field,person[field],'profile');
    }
    // Other author-defined character sections are still searched, but never
    // untrusted image/AI prompt blobs or raw serialized objects.
    for(const [field,value] of Object.entries(person)){
      if(['notes','connections','socialCircle','background','residence','workplace'].includes(field))
        add('character',person.id,field,value,'profile');
    }
  }
  for(const place of (library.locations||[]).filter(x=>x.worldId===worldId).slice(0,1500))
    add('location',place.id,'description',place.description,'established');
  for(const entity of (library.entities||[]).filter(x=>x.worldId===worldId).slice(0,1500))
    add('entity',entity.id,'description',entity.description,'established');
  for(const relationship of (library.relationships||[]).filter(x=>x.worldId===worldId).slice(0,1500))
    add('relationship',relationship.id,'notes',relationship.notes,'established');
  for(const entry of (state.lore||[]).slice(0,1500)){
    if(entry.worldId&&entry.worldId!==worldId)continue;
    for(const field of ['title','content','body','description'])add('lore',entry.id,field,entry[field],
      entry.private?'private':'lore');
  }
  for(const scene of (state.sessions||[]).filter(s=>!s.trashedAt&&(!s.worldId||s.worldId===worldId)).slice(-800)){
    for(const field of ['direction','publicSummary','location','atmosphere'])add('scene',scene.id,field,scene[field],'scene');
    for(const message of (scene.messages||[]).slice(-250))
      add('dialogue',message.id,'content',message.content,'unverified');
  }
  return sources;
}
function matchesExisting(text,names){
  const lower=keyOf(text),hits=[];
  for(const item of names){
    const name=keyOf(item.name);
    if(name.length<3)continue;
    const at=lower.indexOf(name);
    if(at>=0){const before=lower[at-1],after=lower[at+name.length];
      if((!before||!/[\p{L}\p{N}]/u.test(before))&&
         (!after||!/[\p{L}\p{N}]/u.test(after)))hits.push(item);
    }
  }
  return hits;
}
/**
 * Returns source-backed *unverified* suggestions, never inserts.
 * 'locations' or 'groups' controls which recommendations appear in an editor.
 * All sources and established entries are constrained to the supplied world.
 */
export function discoverUniverseMentions({worldId,library,state={},focus='locations',limit=14,sourcesOverride=null}={}){
  if(!worldId||library?.activeWorldId!==worldId)throw Error('Open the correct Connical Universe');
  if(!['locations','groups'].includes(focus))throw Error('Unsupported discovery focus');
  const established=focus==='locations'
    ?(library.locations||[]).filter(x=>x.worldId===worldId)
    :(library.entities||[]).filter(x=>x.worldId===worldId);
  const byName=new Set(established.map(x=>keyOf(x.name)));
  const candidates=new Map();
  const sources=sourcesOverride||sourcesFor({state,library,worldId});
  for(const source of sources){
    const pattern=focus==='locations'?PLACE:COLLECTIVE;
    pattern.lastIndex=0;
    for(const match of source.text.matchAll(pattern)){
      const name=normalizeName(focus==='locations'?match[1]:match[1]+' '+match[2]);
      if(!likelyName(name))continue;
      // Do not re-suggest established entries or duplicate aliases.
      const token=keyOf(name);
      if(byName.has(token))continue;
      const kind=focus==='locations'?'other':suffixKinds[match[2]]||'group';
      const id=focus+':'+token;
      let candidate=candidates.get(id);
      if(!candidate){
        candidate={name,kind,focus,status:'unverified',evidence:[],mentions:0};
        candidates.set(id,candidate);
      }
      candidate.mentions++;
      if(candidate.evidence.length<4&&!candidate.evidence.some(e=>e.type===source.type&&e.id===source.id&&e.field===source.field)){
        candidate.evidence.push({type:source.type,id:source.id,field:source.field,trust:source.trust,
          quote:quotesFrom(source.text,match.index,match.index+match[0].length),
          ...(source.fingerprint?{fingerprint:source.fingerprint}:{})});
      }
    }
  }
  // Existing names mentioned in relevant material can still be surfaced as
  // links, but never as new-entry candidates.
  const links=[];
  for(const item of established){
    const evidence=sources.find(s=>matchesExisting(s.text,[item]).length);
    if(evidence)links.push({name:item.name,id:item.id,kind:item.kind,status:'existing',
      evidence:[{type:evidence.type,id:evidence.id,field:evidence.field,trust:evidence.trust,
        quote:quotesFrom(evidence.text,Math.max(0,keyOf(evidence.text).indexOf(keyOf(item.name))),
          Math.max(0,keyOf(evidence.text).indexOf(keyOf(item.name)))+item.name.length)}]});
  }
  return {worldId,focus,scannedSources:sources.length,
    suggestions:[...candidates.values()].sort((a,b)=>b.evidence.length-a.evidence.length||b.mentions-a.mentions||a.name.localeCompare(b.name)).slice(0,limit),
    existingLinks:links.slice(0,limit)};
}
