export type ProviderId = 'openai' | 'openrouter';

function providerFromEnv(name: string, fallback: ProviderId): ProviderId {
  const value = process.env[name] ?? fallback;
  if (value === 'openai' || value === 'openrouter') return value;
  throw new Error(`Invalid ${name} "${value}". Expected "openai" or "openrouter".`);
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  throw new Error(`Invalid ${name} "${value}". Expected a positive integer.`);
}

export const config = {
  /** Provider for LLM-backed text processing. */
  get llmProvider(): ProviderId {
    return providerFromEnv('LISEN_LLM_PROVIDER', 'openai');
  },
  /** Model for whole-book analysis (fiction detection, characters, casting). */
  get analysisModel(): string {
    return process.env.LISEN_ANALYSIS_MODEL ?? 'gpt-4.1';
  },
  /** Model for per-chapter bulk work (summaries, cleanup, dialogue attribution). */
  get chapterModel(): string {
    return process.env.LISEN_CHAPTER_MODEL ?? 'gpt-4.1-mini';
  },
  /** TTS model. OpenRouter model ids include the provider prefix. */
  get ttsModel(): string {
    return (
      process.env.LISEN_TTS_MODEL ??
      (this.ttsProvider === 'openrouter' ? 'openai/gpt-4o-mini-tts-2025-12-15' : 'gpt-4o-mini-tts')
    );
  },
  /** TTS provider id. */
  get ttsProvider(): ProviderId {
    return providerFromEnv('LISEN_TTS_PROVIDER', 'openai');
  },
  /** OpenRouter-compatible API base URL. */
  get openRouterBaseUrl(): string {
    return process.env.LISEN_OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
  },
  /** Optional URL supplied to OpenRouter for application attribution. */
  get openRouterSiteUrl(): string | undefined {
    return process.env.LISEN_OPENROUTER_SITE_URL;
  },
  /** Optional JSON voice catalogue for a non-OpenAI OpenRouter TTS model. */
  get ttsVoicesFile(): string | undefined {
    return process.env.LISEN_TTS_VOICES_FILE;
  },
  /** Shared, provider-neutral voice library. It is intentionally outside book work folders. */
  get voiceLibraryFile(): string {
    return process.env.LISEN_VOICE_LIBRARY_FILE ?? './library/voices.json';
  },
  /** Max characters sent to the LLM per chunk when processing chapter text. */
  llmChunkChars: 9000,
  /** Max characters per TTS request (OpenAI speech limit is 4096). */
  get ttsMaxChars(): number {
    return positiveIntFromEnv('LISEN_TTS_MAX_CHARS', 4000);
  },
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
  'voices',
  'synth',
  'assemble',
] as const;

export type Stage = (typeof STAGES)[number];
