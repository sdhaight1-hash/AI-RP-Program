// World-scoped transport boundary for the browser. Keep tab selection local
// to the caller; never depend on the server's process-wide default world.
export const worldPath=(path,worldId)=>
  worldId ? `${path}${path.includes('?')?'&':'?'}worldId=${encodeURIComponent(worldId)}` : path;

async function getJson(fetchImpl,path){
  const response=await fetchImpl(path);
  let data;
  try{data=await response.json();}
  catch{throw new Error('World service returned an invalid response');}
  if(!response.ok){
    const error=new Error(data?.error||`World service returned ${response.status}`);
    error.status=response.status;
    throw error;
  }
  return data;
}

export async function loadWorldSnapshot(fetchImpl,worldId){
  const state=await getJson(fetchImpl,worldPath('/api/state',worldId));
  if(worldId && state.worldId!==worldId)
    throw new Error('World service returned data from a different world');
  return state;
}

export async function loadWorldCatalog(fetchImpl,worldId){
  const library=await getJson(fetchImpl,worldPath('/api/worlds',worldId));
  if(worldId && library.activeWorldId!==worldId)
    throw new Error('World service returned a different world catalog');
  return library;
}
