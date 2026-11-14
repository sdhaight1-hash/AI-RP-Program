// Character Studio fields are durable world identity, not episodic memory.
// Retrieve the specialized parts only when the present topic calls for them.
const categories=[
  {name:'Family and upbringing',pattern:/\b(family|parent|mother|father|mom|dad|sibling|brother|sister|grandparent|childhood|grew up|raised|born|hometown|heritage)\b/iu,keys:['familyHistory','backstory']},
  {name:'Formative history',pattern:/\b(past|history|before|used to|when you were|happened to you|formative|experience|previous life)\b/iu,keys:['formativeEvents','backstory']},
  {name:'Appearance',pattern:/\b(eyes?|hair|face|look like|looks?|appear|height|tall|skin|body|build|wear|clothes?|dress|outfit|style)\b/iu,keys:['facialFeatures','hair','eyes','physique','clothingStyle','description']},
  {name:'Hobbies and interests',pattern:/\b(hobb(?:y|ies)|interest|free time|fun|enjoy|music|books?|reading|sports?|games?|pastime)\b/iu,keys:['hobbies','socialHabits']},
  {name:'Work and routine',pattern:/\b(work|job|school|teach|office|shift|schedule|day|daily|routine|week|busy|occupation)\b/iu,keys:['dailyRoutine','occupation']},
  {name:'Fears and vulnerability',pattern:/\b(afraid|fear|scared|worry|worried|anxious|vulnerable|trauma|insecure)\b/iu,keys:['fears','stressBehavior']},
  {name:'Personal boundaries',pattern:/\b(boundary|boundaries|comfortable|uncomfortable|consent|limit|refuse|principle)\b/iu,keys:['boundaries','comfortBehavior']},
  {name:'Friendship and social life',pattern:/\b(friend|social|relationship|date|dating|love|trust|bond|partner|people)\b/iu,keys:['socialHabits','comfortBehavior']},
];

export function selectCharacterDetails(character,cue,limit=3) {
  const text=String(cue||'').slice(-1000);
  if(!text.trim())return [];
  const candidates=categories.filter(g=>g.pattern.test(text)).map(g=>({
    name:g.name,
    content:g.keys.filter(k=>character?.[k]).map(k=>String(character[k])).join('; ').slice(0,460)
  })).filter(g=>g.content);
  return candidates.slice(0,Math.max(0,Math.min(5,limit)));
}
