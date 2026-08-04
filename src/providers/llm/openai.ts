import OpenAI from 'openai';
import type { z } from 'zod';

let client: OpenAI | undefined;

function getClient(): OpenAI {
  client ??= new OpenAI();
  return client;
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
      const messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ];
      if (lastError) {
        messages.push({
          role: 'user',
          content: `Your previous response was invalid: ${lastError}\nRespond again with corrected JSON only.`,
        });
      }
      const res = await getClient().chat.completions.create({
        model: opts.model,
        messages,
        response_format: { type: 'json_object' },
      });
      raw = res.choices[0]?.message?.content ?? '';
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const backoff = 2000 * 2 ** (attempt - 1);
      console.warn(`  LLM call failed (${(err as Error).message}), retrying in ${backoff / 1000}s...`);
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
    }
  }
  throw new Error('unreachable');
}
