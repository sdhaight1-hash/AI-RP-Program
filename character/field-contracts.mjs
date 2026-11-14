// The purpose, evidence dependencies, and exclusion boundaries of every
// persistent Character Studio field. New generated values are always drafts.
// Timeline state, current emotions, scenes, and encounters are never inferred.
import { CHARACTER_V2_FIELDS } from './schema.mjs';

const rule=(purpose,related=[],boundary='')=>Object.freeze({purpose,related,boundary});
export const CHARACTER_FIELD_CONTRACTS=Object.freeze({
  name:rule('A stable personal name appropriate to the established world and origin.',['aliases','age','backstory'],'Do not rename an existing actor or related world entity.'),
  handle:rule('The usual messaging username or handle, when a messaging medium exists.',['name','aliases','occupation','textStyle'],'Not an assumed current online status or a universal nickname.'),
  tagline:rule('A single brief out-of-character character-library introduction conveying a defining hook.',['personality','occupation','motivations','description'],'Not a biography, dialogue sample, or in-world event.'),
  age:rule('Canonical age at the world timeline reference point, only when chronology supports it.',['backstory','familyHistory','formativeEvents'],'Do not assert a birthdate or timeline date without evidence.'),
  pronouns:rule('The pronouns used to refer to this character.',['name','description'],'Do not infer pronouns from appearance or name alone.'),
  aliases:rule('Known nicknames, aliases and who uses them, if established.',['name','familyHistory','socialHabits'],'Do not create separate identities or claim they are used by people not yet established.'),
  occupation:rule('Established work, study, vocation or community role and ordinary responsibilities.',['age','backstory','dailyRoutine','preferredEnvironment'],'No workplace teleportation or claim of a currently active shift.'),
  description:rule('An enduring, nonredundant outward impression of the character.',['facialFeatures','hair','eyes','physique','clothingStyle','age'],'Not a scene, current pose, temporary outfit, or new biography.'),
  facialFeatures:rule('Facial structure, complexion, distinct marks and characteristic expressions.',['description','age','personality'],'No clothes, manner of speaking, or generic whole-body description.'),
  hair:rule('Hair color, texture, length and customary grooming.',['description','clothingStyle'],'Not an unconfirmed hairstyle worn today.'),
  eyes:rule('Eye color, shape and distinctive visible characteristics.',['description','facialFeatures'],'Not emotions or a particular gaze in a live scene.'),
  physique:rule('Stable height, frame, build, posture and proportions without contradictions.',['description','age','occupation'],'Not an action sequence or current outfit.'),
  clothingStyle:rule('Usual aesthetic, recurring clothing preferences and grooming habits.',['description','occupation','preferredEnvironment','personality'],'Not clothing currently worn or a new place of residence.'),
  personality:rule('Core temperament, habitual choices and observable behavior across situations.',['values','motivations','contradictions','stressBehavior','comfortBehavior','socialHabits'],'Not backstory, permanent emotion, a list of adjectives or scripted player reactions.'),
  values:rule('Deep ethical commitments, priorities, loyalties and the tradeoffs they guide.',['personality','motivations','familyHistory','backstory'],'Not momentary feelings or a restatement of generic personality traits.'),
  contradictions:rule('Specific tensions between established values, desires and actual habits, with behavioral consequences.',['personality','values','motivations','fears','stressBehavior'],'Not random incompatible traits or an unrelated trauma invented for drama.'),
  stressBehavior:rule('Observable coping, avoidance, decision-making and communication under pressure.',['personality','fears','conflictStyle','values'],'Not a permanent mood, diagnostic label, or a forced reaction in every scene.'),
  comfortBehavior:rule('How behavior, speech and routines change around safety, familiarity or trust.',['personality','socialHabits','speechStyle','stressBehavior'],'Not automatic trust toward the player or an assumed relationship.'),
  conflictStyle:rule('Patterns of disagreement, escalation, withdrawal, repair and apology.',['personality','values','stressBehavior','boundaries','speechStyle'],'Not a forced argument or a scripted outcome.'),
  socialHabits:rule('How the character maintains relationships, contacts others, hosts, and spends time socially.',['personality','values','familyHistory','hobbies','dailyRoutine'],'Not another character’s private feelings or an invented confirmed relationship.'),
  backstory:rule('Concise canonical life chronology and established long-running circumstances.',['age','occupation','familyHistory','formativeEvents','preferredEnvironment'],'Not a present scenario, current location, or omniscient knowledge.'),
  familyHistory:rule('Family structure, upbringing and meaningful established kinship dynamics.',['backstory','age','values','socialHabits'],'Do not invent specific named relatives or assert new world entities as established fact.'),
  formativeEvents:rule('Particular earlier experiences and the lasting behavioral effect of each.',['backstory','familyHistory','values','personality','fears'],'Not current events, free-floating melodrama, or another biography overview.'),
  motivations:rule('Independent medium- and long-term desires, needs, plans and competing priorities.',['values','personality','occupation','fears','backstory'],'Not a plan to serve or automatically fall in love with the player.'),
  fears:rule('Specific vulnerabilities, apprehensions and what situations activate them.',['formativeEvents','personality','motivations','stressBehavior'],'Not mental-health diagnoses or a requirement to react identically every time.'),
  boundaries:rule('Personal limits, consent preferences and the kinds of choices the character declines.',['values','personality','conflictStyle','fears'],'Not absolute scripting of other people or censorship rules.'),
  hobbies:rule('Voluntary interests, skills practiced and how the character enjoys free time.',['personality','occupation','socialHabits','preferredEnvironment'],'Not their job duties or a claimed current activity.'),
  preferredEnvironment:rule('Typical surroundings, sensory preferences and places they favor or avoid.',['personality','dailyRoutine','hobbies','occupation','backstory'],'Not where they are right now; use known named world places only when supported.'),
  dailyRoutine:rule('Typical weekly and daily rhythms, habits, recurring obligations and flexibility.',['occupation','hobbies','preferredEnvironment','socialHabits'],'Not an immutable schedule or automatic relocation to a familiar place.'),
  speechStyle:rule('Underlying cadence, vocabulary, humor, register and distinctive verbal habits across media.',['personality','values','socialHabits','exampleDialogue'],'Not literal scripted responses or specific actions by the player.'),
  inPersonStyle:rule('How voice, pauses, gesture, posture and eye contact shape an in-person conversation.',['speechStyle','personality','comfortBehavior','conflictStyle'],'Not phone-only or text-only cues; avoid describing player actions.'),
  phoneStyle:rule('Audible voice, timing, pauses, interruption habits and speech when physical cues are absent.',['speechStyle','personality','conflictStyle','inPersonStyle'],'No eye contact, clothing, visible movement or physical co-presence.'),
  textStyle:rule('Text-message length, spelling, punctuation, abbreviation, emoji and reply rhythms.',['speechStyle','personality','socialHabits','phoneStyle'],'Not spoken stage directions or fictional read receipts.'),
  exampleDialogue:rule('Short examples demonstrating consistent voice in several situations and media.',['speechStyle','inPersonStyle','phoneStyle','textStyle','personality'],'These are illustrative samples, NOT canon events, past conversations or player commitments.')
});

if(CHARACTER_V2_FIELDS.some(k=>!CHARACTER_FIELD_CONTRACTS[k]))
  throw new Error('Every persistent character field needs an explicit authoring contract');

export function fieldInstruction(key) {
  const c=CHARACTER_FIELD_CONTRACTS[key];
  if(!c)throw new Error('Unknown character field');
  return `${key}: ${c.purpose} Boundary: ${c.boundary}`;
}
