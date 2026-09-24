import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkDir } from '../src/state.js';
import { runStage, type PipelineEvent } from '../src/pipeline/runner.js';
import { jsonCall } from '../src/providers/llm/openai.js';
import { getTTSProvider } from '../src/providers/tts/openai.js';
import { runVoices } from '../src/pipeline/voices.js';
import { config } from '../src/config.js';

vi.mock('../src/providers/llm/openai.js', () => ({ jsonCall: vi.fn() }));
vi.mock('../src/providers/tts/openai.js', () => ({ getTTSProvider: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: Object.assign(vi.fn(), {
  [Symbol.for('nodejs.util.promisify.custom')]: vi.fn(),
}) }));
const command = vi.mocked((execFile as any)[promisify.custom]);
const llm = vi.mocked(jsonCall);
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-stage-progress-'));
  roots.push(root);
  const epubPath = path.join(root, 'book.epub');
  fs.writeFileSync(epubPath, 'offline fixture');
  const work = new WorkDir(epubPath, root);
  const chapters = [0, 1].map((index) => ({ index, title: `Chapter ${index}`, file: `chapters/${index}.md`, words: 2000 }));
  work.writeJson('metadata.json', { title: 'Book', author: 'Author', language: 'en', chapters });
  const analysis = { isFiction: true, summary: 'Story.', characters: [], author: { name: 'Author', sex: 'unknown', age: 'unknown', country: 'unknown' }, chapters: chapters.map((ch) => ({ index: ch.index, narrate: true })) };
  work.writeJson('analysis.json', analysis);
  work.writeJson('characters.json', { version: 1, chapters: [0, 1], characters: [] });
  work.dir('chapters');
  for (const ch of chapters) fs.writeFileSync(work.path(ch.file), 'A'.repeat(8000) + '\n\n' + 'B'.repeat(3000));
  work.writeJson('script/00.json', { index: 0, segments: [{ speaker: 'Alice', text: 'Hello.', confidence: 'high' }] });
  for (const stage of ['extract', 'analyze', 'chapters', 'list-characters', 'script', 'voices', 'synth'] as const) work.markDone(stage);
  const events: PipelineEvent[] = [];
  const options = { epubPath, workRoot: root, outDir: path.join(root, 'out'), onEvent: (event: PipelineEvent) => events.push(event) };
  return { work, options, events, analysis };
}

