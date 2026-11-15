// Narrow, server-authorized fast append for explicitly journal-enabled worlds.
// Never accept a caller-supplied NPC role, witness list or conversation medium.
import {chooseSpeaker} from '../harness.mjs';
import {channelAudience,getChannel} from '../interactions/channels.mjs';
import {journalEnabled,appendVerifiedPlayerRow} from '../storage/append-journal.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function appendAuthorizedPlayerMessage(store,input){
  if(!store?.db||!store?.activeWorldId)
    throw new Error('A request-scoped world database is required');
  if(!input||typeof input!=='object'||Array.isArray(input)||
     Object.keys(input).some(key=>!['worldId','sceneId','revision','messageId','content'].includes(key))||
     input.worldId!==store.activeWorldId||
     typeof input.sceneId!=='string'||!input.sceneId||input.sceneId.length>160||
     !Number.isSafeInteger(input.revision)||input.revision<0||
     typeof input.messageId!=='string'||!UUID.test(input.messageId)||
     typeof input.content!=='string'||!input.content.trim()||input.content.length>30000)
    throw new Error('Invalid world-scoped player append request');
  const db=store.db;
  if(!journalEnabled(db))
    throw new Error('Incremental append is disabled; use the standard save path');
  db.exec('BEGIN IMMEDIATE');
  try {
    // Read only this scene's metadata and participating character profiles:
    // no full historical story JSON or untrusted witness IDs.
    const row=db.prepare('SELECT document FROM story_projection_scenes WHERE scene_id=?')
      .get(input.sceneId);
    if(!row)throw new Error('Scene not found');
    const scene=JSON.parse(row.document);
    if(scene.id!==input.sceneId||scene.trashedAt||
       !scene.timelineId||
       !db.prepare('SELECT 1 FROM timelines WHERE id=? AND world_id=?')
         .get(scene.timelineId,input.worldId))
      throw new Error('Scene is unavailable in this world');
    const channel=getChannel(scene.channelId);
    if(channel.id!==scene.channelId)throw new Error('Unknown scene communication medium');
    const cast=[...new Set(scene.castIds||[scene.characterId])];
    if(!cast.length||cast.length>64||cast.some(id=>typeof id!=='string'||!id||id.length>160))
      throw new Error('Invalid scene cast');
    const placeholders=cast.map(()=>'?').join(',');
    const characters=db.prepare('SELECT document FROM story_projection_characters WHERE character_id IN ('+
      placeholders+')').all(...cast).map(row=>JSON.parse(row.document));
    if(cast.some(id=>!characters.some(c=>c.id===id&&!c.trashedAt)))
      throw new Error('Scene cast changed or is unavailable');
    const previous=db.prepare("SELECT document FROM story_projection_messages WHERE scene_id=? AND json_extract(document,'$.role')='assistant' ORDER BY position DESC LIMIT 1")
      .get(scene.id);
    const lastAssistant=previous?JSON.parse(previous.document):null;
    const target=chooseSpeaker(scene,characters,[
      ...(lastAssistant?[lastAssistant]:[]),{role:'user',content:input.content}
    ]);
    if(!target||!cast.includes(target))throw new Error('No eligible scene speaker');
    const witnesses=channelAudience(channel.id)==='cast'?cast:[target];
    const verify=db.prepare("SELECT 1 FROM timeline_actors WHERE timeline_id=? AND actor_id=? AND controller='npc' AND character_id=?");
    if(witnesses.some(id=>!verify.get(scene.timelineId,id,id)))
      throw new Error('Scene participant is not an authorized timeline actor');
    const now=Date.now();
    const message={id:input.messageId,role:'user',content:input.content,
      channelId:channel.id,witnessIds:witnesses,sentAt:now};
    const result=appendVerifiedPlayerRow(db,{
      sceneId:scene.id,message,expectedRevision:input.revision,updatedAt:now
    });
    db.exec('COMMIT');
    return {worldId:input.worldId,sceneId:scene.id,...result};
  }catch(error){
    if(db.isTransaction)db.exec('ROLLBACK');
    throw error;
  }
}
