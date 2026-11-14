// Small append-only player-turn boundary. Edits, retries, NPC replies and
// timeline/canon changes continue through the existing reviewed save pipeline.
// A browser cannot use this endpoint to impersonate an NPC or alter history.
import { chooseSpeaker } from '../harness.mjs';
import { getChannel } from '../interactions/channels.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validId=value=>typeof value==='string'&&UUID.test(value);
const eq=(a,b)=>a.length===b.length&&a.every((id,i)=>id===b[i]);

export function appendPlayerMessage(store,input){
  if(!input||typeof input!=='object'||Array.isArray(input) ||
    !Number.isSafeInteger(input.revision)||input.revision<0 ||
    typeof input.sceneId!=='string'||input.sceneId.length>160 ||
    typeof input.worldId!=='string'||!input.worldId)
    throw new Error('Invalid player message append request');
  if(store.scopeWorldId&&store.scopeWorldId!==input.worldId)
    throw new Error('Wrong world');
  if(store.activeWorldId&&store.activeWorldId!==input.worldId)
    throw new Error('Wrong world');
  const proposed=input.message;
  if(!proposed||typeof proposed!=='object'||Array.isArray(proposed)||
    !validId(proposed.id)||proposed.role!=='user'||
    typeof proposed.content!=='string'||!proposed.content.trim()||
    proposed.content.length>30_000 ||
    !Number.isSafeInteger(proposed.sentAt)||proposed.sentAt<0 ||
    !Array.isArray(proposed.witnessIds)||
    Object.keys(proposed).some(key=>!['id','role','content','channelId','sentAt','witnessIds'].includes(key)))
    throw new Error('Only a new, bounded player message can be appended');
  const snapshot=store.load();
  if(snapshot.revision!==input.revision)
    throw new Error('Story revision changed before player message append');
  const state=snapshot.state;
  const scene=state?.sessions?.find(s=>s.id===input.sceneId&&!s.trashedAt);
  if(!scene)throw new Error('Scene not found');
  if(scene.messages.some(m=>m.id===proposed.id))
    throw new Error('Message ID already exists');
  const channel=getChannel(scene.channelId).id;
  if(proposed.channelId!==channel)throw new Error('Scene channel changed');
  const cast=scene.castIds||[scene.characterId];
  const target=chooseSpeaker(scene,state.characters,
    [...scene.messages,{role:'user',content:proposed.content}]);
  const recipients=channel==='in_person'?[...cast]:target?[target]:[];
  if(!recipients.length)throw new Error('Scene has no available recipient');
  const provided=[...new Set(proposed.witnessIds)].sort();
  if(!eq([...new Set(recipients)].sort(),provided))
    throw new Error('Player message witness set changed');
  if(recipients.some(id=>!state.characters.some(c=>c.id===id&&!c.trashedAt)))
    throw new Error('Scene cast is unavailable');
  const message={id:proposed.id,role:'user',channelId:channel,
    content:proposed.content,sentAt:proposed.sentAt,witnessIds:recipients};
  scene.messages.push(message);
  scene.updatedAt=Date.now();
  const saved=store.save(state,input.revision,{worldId:input.worldId});
  if(!saved)throw new Error('Story revision changed before player message append');
  return {...saved,worldId:input.worldId,sceneId:scene.id,message};
}