describe('stage activities', () => {
  it.each(['analyze', 'casting'] as const)('shows a heartbeat without a fabricated percentage during %s', async (stage) => {
    const { options, events, analysis } = fixture();
    let release!: (result: any) => void;
    llm.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    vi.useFakeTimers();
    const run = runStage({ ...options, stage, rerun: true });
    await vi.advanceTimersByTimeAsync(config.progressIntervalMs);
    expect(events.at(-1)).toMatchObject({ type: 'progress', stage, heartbeat: true, progress: {
      activity: expect.stringContaining('waiting for model response'), elapsedMs: config.progressIntervalMs,
    } });
    expect(events.at(-1)?.progress).not.toHaveProperty('totalUnits');
    release(stage === 'analyze' ? analysis : { version: 2, narrator: {}, characters: {} });
    await run;
    expect(events.at(-1)?.type).toBe('completed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up a failed model activity without claiming completion', async () => {
    const { options, events } = fixture();
    let fail!: (error: Error) => void;
    llm.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    vi.useFakeTimers();
    const run = runStage({ ...options, stage: 'analyze', rerun: true });
    const outcome = expect(run).rejects.toThrow('offline failure');
    await vi.advanceTimersByTimeAsync(config.progressIntervalMs);
    fail(new Error('offline failure'));
    await outcome;
    expect(vi.getTimerCount()).toBe(0);
    expect(events.some((event) => event.type === 'completed')).toBe(false);
  });

  it('measures selected chapter text and reports reuse and discovery-only backfills', async () => {
    const { options, work, events } = fixture();
    llm.mockResolvedValue({ cleanedText: 'Cleaned.', partialSummary: 'Summary.', characters: [] });
    await runStage({ ...options, stage: 'chapters', chapterIndexes: [1], rerun: true });
    expect(events.some((event) => event.progress && 'activity' in event.progress && event.progress.activity.includes('block 2/2') && event.progress.completedUnits === 8000 && event.progress.totalUnits === 11000)).toBe(true);
    expect(events.filter((event) => event.progress?.phase === 'completed').at(-1)?.progress).toMatchObject({ completedChapters: 1, totalChapters: 1 });
    expect(events.filter((event) => event.progress).every((event) => event.progress?.chapterIndex === 1)).toBe(true);
    expect(llm).toHaveBeenCalledTimes(2);

    events.length = 0;
    await runStage({ ...options, stage: 'chapters', chapterIndexes: [1] });
    expect(llm).toHaveBeenCalledTimes(2);
    expect(events.find((event) => event.progress?.phase === 'skipped')?.progress).toMatchObject({ completedChapters: 1 });
    fs.rmSync(work.path('chapter-characters/01.json'));
    events.length = 0;
    await runStage({ ...options, stage: 'chapters', chapterIndexes: [1] });
    expect(events.some((event) => event.progress && 'activity' in event.progress && event.progress.activity.includes('Discovering speakers in block 2/2'))).toBe(true);
    expect(fs.readFileSync(work.path('chapters-clean/01.md'), 'utf8')).toBe('Cleaned.\n\nCleaned.');
  });

  it('counts cached and out-of-order synthesized segments without changing cache inputs', async () => {
    const { options, work, events } = fixture();
    work.writeJson('casting.json', { version: 2, narrator: { voiceProfile: {}, instructions: 'Steady.' }, characters: {} });
    work.writeJson('script/00.json', { index: 0, segments: ['Cached.', 'Second.', 'Third.'].map((text) => ({ speaker: 'narrator', text, confidence: 'high' })) });
    const bindings = runVoices(work, { provider: 'openai', model: 'gpt-4o-mini-tts' }, path.resolve('library/voices.json'));
    const binding = bindings.narrator;
    const hash = crypto.createHash('sha256').update([binding.provider, binding.model, binding.voiceId, 'Steady.', 'Cached.'].join('\x1f')).digest('hex').slice(0, 24);
    fs.writeFileSync(path.join(work.dir('audio-cache'), hash + '.mp3'), 'paid audio');
    const pending: Array<(audio: Buffer) => void> = [];
    const synthesize = vi.fn(() => new Promise<Buffer>((resolve) => pending.push(resolve)));
    vi.mocked(getTTSProvider).mockReturnValue({ maxChars: 4000, synthesize } as any);
    vi.useFakeTimers();
    const run = runStage({ ...options, stage: 'synth', chapterIndexes: [0], rerun: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(events.at(-1)?.progress).toMatchObject({ completedUnits: 1, totalUnits: 3 });
    pending[1](Buffer.from('third audio'));
    await vi.advanceTimersByTimeAsync(0);
    expect(events.at(-1)?.progress).toMatchObject({ completedUnits: 2 });
    expect(fs.existsSync(work.path('audio/00-segments.json'))).toBe(false);
    pending[0](Buffer.from('second audio'));
    await run;
    expect(work.readJson<any>('audio/00-segments.json').segments[0]).toBe(hash);
    expect(fs.readFileSync(work.path('audio-cache', hash + '.mp3'), 'utf8')).toBe('paid audio');
    expect(events.filter((event) => event.progress).at(-1)?.progress).toMatchObject({ completedUnits: 3, totalUnits: 3, completedChapters: 1, totalChapters: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('asynchronous assembly progress', () => {
  it('keeps reporting during encoding, reuses chapters, then reports joining and export', async () => {
    const { options, work, events } = fixture();
    work.writeJson('audio/00-segments.json', { index: 0, segments: ['cached'] });
    work.writeJson('audio/01-segments.json', { index: 1, segments: ['new'] });
    fs.writeFileSync(work.path('audio/00.m4a'), 'existing encoding');
    let release!: () => void;
    command.mockImplementation(async (bin: string, args: string[]) => {
      if (bin === 'ffprobe') return { stdout: '1.25\n', stderr: '' };
      const output = args.at(-1)!;
      fs.writeFileSync(output, 'encoded audio');
      if (output.endsWith('.tmp.m4a')) await new Promise<void>((resolve) => { release = resolve; });
      return { stdout: '', stderr: '' };
    });
    vi.useFakeTimers();
    const run = runStage({ ...options, stage: 'assemble' });
    await vi.advanceTimersByTimeAsync(config.progressIntervalMs);
    expect(events.at(-1)).toMatchObject({ heartbeat: true, progress: { activity: expect.stringContaining('waiting for ffmpeg'), completedUnits: 1, totalUnits: 2 } });
    release();
    const result = await run;
    expect(fs.existsSync(result.output!)).toBe(true);
    expect(fs.readFileSync(work.path('audio/00.m4a'), 'utf8')).toBe('existing encoding');
    expect(fs.readFileSync(work.path('audio/ffmetadata.txt'), 'utf8')).toContain('END=2500');
    const joining = events.find((event) => event.progress && 'activity' in event.progress && event.progress.activity.startsWith('Joining'));
    expect(joining?.progress).not.toHaveProperty('totalUnits');
    expect(new WorkDir(options.epubPath, options.workRoot).isDone('assemble')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not publish a failed chapter encode or complete the stage', async () => {
    const { options, work, events } = fixture();
    work.writeJson('audio/00-segments.json', { index: 0, segments: ['paid'] });
    fs.writeFileSync(path.join(work.dir('audio-cache'), 'paid.mp3'), 'paid audio');
    command.mockImplementation(async (_bin: string, args: string[]) => {
      fs.writeFileSync(args.at(-1)!, 'partial encoding');
      throw new Error('ffmpeg failed');
    });
    await expect(runStage({ ...options, stage: 'assemble', chapterIndexes: [0] })).rejects.toThrow('ffmpeg failed');
    expect(fs.existsSync(work.path('audio/00.m4a'))).toBe(false);
    expect(fs.existsSync(work.path('audio/00.m4a.tmp.m4a'))).toBe(false);
    expect(fs.existsSync(work.path('audio-cache/paid.mp3'))).toBe(true);
    expect(events.some((event) => event.type === 'completed')).toBe(false);
  });
});
