import { AsyncLocalStorage } from 'node:async_hooks';

export type ProviderId = 'openai' | 'openrouter';

export interface LlmRunConfig {
  provider?: ProviderId;
  model?: string;
  scriptModel?: string;
  scriptReasoningEffort?: OpenRouterReasoningEffort;
}

/** OpenRouter prices in US dollars per million tokens. */
export interface OpenRouterMaxPrice {
  prompt?: number;
  completion?: number;
}

/**
 * How much a text model may reason before answering. 'none' turns reasoning
 * off, which is the default: the pipeline asks for short structured answers,
 * and a model left to reason by default can spend twenty times the tokens of
 * its answer. 'default' sends no setting and leaves the choice to the provider.
 */
export type OpenRouterReasoningEffort = 'none' | 'default' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const llmRunConfig = new AsyncLocalStorage<LlmRunConfig>();

/**
 * Apply UI/CLI run-specific LLM preferences without changing the environment
 * for another request. The values are available throughout async stage work.
 */
export function withLlmRunConfig<T>(overrides: LlmRunConfig, task: () => T): T {
  return llmRunConfig.run(overrides, task);
}

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

function openRouterMaxPriceFromEnv(): OpenRouterMaxPrice | undefined {
  const value = process.env.LISEN_OPENROUTER_MAX_PRICE;
  // Empty means no cap, so a caller can lift a cap that .env sets (.env never overrides a variable already set).
  if (value === undefined || !value.trim()) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      `Invalid LISEN_OPENROUTER_MAX_PRICE "${value}". Expected JSON such as {"prompt":0.10,"completion":0.40}.`
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid LISEN_OPENROUTER_MAX_PRICE. Expected a JSON object with prompt and/or completion prices.');
  }

  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!keys.length || keys.some((key) => key !== 'prompt' && key !== 'completion')) {
    throw new Error('Invalid LISEN_OPENROUTER_MAX_PRICE. Only "prompt" and "completion" prices are supported.');
  }

  const price: OpenRouterMaxPrice = {};
  for (const key of keys as Array<keyof OpenRouterMaxPrice>) {
    const amount = record[key];
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      throw new Error(`Invalid LISEN_OPENROUTER_MAX_PRICE.${key}. Expected a non-negative number in US dollars per million tokens.`);
    }
    price[key] = amount;
  }
  return price;
}

