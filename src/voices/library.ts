import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config, type ProviderId } from '../config.js';
import type { Voice } from '../providers/tts/types.js';
import { OPENAI_VOICES, loadVoiceCatalog } from '../providers/tts/voices.js';

const ProviderSchema = z.enum(['openai', 'openrouter', 'fish']);

const ModelSchema = z.object({
  id: z.string(),
  provider: ProviderSchema,
  model: z.string(),
  availability: z.string().optional(),
  supportsInstructions: z.boolean().default(false),
}).passthrough();

const LibrarySchema = z.object({
  updatedAt: z.string(),
  voices: z.array(z.object({
    id: z.string(),
    nativeVoiceId: z.string(),
    models: z.array(z.string()).min(1),
    traits: z.object({
      presentation: z.enum(['male', 'female', 'neutral', 'unknown']).default('unknown'),
      age: z.string().default('unknown'),
      tone: z.array(z.string()).default([]),
      languages: z.array(z.string()).default([]),
      accent: z.string().default('unspecified'),
    }),
    description: z.string().default(''),
    source: z.enum(['built-in', 'imported']).default('built-in'),
    availability: z.string().optional(),
    compatibility: z.object({
      basis: z.string(),
    }).passthrough().optional(),
  }).passthrough()),
}).passthrough();

export const VoiceLibrarySchema = z.discriminatedUnion('version', [
  LibrarySchema.extend({
    version: z.literal(1),
    models: z.array(ModelSchema.extend({ maxChars: z.number().int().positive() })),
  }),
  LibrarySchema.extend({
    version: z.literal(2),
    models: z.array(ModelSchema.extend({
      inputLimits: z.array(z.object({
        field: z.string(),
        max: z.number().int().positive().nullable(),
        unit: z.enum(['characters', 'tokens']),
        scope: z.string(),
      }).passthrough()),
    })),
  }),
]);
export type VoiceLibrary = z.infer<typeof VoiceLibrarySchema>;
export type LibraryVoice = VoiceLibrary['voices'][number];

export interface VoiceTarget {
  provider: ProviderId | 'fish';
  model: string;
}

export function modelId(target: VoiceTarget): string {
  return `${target.provider}:${target.model}`;
}

export function defaultVoiceTarget(): VoiceTarget {
  return { provider: config.ttsProvider, model: config.ttsModel };
}

export function loadVoiceLibrary(file = config.voiceLibraryFile): VoiceLibrary {
  try {
    return VoiceLibrarySchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Voice library not found: ${file}. Run "lisen voices refresh" or import a catalogue first.`);
    }
    throw new Error(`Voice library ${file} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function saveVoiceLibrary(library: VoiceLibrary, file = config.voiceLibraryFile): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(library, null, 2));
  fs.renameSync(temporary, file);
}

/**
 * OpenAI exposes a fixed published voice set rather than a voices-list API.
 * Refresh therefore records that provider catalogue locally. OpenRouter uses
 * the configured catalogue for models whose voice sets are model-specific.
 */
export function refreshVoiceLibrary(target = defaultVoiceTarget(), file = config.voiceLibraryFile): VoiceLibrary {
  const catalog = voicesForTarget(target);
  const existing = fs.existsSync(file) ? loadVoiceLibrary(file) : undefined;
  if (existing?.version === 2) throw new Error('Version-2 catalogues support listing and applying. Refresh is not implemented for this format; keep the existing catalogue.');
  const id = modelId(target);
  const model = {
    id,
    provider: target.provider,
    model: target.model,
    supportsInstructions: target.provider === 'openai' || target.model.startsWith('openai/'),
    maxChars: config.ttsMaxChars,
  };
  const preserved = existing?.voices.filter((voice) => !voice.models.includes(id)) ?? [];
  const voices = catalog.map((voice) => toLibraryVoice(voice, id));
  const library: VoiceLibrary = {
    version: 1,
    updatedAt: new Date().toISOString(),
    models: [...(existing?.models.filter((entry) => entry.id !== id) ?? []), model],
    voices: [...preserved, ...voices],
  };
  saveVoiceLibrary(library, file);
  return library;
}

/** Import a legacy array catalogue into an explicit provider/model namespace. */
export function importVoiceLibrary(source: string, target: VoiceTarget, file = config.voiceLibraryFile): VoiceLibrary {
  const catalog = loadVoiceCatalog(source);
  const existing = fs.existsSync(file) ? loadVoiceLibrary(file) : undefined;
  if (existing?.version === 2) throw new Error('Legacy import cannot overwrite a version-2 catalogue. Choose a separate --library file.');
  const id = modelId(target);
  const model = {
    id,
    provider: target.provider,
    model: target.model,
    supportsInstructions: target.provider === 'openai' || target.model.startsWith('openai/'),
    maxChars: config.ttsMaxChars,
  };
  const preserved = existing?.voices.filter((voice) => !voice.models.includes(id)) ?? [];
  const library: VoiceLibrary = {
    version: 1,
    updatedAt: new Date().toISOString(),
    models: [...(existing?.models.filter((entry) => entry.id !== id) ?? []), model],
    voices: [...preserved, ...catalog.map((voice) => ({ ...toLibraryVoice(voice, id), source: 'imported' as const }))],
  };
  saveVoiceLibrary(library, file);
  return library;
}

export function voicesForTarget(target: VoiceTarget): Voice[] {
  if (target.provider === 'fish') throw new Error('Use the bundled Fish catalogue with voices list or voices apply; Fish catalogue refresh is not implemented yet.');
  if (target.provider === 'openai' || target.model.startsWith('openai/')) return OPENAI_VOICES;
  if (!config.ttsVoicesFile) {
    throw new Error(`Model "${target.model}" has no built-in voice catalogue. Import its catalogue with "lisen voices import <file> --provider ${target.provider} --model ${target.model}".`);
  }
  return loadVoiceCatalog(config.ttsVoicesFile);
}

function toLibraryVoice(voice: Voice, targetId: string): LibraryVoice {
  const description = voice.description.toLowerCase();
  const tone = ['bright', 'friendly', 'calm', 'warm', 'energetic', 'soft', 'expressive', 'steady', 'authoritative']
    .filter((trait) => description.includes(trait));
  return {
    id: `${targetId}:${voice.id}`,
    nativeVoiceId: voice.id,
    models: [targetId],
    traits: {
      presentation: voice.sex,
      age: description.includes('younger') ? 'young adult' : description.includes('mature') ? 'mature' : 'unknown',
      tone,
      languages: ['en'],
      accent: description.includes('british') ? 'British' : 'unspecified',
    },
    description: voice.description,
    source: 'built-in',
  };
}
