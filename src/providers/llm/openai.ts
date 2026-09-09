import OpenAI from 'openai';
import type { z } from 'zod';
import { config } from '../../config.js';
import { reportWarning } from '../../util/warnings.js';

let client: OpenAI | undefined;

function getClient(): OpenAI {
  client ??= new OpenAI();
  return client;
}

type Message = { role: 'system' | 'user'; content: string };

async function createCompletion(model: string, messages: Message[]): Promise<string> {
  if (config.llmProvider === 'openai') {
    const res = await getClient().chat.completions.create({
      model,
      messages,
      response_format: { type: 'json_object' },
    });
    return res.choices[0]?.message?.content ?? '';
  }

  const res = await fetch(`${config.openRouterBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ''}`,
      'Content-Type': 'application/json',
      'X-OpenRouter-Title': 'Lisen EPUB Convertor',
      ...(config.openRouterSiteUrl ? { 'HTTP-Referer': config.openRouterSiteUrl } : {}),
    },
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: 'json_object' },
      // Do not let OpenRouter route to a provider that would silently ignore
      // JSON mode; every pipeline stage relies on schema-valid JSON.
      provider: { require_parameters: true },
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter LLM request failed (${res.status}): ${(await res.text()).slice(0, 1000)}`);
  }
  const body: unknown = await res.json();
  const content = (body as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message
    ?.content;
  if (typeof content !== 'string') throw new Error('OpenRouter LLM response did not contain message content.');
  return content;
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
      raw = await createCompletion(opts.model, messages);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const backoff = 2000 * 2 ** (attempt - 1);
      reportWarning(`LLM call failed (${(err as Error).message}), retrying in ${backoff / 1000}s...`);
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }

    try {
      const parsed = opts.schema.parse(JSON.parse(raw));
      return parsed;
    } catch (err) {
      lastError = (err as Error).message.slice(0, 2000);
      if (attempt === maxRetries) {
        throw new Error(`LLM returned invalid JSON after ${maxRetries} attempts: ${lastError}`);
      }
      reportWarning(`LLM returned invalid JSON (${lastError}), retrying (attempt ${attempt + 1} of ${maxRetries})...`);
    }
  }
  throw new Error('unreachable');
}
