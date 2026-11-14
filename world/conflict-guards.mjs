// Guard irreversible identity/history removals in the authoritative save path.
// Neither a stale browser backup nor a full-document PUT is a deletion grant.
import {purgeArchived} from '../harness.mjs';

export class DeletionConflictError extends Error {
  constructor(message){super(message);this.name='DeletionConflictError';}
}

const recordIds=list=>new Set((list||[]).map(x=>x.id));

export function assertExplicitPurges(previous,next,{
  purgedCharacterId=null,purgedSceneId=null
}={}) {
  if(!previous){
    if(purgedCharacterId||purgedSceneId)
      throw new DeletionConflictError('There is no existing library record to purge');
    return;
  }
  const removedCharacters=(previous.characters||[]).filter(c=>
    !recordIds(next.characters).has(c.id));
  const removedScenes=(previous.sessions||[]).filter(s=>
    !recordIds(next.sessions).has(s.id));

  if(removedCharacters.length!==Number(Boolean(purgedCharacterId)) ||
     removedScenes.length!==Number(Boolean(purgedSceneId)) ||
     (purgedCharacterId&&removedCharacters[0]?.id!==purgedCharacterId) ||
     (purgedSceneId&&removedScenes[0]?.id!==purgedSceneId))
    throw new DeletionConflictError(
      'Removing an existing character or scene requires the confirmed Library & Trash permanent-delete action. Archive first.'
    );

  // Never trust an API caller's claim that a record is safely removable.
  // Re-evaluate the original saved state, including fork/encounter dependencies,
  // inside the same SQLite write transaction as the final story revision.
  if(purgedCharacterId||purgedSceneId) {
    const expected=structuredClone(previous);
    try {
      if(purgedSceneId)purgeArchived(expected,'scene',purgedSceneId);
      if(purgedCharacterId)purgeArchived(expected,'character',purgedCharacterId);
    }catch(error){
      throw new DeletionConflictError(error.message);
    }
  }
}
