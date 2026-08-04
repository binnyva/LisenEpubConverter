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

// ---------- Stage 4: script ----------

export const ScriptSegmentSchema = z.object({
  /** 'narrator' or a character name from the analysis cast. */
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
  segments: z.array(ScriptSegmentSchema),
});
export type ChapterScript = z.infer<typeof ChapterScriptSchema>;

// ---------- Stage 5: casting ----------

export const VoiceAssignmentSchema = z.object({
  voiceId: z.string(),
  /** Standing instructions for this speaker's delivery, e.g. "Elderly gruff Scottish man." */
  instructions: z.string().default(''),
});
export type VoiceAssignment = z.infer<typeof VoiceAssignmentSchema>;

export const CastingSchema = z.object({
  narrator: VoiceAssignmentSchema,
  /** Keyed by canonical character name. */
  characters: z.record(z.string(), VoiceAssignmentSchema),
});
export type Casting = z.infer<typeof CastingSchema>;

// ---------- Stage 6: synth ----------

export interface ChapterAudioManifest {
  index: number;
  /** Ordered audio-cache hashes making up the chapter. */
  segments: string[];
}
