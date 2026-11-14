// Static Studio navigation and pure command matching; no DOM or story state.
export const WORKSPACE_META=Object.freeze({
  world:{name:'World & canon',kicker:'THE UNIVERSE',title:'The world behind the story',
    summary:'A consistent setting with its own places, people, relationships and independent timelines. Edit canon deliberately; scenes do not silently rewrite it.',
    tab:'worlds'},
  characters:{name:'Characters',kicker:'THE CAST',title:'People with lives beyond the scene',
    summary:'Build distinct personalities, histories, routines and voices rooted in this world. Reviewed character details can inform new world canon without forcing it.',
    tab:'character'},
  story:{name:'Story room',kicker:'LIVE STORY',title:'Story room',summary:'',tab:'scene'},
  memory:{name:'Memory & review',kicker:'EVIDENCE & CONTINUITY',title:'What each character can remember',
    summary:'Witnessed dialogue, reviewed subjective beliefs and objective world events are different kinds of knowledge. Review the evidence before making it canon.',
    tab:'context'},
  tools:{name:'Models & lab',kicker:'LOCAL INFRASTRUCTURE',title:'Your private creative toolkit',
    summary:'Choose a local model, inspect exactly what it sees, test character fidelity, evaluate semantic recall and manage visual workflows—all from this machine.',
    tab:'setup'}
});
export function searchStudioCommands(commands,term,limit=16){
  const words=String(term||'').trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return commands.filter(item=>{
    const haystack=(item.label+' '+item.detail+' '+item.keywords).toLocaleLowerCase();
    return words.every(word=>haystack.includes(word));
  }).slice(0,limit);
}
