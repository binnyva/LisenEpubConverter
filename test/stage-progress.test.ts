import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkDir } from '../src/state.js';
import { runStage } from '../src/pipeline/runner.js';
import { jsonCall } from '../src/providers/llm/openai.js';
import { getTTSProvider } from '../src/providers/tts/openai.js';
import { runVoices } from '../src/pipeline/voices.js';
import { config } from '../src/config.js';
import { bookFixture, labelsReply, readScript, removeFixtures, writeScript } from './helpers.js';

vi.mock('../src/providers/llm/openai.js', () => ({ jsonCall: vi.fn() }));
vi.mock('../src/providers/tts/openai.js', () => ({ getTTSProvider: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: Object.assign(vi.fn(), {
  [Symbol.for('nodejs.util.promisify.custom')]: vi.fn(),
}) }));
const command = vi.mocked((execFile as any)[promisify.custom]);
const llm = vi.mocked(jsonCall);
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  removeFixtures();
});

/** Two chapters, the first already scripted, with every stage before Assemble marked done. */
function fixture() {
  const book = bookFixture({
    chapters: ['Plain narration with nothing to attribute.', `${'A'.repeat(12000)}\n\n"Who goes there?" asked the guard.\n\n${'B'.repeat(9000)}`],
    done: ['extract', 'metadata', 'script', 'voices', 'synth'],
  });
  writeScript(book.work, 0, [{ speaker: 'Alice', text: 'Hello.' }]);
  return book;
}

const profileReply = (book: ReturnType<typeof fixture>) => ({ ...book.profile, summarySource: undefined });

