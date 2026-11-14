// Static Character Studio field layout. Kept separate from the large browser
// controller so field ownership can be audited against the durable schema.
export const BUILDER_SECTIONS = {
  identity: [
    ['name','Name','text','World-specific character identity.'],
    ['aliases','Aliases and nicknames','text','Names used by friends, family, or acquaintances.'],
    ['age','Age','text','Age in this world and canonical point in history.'],
    ['pronouns','Pronouns','text','Optional pronouns for dialogue and narration.'],
    ['handle','Messaging handle','text','Optional social username for worlds with messaging.'],
    ['tagline','One-line introduction','text','Public description in the character library.'],
    ['color','Character accent','color','Personal color; separate from the UI theme.'],
  ],
  appearance: [
    ['description','Appearance overview','textarea','Canonical visible identity; not a current outfit or scene.'],
    ['facialFeatures','Face and distinguishing features','textarea','Face shape, complexion, freckles, marks, and habitual expressions.'],
    ['hair','Hair','text','Color, length, texture and ordinary styling.'],
    ['eyes','Eyes','text','Color and distinctive characteristics.'],
    ['physique','Physical build','textarea','Height, frame, posture, proportions; avoid contradictory descriptors.'],
    ['clothingStyle','Typical fashion and grooming','textarea','Usual aesthetic, clothing preferences and self-presentation.'],
  ],
  mind: [
    ['personality','Temperament and personality','textarea','Defining tendencies and context-specific behavior.'],
    ['values','Core values','textarea','What they believe, prioritize and will stand up for.'],
    ['contradictions','Contradictions','textarea','Tensions between desires, ideals and habits.'],
    ['stressBehavior','When stressed','textarea','Observable coping responses rather than abstract adjectives.'],
    ['comfortBehavior','When relaxed or comfortable','textarea','How familiarity and safety change their behavior.'],
    ['conflictStyle','Conflict and reconciliation','textarea','How they disagree, apologize and make amends.'],
    ['motivations','Motivations and goals','textarea','What they seek beyond the player character.'],
    ['fears','Fears and vulnerabilities','textarea','Specific fears, insecurities and sensitive subjects.'],
    ['boundaries','Personal boundaries','textarea','What they will decline or resist.'],
  ],
  history: [
    ['backstory','Life overview','textarea','Established personal history, not universal world knowledge.'],
    ['familyHistory','Family and upbringing','textarea','Family circumstances and meaningful ties.'],
    ['formativeEvents','Formative events','textarea','Specific past experiences that shaped present behavior.'],
  ],
  life: [
    ['occupation','Occupation / role','text','What they do for work, study or community life.'],
    ['hobbies','Hobbies and interests','textarea','How they spend their own free time.'],
    ['preferredEnvironment','Preferred environment','textarea','Atmospheres and surroundings they gravitate toward; not current location.'],
    ['dailyRoutine','Daily and weekly rhythms','textarea','Typical schedules, habits and exceptions; not rigid teleportation rules.'],
    ['socialHabits','Social habits','textarea','How they maintain friendships, communicate and spend time with others.'],
  ],
  voice: [
    ['speechStyle','Distinctive voice','textarea','Pacing, vocabulary, cadence, humor, regionalisms.'],
    ['inPersonStyle','In-person speaking style','textarea','Body language and conversational rhythms when physically together.'],
    ['phoneStyle','Phone-call speaking style','textarea','Audible mannerisms, pauses and tone; no visual gestures.'],
    ['textStyle','Messaging style','textarea','Message length, punctuation, emojis and sending habits.'],
    ['exampleDialogue','Example exchanges','textarea','Demonstrations of voice, not events assumed to have happened.'],
  ],
};