function parseReasoningEffort(value: string, name: string): OpenRouterReasoningEffort {
  if (['none', 'default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) {
    return value as OpenRouterReasoningEffort;
  }
  throw new Error(
    `Invalid ${name} "${value}". Expected none (off), default (the provider's own), minimal, low, medium, high, xhigh, or max.`
  );
}

function openRouterReasoningEffortFromEnv(): OpenRouterReasoningEffort {
  return parseReasoningEffort(process.env.LISEN_OPENROUTER_REASONING_EFFORT ?? 'none', 'LISEN_OPENROUTER_REASONING_EFFORT');
}

export const config = {
  /** Provider for LLM-backed text processing. */
  get llmProvider(): ProviderId {
    const selected = llmRunConfig.getStore()?.provider;
    if (selected) return selected;
    return providerFromEnv('LISEN_LLM_PROVIDER', 'openai');
  },
  /** Model for whole-book work: the Metadata call, casting, and speaker review. */
  get analysisModel(): string {
    const selected = llmRunConfig.getStore()?.model;
    if (selected) return selected;
    return process.env.LISEN_ANALYSIS_MODEL ?? 'gpt-4.1';
  },
  /** Model for per-chapter bulk work (cleanup edits and dialogue labels). */
  get chapterModel(): string {
    const selected = llmRunConfig.getStore()?.model;
    if (selected) return selected;
    return process.env.LISEN_CHAPTER_MODEL ?? 'gpt-4.1-mini';
  },
  /** Model used by Script's per-chunk call. */
  get scriptModel(): string {
    return llmRunConfig.getStore()?.scriptModel || process.env.LISEN_SCRIPT_MODEL || this.chapterModel;
  },
  /** Script verification defaults to the stronger analysis model. */
  get scriptReviewModel(): string {
    return llmRunConfig.getStore()?.scriptModel || process.env.LISEN_SCRIPT_MODEL || this.analysisModel;
  },
  /** Reasoning for Script's attribution and verification calls; off unless set. */
  get scriptReasoningEffort(): OpenRouterReasoningEffort {
    const value = llmRunConfig.getStore()?.scriptReasoningEffort
      ?? process.env.LISEN_SCRIPT_REASONING_EFFORT
      ?? this.openRouterReasoningEffort;
    return parseReasoningEffort(value, 'LISEN_SCRIPT_REASONING_EFFORT');
  },
  /** Room for a dialogue-heavy chunk's labels, plus reasoning tokens when enabled. */
  get scriptMaxCompletionTokens(): number {
    return positiveIntFromEnv('LISEN_SCRIPT_MAX_COMPLETION_TOKENS', Math.max(8192, this.llmMaxCompletionTokens));
  },
  scriptVerificationBatchSize: 12,
  /** Max characters of chapter text per Script call when the model returns labels. */
  scriptChunkChars: 16_000,
  /** Max characters per Script call when the model must return the text itself (unquoted dialogue). */
  scriptUnquotedChunkChars: 6_000,
  /** A chunk is cut further so one reply never has to label more quotes than this. */
  scriptMaxQuotesPerChunk: 120,
  /** Adjacent narration is joined into segments of at most this many characters. */
  narrationMergeChars: 1500,
  /** Words of each chapter's opening sent to Metadata. */
  metadataOpeningWords: 150,
  /** Words of the first body chapter sent to Metadata as a prose sample. */
  metadataSampleWords: 1500,
  /** Double-quote pairs per 1,000 words above which a book's dialogue is treated as quoted. */
  quotedDialoguePairsPerThousandWords: 2,
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
  /** Optional OpenRouter per-million-token price caps for text-model routing. */
  get openRouterMaxPrice(): OpenRouterMaxPrice | undefined {
    return openRouterMaxPriceFromEnv();
  },
  /** Optional local JSONL trace for OpenRouter LLM requests and responses. */
  get openRouterTraceFile(): string | undefined {
    return process.env.LISEN_OPENROUTER_TRACE_FILE;
  },
  /** Reasoning for every text-model call that does not set its own; off by default. */
  get openRouterReasoningEffort(): OpenRouterReasoningEffort {
    return openRouterReasoningEffortFromEnv();
  },
  /** Optional JSON voice catalogue for a non-OpenAI OpenRouter TTS model. */
  get ttsVoicesFile(): string | undefined {
    return process.env.LISEN_TTS_VOICES_FILE;
  },
  /** Shared, provider-neutral voice library. It is intentionally outside book work folders. */
  get voiceLibraryFile(): string {
    return process.env.LISEN_VOICE_LIBRARY_FILE ?? './library/voices.json';
  },
  /** Extract splits a source chapter longer than this many words into parts. */
  maxChapterWords: 8000,
  /** Approximate size of each part when a chapter is split. */
  targetChapterWords: 5000,

  /** Maximum tokens requested for a structured LLM completion. */
  get llmMaxCompletionTokens(): number {
    return positiveIntFromEnv('LISEN_LLM_MAX_COMPLETION_TOKENS', 4096);
  },
  /** Maximum time to wait for one LLM response before retrying the request. */
  get llmResponseTimeoutMs(): number {
    return positiveIntFromEnv('LISEN_LLM_RESPONSE_TIMEOUT_MS', 120_000);
  },
  /** Total LLM attempts for a transient failure, including the initial request. */
  get llmMaxRetries(): number {
    return positiveIntFromEnv('LISEN_LLM_MAX_RETRIES', 5);
  },
  /** Initial retry delay for LLM calls. Subsequent delays double from this value. */
  get llmRetryBaseMs(): number {
    return positiveIntFromEnv('LISEN_LLM_RETRY_BASE_MS', 2_000);
  },
  /** Upper bound for an exponential LLM retry delay when no provider delay is supplied. */
  get llmRetryMaxMs(): number {
    return positiveIntFromEnv('LISEN_LLM_RETRY_MAX_MS', 60_000);
  },
  /** Status heartbeat while a pipeline activity is pending. */
  progressIntervalMs: 10_000,
  /** Max characters per TTS request (OpenAI speech limit is 4096). */
  get ttsMaxChars(): number {
    return positiveIntFromEnv('LISEN_TTS_MAX_CHARS', 4000);
  },
  /** Parallel TTS requests. */
  ttsConcurrency: 4,
  /** Parallel LLM requests for per-chapter work. */
  llmConcurrency: 3,
  /** Speakers designed per Casting request; a larger story cast is split so the reply fits. */
  castingBatchSize: 30,
  /** Audio bitrate for chapter/book AAC encoding. */
  audioBitrate: '96k',
  /** Silence inserted where the book marks a scene break ("• • •"). */
  get sceneBreakPauseMs(): number {
    return positiveIntFromEnv('LISEN_SCENE_BREAK_PAUSE_MS', 2_000);
  },
};

/** Tunables of the Script benchmark (`npm run bench`); see benchmarks/ and README.md. */
export const benchmarkConfig = {
  /** Configurations run at once, each in its own child process. */
  concurrency: 4,
  /** Script completion cap for a run with reasoning off. A model that reasons anyway still has room. */
  maxCompletionTokens: 16_384,
  /** Script completion cap when reasoning is on; reasoning tokens count against it. */
  reasoningMaxCompletionTokens: 65_536,
  /** One response may take this long; a reasoning block on a slow model took about 100 seconds. */
  responseTimeoutMs: 600_000,
  /** Runs of each configuration, unless the command line asks for more. */
  repeats: 1,
  /** A run whose text covers less than this share of the reference's lines is ranked below complete runs. */
  minCoverage: 0.95,
};

export const STAGES = [
  'extract',
  'metadata',
  'script',
  'casting',
  'voices',
  'synth',
  'assemble',
] as const;

export type Stage = (typeof STAGES)[number];
