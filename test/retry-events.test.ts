import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PipelineEvent } from '../src/pipeline/runner.js';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function scriptFixture() {
  const { WorkDir } = await import('../src/state.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-retry-'));
  roots.push(root);
  const epubPath = path.join(root, 'book.epub');
  fs.writeFileSync(epubPath, 'offline fixture');
  const work = new WorkDir(epubPath, root);
  work.writeJson('metadata.json', { chapters: [{ index: 0, title: 'Chapter one' }] });
  work.writeJson('analysis.json', {
    isFiction: true, summary: 'A story.',
    characters: [{ name: 'Alice', aliases: [], sex: 'female', age: 'child', importance: 'main' }],
    chapters: [{ index: 0, narrate: true }],
  });
  work.writeJson('chapter-summaries.json', { 0: 'Alice speaks.' });
  fs.writeFileSync(path.join(work.dir('chapters-clean'), '00.md'), 'Hello.');
  for (const stage of ['extract', 'analyze', 'chapters'] as const) work.markDone(stage);
  return { epubPath, workRoot: root, outDir: path.join(root, 'out'), stage: 'script' as const, rebuild: true };
}

const limited = () => new Response(JSON.stringify({ error: { message: 'Provider returned error', code: 429,
  metadata: { raw: 'Model is temporarily rate-limited upstream.' } } }), { status: 429 });
const success = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
  segments: [{ speaker: 'Alice', text: 'Hello.', confidence: 'high' }],
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
    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual(['started', 'warning']);
    expect(onEvent.mock.calls[1][0]).toMatchObject({ stage: 'script', message: expect.stringContaining('retrying in 2s') });
    expect(onEvent.mock.calls[1][0].message).toContain('rate-limited upstream');
    await vi.runAllTimersAsync();
    await outcome;
    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual(exhausted
      ? ['started', 'warning', 'warning'] : ['started', 'warning', 'completed']);
    expect(fetchMock).toHaveBeenCalledTimes(exhausted ? 3 : 2);
  });
});
