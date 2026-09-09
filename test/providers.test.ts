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
      response_format: { type: 'json_object' },
      provider: { require_parameters: true },
    });
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
