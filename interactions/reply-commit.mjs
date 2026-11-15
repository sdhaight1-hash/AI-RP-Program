// One authoritative NPC reply transition, shared by HTTP commit and tests.
// The browser never defines an acting character's generated text or source ID;
// that data comes from a completed, server-owned model stream.
import {settleEmotion} from '../engine.mjs';
import {channelAudience,getChannel} from './channels.mjs';
import {isReplyBasisCurrent} from './reply-review.mjs';

export function applyCompletedNpcReply(state,lease,{reviewed=false}={}){
  if(!state||!Array.isArray(state.sessions)||!Array.isArray(state.characters))
    throw new Error('No authoritative story state');
  if(typeof reviewed!=='boolean')throw new Error('Invalid review choice');
  if(!['normal','continue','retry'].includes(lease?.mode)||
    typeof lease?.text!=='string'||!lease.text.trim()||lease.text.length>30000)
    throw new Error('Invalid or empty completed NPC response');
  const scene=state.sessions.find(s=>s.id===lease.sceneId&&!s.trashedAt);
  if(!isReplyBasisCurrent(scene,lease.basis))
    throw new Error('Scene changed during NPC generation; retry from the current story');
  const actor=state.characters.find(c=>c.id===lease.actorId&&!c.trashedAt);
  if(!actor || !(scene.castIds||[scene.characterId]).includes(lease.actorId))
    throw new Error('Acting character is no longer available in the scene');
  const previous=scene.messages.at(-1);
  if(lease.mode==='retry'){
    if(previous?.role!=='assistant'||(previous.speakerId||scene.characterId)!==lease.actorId)
      throw new Error('Retry no longer refers to the acting NPC reply');
    const variants=Array.isArray(previous.variants)&&previous.variants.length
      ?[...previous.variants]:[previous.content];
    if(!variants.includes(lease.text))variants.push(lease.text);
    previous.content=lease.text;
    previous.variants=variants.slice(-20);
    previous.variantIndex=previous.variants.indexOf(previous.content);
    if(previous.variantIndex<0)previous.variantIndex=previous.variants.length-1;
    if(reviewed)previous.reviewedDraft=true;
  }else{
    const channel=getChannel(scene.channelId);
    const witnesses=channelAudience(channel.id)==='cast'?
      [...(scene.castIds||[scene.characterId])]:[lease.actorId];
    if(scene.messages.some(m=>m.id===lease.messageId))
      throw new Error('NPC reply source ID is already used');
    scene.messages.push({
      id:lease.messageId,role:'assistant',speakerId:lease.actorId,
      channelId:channel.id,witnessIds:witnesses,content:lease.text,
      sentAt:lease.completedAt,...(reviewed?{reviewedDraft:true}:{})
    });
    if((scene.castIds||[]).length>1){
      scene.emotionByActor ||= {};
      scene.emotionByActor[lease.actorId]=settleEmotion(scene.emotionByActor[lease.actorId]||scene.emotion);
    }else scene.emotion=settleEmotion(scene.emotion);
  }
  scene.updatedAt=Date.now();
  return scene.messages.at(-1);
}
