// Fidelity Lab presentation only. Local-model inference and reviewed writes
// remain owned by the character controller; this module cannot mutate canon.
import {FIDELITY_PROBES,FIDELITY_RATINGS,normalizeFidelityReviews,makeFidelityProbe} from '../fidelity.mjs';
import {getChannel} from '../interactions/channels.mjs';

export function renderFidelityLab(host,character,api){
  const {el,$,renderBuilder,runFidelityProbe,runLocalModelAssessment,
    renderLocalModelReport,save,builderCharacter,
    getSelectedProbe,setSelectedProbe,getFidelityController,
    getLocalEvalController,getAiDraftController,getWorldEntryController,
    getLocalEvalReport,getFidelityDraft,setFidelityDraft,isRunning}=api;
  host.append(el('h3','Character fidelity lab','builder-subtitle'),el('p','Generate one isolated test reply at a time. Rate what the character actually said; nothing here enters the story, world ledger, or NPC memory.','help'));
  const current = FIDELITY_PROBES.find(p => p.id === getSelectedProbe()) || FIDELITY_PROBES[0];
  const label = el('label','Test scenario','field-label');label.htmlFor='fidelity-probe';
  const select = document.createElement('select'); select.id='fidelity-probe';
  for (const probe of FIDELITY_PROBES) select.add(new Option(`${probe.label} (${getChannel(probe.channelId).label})`,probe.id));
  select.value=current.id;
  select.onchange = () => { getFidelityController()?.abort();setSelectedProbe(select.value);setFidelityDraft(null);renderBuilder(); };
  const prompt = el('p',`Player says: “${current.playerMessage}”`,'fidelity-prompt');
  const objective = el('p',current.objective,'help');
  const actions=el('div','','inline-actions');
  const run=el('button','✧ Generate test reply','primary-button');run.id='fidelity-run';
  const stop=el('button','Stop','subtle-button');stop.id='fidelity-stop';stop.classList.toggle('hidden',!getFidelityController());
  run.disabled=!!getFidelityController() || !!getLocalEvalController() || !!getAiDraftController() || isRunning();
  run.onclick=()=>runFidelityProbe();stop.onclick=()=>getFidelityController()?.abort();actions.append(run,stop);
  const status=el('p',getFidelityController()?'Model is generating…':'Each run tests the currently saved profile. Comparisons are qualitative, not scientific personality scores.','builder-note');status.id='fidelity-status';
  host.append(label,select,prompt,objective,actions,status);
  const assessment=el('section','','group');
  assessment.append(el('h4','Real local-model assessment','builder-subtitle'),
    el('p','Run seven read-only synthetic tests against your loaded chat model: three compartmentalized character fields, three voice/agency/channel probes and one character-to-world extraction. Optionally test the configured local embedding model. Timing and warnings are diagnostic, not a personality score.','help'));
  const evalActions=el('div','','inline-actions');
  const runEval=el('button','Run local model assessment','subtle-button');
  const cancelEval=el('button','Cancel assessment','subtle-button');
  runEval.disabled=Boolean(getLocalEvalController()||getFidelityController()||getAiDraftController()||getWorldEntryController()||isRunning());
  cancelEval.classList.toggle('hidden',!getLocalEvalController());
  runEval.onclick=runLocalModelAssessment;cancelEval.onclick=()=>getLocalEvalController()?.abort();
  evalActions.append(runEval,cancelEval);
  assessment.append(evalActions,el('p',getLocalEvalController()?'Evaluation running…':'The assessment never changes your stories or world records.','help'));
  const reportArea=el('div','','group');reportArea.id='local-eval-report';
  assessment.append(reportArea);host.append(assessment);
  if(getLocalEvalReport())renderLocalModelReport(getLocalEvalReport());

  const draft=getFidelityDraft()?.characterId===character.id && getFidelityDraft()?.probeId===current.id ? getFidelityDraft() : null;
  if (draft) {
    host.append(el('h4','Test reply','builder-subtitle'));
    const output=el('div',draft.reply,'fidelity-reply');output.id='fidelity-reply';host.append(output);
    if(draft.warnings.length){
      const notice=el('div','','fidelity-warnings');notice.append(el('strong','Possible issues (heuristics, not guarantees):'));
      for(const warning of draft.warnings)notice.append(el('p',warning));host.append(notice);
    }
    const rubric=el('div','','fidelity-rubric');rubric.append(el('h4','Human review (1 = poor, 5 = excellent)','builder-subtitle'));
    for(const key of FIDELITY_RATINGS){
      const row=el('label','','fidelity-rating');row.append(el('span',key[0].toUpperCase()+key.slice(1)));
      const rating=document.createElement('select');rating.id=`fidelity-rating-${key}`;
      rating.add(new Option('Not rated',''));
      for(let n=1;n<=5;n++)rating.add(new Option(String(n),String(n)));
      row.append(rating);rubric.append(row);
    }
    const notesLabel=el('label','Reviewer notes','field-label');notesLabel.htmlFor='fidelity-notes';
    const notes=document.createElement('textarea');notes.id='fidelity-notes';notes.rows=3;notes.maxLength=1800;
    notes.placeholder='What sounded in-character? Where did the model miss the voice, boundaries, or medium?';
    const saveReview=el('button','Save reviewed result','primary-button');saveReview.id='fidelity-save';
    saveReview.onclick=()=>{
      if(!getFidelityDraft() || getFidelityDraft() !== draft || builderCharacter()?.id!==character.id)return;
      const ratings=Object.fromEntries(FIDELITY_RATINGS.map(key=>[key,Number($(`fidelity-rating-${key}`).value)||null]));
      if(!Object.values(ratings).some(Number.isInteger)){status.textContent='Rate at least one dimension to save this review.';return;}
      const record={id:crypto.randomUUID(),probeId:draft.probeId,reply:draft.reply,model:draft.model,
        profileFingerprint:draft.profileFingerprint,reviewedAt:Date.now(),ratings,notes:notes.value};
      character.fidelityReviews=normalizeFidelityReviews([...(character.fidelityReviews||[]),record]);
      setFidelityDraft(null);save();renderBuilder();
    };
    host.append(rubric,notesLabel,notes,saveReview);
  }
  const reviews=normalizeFidelityReviews(character.fidelityReviews);
  const past=el('section','','fidelity-history');past.append(el('h4',`Saved reviews (${reviews.length})`,'builder-subtitle'));
  for(const review of [...reviews].reverse().slice(0,8)){
    const record=el('div','','fidelity-history-item');
    const scenario=FIDELITY_PROBES.find(p=>p.id===review.probeId)?.label || review.probeId;
    const summary=Object.entries(review.ratings).filter(([,v])=>v!==null).map(([k,v])=>`${k}: ${v}/5`).join(' · ');
    record.append(el('strong',`${scenario} · ${review.model || 'local model'}`),el('p',summary||'Not rated'),el('p',review.reply.length>220?review.reply.slice(0,220)+'…':review.reply));
    if(review.notes)record.append(el('p',review.notes));
    if(review.profileFingerprint!==makeFidelityProbe({character,probeId:review.probeId}).profileFingerprint){
      record.append(el('p','Character profile changed since this test.','fidelity-stale'));
    }
    past.append(record);
  }
  host.append(past);
}
