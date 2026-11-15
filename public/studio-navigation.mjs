// Static Studio navigation and pure command matching; no DOM or story state.
export const WORKSPACE_META=Object.freeze({
  world:{name:'Connical Universe',kicker:'01 · CANON',title:'The Connical Universe behind the story',
    summary:'Manage this universe’s foundation, locations, timelines and relationships. Each Connical Universe has independent canon.',
    tab:'worlds'},
  characters:{name:'Characters',kicker:'02 · PEOPLE',title:'People with lives beyond the scene',
    summary:'Create believable characters with coherent histories, agency and habits. Archived people are recoverable from Trash.',
    tab:'character'},
  encounters:{name:'Encounters',kicker:'03 · STARTING SITUATIONS',title:'Encounters & communication',
    summary:'Create, edit or remove reusable scene starters. Choose between in-person, webcam, calls, texting, social media and email.',
    tab:'worlds'},
  story:{name:'Play',kicker:'04 · LIVE SCENE',title:'Play',summary:'',tab:'scene'},
  memory:{name:'Knowledge',kicker:'05 · CONTINUITY',title:'What each character can remember',
    summary:'World lore, subjective memories and witnessed events are different. Review what each actor can actually know.',
    tab:'context'},
  tools:{name:'Settings & tools',kicker:'06 · LOCAL TOOLS',title:'Your private creative toolkit',
    summary:'Configure local models and visuals, manage archived records and inspect model fidelity—all on this computer.',
    tab:'setup'}
});
// A workbench only shows related tools, rather than thirteen unrelated tabs
// competing for attention in one continuously visible detail drawer.
export const DETAIL_TABS=Object.freeze({
  world:['worlds','atlas','relations','lore'],
  characters:['character','cast','emotion','library'],
  encounters:['worlds','atlas','relations','library'],
  story:['scene','cast','emotion','memory'],
  memory:['context','memory','lore','library'],
  tools:['setup','gallery','context','library']
});
export const visibleDetailTabs=workspace=>DETAIL_TABS[workspace]||DETAIL_TABS.story;
export function searchStudioCommands(commands,term,limit=16){
  const words=String(term||'').trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return commands.filter(item=>{
    const haystack=(item.label+' '+item.detail+' '+item.keywords).toLocaleLowerCase();
    return words.every(word=>haystack.includes(word));
  }).slice(0,limit);
}
