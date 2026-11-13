// Pure roleplay prompt and persistence helpers; no browser dependencies.
export const STORAGE_KEY = 'ai-rp-studio:v1';
export const DEFAULT_SETTINGS = Object.freeze({ model: '', temperature: 0.95, max_tokens: 450, readingMode: false });

export function createCharacter(name = 'New character') {
  return {
    id: crypto.randomUUID(), name, description: '', personality: '', backstory: '',
    scenario: '', greeting: '', color: '#a68dd6',
  };
}

export function createSession(character) {
  return {
    id: crypto.randomUUID(), characterId: character.id, title: `With ${character.name}`,
    messages: character.greeting ? [{ id: crypto.randomUUID(), role: 'assistant', content: character.greeting }] : [],
    summary: '', authorNote: '', updatedAt: Date.now(),
  };
}

export function makeInitialState() {
  const character = {
    ...createCharacter('Mara Vale'),
    description: 'A watchful antiquarian who runs a bookshop in a rain-soaked harbor town.',
    personality: 'Dry wit, careful with trust, curious, quietly compassionate. Never omniscient.',
    backstory: 'Mara inherited the shop from her missing mentor. She knows the town has secrets, but not their answers.',
    scenario: 'Late evening in the harbor bookshop, during a storm. The player has just entered.',
    greeting: 'The bell above the door gives a tired chime. Mara looks up from an old photograph. "We are technically closed," she says, but makes no move to send you away.',
  };
  const session = createSession(character);
  return {
    characters: [character], sessions: [session], activeSessionId: session.id,
    lore: [], persona: { name: 'Player', description: '' }, settings: { ...DEFAULT_SETTINGS },
  };
}

export function normalizeState(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.characters) || !Array.isArray(value.sessions)) {
    return makeInitialState();
  }
  const characters = value.characters.filter(c => c && typeof c.id === 'string' && typeof c.name === 'string');
  const sessions = value.sessions.filter(s => s && typeof s.id === 'string' && typeof s.characterId === 'string' && Array.isArray(s.messages))
    .map(s => ({ ...s, authorNote: typeof s.authorNote === 'string' ? s.authorNote : '',
      messages: s.messages.filter(m => ['user', 'assistant'].includes(m?.role) && typeof m?.content === 'string')
        .map(m => ({ ...m, id: typeof m.id === 'string' ? m.id : crypto.randomUUID(),
          pinned: Boolean(m.pinned),
          variants: m.role === 'assistant' && Array.isArray(m.variants)
            ? m.variants.filter(v => typeof v === 'string').slice(0, 20) : undefined,
        })) }));
  if (!characters.length) return makeInitialState();
  return {
    characters, sessions,
    activeSessionId: sessions.some(s => s.id === value.activeSessionId) ? value.activeSessionId : (sessions[0]?.id || null),
    lore: Array.isArray(value.lore) ? value.lore.filter(l => l && typeof l.content === 'string' && Array.isArray(l.keywords)) : [],
    persona: { name: String(value.persona?.name || 'Player'), description: String(value.persona?.description || '') },
    settings: { ...DEFAULT_SETTINGS, ...value.settings },
  };
}

export function getActiveLore(entries, messages, maxEntries = 4) {
  // Only recent conversation activates the lore; no false positives from the system prompt.
  const text = messages.slice(-6).map(m => m.content).join(' ').toLocaleLowerCase();
  return entries.filter(entry => entry.keywords.some(k => typeof k === 'string' && k.trim() && text.includes(k.trim().toLocaleLowerCase())))
    .slice(0, maxEntries);
}

export function buildMessages({ character, persona, summary = '', authorNote = '', lore = [], history = [] }) {
  if (!character) throw new Error('Select a character first');
  const selectedLore = getActiveLore(lore, history);
  const part = (label, text, cap = 1600) => `${label}:\n${String(text || 'Not specified').slice(0, cap)}`;
  const system = [
    'You are portraying one fictional character in an ongoing literary roleplay. You are not an assistant.',
    'Remain in character. Write dialogue and grounded action in natural prose. React to the player without controlling their actions, thoughts, speech, or feelings.',
    'Respect established events and character knowledge. The character is not omniscient. No meta commentary, explanations of instructions, or forced plot resolutions.',
    'Avoid repetitive phrases. Match the pacing and length of the player, normally 1-4 paragraphs. Leave room for the player to respond.',
    part('Character name', character.name, 120),
    part('Appearance and identity', character.description),
    part('Personality and voice', character.personality),
    part('Backstory and character knowledge', character.backstory),
    part('Scene and premise', character.scenario),
    part('Player name', persona.name, 120),
    part('Player persona', persona.description),
    summary ? part('Canon summary of events so far', summary, 2500) : '',
    history.some(m => m.pinned) ? `Pinned moments (established in this scene):\n${history.filter(m => m.pinned).slice(-5).map(m => `- ${m.role === 'user' ? 'Player' : character.name}: ${String(m.content).slice(0, 650)}`).join('\n')}` : '',
    selectedLore.length ? `Relevant world lore (not necessarily known to the character):\n${selectedLore.map(e => `- ${String(e.content).slice(0, 750)}`).join('\n')}` : '',
    authorNote ? part('Author note — immediate tone and pacing guidance, not new canon', authorNote, 1200) : '',
    'Continue the scene directly. Never write the player character\'s next response.',
  ].filter(Boolean).join('\n\n');
  // Compact older history by character budget; drop oldest complete turns first.
  const recent = [];
  let remaining = 15000;
  for (const item of [...history].reverse()) {
    if (typeof item.content !== 'string' || !['user', 'assistant'].includes(item.role)) continue;
    if (item.content.length > remaining) break;
    recent.unshift({ role: item.role, content: item.content });
    remaining -= item.content.length;
  }
  return { messages: [{ role: 'system', content: system }, ...recent], activatedLore: selectedLore };
}

export function importCharacter(obj) {
  // Own native JSON format, deliberately not claiming support for Tavern PNG cards yet.
  const source = obj && typeof obj === 'object' && obj.character && typeof obj.character === 'object' ? obj.character : obj;
  if (!source || typeof source.name !== 'string' || !source.name.trim()) throw new Error('JSON must include a character name');
  const result = createCharacter(source.name.trim().slice(0, 100));
  for (const key of ['description', 'personality', 'backstory', 'scenario', 'greeting']) {
    if (typeof source[key] === 'string') result[key] = source[key].slice(0, 12000);
  }
  if (typeof source.color === 'string' && /^#[0-9a-f]{6}$/i.test(source.color)) result.color = source.color;
  return result;
}
