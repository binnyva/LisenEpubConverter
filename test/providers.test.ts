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
      provider: { require_parameters: true },
    });
    // Reasoning is off unless configured: a model left to its default can reason at length.
    expect(JSON.parse(init.body as string).reasoning).toEqual({ enabled: false });
    expect(init.headers).toMatchObject({ 'X-OpenRouter-Metadata': 'enabled' });
  });

  it('sends a reasoning effort when one is configured', async () => {
    vi.stubEnv('LISEN_LLM_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('LISEN_OPENROUTER_REASONING_EFFORT', 'high');
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"answer":"ready"}' } }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { jsonCall } = await import('../src/providers/llm/openai.js');
    await jsonCall({
      model: 'example/reasoning-model', system: 'Return JSON.', user: 'Go.',
      schema: z.object({ answer: z.string() }), maxRetries: 1,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ reasoning: { effort: 'high' } });
  });

  it('explicitly disables provider reasoning for non-fiction cleanup', async () => {
    vi.stubEnv('LISEN_LLM_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('LISEN_OPENROUTER_REASONING_EFFORT', 'high');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"answer":"ready"}' } }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { jsonCall } = await import('../src/providers/llm/openai.js');

    await jsonCall({ model: 'deepseek/deepseek-v4-flash-0731', system: 'Return JSON.', user: 'Go.',
      schema: z.object({ answer: z.string() }), disableReasoning: true, maxRetries: 1 });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).reasoning).toEqual({ enabled: false });
  });

  it('uses per-call reasoning and token limits for Script without changing the global setting', async () => {
    vi.stubEnv('LISEN_LLM_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.stubEnv('LISEN_OPENROUTER_REASONING_EFFORT', 'high');
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"answer":"ready"}' } }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { jsonCall } = await import('../src/providers/llm/openai.js');
    const base = { model: 'example/reasoning-model', system: 'Return JSON.', user: 'Go.',
      schema: z.object({ answer: z.string() }), maxRetries: 1 };

    await jsonCall({ ...base, reasoningEffort: 'medium', maxCompletionTokens: 8192 });
    await jsonCall({ ...base, reasoningEffort: 'none' });

    const first = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    const second = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(first).toMatchObject({ reasoning: { effort: 'medium' }, max_tokens: 8192 });
    expect(second.reasoning).toEqual({ enabled: false });
    expect(second.max_tokens).toBe(4096);
  });

  it('leaves reasoning to the provider only when asked to, and says how after a routing failure', async () => {
    vi.stubEnv('LISEN_LLM_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"ready"}' } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'No endpoints found that support the requested parameters.' } }), { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const { jsonCall } = await import('../src/providers/llm/openai.js');
    const { config } = await import('../src/config.js');
    const base = { model: 'example/plain-model', system: 'Return JSON.', user: 'Go.', schema: z.object({ answer: z.string() }), maxRetries: 1 };

    expect(config.openRouterReasoningEffort).toBe('none');
    expect(config.scriptReasoningEffort).toBe('none');
    await jsonCall({ ...base, reasoningEffort: 'default' });
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)).not.toHaveProperty('reasoning');

    await expect(jsonCall(base)).rejects.toThrow('LISEN_OPENROUTER_REASONING_EFFORT=default');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops instead of retrying a response exhausted by reasoning tokens', async () => {
    vi.stubEnv('LISEN_LLM_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: 'length', message: { content: '' } }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { jsonCall } = await import('../src/providers/llm/openai.js');

    await expect(jsonCall({ model: 'example/reasoning-model', system: 'Return JSON.', user: 'Go.',
      schema: z.object({ answer: z.string() }) })).rejects.toThrow('LISEN_SCRIPT_MAX_COMPLETION_TOKENS');
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('honors OpenRouter Retry-After instead of exponential backoff', async () => {
    vi.stubEnv('LISEN_LLM_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'Rate limit exceeded', code: 429 } }), {
        status: 429,
        headers: { 'retry-after': '1' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"ready"}' } }] }), {
        status: 200,
      }));
    vi.stubGlobal('fetch', fetchMock);

    const { jsonCall } = await import('../src/providers/llm/openai.js');
    const result = jsonCall({
      model: 'example/json-model', system: 'Return JSON.', user: 'Go.',
      schema: z.object({ answer: z.string() }),
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ answer: 'ready' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry an OpenRouter client error', async () => {
    vi.stubEnv('LISEN_LLM_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'No endpoints found that can handle the requested parameters', code: 404 },
    }), { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const { jsonCall } = await import('../src/providers/llm/openai.js');
    await expect(jsonCall({
      model: 'example/incompatible-model', system: 'Return JSON.', user: 'Go.',
      schema: z.object({ answer: z.string() }),
    })).rejects.toThrow('OpenRouter LLM request failed (404)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports safe diagnostics when OpenRouter exhausts its completion budget', async () => {
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
    })).rejects.toThrow(/completion token limit.*request-test.*gen-test.*finishReason.*length.*content.*0 chars/s);
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

  it('uses compatible voices from the bound shared library for a non-OpenAI model', async () => {
    const { getTTSProvider } = await import('../src/providers/tts/openai.js');
    const provider = getTTSProvider(
      { provider: 'openrouter', model: 'fish-audio/s2.1-pro-free:free' },
      path.resolve('library/voices.json'),
    );

    expect(provider.listVoices()).toContainEqual({
      id: 'b347db033a6549378b48d00acb0d06cd',
      sex: 'female',
      description: 'Female voice suited to meditation.',
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
