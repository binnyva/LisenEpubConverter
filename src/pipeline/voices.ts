import fs from 'node:fs';
import path from 'node:path';
import type { WorkDir } from '../state.js';
import { BOOK_STORY_ID, CastingSchema, ChapterScriptSchema, VoiceBindingsSchema, type BookMetadata, type CastSpeaker, type Casting, type VoiceBinding, type VoiceBindings } from '../types.js';
import { config } from '../config.js';
import { readCharacterRegistry } from './cast.js';
import { METADATA_FILE, SCRIPTS_DIR, listChapterFiles } from '../layout.js';
import { readStories } from './stories.js';
import { defaultVoiceTarget, loadVoiceLibrary, modelId, type LibraryVoice, type VoiceTarget } from '../voices/library.js';
import { reportProgress } from '../util/progress.js';

/** Stage 5: apply one compatible library model to a provider-neutral cast. */
export function runVoices(work: WorkDir, target = defaultVoiceTarget(), libraryFile = config.voiceLibraryFile): VoiceBindings {
  reportProgress({ activity: 'Loading voice catalogue and validating scripted speakers' });
  const library = loadVoiceLibrary(libraryFile);
  const targetId = modelId(target);
  const model = library.models.find((entry) => entry.id === targetId);
  if (!model || model.availability === 'unavailable') throw new Error(`Voice library has no available catalogue for ${target.provider}/${target.model}.`);
  const candidates = library.voices.filter((voice) => voice.models.includes(targetId) && voice.availability !== 'unavailable');
  if (!candidates.length) throw new Error(`Voice library has no voices compatible with ${target.provider}/${target.model}.`);
  const casting = readCasting(work);
  validateScriptSpeakers(work, casting);
  // Casting can specify a character's spoken language, but most profiles leave
  // it unknown. In that case the source language is the safe default: an
  // automatic binding must not select a voice intended for another language.
  const bookLanguage = fs.existsSync(work.path(METADATA_FILE))
    ? work.readJson<BookMetadata>(METADATA_FILE).language
    : undefined;

  const existing = fs.existsSync(work.path('voice-bindings.json'))
    ? VoiceBindingsSchema.parse(work.readJson('voice-bindings.json'))
    : undefined;
  const groups = speakerGroups(work, Object.keys(casting.characters));
  const totalSpeakers = Object.keys(casting.characters).length + 1;
  reportProgress({ activity: 'Matching narrator and character voices', completedUnits: 0, totalUnits: totalSpeakers, unit: 'speakers matched' });
  // The narrator's voice is reserved for the whole book; character voices are
  // allocated story by story. Two characters in one story should not share a
  // voice while the catalogue still has one free, but characters in separate
  // stories never share a scene and can safely reuse the same voice.
  const reserved = new Set<string>();
  const narrator = chooseBinding(casting.narrator, existing?.narrator, candidates, target, model.supportsInstructions, reserved, bookLanguage);
  reserved.add(narrator.libraryVoiceId);
  reportProgress({ activity: 'Matched narrator voice', completedUnits: 1, totalUnits: totalSpeakers, unit: 'speakers matched' });
  const characters: Record<string, VoiceBinding> = {};
  for (const group of groups) {
    const used = new Set(reserved);
    for (const name of group) {
      characters[name] = chooseBinding(casting.characters[name], existing?.characters[name], candidates, target, model.supportsInstructions, used, bookLanguage);
      used.add(characters[name].libraryVoiceId);
      reportProgress({ activity: `Matched voice for ${name}`, completedUnits: Object.keys(characters).length + 1, totalUnits: totalSpeakers, unit: 'speakers matched' });
    }
  }
  const bindings: VoiceBindings = {
    version: 1,
    libraryFile: path.resolve(libraryFile),
    target,
    narrator,
    characters,
  };
  work.writeJson('voice-bindings.json', bindings);
  reportProgress({ activity: 'Voice bindings saved', phase: 'completed', completedUnits: totalSpeakers, totalUnits: totalSpeakers, unit: 'speakers matched' });
  return bindings;
}

