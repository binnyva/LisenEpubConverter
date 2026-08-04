export const config = {
  /** Model for whole-book analysis (fiction detection, characters, casting). */
  analysisModel: process.env.LISEN_ANALYSIS_MODEL ?? 'gpt-4.1',
  /** Model for per-chapter bulk work (summaries, cleanup, dialogue attribution). */
  chapterModel: process.env.LISEN_CHAPTER_MODEL ?? 'gpt-4.1-mini',
  /** TTS model. */
  ttsModel: process.env.LISEN_TTS_MODEL ?? 'gpt-4o-mini-tts',
  /** TTS provider id (only 'openai' implemented for now). */
  ttsProvider: process.env.LISEN_TTS_PROVIDER ?? 'openai',
  /** Max characters sent to the LLM per chunk when processing chapter text. */
  llmChunkChars: 9000,
  /** Max characters per TTS request (OpenAI speech limit is 4096). */
  ttsMaxChars: 4000,
  /** Parallel TTS requests. */
  ttsConcurrency: 4,
  /** Parallel LLM requests for per-chapter work. */
  llmConcurrency: 3,
  /** Characters ranked above this many distinct-voice slots share voices via instructions. */
  distinctVoiceSlots: 8,
  /** Audio bitrate for chapter/book AAC encoding. */
  audioBitrate: '96k',
};

export const STAGES = [
  'extract',
  'analyze',
  'chapters',
  'script',
  'casting',
  'synth',
  'assemble',
] as const;

export type Stage = (typeof STAGES)[number];
