// Actor-scoped semantic candidate sampling for small, fixed embedding budgets.
// This selects authorized IDs/text only; scores grant no permission to see data.
import { retrieveActorMemories } from './store.mjs';

export function selectSemanticDialogueCandidates(db,{timelineId,actorId,query,limit=96}){
  const room=Math.max(0,Math.min(160,Math.trunc(Number(limit)||0)));
  if(!room)return [];
  if(!db.prepare('SELECT 1 FROM timeline_actors WHERE timeline_id=? AND actor_id=?')
    .get(timelineId,actorId))throw Error('Actor is not in this timeline');
  const lexicalCap=Math.min(room,Math.ceil(room*0.15));
  const pinnedCap=Math.min(room,Math.ceil(room*0.15));
  const recentCap=Math.min(room,Math.floor(room*0.4));
  const earlyCap=Math.min(room,Math.ceil(room*0.1));
  const middleCap=Math.max(0,room-lexicalCap-pinnedCap-recentCap-earlyCap);
  const cols='id,source_message_id,text';
  const lexical=retrieveActorMemories(db,{timelineId,actorId,query,limit:lexicalCap})
    .map(x=>({id:x.id,source_message_id:x.sourceMessageId,text:x.text}));
  const pinned=db.prepare(`SELECT ${cols} FROM actor_memories
    WHERE timeline_id=? AND actor_id=? AND pinned=1
    ORDER BY occurred_at DESC,rowid DESC LIMIT ?`).all(timelineId,actorId,pinnedCap);
  const recent=db.prepare(`SELECT ${cols} FROM actor_memories
    WHERE timeline_id=? AND actor_id=? ORDER BY occurred_at DESC,rowid DESC LIMIT ?`)
    .all(timelineId,actorId,room);
  const early=db.prepare(`SELECT ${cols} FROM actor_memories
    WHERE timeline_id=? AND actor_id=? ORDER BY occurred_at ASC,rowid ASC LIMIT ?`)
    .all(timelineId,actorId,earlyCap);
  const total=db.prepare('SELECT count(*) AS n FROM actor_memories WHERE timeline_id=? AND actor_id=?')
    .get(timelineId,actorId).n;
  const midpoint=db.prepare(`SELECT ${cols} FROM actor_memories
    WHERE timeline_id=? AND actor_id=? ORDER BY occurred_at ASC,rowid ASC LIMIT 1 OFFSET ?`);
  const middle=[];
  // Deterministic strata represent otherwise-invisible middle-era memories.
  // A bounded pool cannot guarantee implicit recall of every old fact.
  for(let i=0;i<middleCap&&total>0;i++){
    const offset=Math.floor(((i+1)*(total-1))/(middleCap+1));
    const row=midpoint.get(timelineId,actorId,offset);
    if(row)middle.push(row);
  }
  const selected=[],seen=new Set();
  const add=(rows,max=room)=>{
    let accepted=0;
    for(const item of rows){
      if(selected.length>=room||accepted>=max)break;
      if(seen.has(item.id))continue;
      seen.add(item.id);accepted++;
      selected.push({kind:'dialogue',id:item.id,sourceMessageId:item.source_message_id,
        text:'Previously heard: '+item.text,
        embeddingText:item.text.replace(/^(?:Player|You|Another character) said:\s*/u,'')});
    }
  };
  add(lexical,lexicalCap);
  add(pinned,pinnedCap);
  add(recent,recentCap);
  add(early,earlyCap);
  add(middle,middleCap);
  add(recent); // Fill overlap vacancies; never exceed the requested bound.
  return selected;
}