/** Fail before paid synthesis if the cast and selected library target diverge. */
export function validateVoiceBindings(work: WorkDir): VoiceBindings {
  if (!fs.existsSync(work.path('voice-bindings.json'))) {
    throw new Error('Voice bindings are missing. Run the voices stage before synthesis.');
  }
  const bindings = VoiceBindingsSchema.parse(work.readJson('voice-bindings.json'));
  const casting = readCasting(work);
  const library = loadVoiceLibrary(bindings.libraryFile);
  const model = library.models.find((entry) => entry.id === modelId(bindings.target));
  if (!model || model.availability === 'unavailable') throw new Error('The bound model is missing or unavailable in the voice library.');
  validateScriptSpeakers(work, casting);
  const valid = new Map(library.voices.map((voice) => [voice.id, voice]));
  const expected = Object.keys(casting.characters);
  for (const name of ['narrator', ...expected]) {
    const binding = name === 'narrator' ? bindings.narrator : bindings.characters[name];
    if (!binding) throw new Error(`Voice binding is missing for ${name}. Run the voices stage again.`);
    const voice = valid.get(binding.libraryVoiceId);
    if (!voice || voice.availability === 'unavailable' || !voice.models.includes(modelId(bindings.target)) || voice.nativeVoiceId !== binding.voiceId) {
      throw new Error(`Voice binding for ${name} is no longer compatible with ${bindings.target.provider}/${bindings.target.model}. Run the voices stage again.`);
    }
    if (binding.provider !== bindings.target.provider || binding.model !== bindings.target.model) {
      throw new Error(`Voice binding for ${name} does not match the book target. Run the voices stage again.`);
    }
  }
  return bindings;
}

/**
 * Cast names grouped by story, in casting order. A hand-written cast with no
 * character registry, and a continuous work, are a single group.
 */
function speakerGroups(work: WorkDir, names: string[]): string[][] {
  let storyOfName: Map<string, string> | undefined;
  try {
    const stories = readStories(work);
    if (stories.collection) {
      storyOfName = new Map(readCharacterRegistry(work, stories).characters.map((character) => [character.name, character.story || BOOK_STORY_ID]));
    }
  } catch {
    // Voices can be applied to a cast that has no registry beside it.
  }
  if (!storyOfName) return names.length ? [names] : [];
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const story = storyOfName.get(name) ?? BOOK_STORY_ID;
    groups.set(story, [...(groups.get(story) ?? []), name]);
  }
  return [...groups.values()];
}

function validateScriptSpeakers(work: WorkDir, casting: Casting): void {
  const missing = new Set<string>();
  for (const { file } of listChapterFiles(work.root, SCRIPTS_DIR, '.json')) {
    const script = ChapterScriptSchema.parse(work.readJson(file));
    for (const segment of script.segments) {
      if (segment.speaker !== 'narrator' && !Object.hasOwn(casting.characters, segment.speaker)) missing.add(segment.speaker);
    }
  }
  if (missing.size) throw new Error(`Add missing scripted speakers to casting.json before applying voices: ${[...missing].join(', ')}.`);
}

function readCasting(work: WorkDir): Casting {
  const casting = CastingSchema.safeParse(work.readJson<unknown>('casting.json'));
  if (!casting.success) throw new Error('casting.json does not match the casting format. Re-run the casting stage.');
  return casting.data;
}

