// A universe blueprint is a world-local, versioned authoring foundation.
// It is independent of event timelines, personal memories and the registry.
import {MAX_AUTHORED_TEXT} from './geography.mjs';
export const UNIVERSE_BLUEPRINT_FIELDS=Object.freeze({
  scope:{label:'Scale & geography',max:MAX_AUTHORED_TEXT,purpose:'Boundaries of the setting: city, planet, system, realms or multiverse; key geography and travel limits'},
  era:{label:'Era & technology',max:MAX_AUTHORED_TEXT,purpose:'Calendar assumptions, approximate historical era, available technology and ordinary infrastructure'},
  genre:{label:'Genre & mood',max:MAX_AUTHORED_TEXT,purpose:'Genre expectations, narrative mood and everyday emotional texture'},
  rules:{label:'Physical & metaphysical rules',max:MAX_AUTHORED_TEXT,purpose:'Ground rules for physics, magic, science, supernatural phenomena and their explicit limits'},
  society:{label:'Cultures & institutions',max:MAX_AUTHORED_TEXT,purpose:'Major cultural practices, social structures, economies, governance and daily life'},
  conflicts:{label:'Tensions & active pressures',max:MAX_AUTHORED_TEXT,purpose:'Unresolved disputes, pressures, mysteries and realistic opportunities; not predetermined outcomes'},
  themes:{label:'Themes & storytelling boundaries',max:MAX_AUTHORED_TEXT,purpose:'Core motifs, intended themes and constraints on what the setting does or does not contain'}
});
export const emptyUniverseBlueprint=()=>Object.fromEntries(Object.keys(UNIVERSE_BLUEPRINT_FIELDS).map(key=>[key,'']));
export function normalizeUniverseBlueprint(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value))
    throw Error('Universe blueprint must be an object');
  const unexpected=Object.keys(value).find(key=>!UNIVERSE_BLUEPRINT_FIELDS[key]);
  if(unexpected)throw Error('Unknown universe blueprint field: '+unexpected);
  const result=emptyUniverseBlueprint();
  for(const [key,contract] of Object.entries(UNIVERSE_BLUEPRINT_FIELDS)){
    const field=value[key]??'';
    if(typeof field!=='string'||field.length>contract.max)
      throw Error(contract.label+' must contain at most '+contract.max+' characters');
    result[key]=field.trim();
  }
  return result;
}
