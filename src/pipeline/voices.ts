import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { WorkDir } from '../state.js';
import { CastingSchema, ChapterScriptSchema, VoiceBindingsSchema, type CastSpeaker, type Casting, type VoiceBinding, type VoiceBindings } from '../types.js';
import { config } from '../config.js';
import { defaultVoiceTarget, loadVoiceLibrary, modelId, type LibraryVoice, type VoiceTarget } from '../voices/library.js';

/** Stage 6: apply one compatible library model to a provider-neutral cast. */
export function runVoices(work: WorkDir, target = defaultVoiceTarget(), libraryFile = config.voiceLibraryFile): VoiceBindings {
  const library = loadVoiceLibrary(libraryFile);
  const targetId = modelId(target);
  const model = library.models.find((entry) => entry.id === targetId);
  if (!model || model.availability === 'unavailable') throw new Error(`Voice library has no available catalogue for ${target.provider}/${target.model}.`);
  const candidates = library.voices.filter((voice) => voice.models.includes(targetId) && voice.availability !== 'unavailable');
  if (!candidates.length) throw new Error(`Voice library has no voices compatible with ${target.provider}/${target.model}.`);
  const casting = readCasting(work);
  validateScriptSpeakers(work, casting);

  const existing = fs.existsSync(work.path('voice-bindings.json'))
    ? VoiceBindingsSchema.parse(work.readJson('voice-bindings.json'))
    : undefined;
  const used = new Set<string>();
  const narrator = chooseBinding(casting.narrator, existing?.narrator, candidates, target, model.supportsInstructions, used);
  used.add(narrator.libraryVoiceId);
  const characters: Record<string, VoiceBinding> = {};
  for (const [name, speaker] of Object.entries(casting.characters)) {
    characters[name] = chooseBinding(speaker, existing?.characters[name], candidates, target, model.supportsInstructions, used);
    used.add(characters[name].libraryVoiceId);
  }
  const bindings: VoiceBindings = {
    version: 1,
    libraryFile: path.resolve(libraryFile),
    target,
    narrator,
    characters,
  };
  work.writeJson('voice-bindings.json', bindings);
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

function validateScriptSpeakers(work: WorkDir, casting: Casting): void {
  if (!fs.existsSync(work.path('script'))) return;
  const missing = new Set<string>();
  for (const file of fs.readdirSync(work.path('script')).filter((file) => file.endsWith('.json'))) {
    const script = ChapterScriptSchema.parse(work.readJson(`script/${file}`));
    for (const segment of script.segments) {
      if (segment.speaker !== 'narrator' && !Object.hasOwn(casting.characters, segment.speaker)) missing.add(segment.speaker);
    }
  }
  if (missing.size) throw new Error(`Add missing scripted speakers to casting.json before applying voices: ${[...missing].join(', ')}.`);
}

const LegacySpeakerSchema = z.object({ voiceId: z.string(), instructions: z.string().default('') });
const LegacyCastingSchema = z.object({
  narrator: LegacySpeakerSchema,
  characters: z.record(z.string(), LegacySpeakerSchema),
});

/**
 * Old work folders stored model-specific IDs in casting.json without recording
 * the model. Preserve their instructions, keep a backup, and intentionally
 * leave the new profile unknown so applying the selected library is explicit.
 */
function readCasting(work: WorkDir): Casting {
  const raw = work.readJson<unknown>('casting.json');
  const modern = CastingSchema.safeParse(raw);
  if (modern.success) return modern.data;
  const legacy = LegacyCastingSchema.safeParse(raw);
  if (!legacy.success) throw new Error('casting.json does not match the current or legacy casting format. Re-run the casting stage.');
  const backup = work.path('casting.legacy.json');
  if (!fs.existsSync(backup)) fs.copyFileSync(work.path('casting.json'), backup);
  const speaker = (entry: z.infer<typeof LegacySpeakerSchema>): CastSpeaker => ({
    voiceProfile: { presentation: 'unknown', age: 'unknown', tone: [], language: 'unknown', accent: 'unspecified' },
    instructions: entry.instructions,
  });
  const casting: Casting = {
    version: 2,
    narrator: speaker(legacy.data.narrator),
    characters: Object.fromEntries(Object.entries(legacy.data.characters).map(([name, entry]) => [name, speaker(entry)])),
  };
  work.writeJson('casting.json', casting);
  console.warn(`  Migrated legacy casting.json; original saved as ${backup}. Run voices to choose a recorded provider/model target.`);
  return casting;
}

function chooseBinding(
  speaker: CastSpeaker,
  existing: VoiceBinding | undefined,
  candidates: LibraryVoice[],
  target: VoiceTarget,
  supportsInstructions: boolean,
  used: Set<string>,
): VoiceBinding {
  if (existing?.selection === 'manual') {
    const voice = candidates.find((candidate) => candidate.id === existing.libraryVoiceId && candidate.nativeVoiceId === existing.voiceId);
    if (voice) return { ...existing, provider: target.provider, model: target.model };
    throw new Error('A manual voice binding is incompatible with the selected target. Update that binding explicitly before applying voices.');
  }
  const ranked = candidates
    .map((voice) => ({ voice, score: score(speaker, voice, used) }))
    .sort((left, right) => right.score - left.score || left.voice.id.localeCompare(right.voice.id));
  const chosen = ranked[0]?.voice;
  if (!chosen) throw new Error('No compatible voice is available for casting.');
  const reasons = [
    `Compatible with ${target.provider}/${target.model}.`,
    ...(speaker.voiceProfile.presentation !== 'unknown' && chosen.traits.presentation === speaker.voiceProfile.presentation
      ? [`Matches ${speaker.voiceProfile.presentation} presentation.`] : []),
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

function score(speaker: CastSpeaker, voice: LibraryVoice, used: Set<string>): number {
  let value = used.has(voice.id) ? -20 : 0;
  const profile = speaker.voiceProfile;
  if (profile.presentation !== 'unknown') value += voice.traits.presentation === profile.presentation ? 30 : voice.traits.presentation === 'neutral' ? 5 : -12;
  if (profile.age !== 'unknown') value += voice.traits.age === profile.age ? 10 : 0;
  value += profile.tone.filter((tone) => voice.traits.tone.some((candidate) => candidate.toLowerCase() === tone.toLowerCase())).length * 8;
  if (profile.accent !== 'unspecified') value += voice.traits.accent.toLowerCase() === profile.accent.toLowerCase() ? 6 : 0;
  return value;
}
