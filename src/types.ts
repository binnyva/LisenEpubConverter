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
  /**
   * Set when Extract split one oversized source chapter into several. `first`
   * is the index of the chapter holding part 1, shared by every part.
   */
  part?: { first: number; number: number; total: number };
}

export interface BookMetadata {
  title: string;
  author: string;
  language: string;
  /** Subject headings from the source, when it carries any. */
  subjects: string[];
  /** The source's own description, often the publisher's blurb. */
  description: string;
  /** Cover image path relative to the work dir, if found. */
  coverFile?: string;
  chapters: ExtractedChapter[];
  /**
   * Written by the Metadata stage and absent until it has run. Extract owns
   * every other field, so Metadata can be rebuilt without extracting again.
   */
  profile?: BookProfile;
}

// ---------- Stage 2: metadata ----------

const SexSchema = z.enum(['male', 'female', 'unknown']).default('unknown');

export const AuthorProfileSchema = z.object({
  sex: SexSchema,
  race: z.string().default('unknown'),
  /** Approximate age or life stage, e.g. "30s", "elderly". */
  age: z.string().default('unknown'),
  country: z.string().default('unknown'),
});
export type AuthorProfile = z.infer<typeof AuthorProfileSchema>;

export const BOOK_FORMS = ['novel', 'short story', 'short story collection', 'non-fiction'] as const;

export const ChapterPlanSchema = z.object({
  index: z.number(),
  /** The title as it should be read and displayed. */
  title: z.string().default(''),
  narrate: z.boolean(),
  reason: z.string().default(''),
});
export type ChapterPlan = z.infer<typeof ChapterPlanSchema>;

/** What the Metadata call returns. */
export const MetadataResponseSchema = z.object({
  /** Whether the model knows this book. Its summary is only trusted when true. */
  recognised: z.boolean(),
  summary: z.string().default(''),
  author: AuthorProfileSchema,
  isFiction: z.boolean(),
  form: z.enum(BOOK_FORMS),
  genres: z.array(z.string()).default([]),
  narrator: z.object({
    pointOfView: z.enum(['first', 'third', 'unknown']).default('unknown'),
    /** Apparent sex of a first-person narrator. */
    sex: SexSchema,
  }),
  /** 'quoted' when dialogue sits inside quotation marks. */
  dialogueStyle: z.enum(['quoted', 'unquoted']),
  chapters: z.array(ChapterPlanSchema),
  /** Proposed story grouping for a collection; narratable chapters only. */
  stories: z.array(z.object({
    title: z.string().default(''),
    chapters: z.array(z.number().int().nonnegative()).default([]),
  })).default([]),
});
export type MetadataResponse = z.infer<typeof MetadataResponseSchema>;

export const BookProfileSchema = MetadataResponseSchema.extend({
  /** Where the summary came from. Nothing downstream may depend on it. */
  summarySource: z.enum(['model', 'blurb', 'none']),
  /** Set when the book's own text overruled the model's dialogue style. */
  dialogueStyleNote: z.string().optional(),
});
export type BookProfile = z.infer<typeof BookProfileSchema>;

// ---------- Story grouping ----------

/** A single continuous work is one story covering every narratable chapter. */
export const BOOK_STORY_ID = 'book';

export const StorySchema = z.object({
  id: z.string(),
  title: z.string().default(''),
  /** Narratable chapter indexes belonging to this story, ascending. */
  chapters: z.array(z.number().int().nonnegative()).default([]),
});
export type Story = z.infer<typeof StorySchema>;

export const StoriesSchema = z.object({
  version: z.literal(1).default(1),
  /** Characters are scoped per story when true. */
  collection: z.boolean().default(false),
  stories: z.array(StorySchema).default([]),
});
export type Stories = z.infer<typeof StoriesSchema>;

// ---------- Stage 3: script ----------

/** A speaker as the Script call reports one that the running cast lacks. */
export const CharacterReportSchema = z.object({
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  sex: SexSchema,
  /** Approximate age or life stage, e.g. "30s", "child", "elderly". */
  age: z.string().default('unknown'),
  /** False for role descriptions such as "the station guard". */
  named: z.boolean().default(true),
  /** Short quotation supporting the identity. */
  evidence: z.string().default(''),
});
export type CharacterReport = z.infer<typeof CharacterReportSchema>;

