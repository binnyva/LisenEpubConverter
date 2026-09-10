import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { z } from 'zod';
import { config } from '../../config.js';
import { reportWarning } from '../../util/warnings.js';
import { TaskCancelledError, taskCancellationSignal, waitForRetry } from '../../util/cancellation.js';

let client: OpenAI | undefined;

function getClient(): OpenAI {
  client ??= new OpenAI();
  return client;
}

type Message = { role: 'system' | 'user'; content: string };
type Completion = { content: string; diagnostics?: string };

type OpenRouterResponse = {
  id?: unknown;
  model?: unknown;
  choices?: Array<{
    finish_reason?: unknown;
    message?: { content?: unknown; refusal?: unknown };
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
  openrouter_metadata?: {
    provider_name?: unknown;
    provider?: unknown;
  };
  error?: { message?: unknown; code?: unknown; metadata?: { raw?: unknown } };
};

/** Keep provider diagnostics actionable without including generated book text or credentials. */
function openRouterDiagnostics(body: unknown, response: Response): string {
  const parsed = body as OpenRouterResponse;
  const choice = parsed.choices?.[0];
  const content = choice?.message?.content;
  const metadata = parsed.openrouter_metadata;
  const details: Record<string, unknown> = {
    requestId: response.headers.get('x-request-id') ?? response.headers.get('x-openrouter-request-id') ?? undefined,
    completionId: typeof parsed.id === 'string' ? parsed.id : undefined,
    model: typeof parsed.model === 'string' ? parsed.model : undefined,
    provider: typeof metadata?.provider_name === 'string'
      ? metadata.provider_name
      : typeof metadata?.provider === 'string' ? metadata.provider : undefined,
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined,
    content: typeof content === 'string' ? `${content.length} chars` : typeof content,
    refusal: typeof choice?.message?.refusal === 'string' ? 'present' : undefined,
    promptTokens: typeof parsed.usage?.prompt_tokens === 'number' ? parsed.usage.prompt_tokens : undefined,
    completionTokens: typeof parsed.usage?.completion_tokens === 'number' ? parsed.usage.completion_tokens : undefined,
    totalTokens: typeof parsed.usage?.total_tokens === 'number' ? parsed.usage.total_tokens : undefined,
    errorCode: typeof parsed.error?.code === 'string' || typeof parsed.error?.code === 'number' ? parsed.error.code : undefined,
    upstreamError: typeof parsed.error?.metadata?.raw === 'string' ? parsed.error.metadata.raw.slice(0, 1000) : undefined,
  };
  return JSON.stringify(Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)));
}

function openRouterErrorMessage(body: unknown): string {
  const error = (body as OpenRouterResponse).error;
  const message = typeof error?.message === 'string' ? error.message.slice(0, 1000) : 'no provider error message';
  const upstream = typeof error?.metadata?.raw === 'string' ? error.metadata.raw.slice(0, 1000) : undefined;
  return upstream && upstream !== message ? `${message} (${upstream})` : message;
}

function openRouterResponseFormat(schema: z.ZodType): {
  type: 'json_schema';
  json_schema: { name: string; strict: true; schema: object };
} {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'lisen_response',
      strict: true,
      schema: z.toJSONSchema(schema, { target: 'draft-07' }),
    },
  };
}

/**
 * Writes an opt-in local trace for diagnosing provider behavior. This can
 * include book text and generated prose, so it is deliberately disabled by
 * default. Never include authorization headers or API keys in this record.
 */
function writeOpenRouterTrace(entry: Record<string, unknown>): Promise<void> | undefined {
  const file = config.openRouterTraceFile;
  if (!file) return undefined;
  return fs.mkdir(path.dirname(file), { recursive: true })
    .then(() => fs.appendFile(file, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, 'utf8'))
    // Diagnostics must never block or fail an audiobook run.
    .catch(() => undefined);
}

