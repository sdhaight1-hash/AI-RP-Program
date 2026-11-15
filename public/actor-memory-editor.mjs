// Actor memory UI uses only the authoritative, world-scoped context and fact APIs.
// The current world, scene, revision and settings are read at action time to
// avoid stale async callbacks from another scene or browser world.
export function renderActorMemoryEditor(host,s,api){
  const {$,el,escapeHtml,sceneActor,requireSavedStory,fetch,
    renderInspector,showError,getCurrentTab,getActiveWorldId,
    getActiveSession,getRevision,getSettings}=api;
    const actor=sceneActor(s);
    if(!actor){host.innerHTML='<h2 class="panel-title">No available actor</h2><p class="help">Restore or add an actor first.</p>';return;}
    host.innerHTML='<h2 class="panel-title">Context inspector</h2><p class="help">Reading the exact actor-visible context from SQLite…</p>';
    const requestedScene=s.id,requestedWorld=getActiveWorldId();
    void (async()=>{
      try {
        await requireSavedStory();
        const result=await fetch('/api/actor/context',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({worldId:requestedWorld,sceneId:requestedScene,actorId:actor.id,
            mode:'preview',contextWindow:getSettings().contextWindow||4096,
            max_tokens:getSettings().max_tokens,revision:getRevision()})});
        const prompt=await result.json();
        if(!result.ok)throw new Error(prompt.error||'Context retrieval failed');
        if(getCurrentTab()!=='context'||getActiveWorldId()!==requestedWorld||getActiveSession()?.id!==requestedScene)return;
        const allText=prompt.messages.map(m=>`[${m.role.toUpperCase()}]
${m.content}`).join('\n\n');
        host.innerHTML=`<h2 class="panel-title">Context inspector</h2><p class="help">Server-assembled, actor-scoped prompt. Token numbers are ${escapeHtml(prompt.metadata.countMethod)}.</p><div class="context-stats"><div><strong>${prompt.metadata.promptTokens.toLocaleString()}</strong><span>Prompt tokens</span></div><div><strong>${prompt.metadata.contextWindow.toLocaleString()}</strong><span>Context window</span></div><div><strong>${prompt.metadata.recalled}</strong><span>Retrieved memories</span></div></div><div class="inline-actions"><button id="copy-context" class="subtle-button">Copy prompt</button></div><pre class="context-text" id="context-text"></pre>`;
        const semantic=prompt.metadata.semantic;
        const recallStatus=el('p',
          semantic?.status==='disabled'?'Semantic recall disabled (lexical only).':
          semantic?.status==='fallback'?'Local semantic model unavailable; lexical fallback used.':
          semantic?.status==='no-match'?'Semantic recall enabled; no strong additional match.':
          `Semantic recall: ${semantic?.selected||0} evidence item(s) in final prompt from ${semantic?.candidates||0} candidate(s).`,
          'help');
        $('context-text').before(recallStatus);
        $('context-text').textContent=allText;
        $('copy-context').onclick=async()=>{try{await navigator.clipboard.writeText(allText);}catch{showError('Clipboard unavailable.');}};

        // Reviewed personal knowledge is stored outside the scene transcript.
        // The actor must have witnessed the selected evidence before saving.
        const factsUrl='/api/actor/facts?worldId='+encodeURIComponent(requestedWorld)+
          '&timelineId='+encodeURIComponent(s.timelineId)+'&actorId='+encodeURIComponent(actor.id);
        const factsResponse=await fetch(factsUrl);
        const factData=await factsResponse.json();
        if(!factsResponse.ok)throw new Error(factData.error||'Cannot read character memories');
        if(getCurrentTab()!=='context'||getActiveWorldId()!==requestedWorld||getActiveSession()?.id!==requestedScene)return;
        const section=el('section','','group');
        section.append(el('h3','Character memory notebook','builder-subtitle'),
          el('p','Record a concise belief, promise, or meaningful personal detail. The source must be something this character actually heard or said. These notes are subjective memories, never world canon.','help'));
        for(const fact of factData.facts.slice(0,15)){
          const entry=el('div','','lore-card');
          entry.append(el('strong',fact.kind+' · '+fact.status+(fact.validSource?'':' · source changed (not recalled)')),el('p',fact.text,'help'));
          if(fact.status==='active'){
            const revoke=el('button','Revoke memory','subtle-button');
            revoke.onclick=async()=>{
              try{
                const response=await fetch('/api/actor/facts/revoke',{method:'POST',headers:{'Content-Type':'application/json'},
                  body:JSON.stringify({worldId:requestedWorld,timelineId:s.timelineId,actorId:actor.id,id:fact.id})});
                const result=await response.json();
                if(!response.ok)throw Error(result.error||'Memory revocation failed');
                renderInspector();
              }catch(error){showError(error.message);}
            };
            entry.append(revoke);
          }
          section.append(entry);
        }
        const visibleSources=s.messages.filter(m=>m.id && (
          (m.witnessIds||[]).includes(actor.id) || (m.role==='assistant' && m.speakerId===actor.id)
        )).slice(-40);
        const source=el('select');source.id='fact-source';
        for(const m of visibleSources){
          const label=(m.role==='user'?'Player':m.speakerId===actor.id?'Self':'Other NPC')+': '+m.content.slice(0,85);
          source.add(new Option(label,m.id));
        }
        const kind=el('select');kind.id='fact-kind';
        for(const value of ['belief','promise','relationship','autobiography','observation'])kind.add(new Option(value,value));
        const supersedes=el('select');supersedes.id='fact-supersedes';
        supersedes.add(new Option('No correction — new memory',''));
        for(const fact of factData.facts.filter(x=>x.status==='active' && x.validSource))
          supersedes.add(new Option('Correct: '+fact.text.slice(0,65),fact.id));
        const note=el('textarea');note.id='fact-note';note.rows=3;note.maxLength=700;
        note.placeholder='What does this NPC now remember or believe?';
        const suggestFact=el('button','Ask local AI to suggest memories','subtle-button');
        const suggestionsHost=el('div','','group');
        suggestFact.disabled=!getSettings().model||!visibleSources.length;
        suggestFact.onclick=async()=>{
          suggestFact.disabled=true;
          suggestFact.textContent='Looking for important moments…';
          suggestionsHost.replaceChildren();
          try{
            await requireSavedStory();
            const response=await fetch('/api/actor/facts/suggest',{method:'POST',
              headers:{'Content-Type':'application/json'},
              body:JSON.stringify({worldId:requestedWorld,sceneId:requestedScene,
                actorId:actor.id,revision:getRevision(),model:getSettings().model})});
            const data=await response.json();
            if(!response.ok)throw Error(data.error||'Memory suggestions failed');
            if(getCurrentTab()!=='context'||getActiveWorldId()!==requestedWorld||getActiveSession()?.id!==requestedScene)return;
            if(!data.suggestions.length)suggestionsHost.append(el('p','No significant new memories found in the recent conversation.','help'));
            for(const proposal of data.suggestions){
              const row=el('div','','lore-card');
              row.append(el('strong',proposal.kind),el('p',proposal.text,'help'),
                el('p','From: “'+proposal.quote+'”','help'));
              const review=el('button','Review this suggestion','subtle-button');
              review.onclick=()=>{
                source.value=proposal.sourceMessageId;
                kind.value=proposal.kind;
                note.value=proposal.text;
                note.focus();
              };
              row.append(review);suggestionsHost.append(row);
            }
          }catch(error){showError(error.message);}
          finally{suggestFact.disabled=false;suggestFact.textContent='Ask local AI to suggest memories';}
        };
        const saveFact=el('button','Remember this detail','primary-button');
        saveFact.disabled=!visibleSources.length;
        saveFact.onclick=async()=>{
          if(!note.value.trim())return showError('Write a short character memory first.');
          try {
            await requireSavedStory();
            const response=await fetch('/api/actor/facts',{method:'POST',headers:{'Content-Type':'application/json'},
              body:JSON.stringify({worldId:requestedWorld,sceneId:requestedScene,actorId:actor.id,
                sourceMessageId:source.value,kind:kind.value,text:note.value,revision:getRevision(),
                supersedesId:supersedes.value||null})});
            const result=await response.json();
            if(!response.ok)throw Error(result.error||'Memory was not saved');
            renderInspector();showError();
          }catch(error){showError(error.message);}
        };
        section.append(el('label','Source conversation message','field-label'),source,
          el('label','Kind of memory','field-label'),kind,
          el('label','Correct an earlier belief (optional)','field-label'),supersedes,
          el('label','Subjective memory','field-label'),note,saveFact,suggestFact,suggestionsHost);
        if(!visibleSources.length)section.append(el('p','No witnessed source messages in this scene yet.','help'));
        host.append(section);

      }catch(error){if(getCurrentTab()==='context')host.innerHTML='<h2 class="panel-title">Context inspector</h2><p class="help"></p>',host.querySelector('p').textContent=error.message;}
    })();

}
