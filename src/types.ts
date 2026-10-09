import { z } from 'zod';

// ---------- Stage 1: extract ----------

export interface ExtractedChapter {
  /** Spine order, 0-based. */
  index: number;
  /** Spine idref. */
  id: string;
  /** Best-effort title from the TOC or first heading. */
  title: string;
  /** Canonical plain-text file path relative to the work dir. */
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

// ---------- Stage 4: BookNLP ----------

export const ChapterMapSchema = z.object({
  version: z.literal(1),
  offsetConvention: z.literal('unicode-code-points-half-open'),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  chapters: z.array(z.object({
    index: z.number().int().nonnegative(),
    title: z.string(),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    titleInText: z.boolean().default(false),
  })),
});
export type ChapterMap = z.infer<typeof ChapterMapSchema>;

export const AnnotationMentionSchema = z.object({
  entityId: z.string(),
  startToken: z.number().int().nonnegative(),
  endToken: z.number().int().nonnegative(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  text: z.string(),
  kind: z.enum(['proper', 'common', 'pronoun']),
  category: z.string(),
});

export const AnnotationQuoteSchema = z.object({
  id: z.string(),
  startToken: z.number().int().nonnegative(),
  endToken: z.number().int().nonnegative(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  text: z.string(),
  chapterIndex: z.number().int().nonnegative().nullable(),
  entityId: z.string().nullable(),
  mention: AnnotationMentionSchema.nullable(),
  assignment: z.enum(['generated', 'unresolved', 'manual']),
});

export const BookAnnotationsSchema = z.object({
  version: z.literal(1),
  source: z.object({
    inputSha256: z.string(), offsetConvention: z.literal('unicode-code-points-half-open'),
    sourcePath: z.string().optional(), sourceHash: z.string().optional(),
  }),
  provenance: z.object({
    tool: z.literal('booknlp'),
    toolVersion: z.string(),
    model: z.enum(['big', 'small']),
    pipeline: z.literal('entity,quote,coref'),
    adapterVersion: z.string(),
    fingerprint: z.string(),
  }),
  mentions: z.array(AnnotationMentionSchema),
  quotations: z.array(AnnotationQuoteSchema),
});
export type BookAnnotations = z.infer<typeof BookAnnotationsSchema>;

export const CorrectionsSchema = z.object({
  version: z.literal(1),
  characters: z.record(z.string(), z.object({
    name: z.string().optional(), aliases: z.array(z.string()).optional(),
    age: z.string().optional(), race: z.string().optional(), class: z.string().optional(), country: z.string().optional(),
    presentation: z.enum(['male', 'female', 'neutral', 'unknown']).optional(),
    mergeInto: z.string().optional(),
  })).default({}),
  quotationSpeakers: z.record(z.string(), z.string()).default({}),
});
export type Corrections = z.infer<typeof CorrectionsSchema>;

// ---------- Stage 5: list characters ----------

export const CharacterRegistrySchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  chapters: z.array(z.number().int().nonnegative()),
  characters: z.array(PersonProfileSchema.extend({
    id: z.string(),
    chapters: z.array(z.number().int().nonnegative()),
    evidence: z.array(z.object({ chapter: z.number(), chunk: z.number(), text: z.string() })),
    issues: z.array(z.string()),
    sourceEntityIds: z.array(z.string()).default([]),
    sourceQuoteIds: z.array(z.string()).default([]),
    inferredPronouns: z.array(z.string()).default([]),
  })),
});
export type CharacterRegistry = z.infer<typeof CharacterRegistrySchema>;

// ---------- Stage 6: script ----------

export const ScriptSegmentSchema = z.object({
  /** 'narrator' or a canonical name from the book's character registry. */
  speaker: z.string(),
  /** Stable application identity. Names are only display labels. */
  speakerId: z.string().optional(),
  /** Verbatim text to be spoken. */
  text: z.string(),
  /** Optional delivery hint for TTS instructions, e.g. "whispering". */
  delivery: z.string().optional(),
  confidence: z.enum(['high', 'low']).default('high'),
  sourceStart: z.number().int().nonnegative().optional(),
  sourceEnd: z.number().int().nonnegative().optional(),
  quotationId: z.string().optional(),
});
export type ScriptSegment = z.infer<typeof ScriptSegmentSchema>;

export const ChapterScriptSchema = z.object({
  index: z.number(),
  version: z.literal(2).optional(),
  format: z.enum(['plain-text', 'legacy-markdown']).optional(),
  characterRegistryHash: z.string().optional(),
  fingerprint: z.string().optional(),
  segments: z.array(ScriptSegmentSchema),
});
export type ChapterScript = z.infer<typeof ChapterScriptSchema>;

// ---------- Stage 7: casting ----------

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

// ---------- Stage 8: voice bindings ----------

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

export const ManualSpeakerSettingsSchema = z.object({
  version: z.literal(1),
  instructions: z.record(z.string(), z.string()).default({}),
  voiceBindings: z.record(z.string(), VoiceBindingSchema).default({}),
});
export type ManualSpeakerSettings = z.infer<typeof ManualSpeakerSettingsSchema>;

// ---------- Stage 9: synth ----------

export interface ChapterAudioManifest {
  version?: 2;
  index: number;
  /** Ordered audio-cache hashes making up the chapter. */
  segments: string[];
  scriptFingerprint?: string;
  fingerprint?: string;
  encoding?: { codec: 'aac'; bitrate: string; sampleRate: number; channels: number };
}
