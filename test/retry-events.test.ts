import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipelineEvent } from '../src/pipeline/runner.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function scriptFixture() {
  const { bookFixture, removeFixtures } = await import('./helpers.js');
  cleanups.push(removeFixtures);
  const { run } = bookFixture({ chapters: ['"Hello," said Alice.'] });
  return { ...run, onEvent: undefined, stage: 'script' as const, rebuild: true };
}

const limited = () => new Response(JSON.stringify({ error: { message: 'Provider returned error', code: 429,
  metadata: { raw: 'Model is temporarily rate-limited upstream.' } } }), { status: 429 });
const success = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
  labels: [{ id: 1, speaker: 'Alice', confidence: 'high' }],
  edits: [],
  characters: [{ name: 'Alice', aliases: [], sex: 'female', age: 'child', named: true, evidence: 'said Alice' }],
}) } }] }));

describe('script rebuild retry events', () => {
  it.each([false, true])('reports a 429 during the run, then handles exhausted=%s', async (exhausted) => {
    vi.stubEnv('LISEN_LLM_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY', 'offline-test');
    const options = await scriptFixture();
    const { runStage } = await import('../src/pipeline/runner.js');
    const fetchMock = vi.fn().mockImplementation(limited);
    if (!exhausted) fetchMock.mockImplementationOnce(limited).mockImplementation(success);
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const onEvent = vi.fn<(event: PipelineEvent) => void>();
    vi.useFakeTimers();
    const run = runStage({ ...options, onEvent });
    const outcome = exhausted ? expect(run).rejects.toThrow('(429)') : expect(run).resolves.toMatchObject({ stage: 'script' });
    await vi.advanceTimersByTimeAsync(0);
    const types = () => onEvent.mock.calls.map(([event]) => event.type).filter((type) => type !== 'progress' && type !== 'usage');
    expect(types()).toEqual(['started', 'warning']);
    expect(onEvent.mock.calls.find(([event]) => event.type === 'warning')![0]).toMatchObject({ stage: 'script', message: expect.stringContaining('retrying in 2s') });
    expect(onEvent.mock.calls.find(([event]) => event.type === 'warning')![0].message).toContain('rate-limited upstream');
    await vi.runAllTimersAsync();
    await outcome;
    expect(types()).toEqual(exhausted
      ? ['started', 'warning', 'warning', 'warning', 'warning'] : ['started', 'warning', 'completed']);
    expect(fetchMock).toHaveBeenCalledTimes(exhausted ? 5 : 2);
    expect(fs.existsSync(options.workRoot)).toBe(true);
  });
});
