import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { parseVoiceCatalog } from '../src/providers/tts/voices.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('OpenRouter LLM provider', () => {
  it('requires JSON-capable routing and parses the completion', async () => {
    vi.stubEnv('LISEN_LLM_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"ready"}' } }] }), {
        status: 200,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const { jsonCall } = await import('../src/providers/llm/openai.js');
    const result = await jsonCall({
      model: 'example/json-model',
      system: 'Return JSON.',
      user: 'Go.',
      schema: z.object({ answer: z.string() }),
      maxRetries: 1,
    });

    expect(result).toEqual({ answer: 'ready' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-key' });
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'example/json-model',
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'lisen_response',
          strict: true,
          schema: {
            type: 'object',
            required: ['answer'],
            additionalProperties: false,
          },
        },
      },
      max_tokens: 4096,
      reasoning: { effort: 'none' },
      provider: { require_parameters: true },
    });
    expect(init.headers).toMatchObject({ 'X-OpenRouter-Metadata': 'enabled' });
  });

  it('applies the configured OpenRouter text-model price caps', async () => {
    vi.stubEnv('LISEN_LLM_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('LISEN_OPENROUTER_MAX_PRICE', '{"prompt":0.10,"completion":0.40}');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"ready"}' } }] }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const { jsonCall } = await import('../src/providers/llm/openai.js');
    await jsonCall({
      model: 'example/json-model', system: 'Return JSON.', user: 'Go.',
      schema: z.object({ answer: z.string() }), maxRetries: 1,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      provider: { require_parameters: true, max_price: { prompt: 0.10, completion: 0.40 } },
    });
  });

  it('writes an opt-in local trace without the API key', async () => {
    vi.stubEnv('LISEN_LLM_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'secret-key');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-openrouter-trace-'));
    const traceFile = path.join(root, 'requests.jsonl');
    vi.stubEnv('LISEN_OPENROUTER_TRACE_FILE', traceFile);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"ready"}' } }] }), {
        status: 200, headers: { 'x-request-id': 'openrouter-request' },
      })
    ));

    const { jsonCall } = await import('../src/providers/llm/openai.js');
    await jsonCall({
      model: 'example/json-model', system: 'Return JSON.', user: 'Go.',
      schema: z.object({ answer: z.string() }), maxRetries: 1,
    });

    const records = fs.readFileSync(traceFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ type: 'request', body: { model: 'example/json-model' } });
    expect(records[1]).toMatchObject({ type: 'response', status: 200, headers: { requestId: 'openrouter-request' } });
    expect(JSON.stringify(records)).not.toContain('secret-key');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects an invalid OpenRouter text-model price cap before requesting a model', async () => {
    vi.stubEnv('LISEN_LLM_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('LISEN_OPENROUTER_MAX_PRICE', '{"prompt":-1}');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { jsonCall } = await import('../src/providers/llm/openai.js');
    await expect(jsonCall({
      model: 'example/json-model', system: 'Return JSON.', user: 'Go.',
      schema: z.object({ answer: z.string() }), maxRetries: 1,
    })).rejects.toThrow('Invalid LISEN_OPENROUTER_MAX_PRICE.prompt');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries after 120 seconds when the model does not respond', async () => {
    vi.stubEnv('LISEN_LLM_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { jsonCall } = await import('../src/providers/llm/openai.js');
    const result = jsonCall({
      model: 'example/json-model',
      system: 'Return JSON.',
      user: 'Go.',
      schema: z.object({ answer: z.string() }),
    });

    const assertion = expect(result).rejects.toThrow('LLM request timed out after 120 seconds without a model response.');
    await vi.advanceTimersByTimeAsync(120_000);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reports safe diagnostics when OpenRouter returns an empty completion', async () => {
    vi.stubEnv('LISEN_LLM_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'gen-test', model: 'example/json-model',
      choices: [{ finish_reason: 'length', message: { content: '' } }],
      usage: { prompt_tokens: 20, completion_tokens: 4096, total_tokens: 4116 },
    }), { status: 200, headers: { 'x-request-id': 'request-test' } })));

    const { jsonCall } = await import('../src/providers/llm/openai.js');
    await expect(jsonCall({
      model: 'example/json-model', system: 'Return JSON.', user: 'Go.',
      schema: z.object({ answer: z.string() }), maxRetries: 1,
    })).rejects.toThrow(/response was empty.*request-test.*gen-test.*finishReason.*length.*content.*0 chars/s);
  });

  it('cancels an in-flight model request without retrying it', async () => {
    vi.stubEnv('LISEN_LLM_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { withTaskCancellation } = await import('../src/util/cancellation.js');
    const { jsonCall } = await import('../src/providers/llm/openai.js');
    const controller = new AbortController();
    const result = withTaskCancellation(controller.signal, () => jsonCall({
      model: 'example/json-model',
      system: 'Return JSON.',
      user: 'Go.',
      schema: z.object({ answer: z.string() }),
    }));

    const assertion = expect(result).rejects.toThrow('Task cancelled by user.');
    controller.abort();
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('OpenRouter TTS provider', () => {
  it('uses the speech endpoint and OpenAI provider instructions', async () => {
    vi.stubEnv('LISEN_TTS_PROVIDER', 'openrouter');
    vi.stubEnv('LISEN_TTS_MODEL', 'openai/gpt-4o-mini-tts-2025-12-15');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { getTTSProvider } = await import('../src/providers/tts/openai.js');
    const provider = getTTSProvider();
    expect(provider.listVoices().some((voice) => voice.id === 'nova')).toBe(true);

    await expect(
      provider.synthesize({ text: 'Hello.', voiceId: 'nova', instructions: 'Warm and calm.' })
    ).resolves.toEqual(Buffer.from([1, 2, 3]));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/audio/speech');
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'openai/gpt-4o-mini-tts-2025-12-15',
      input: 'Hello.',
      voice: 'nova',
      response_format: 'mp3',
      provider: { options: { openai: { instructions: 'Warm and calm.' } } },
    });
  });
});

describe('custom TTS voice catalogues', () => {
  it('validates the voice metadata required for casting', () => {
    expect(parseVoiceCatalog('[{"id":"voice-a","sex":"female","description":"warm"}]', 'test')).toEqual([
      { id: 'voice-a', sex: 'female', description: 'warm' },
    ]);
    expect(() => parseVoiceCatalog('[{"id":"voice-a","sex":"other","description":"warm"}]', 'test')).toThrow(
      'entry 1'
    );
  });
});