async function createCompletion(model: string, messages: Message[], schema: z.ZodType): Promise<Completion> {
  const controller = new AbortController();
  const timeoutMessage = `LLM request timed out after ${config.llmResponseTimeoutMs / 1000} seconds without a model response.`;
  const timeout = setTimeout(() => controller.abort(new Error(timeoutMessage)), config.llmResponseTimeoutMs);
  const cancellationSignal = taskCancellationSignal();
  const signal = cancellationSignal ? AbortSignal.any([controller.signal, cancellationSignal]) : controller.signal;

  try {
    if (config.llmProvider === 'openai') {
      const res = await getClient().chat.completions.create({
        model,
        messages,
        response_format: { type: 'json_object' },
        max_completion_tokens: config.llmMaxCompletionTokens,
      }, { signal });
      return { content: res.choices[0]?.message?.content ?? '' };
    }

    const requestId = randomUUID();
    const requestBody = {
      model,
      messages,
      // Unlike basic JSON mode, this requires the fields and types that the
      // current pipeline stage needs, rather than merely valid JSON syntax.
      response_format: openRouterResponseFormat(schema),
      // OpenRouter's endpoint capability metadata advertises this as
      // `max_tokens`. With require_parameters enabled, the OpenAI-specific
      // `max_completion_tokens` name can exclude otherwise compatible routes.
      max_tokens: config.llmMaxCompletionTokens,
      // Chapter cleanup and the other Lisen stages need schema-shaped output,
      // not a reasoning transcript. Disable thinking by default so it cannot
      // consume the completion budget before the JSON is written.
      reasoning: { effort: config.openRouterReasoningEffort },
      // Do not let OpenRouter route to a provider that would silently ignore
      // JSON mode; every pipeline stage relies on schema-valid JSON.
      provider: {
        require_parameters: true,
        ...(config.openRouterMaxPrice ? { max_price: config.openRouterMaxPrice } : {}),
      },
    };
    const url = `${config.openRouterBaseUrl}/chat/completions`;
    const requestTrace = writeOpenRouterTrace({ type: 'request', requestId, url, body: requestBody });
    if (requestTrace) await requestTrace;

    let res: Response;
    try {
      res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ''}`,
        'Content-Type': 'application/json',
        'X-OpenRouter-Title': 'Lisen EPUB Convertor',
        'X-OpenRouter-Metadata': 'enabled',
        ...(config.openRouterSiteUrl ? { 'HTTP-Referer': config.openRouterSiteUrl } : {}),
      },
      body: JSON.stringify(requestBody),
      signal,
    });
    } catch (err) {
      const errorTrace = writeOpenRouterTrace({ type: 'transport-error', requestId, error: (err as Error).message });
      if (errorTrace) await errorTrace;
      throw err;
    }
    const responseText = await res.text();
    const responseTrace = writeOpenRouterTrace({
      type: 'response',
      requestId,
      status: res.status,
      statusText: res.statusText,
      headers: {
        requestId: res.headers.get('x-request-id') ?? res.headers.get('x-openrouter-request-id') ?? undefined,
        contentType: res.headers.get('content-type') ?? undefined,
      },
      body: responseText,
    });
    if (responseTrace) await responseTrace;
    let body: unknown;
    try {
      body = JSON.parse(responseText);
    } catch {
      throw new Error(`OpenRouter LLM returned a non-JSON response (${res.status}; ${responseText.length} bytes).`);
    }
    const diagnostics = openRouterDiagnostics(body, res);
    if (!res.ok) {
      throw new Error(`OpenRouter LLM request failed (${res.status}): ${openRouterErrorMessage(body)}. Diagnostics: ${diagnostics}`);
    }
    const content = (body as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message
      ?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error(`OpenRouter LLM response was empty. Diagnostics: ${diagnostics}`);
    }
    return { content, diagnostics };
  } catch (err) {
    if (cancellationSignal?.aborted) throw new TaskCancelledError();
    if (controller.signal.aborted) throw new Error(timeoutMessage);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Call the LLM in JSON mode and validate the response against a zod schema.
 * Retries transient API errors and invalid-JSON/schema failures, feeding the
 * validation error back to the model on schema retries.
 */
export async function jsonCall<S extends z.ZodType>(opts: {
  model: string;
  system: string;
  user: string;
  schema: S;
  maxRetries?: number;
}): Promise<z.infer<S>> {
  const maxRetries = opts.maxRetries ?? 3;
  let lastError = '';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let raw: string;
    let diagnostics: string | undefined;
    try {
      const messages: Message[] = [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ];
      if (lastError) {
        messages.push({
          role: 'user',
          content: `Your previous response was invalid: ${lastError}\nRespond again with corrected JSON only.`,
        });
      }
      const completion = await createCompletion(opts.model, messages, opts.schema);
      raw = completion.content;
      diagnostics = completion.diagnostics;
    } catch (err) {
      if (err instanceof TaskCancelledError) throw err;
      if (attempt === maxRetries) throw err;
      const backoff = 2000 * 2 ** (attempt - 1);
      reportWarning(`LLM call failed (${(err as Error).message}), retrying in ${backoff / 1000}s...`);
      await waitForRetry(backoff);
      continue;
    }

    try {
      const parsed = opts.schema.parse(JSON.parse(raw));
      return parsed;
    } catch (err) {
      lastError = (err as Error).message.slice(0, 2000);
      if (attempt === maxRetries) {
        throw new Error(`LLM returned invalid JSON after ${maxRetries} attempts: ${lastError}${diagnostics ? `. Diagnostics: ${diagnostics}` : ''}`);
      }
      reportWarning(`LLM returned invalid JSON (${lastError})${diagnostics ? `; diagnostics: ${diagnostics}` : ''}, retrying (attempt ${attempt + 1} of ${maxRetries})...`);
    }
  }
  throw new Error('unreachable');
}