describe('stage activities', () => {
  it.each(['metadata', 'casting'] as const)('shows a heartbeat without a fabricated percentage during %s', async (stage) => {
    const book = fixture();
    let release!: (result: any) => void;
    llm.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    llm.mockResolvedValue({ characters: {} } as any);
    vi.useFakeTimers();
    const run = runStage({ ...book.run, stage, rerun: true });
    await vi.advanceTimersByTimeAsync(config.progressIntervalMs);
    expect(book.events.at(-1)).toMatchObject({ type: 'progress', stage, heartbeat: true, progress: {
      activity: expect.stringContaining('waiting for model response'), elapsedMs: config.progressIntervalMs,
    } });
    if (stage === 'metadata') expect(book.events.at(-1)?.progress).not.toHaveProperty('totalUnits');
    release(stage === 'metadata' ? profileReply(book) : { narrator: { voiceProfile: {}, instructions: 'Steady.' } });
    await run;
    expect(book.events.filter((event) => event.type !== 'usage').at(-1)?.type).toBe('completed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up a failed model activity without claiming completion', async () => {
    const book = fixture();
    let fail!: (error: Error) => void;
    llm.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    vi.useFakeTimers();
    const run = runStage({ ...book.run, stage: 'metadata', rerun: true });
    const outcome = expect(run).rejects.toThrow('offline failure');
    await vi.advanceTimersByTimeAsync(config.progressIntervalMs);
    fail(new Error('offline failure'));
    await outcome;
    expect(vi.getTimerCount()).toBe(0);
    expect(book.events.some((event) => event.type === 'completed')).toBe(false);
  });

  it('reports Script blocks by characters processed, then reuses the saved script', async () => {
    const book = fixture();
    llm.mockResolvedValue(labelsReply([[2, 'the guard']], { characters: [{ name: 'the guard', named: false }] }) as any);
    await runStage({ ...book.run, stage: 'script', chapterIndexes: [1], rerun: true });
    const progress = book.events.flatMap((event) => (event.progress && 'phase' in event.progress ? [event.progress] : []));
    // Two blocks: the dialogue needs the model, the 9,000 characters of narration after it do not.
    expect(progress.find((entry) => entry.phase === 'attributing')).toMatchObject({ block: 1, totalBlocks: 2, processedChars: 0, totalChars: 21036 });
    expect(progress.filter((entry) => entry.phase === 'attributing')).toHaveLength(1);
    expect(progress.at(-1)).toMatchObject({ phase: 'completed', completedChapters: 1, totalChapters: 1, chapterIndex: 1 });
    expect(llm).toHaveBeenCalledTimes(1);
    expect(readScript(book.work, 1).segments.map((segment) => segment.speaker)).toEqual(['narrator', 'the guard (chapter 2)', 'narrator', 'narrator']);

    book.events.length = 0;
    await runStage({ ...book.run, stage: 'script', chapterIndexes: [1] });
    expect(llm).toHaveBeenCalledTimes(1);
    expect(book.events.find((event) => event.progress?.phase === 'skipped')?.progress).toMatchObject({ completedChapters: 1 });
  });

  it('counts cached and out-of-order synthesized segments without changing cache inputs', async () => {
    const { work, run, events } = fixture();
    work.writeJson('casting.json', { version: 2, narrator: { voiceProfile: {}, instructions: 'Steady.' }, characters: {} });
    writeScript(work, 0, ['Cached.', 'Second.', 'Third.'].map((text) => ({ speaker: 'narrator', text })));
    const bindings = runVoices(work, { provider: 'openai', model: 'gpt-4o-mini-tts' }, path.resolve('library/voices.json'));
    const binding = bindings.narrator;
    const hash = crypto.createHash('sha256').update([binding.provider, binding.model, binding.voiceId, 'Steady.', 'Cached.'].join('\x1f')).digest('hex').slice(0, 24);
    fs.writeFileSync(path.join(work.dir('2-audio-cache'), hash + '.mp3'), 'paid audio');
    const pending: Array<(audio: Buffer) => void> = [];
    const synthesize = vi.fn(() => new Promise<Buffer>((resolve) => pending.push(resolve)));
    vi.mocked(getTTSProvider).mockReturnValue({ maxChars: 4000, synthesize } as any);
    vi.useFakeTimers();
    const stage = runStage({ ...run, stage: 'synth', chapterIndexes: [0], rerun: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(events.at(-1)?.progress).toMatchObject({ completedUnits: 1, totalUnits: 3 });
    pending[1](Buffer.from('third audio'));
    await vi.advanceTimersByTimeAsync(0);
    expect(events.at(-1)?.progress).toMatchObject({ completedUnits: 2 });
    expect(fs.existsSync(work.path('3-audio/00-chapter-1.json'))).toBe(false);
    pending[0](Buffer.from('second audio'));
    await stage;
    expect(work.readJson<any>('3-audio/00-chapter-1.json').segments[0]).toBe(hash);
    expect(fs.readFileSync(work.path('2-audio-cache', hash + '.mp3'), 'utf8')).toBe('paid audio');
    expect(events.filter((event) => event.progress).at(-1)?.progress).toMatchObject({ completedUnits: 3, totalUnits: 3, completedChapters: 1, totalChapters: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('asynchronous assembly progress', () => {
  it('keeps reporting during encoding, reuses chapters, then reports joining and export', async () => {
    const { work, run, events } = fixture();
    work.writeJson('3-audio/00-chapter-1.json', { index: 0, segments: ['cached'] });
    work.writeJson('3-audio/01-chapter-2.json', { index: 1, segments: ['new'] });
    fs.writeFileSync(work.path('3-audio/00-chapter-1.m4a'), 'existing encoding');
    let release!: () => void;
    command.mockImplementation(async (bin: string, args: string[]) => {
      if (bin === 'ffprobe') return { stdout: '1.25\n', stderr: '' };
      const output = args.at(-1)!;
      fs.writeFileSync(output, 'encoded audio');
      if (path.basename(output).startsWith('pending-')) await new Promise<void>((resolve) => { release = resolve; });
      return { stdout: '', stderr: '' };
    });
    vi.useFakeTimers();
    const stage = runStage({ ...run, stage: 'assemble' });
    await vi.advanceTimersByTimeAsync(config.progressIntervalMs);
    expect(events.at(-1)).toMatchObject({ heartbeat: true, progress: { activity: expect.stringContaining('waiting for ffmpeg'), completedUnits: 1, totalUnits: 2 } });
    release();
    const result = await stage;
    expect(fs.existsSync(result.output!)).toBe(true);
    expect(fs.readFileSync(work.path('3-audio/00-chapter-1.m4a'), 'utf8')).toBe('existing encoding');
    expect(fs.readFileSync(work.path('3-audio/01-chapter-2.m4a'), 'utf8')).toBe('encoded audio');
    expect(fs.readFileSync(work.path('3-audio/ffmetadata.txt'), 'utf8')).toContain('END=2500');
    const joining = events.find((event) => event.progress && 'activity' in event.progress && event.progress.activity.startsWith('Joining'));
    expect(joining?.progress).not.toHaveProperty('totalUnits');
    expect(new WorkDir(run.epubPath, run.workRoot).isDone('assemble')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('finds a chapter by its index when its title has since changed', async () => {
    const { work, run } = fixture();
    work.writeJson('3-audio/00-an-earlier-title.json', { index: 0, segments: ['cached'] });
    fs.writeFileSync(work.path('3-audio/00-an-earlier-title.m4a'), 'existing encoding');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(work.path('3-audio/00-an-earlier-title.m4a'), future, future);
    command.mockImplementation(async (bin: string, args: string[]) => {
      if (bin === 'ffprobe') return { stdout: '1\n', stderr: '' };
      fs.writeFileSync(args.at(-1)!, 'assembled audio');
      return { stdout: '', stderr: '' };
    });

    await runStage({ ...run, stage: 'assemble', chapterIndexes: [0] });

    expect(fs.readFileSync(work.path('3-audio/00-an-earlier-title.m4a'), 'utf8')).toBe('existing encoding');
    expect(fs.readdirSync(work.path('3-audio')).filter((name) => name.endsWith('.m4a'))).toEqual(['00-an-earlier-title.m4a']);
  });

  it('saves the default assembled M4B in the book work folder', async () => {
    const { work, run } = fixture();
    work.writeJson('3-audio/00-chapter-1.json', { index: 0, segments: ['cached'] });
    fs.writeFileSync(work.path('3-audio/00-chapter-1.m4a'), 'existing encoding');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(work.path('3-audio/00-chapter-1.m4a'), future, future);
    command.mockImplementation(async (bin: string, args: string[]) => {
      if (bin === 'ffprobe') return { stdout: '1\n', stderr: '' };
      fs.writeFileSync(args.at(-1)!, 'assembled audio');
      return { stdout: '', stderr: '' };
    });

    const { outDir: _outDir, ...defaultOptions } = run;
    const result = await runStage({ ...defaultOptions, stage: 'assemble' });

    expect(result.output).toBe(work.path('Book.m4b'));
    expect(fs.existsSync(work.path('Book.m4b'))).toBe(true);
  });

  it('does not publish a failed chapter encode or complete the stage', async () => {
    const { work, run, events } = fixture();
    work.writeJson('3-audio/00-chapter-1.json', { index: 0, segments: ['paid'] });
    fs.writeFileSync(path.join(work.dir('2-audio-cache'), 'paid.mp3'), 'paid audio');
    command.mockImplementation(async (_bin: string, args: string[]) => {
      fs.writeFileSync(args.at(-1)!, 'partial encoding');
      throw new Error('ffmpeg failed');
    });
    await expect(runStage({ ...run, stage: 'assemble', chapterIndexes: [0] })).rejects.toThrow('ffmpeg failed');
    expect(fs.readdirSync(work.path('3-audio')).filter((name) => name.endsWith('.m4a'))).toEqual([]);
    expect(fs.existsSync(work.path('2-audio-cache/paid.mp3'))).toBe(true);
    expect(events.some((event) => event.type === 'completed')).toBe(false);
  });
});
