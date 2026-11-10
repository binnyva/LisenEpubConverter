import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkDir } from '../src/state.js';
import { runStage, type PipelineEvent } from '../src/pipeline/runner.js';
import { jsonCall } from '../src/providers/llm/openai.js';
import { config } from '../src/config.js';

vi.mock('../src/providers/llm/openai.js', () => ({ jsonCall: vi.fn() }));
const llm = vi.mocked(jsonCall);
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(isFiction = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-progress-'));
  roots.push(root);
  const epubPath = path.join(root, 'book.epub');
  fs.writeFileSync(epubPath, 'offline fixture');
  const work = new WorkDir(epubPath, root);
  const chapters = [0, 1, 2].map((index) => ({ index, title: `Title ${index}` }));
  work.writeJson('metadata.json', { chapters });
  work.writeJson('analysis.json', { isFiction, summary: 'Story.', chapters: chapters.map((ch) => ({ ...ch, narrate: true })) });
  work.writeJson('chapter-summaries.json', {});
  work.writeJson('characters.json', { version: 1, chapters: [0, 1, 2], characters: [
    { id: 'alice', name: 'Alice', aliases: [], sex: 'female', age: 'child', importance: 'main', chapters: [0], evidence: [], issues: [] },
  ] });
  work.dir('chapters-clean');
  for (const ch of chapters) fs.writeFileSync(work.path(`chapters-clean/0${ch.index}.md`), 'A'.repeat(8000) + '\n\n' + 'B'.repeat(3000));
  for (const stage of ['extract', 'analyze', 'chapters', 'list-characters'] as const) work.markDone(stage);
  const events: PipelineEvent[] = [];
  return { work, events, options: { epubPath, workRoot: root, outDir: root, stage: 'script' as const, chapterIndexes: [0, 2], onEvent: (event: PipelineEvent) => events.push(event) } };
}

describe('script progress through the shared runner', () => {
  it('saves valid boundary repairs when the model omits other segment ids', async () => {
    const { options, work, events } = fixture();
    llm.mockResolvedValueOnce({ segments: [
      { speaker: 'narrator', text: '"Hello," she said.', confidence: 'high' },
      { speaker: 'narrator', text: '"Bye," he answered.', confidence: 'high' },
    ] });
    llm.mockResolvedValueOnce({ repairs: [{ id: 0, segments: [
      { speaker: 'Alice', text: '"Hello,"', confidence: 'high' },
      { speaker: 'narrator', text: 'she said.', confidence: 'high' },
    ] }] });
    llm.mockResolvedValueOnce({ segments: [{ speaker: 'narrator', text: 'B', confidence: 'high' }] });

    await runStage({ ...options, chapterIndexes: [0] });

    const segments = work.readJson<any>('script/00.json').segments;
    expect(segments).toContainEqual(expect.objectContaining({ speaker: 'Alice', text: '"Hello,"' }));
    expect(segments).toContainEqual(expect.objectContaining({ speaker: 'narrator', text: '"Bye," he answered.', confidence: 'low' }));
    expect(events.some((event) => event.type === 'warning' && event.message.includes('omitted segment(s) 1'))).toBe(true);
  });

  it('audits high-confidence dialogue with Script-only reasoning and marks corrections for review', async () => {
    const { options, work } = fixture();
    const registry = work.readJson<any>('characters.json');
    registry.characters.push({
      id: 'bob', name: 'Bob', aliases: [], sex: 'male', age: 'adult', importance: 'secondary',
      chapters: [0], evidence: [], issues: [],
    });
    work.writeJson('characters.json', registry);
    llm.mockResolvedValueOnce({ segments: [{ speaker: 'Alice', text: 'A', confidence: 'high' }] });
    llm.mockResolvedValueOnce({ segments: [{ speaker: 'narrator', text: 'B', confidence: 'high' }] });
    llm.mockResolvedValueOnce({ attributions: [{ id: 0, speaker: 'Bob' }] });

    await runStage({ ...options, chapterIndexes: [0], llmModel: 'general-model',
      scriptModel: 'reasoning-model', scriptReasoningEffort: 'medium' });

    expect(llm).toHaveBeenCalledTimes(3);
    for (const [request] of llm.mock.calls) {
      expect(request).toMatchObject({ model: 'reasoning-model', reasoningEffort: 'medium', maxCompletionTokens: 8192 });
    }
    expect(work.readJson<any>('script/00.json').segments[0]).toMatchObject({ speaker: 'Bob', confidence: 'low' });
  });

  it('reports character-weighted blocks, pending-request heartbeats, verification and selected-chapter completion', async () => {
    const { options, events, work } = fixture();
    let release!: (value: any) => void;
    llm.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    llm.mockResolvedValueOnce({ segments: [{ speaker: 'narrator', text: 'B', confidence: 'high' }] });
    llm.mockImplementationOnce(async () => {
      expect(events.at(-1)?.progress).toMatchObject({ phase: 'verifying', processedChars: 11000, totalChars: 11000, completedChapters: 0 });
      expect(fs.existsSync(work.path('script/00.json'))).toBe(false);
      return { attributions: [{ id: 0, speaker: 'Alice' }] };
    });
    llm.mockResolvedValue({ segments: [{ speaker: 'narrator', text: 'Text', confidence: 'high' }] });
    vi.useFakeTimers();
    const run = runStage(options);
    await vi.advanceTimersByTimeAsync(config.progressIntervalMs);
    expect(events.at(-1)).toMatchObject({ type: 'progress', heartbeat: true, progress: {
      chapterIndex: 0, phase: 'attributing', block: 1, totalBlocks: 2, processedChars: 0, elapsedMs: config.progressIntervalMs,
    } });
    release({ segments: [{ speaker: 'Alice', text: 'A', confidence: 'low' }] });
    await run;
    expect(llm.mock.calls[0][0].model).toBe(config.chapterModel);
    expect(llm.mock.calls[2][0].model).toBe(config.analysisModel);
    expect(events.find((event) => event.progress?.block === 2)).toMatchObject({
      message: expect.stringContaining('72% of text processed'),
      progress: { processedChars: 8000, totalChars: 11000, completedChapters: 0, totalChapters: 2 },
    });
    expect(events.filter((event) => event.progress?.phase === 'completed').map((event) => event.progress?.completedChapters)).toEqual([1, 2]);
    expect(events.filter((event) => event.progress).every((event) => event.progress?.chapterIndex !== 1)).toBe(true);
    expect(events.at(-1)?.type).toBe('completed');
    expect(vi.getTimerCount()).toBe(0);

    events.length = 0;
    llm.mockClear();
    await runStage(options);
    expect(events.filter((event) => event.progress?.phase === 'skipped').map((event) => event.progress?.completedChapters)).toEqual([1, 2]);
    expect(llm).not.toHaveBeenCalled();
  });

  it('stops heartbeats after failure and never reports chapter completion', async () => {
    const { options, events } = fixture();
    vi.useFakeTimers();
    llm.mockRejectedValue(new Error('Request failed'));
    await expect(runStage(options)).rejects.toThrow('Request failed');
    expect(vi.getTimerCount()).toBe(0);
    expect(events.some((event) => event.progress?.phase === 'completed')).toBe(false);
    expect(events.some((event) => event.type === 'completed')).toBe(false);
  });

  it('reports non-fiction progress without requesting attribution', async () => {
    const { options, events } = fixture(false);
    await runStage({ ...options, scriptReasoningEffort: 'high' });
    expect(llm).not.toHaveBeenCalled();
    expect(events.filter((event) => event.progress?.phase === 'completed').map((event) => event.progress?.completedChapters)).toEqual([1, 2]);
  });
});
