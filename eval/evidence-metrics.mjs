// Case-level annotated evidence scoring for the deterministic recall funnel.
// False positives count non-gold source IDs, including irrelevant memories
// returned alongside a correct answer. This evaluator does not infer truth.
const unique=ids=>[...new Set((ids||[]).filter(x=>typeof x==='string'&&x))];

export function measureEvidenceStage(cases,selectIds){
  if(!Array.isArray(cases)||typeof selectIds!=='function')
    throw new TypeError('Annotated cases and source selector required');
  let positives=0,negatives=0,hits=0,returned=0,falseSources=0,negativeHits=0;
  for(const row of cases){
    if(!row||typeof row.id!=='string'||!row.id||
       !(row.gold===null||(typeof row.gold==='string'&&row.gold)))
      throw new Error('Invalid annotated evidence case');
    const selected=unique(selectIds(row));
    returned+=selected.length;
    if(row.gold===null){
      negatives++;
      if(selected.length)negativeHits++;
      falseSources+=selected.length;
    }else{
      positives++;
      if(selected.includes(row.gold))hits++;
      falseSources+=selected.filter(id=>id!==row.gold).length;
    }
  }
  return {
    positiveCases:positives,negativeCases:negatives,
    correctSourceCases:hits,returnedSources:returned,
    irrelevantSources:falseSources,negativeCasesWithRetrieval:negativeHits,
    sourcePrecision:returned?(returned-falseSources)/returned:0,
    sourceRecall:positives?hits/positives:0,
    negativeQueryFalsePositiveRate:negatives?negativeHits/negatives:0
  };
}

export function measureEvidenceFunnel(cases,budgets=[2048,4096,8192]){
  const uniqueBudgets=[...new Set(budgets)];
  if(uniqueBudgets.some(x=>!Number.isSafeInteger(x)||x<256))
    throw new Error('Invalid context budget');
  const final={};
  for(const budget of uniqueBudgets)
    final[budget]=measureEvidenceStage(cases,row=>row.windows?.[budget]?.evidenceIds||[]);
  return {
    lexical:measureEvidenceStage(cases,row=>row.lexicalIds),
    semantic:measureEvidenceStage(cases,row=>row.selectedIds),
    postTrim:final,
    note:'Annotated synthetic source precision/recall, not a real local embedding accuracy benchmark'
  };
}
