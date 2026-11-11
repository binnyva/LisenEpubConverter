import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runStage } from '../src/pipeline/runner.js';
import { collectUsage, formatDuration, recordLlmUsage, recordTtsUsage, totalUsage, usageSummary, type StageUsage } from '../src/util/usage.js';
import { jsonCall } from '../src/providers/llm/openai.js';
import { bookFixture, labelsReply, removeFixtures } from './helpers.js';

vi.mock('../src/providers/llm/openai.js', () => ({ jsonCall: vi.fn() }));
const llm = vi.mocked(jsonCall);
afterEach(() => {
  vi.resetAllMocks();
  removeFixtures();
});

describe('usage collection', () => {
  it('adds up calls and tokens per model, and speech requests, inside one collector', async () => {
    const usage = await collectUsage(async (collected) => {
      recordLlmUsage('small', { promptTokens: 100, completionTokens: 20 });
      recordLlmUsage('small', { promptTokens: 50, completionTokens: 30, reasoningTokens: 10 });
      recordLlmUsage('large', {});
      recordTtsUsage(1200);
      return collected();
    });
    expect(usage.llm).toEqual({ calls: 3, promptTokens: 150, completionTokens: 50, reasoningTokens: 10 });
    expect(usage.models).toEqual({
      small: { calls: 2, promptTokens: 150, completionTokens: 50, reasoningTokens: 10 },
      large: { calls: 1, promptTokens: 0, completionTokens: 0, reasoningTokens: 0 },
    });
    expect(usage.tts).toEqual({ calls: 1, characters: 1200 });
    expect(() => recordLlmUsage('outside', { promptTokens: 1 })).not.toThrow();
  });

  it('summarises a stage in one comparable line', () => {
    const stage = { llm: { calls: 42, promptTokens: 310221, completionTokens: 18004, reasoningTokens: 2100 }, tts: { calls: 0, characters: 0 }, wallMs: 372_000 };
    expect(usageSummary(stage)).toBe('42 LLM calls · 310,221 prompt + 18,004 completion tokens (2,100 reasoning) · 6m 12s');
    expect(usageSummary({ llm: { calls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0 }, tts: { calls: 1204, characters: 512330 }, wallMs: 4_000 }))
      .toBe('1,204 TTS requests (512,330 characters) · 4s');
    expect(usageSummary(totalUsage([]))).toBe('no model calls · 0s');
    expect(formatDuration(3_780_000)).toBe('1h 03m');
    expect(totalUsage([stage as StageUsage, stage as StageUsage]).llm.calls).toBe(84);
  });
});

describe('usage log', () => {
  it('appends a record per executed stage, shares the run id, and skips a stage that did not run', async () => {
    const { work, run, events } = bookFixture({ chapters: ['"Hello," said Ann.', 'Plain prose.'] });
    llm.mockResolvedValue(labelsReply([[1, 'Ann']], { characters: [{ name: 'Ann' }] }) as any);

    const first = await runStage({ ...run, stage: 'script', chapterIndexes: [0], runId: 'run-1' });
    await runStage({ ...run, stage: 'script', runId: 'run-1' });
    const skipped = await runStage({ ...run, stage: 'script', runId: 'run-2' });

    const usage = work.readJson<StageUsage[]>('usage.json');
    expect(usage.map((record) => [record.runId, record.stage, record.outcome, record.chapters])).toEqual([
      ['run-1', 'script', 'completed', [0]], ['run-1', 'script', 'completed', undefined],
    ]);
    expect(first.usage).toEqual(usage[0]);
    expect(skipped).toMatchObject({ skipped: true });
    expect(skipped.usage).toBeUndefined();
    expect(events.filter((event) => event.type === 'usage')).toHaveLength(2);
  });

  it('records a failed stage, and nothing for one refused before it started', async () => {
    const { work, run } = bookFixture({ chapters: ['"Hello," said Ann.'] });
    llm.mockRejectedValue(new Error('provider down'));

    await expect(runStage({ ...run, stage: 'script' })).rejects.toThrow('provider down');
    await expect(runStage({ ...run, stage: 'synth' })).rejects.toThrow('Run voices before synth.');

    expect(work.readJson<StageUsage[]>('usage.json').map((record) => [record.stage, record.outcome])).toEqual([['script', 'failed']]);
  });

  it('survives a rebuild from Extract', async () => {
    const { work, run } = bookFixture({ chapters: ['Plain prose.'] });
    await runStage({ ...run, stage: 'script' });
    fs.writeFileSync(run.epubPath.replace(/\.epub$/, '.md'), '# Book\n\nText.');

    const { clearArtifactsFrom } = await import('../src/pipeline/runner.js');
    clearArtifactsFrom(work, 'extract');

    expect(work.readJson<StageUsage[]>('usage.json')).toHaveLength(1);
  });
});
