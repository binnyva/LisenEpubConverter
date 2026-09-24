import { AsyncLocalStorage } from 'node:async_hooks';

export type ProviderId = 'openai' | 'openrouter';

export interface LlmRunConfig {
  provider?: ProviderId;
  model?: string;
}

/** OpenRouter prices in US dollars per million tokens. */
export interface OpenRouterMaxPrice {
  prompt?: number;
  completion?: number;
}

export type OpenRouterReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

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
  if (value === undefined) return undefined;

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

function openRouterReasoningEffortFromEnv(): OpenRouterReasoningEffort {
  const value = process.env.LISEN_OPENROUTER_REASONING_EFFORT ?? 'none';
  if (['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) {
    return value as OpenRouterReasoningEffort;
  }
  throw new Error(
    `Invalid LISEN_OPENROUTER_REASONING_EFFORT "${value}". Expected none, minimal, low, medium, high, xhigh, or max.`
  );
}

export const config = {
  /** Provider for LLM-backed text processing. */
  get llmProvider(): ProviderId {
    const selected = llmRunConfig.getStore()?.provider;
    if (selected) return selected;
    return providerFromEnv('LISEN_LLM_PROVIDER', 'openai');
  },
  /** Model for whole-book analysis (fiction detection, characters, casting). */
  get analysisModel(): string {
    const selected = llmRunConfig.getStore()?.model;
    if (selected) return selected;
    return process.env.LISEN_ANALYSIS_MODEL ?? 'gpt-4.1';
  },
  /** Model for per-chapter bulk work (summaries, cleanup, dialogue attribution). */
  get chapterModel(): string {
    const selected = llmRunConfig.getStore()?.model;
    if (selected) return selected;
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
  /** Optional OpenRouter per-million-token price caps for text-model routing. */
  get openRouterMaxPrice(): OpenRouterMaxPrice | undefined {
    return openRouterMaxPriceFromEnv();
  },
  /** Optional local JSONL trace for OpenRouter LLM requests and responses. */
  get openRouterTraceFile(): string | undefined {
    return process.env.LISEN_OPENROUTER_TRACE_FILE;
  },
  /** Reasoning budget for OpenRouter text models; off by default for structured pipeline work. */
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
  /** Max characters sent to the LLM per chunk when processing chapter text. */
  llmChunkChars: 6000,
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
  /** Characters ranked above this many distinct-voice slots share voices via instructions. */
  distinctVoiceSlots: 8,
  /** Audio bitrate for chapter/book AAC encoding. */
  audioBitrate: '96k',
};

export const STAGES = [
  'extract',
  'analyze',
  'chapters',
  'list-characters',
  'script',
  'casting',
  'voices',
  'synth',
  'assemble',
] as const;

export type Stage = (typeof STAGES)[number];