export const CastCharacterSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Story scope id. */
  story: z.string().default(BOOK_STORY_ID),
  aliases: z.array(z.string()).default([]),
  sex: SexSchema,
  age: z.string().default('unknown'),
  named: z.boolean().default(true),
  /** Chapters the character was reported in. */
  chapters: z.array(z.number().int().nonnegative()).default([]),
  evidence: z.array(z.object({ chapter: z.number(), chunk: z.number(), text: z.string() })).default([]),
  /** Uncertain merges and conflicts, for review. Never resolved by guessing. */
  issues: z.array(z.string()).default([]),
});
export type CastCharacter = z.infer<typeof CastCharacterSchema>;

/** Dialogue whose speaker Script could not settle; it blocks the stage until reviewed. */
export const UnresolvedSpeakerSchema = z.object({
  story: z.string().default(BOOK_STORY_ID),
  chapter: z.number().int().nonnegative(),
  speaker: z.string(),
  samples: z.array(z.object({ text: z.string(), context: z.string().default('') })).default([]),
  /**
   * A person's answer, for this chapter only: an existing character's name, or
   * "narrator". Adding the speaker to the cast under the same name also settles it.
   */
  resolveAs: z.string().optional(),
});
export type UnresolvedSpeakerRecord = z.infer<typeof UnresolvedSpeakerSchema>;

/** characters.json: the running cast, scoped per story, and what needs review. */
export const CharacterRegistrySchema = z.object({
  version: z.literal(3).default(3),
  stories: z.array(z.object({ id: z.string(), title: z.string().default('') })).default([]),
  characters: z.array(CastCharacterSchema).default([]),
  unresolved: z.array(UnresolvedSpeakerSchema).default([]),
});
export type CharacterRegistry = z.infer<typeof CharacterRegistrySchema>;

export const ScriptSegmentSchema = z.object({
  /** 'narrator' or a canonical name from the book's character registry. */
  speaker: z.string(),
  /** Text to be spoken, or the divider a pause segment stands for. */
  text: z.string(),
  /** Optional delivery hint for TTS instructions, e.g. "whispering". */
  delivery: z.string().optional(),
  confidence: z.enum(['high', 'low']).default('high'),
  /**
   * 'pause' is a scene break: silence instead of speech, with no TTS request
   * and no cost. Absent means ordinary speech.
   */
  kind: z.enum(['speech', 'pause']).optional(),
  /** Silence length of a pause segment; defaults to config.sceneBreakPauseMs. */
  pauseMs: z.number().int().positive().optional(),
});
export type ScriptSegment = z.infer<typeof ScriptSegmentSchema>;

/** How a chapter was scripted: labelled spans, model-returned segments, or narration only. */
export const SCRIPT_MODES = ['quoted', 'unquoted', 'narration'] as const;
export type ScriptMode = (typeof SCRIPT_MODES)[number];

export const ChapterScriptSchema = z.object({
  index: z.number(),
  /** Story scope this chapter was attributed within. */
  story: z.string().optional(),
  mode: z.enum(SCRIPT_MODES).optional(),
  /**
   * Hash of the chapter's own text, chunking and mode. The cast is not part
   * of it: a new character must not invalidate chapters already scripted.
   */
  sourceHash: z.string().optional(),
  segments: z.array(ScriptSegmentSchema),
});
export type ChapterScript = z.infer<typeof ChapterScriptSchema>;

// ---------- Stage 4: casting ----------

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

// ---------- Stage 5: voice bindings ----------

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

// ---------- Stage 6: synth ----------

/** One piece of a chapter: an audio-cache hash, or a stretch of silence. */
export type ChapterAudioEntry = string | { pauseMs: number };

export interface ChapterAudioManifest {
  index: number;
  /** Ordered audio-cache hashes and pauses making up the chapter. */
  segments: ChapterAudioEntry[];
}
