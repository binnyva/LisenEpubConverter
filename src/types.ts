import { z } from 'zod';

// ---------- Stage 1: extract ----------

export interface ExtractedChapter {
  /** Spine order, 0-based. */
  index: number;
  /** Spine idref. */
  id: string;
  /** Best-effort title from the TOC or first heading. */
  title: string;
  /** Markdown file path relative to the work dir. */
  file: string;
  words: number;
  /** Structurally detected as a TOC/nav document. */
  isNav: boolean;
}

export interface BookMetadata {
  title: string;
  author: string;
  language: string;
  /** Cover image path relative to the work dir, if found. */
  coverFile?: string;
  chapters: ExtractedChapter[];
}

// ---------- Stage 2: analyze ----------

export const PersonProfileSchema = z.object({
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  sex: z.enum(['male', 'female', 'unknown']).default('unknown'),
  /** Approximate age or life stage, e.g. "30s", "child", "elderly". */
  age: z.string().default('unknown'),
  race: z.string().default('unknown'),
  /** Social class / occupation. */
  class: z.string().default('unknown'),
  /** Country or accent. */
  country: z.string().default('unknown'),
  importance: z.enum(['main', 'secondary', 'minor']).default('minor'),
});
export type PersonProfile = z.infer<typeof PersonProfileSchema>;

export const ChapterPlanSchema = z.object({
  index: z.number(),
  narrate: z.boolean(),
  reason: z.string().default(''),
});

export const AnalysisSchema = z.object({
  isFiction: z.boolean(),
  summary: z.string(),
  characters: z.array(PersonProfileSchema).default([]),
  author: PersonProfileSchema,
  chapters: z.array(ChapterPlanSchema),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

// ---------- Stage 3: chapters ----------

export interface ChapterSummaries {
  /** Keyed by chapter index. */
  [index: string]: string;
}

export const CharacterObservationSchema = PersonProfileSchema.extend({
  /** Short quotation or concrete textual evidence for identity and traits. */
  evidence: z.string().min(1),
  /** False for role descriptions such as "the station guard". */
  named: z.boolean(),
  confidence: z.enum(['high', 'low']),
});
export type CharacterObservation = z.infer<typeof CharacterObservationSchema>;

export const ChapterCharactersSchema = z.object({
  index: z.number().int().nonnegative(),
  observations: z.array(CharacterObservationSchema.extend({ chunk: z.number().int().nonnegative() })),
});
export type ChapterCharacters = z.infer<typeof ChapterCharactersSchema>;

// ---------- Stage 4: list characters ----------

export const CharacterRegistrySchema = z.object({
  version: z.literal(1),
  chapters: z.array(z.number().int().nonnegative()),
  characters: z.array(PersonProfileSchema.extend({
    id: z.string(),
    chapters: z.array(z.number().int().nonnegative()),
    evidence: z.array(z.object({ chapter: z.number(), chunk: z.number(), text: z.string() })),
    issues: z.array(z.string()),
  })),
});
export type CharacterRegistry = z.infer<typeof CharacterRegistrySchema>;

// ---------- Stage 5: script ----------

export const ScriptSegmentSchema = z.object({
  /** 'narrator' or a canonical name from the book's character registry. */
  speaker: z.string(),
  /** Verbatim text to be spoken. */
  text: z.string(),
  /** Optional delivery hint for TTS instructions, e.g. "whispering". */
  delivery: z.string().optional(),
  confidence: z.enum(['high', 'low']).default('high'),
});
export type ScriptSegment = z.infer<typeof ScriptSegmentSchema>;

export const ChapterScriptSchema = z.object({
  index: z.number(),
  characterRegistryHash: z.string().optional(),
  segments: z.array(ScriptSegmentSchema),
});
export type ChapterScript = z.infer<typeof ChapterScriptSchema>;

// ---------- Stage 6: casting ----------

export const VoiceProfileSchema = z.object({
  /** Desired presentation. This describes the character, not a provider voice. */
  presentation: z.enum(['male', 'female', 'neutral', 'unknown']).default('unknown'),
  age: z.string().default('unknown'),
  tone: z.array(z.string()).default([]),
  language: z.string().default('unknown'),
  accent: z.string().default('unspecified'),
});
export type VoiceProfile = z.infer<typeof VoiceProfileSchema>;

export const CastSpeakerSchema = z.object({
  voiceProfile: VoiceProfileSchema,
  /** Standing instructions for this speaker's delivery, e.g. "Elderly gruff Scottish man." */
  instructions: z.string().default(''),
});
export type CastSpeaker = z.infer<typeof CastSpeakerSchema>;

export const CastingSchema = z.object({
  version: z.literal(2).default(2),
  narrator: CastSpeakerSchema,
  /** Keyed by canonical character name. */
  characters: z.record(z.string(), CastSpeakerSchema),
});
export type Casting = z.infer<typeof CastingSchema>;

// ---------- Stage 7: voice bindings ----------

export const VoiceBindingSchema = z.object({
  libraryVoiceId: z.string(),
  provider: z.enum(['openai', 'openrouter', 'fish']),
  model: z.string(),
  voiceId: z.string(),
  selection: z.enum(['automatic', 'manual']).default('automatic'),
  match: z.object({
    reasons: z.array(z.string()).default([]),
    limitations: z.array(z.string()).default([]),
  }).default({ reasons: [], limitations: [] }),
});
export type VoiceBinding = z.infer<typeof VoiceBindingSchema>;

export const VoiceBindingsSchema = z.object({
  version: z.literal(1).default(1),
  libraryFile: z.string().optional(),
  target: z.object({
    provider: z.enum(['openai', 'openrouter', 'fish']),
    model: z.string(),
  }),
  narrator: VoiceBindingSchema,
  /** Keyed by the same stable speaker key as casting.json. */
  characters: z.record(z.string(), VoiceBindingSchema),
});
export type VoiceBindings = z.infer<typeof VoiceBindingsSchema>;

// ---------- Stage 8: synth ----------

export interface ChapterAudioManifest {
  index: number;
  /** Ordered audio-cache hashes making up the chapter. */
  segments: string[];
}