function chooseBinding(
  speaker: CastSpeaker,
  existing: VoiceBinding | undefined,
  candidates: LibraryVoice[],
  target: VoiceTarget,
  supportsInstructions: boolean,
  used: Set<string>,
  bookLanguage: string | undefined,
): VoiceBinding {
  if (existing?.selection === 'manual') {
    const voice = candidates.find((candidate) => candidate.id === existing.libraryVoiceId && candidate.nativeVoiceId === existing.voiceId);
    if (voice) return { ...existing, provider: target.provider, model: target.model };
    throw new Error('A manual voice binding is incompatible with the selected target. Update that binding explicitly before applying voices.');
  }
  const language = preferredLanguage(speaker.voiceProfile.language, bookLanguage);
  const languageCandidates = language
    ? candidates.filter((voice) => voice.traits.languages.some((candidate) => languageCode(candidate) === language))
    : candidates;
  if (!languageCandidates.length) {
    throw new Error(`Voice library has no ${language} voice compatible with ${target.provider}/${target.model}. Update the casting language, choose another target, or add a manual compatible binding.`);
  }
  const ranked = languageCandidates
    .map((voice) => ({ voice, score: score(speaker, voice, used) }))
    .sort((left, right) => right.score - left.score || left.voice.id.localeCompare(right.voice.id));
  const chosen = ranked[0]?.voice;
  if (!chosen) throw new Error('No compatible voice is available for casting.');
  const reasons = [
    `Compatible with ${target.provider}/${target.model}.`,
    ...(speaker.voiceProfile.presentation !== 'unknown' && chosen.traits.presentation === speaker.voiceProfile.presentation
      ? [`Matches ${speaker.voiceProfile.presentation} presentation.`] : []),
    ...(language ? [`Matches ${language} language.`] : []),
    ...speaker.voiceProfile.tone.filter((tone) => chosen.traits.tone.map((value) => value.toLowerCase()).includes(tone.toLowerCase())).map((tone) => `Matches ${tone} tone.`),
  ];
  const limitations = [
    ...(speaker.voiceProfile.presentation !== 'unknown' && chosen.traits.presentation !== speaker.voiceProfile.presentation
      ? [`Requested ${speaker.voiceProfile.presentation} presentation; catalogue describes this voice as ${chosen.traits.presentation}.`] : []),
    ...(!['unknown', 'unspecified'].includes(speaker.voiceProfile.accent) && chosen.traits.accent.toLowerCase() !== speaker.voiceProfile.accent.toLowerCase()
      ? [`Requested ${speaker.voiceProfile.accent} accent; catalogue describes this voice as ${chosen.traits.accent}.`] : []),
    ...(chosen.compatibility?.basis.startsWith('inferred') ? ['Model compatibility is inferred from provider documentation; synthesis has not been tested.'] : []),
    ...(speaker.voiceProfile.age !== 'unknown' && chosen.traits.age !== speaker.voiceProfile.age
      ? [`Requested ${speaker.voiceProfile.age}; catalogue describes this voice as ${chosen.traits.age}.`] : []),
    ...(used.has(chosen.id) ? ['Reused because the selected library has no unused higher-scoring voice.'] : []),
    ...(!supportsInstructions && speaker.instructions ? [target.provider === 'fish'
      ? 'Fish uses inline delivery cues; a synthesis adapter must translate standing instructions before they can be applied.'
      : 'This model does not support standing delivery instructions.'] : []),
  ];
  return { libraryVoiceId: chosen.id, provider: target.provider, model: target.model, voiceId: chosen.nativeVoiceId, selection: 'automatic', match: { reasons, limitations } };
}

function preferredLanguage(profileLanguage: string, bookLanguage: string | undefined): string | undefined {
  return languageCode(profileLanguage) ?? languageCode(bookLanguage);
}

/**
 * Compare BCP 47 primary language subtags and the human-readable language
 * labels that older casts (and LLM output) commonly contain. The catalogue
 * records BCP 47 codes, while a profile may say "English" or
 * "American English". Treat those forms equivalently so a language-safe
 * catalogue voice is not discarded merely because its label differs.
 */
function languageCode(language: string | undefined): string | undefined {
  const normalized = language?.trim().toLowerCase().replace(/[ _]+/g, '-');
  if (!normalized || normalized === 'unknown' || normalized === 'unspecified') return undefined;
  const aliases: Record<string, string> = {
    'english': 'en',
    'american-english': 'en',
    'british-english': 'en',
    'japanese': 'ja',
    'mandarin': 'zh',
    'mandarin-chinese': 'zh',
    'chinese': 'zh',
    'spanish': 'es',
    'french': 'fr',
    'hindi': 'hi',
    'italian': 'it',
    'portuguese': 'pt',
    'brazilian-portuguese': 'pt',
  };
  if (aliases[normalized]) return aliases[normalized];
  return normalized.split('-', 1)[0];
}

function score(speaker: CastSpeaker, voice: LibraryVoice, used: Set<string>): number {
  let value = used.has(voice.id) ? -20 : 0;
  const profile = speaker.voiceProfile;
  if (profile.presentation !== 'unknown') value += voice.traits.presentation === profile.presentation ? 30 : voice.traits.presentation === 'neutral' ? 5 : -12;
  if (profile.age !== 'unknown') value += voice.traits.age === profile.age ? 10 : 0;
  value += profile.tone.filter((tone) => voice.traits.tone.some((candidate) => candidate.toLowerCase() === tone.toLowerCase())).length * 8;
  if (profile.accent !== 'unspecified') value += voice.traits.accent.toLowerCase() === profile.accent.toLowerCase() ? 6 : 0;
  return value;
}
