import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkDir } from '../src/state.js';
import { runStage } from '../src/pipeline/runner.js';
import { getTTSProvider } from '../src/providers/tts/openai.js';
import { runVoices } from '../src/pipeline/voices.js';
import { config } from '../src/config.js';

vi.mock('../src/providers/tts/openai.js', () => ({ getTTSProvider: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: vi.fn() }) }));
const command = vi.mocked((execFile as any)[promisify.custom]);
const roots: string[] = [];
afterEach(() => { vi.resetAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(indexes = [0]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-audio-correctness-')); roots.push(root);
  const source = path.join(root, 'book.epub'); fs.writeFileSync(source, 'fixture');
  const work = new WorkDir(source, root);
  const chapters = indexes.map((index) => ({ index, title: `Chapter ${index}`, file: `chapters/${String(index).padStart(4, '0')}.txt`, words: 3, isNav: false }));
  work.writeJson('metadata.json', { title: 'Book', author: 'Author', language: 'en', chapters });
  work.writeJson('analysis.json', { isFiction: false, summary: '', characters: [], author: { name: 'Author', aliases: [], sex: 'unknown', age: 'unknown', race: 'unknown', class: 'unknown', country: 'unknown', importance: 'minor' }, chapters: indexes.map((index) => ({ index, narrate: true, reason: '' })) });
  work.writeJson('characters.json', { version: 2, chapters: indexes, characters: [] });
  work.writeJson('casting.json', { version: 2, narrator: { voiceProfile: { presentation: 'unknown', age: 'unknown', tone: [], language: 'en', accent: 'unspecified' }, instructions: 'Steady.' }, characters: {} });
  for (const index of indexes) work.writeJson(`script/${String(index).padStart(4, '0')}.json`, { version: 2, format: 'plain-text', index, fingerprint: `script-${index}`, segments: [{ speaker: 'narrator', speakerId: 'narrator', text: `Chapter ${index}.`, confidence: 'high' }] });
  for (const stage of ['extract', 'analyze', 'chapters', 'booknlp', 'list-characters', 'script', 'casting'] as const) work.markDone(stage);
  runVoices(work, { provider: 'openai', model: 'gpt-4o-mini-tts' }, path.resolve('library/voices.json'));
  work.markDone('voices');
  return { root, source, work };
}

describe('synthesis correctness', () => {
  it('deduplicates identical in-flight requests while retaining repeated manifest occurrences', async () => {
    const { root, source, work } = fixture();
    work.writeJson('script/0000.json', { version: 2, format: 'plain-text', index: 0, fingerprint: 'script-0', segments: [
      { speaker: 'narrator', speakerId: 'narrator', text: 'Same.', confidence: 'high' },
      { speaker: 'narrator', speakerId: 'narrator', text: 'Same.', confidence: 'high' },
      { speaker: 'narrator', speakerId: 'narrator', text: 'Different.', confidence: 'high' },
    ] });
    const synthesize = vi.fn(async () => Buffer.from('paid'));
    vi.mocked(getTTSProvider).mockReturnValue({ maxChars: 4000, synthesize } as any);
    await runStage({ sourcePath: source, workRoot: root, stage: 'synth', chapterIndexes: [0], rerun: true });
    const manifest = work.readJson<any>('audio/0000-segments.json');
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(manifest.segments).toHaveLength(3);
    expect(manifest.segments[0]).toBe(manifest.segments[1]);
    expect(manifest).toMatchObject({ version: 2, scriptFingerprint: 'script-0', encoding: { bitrate: config.audioBitrate } });
  });

  it('blocks only selections affected by an unresolved cross-chapter quotation', async () => {
    const { root, source, work } = fixture([0, 1]);
    work.writeJson('unresolved-quotes.json', { version: 1, quotations: [{ id: 'q-boundary', chapterIndex: null, chapterIndexes: [1], text: '“Quote”', context: 'Context' }] });
    const synthesize = vi.fn(async () => Buffer.from('paid'));
    vi.mocked(getTTSProvider).mockReturnValue({ maxChars: 4000, synthesize } as any);
    await expect(runStage({ sourcePath: source, workRoot: root, stage: 'synth', chapterIndexes: [0], rerun: true })).resolves.toMatchObject({ stage: 'synth' });
    await expect(runStage({ sourcePath: source, workRoot: root, stage: 'synth', chapterIndexes: [1], rerun: true })).rejects.toThrow('unresolved quotation');
  });

  it('stops queued work and waits for active requests to settle after a failure', async () => {
    const { root, source, work } = fixture();
    work.writeJson('script/0000.json', { version: 2, format: 'plain-text', index: 0, fingerprint: 'script-0', segments: ['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.'].map((text) => ({ speaker: 'narrator', speakerId: 'narrator', text, confidence: 'high' })) });
    vi.useFakeTimers();
    const finishers: Array<(data: Buffer) => void> = [];
    const synthesize = vi.fn((request: { text: string }) => request.text === 'One.'
      ? Promise.reject(new Error('provider failed'))
      : new Promise<Buffer>((resolve) => { finishers.push(resolve); }));
    vi.mocked(getTTSProvider).mockReturnValue({ maxChars: 4000, synthesize } as any);
    const run = runStage({ sourcePath: source, workRoot: root, stage: 'synth', chapterIndexes: [0], rerun: true });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(14_000);
    let settled = false; void run.catch(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    for (const finish of finishers) finish(Buffer.from('completed paid output'));
    await expect(run).rejects.toThrow('provider failed');
    expect(synthesize.mock.calls.map(([request]) => request.text)).not.toContain('Five.');
    expect(synthesize.mock.calls.map(([request]) => request.text)).not.toContain('Six.');
    expect(fs.existsSync(work.path('audio/0000-segments.json'))).toBe(false);
    vi.useRealTimers();
  });

  it('aborts and settles every active request before cancellation releases the stage', async () => {
    const { root, source, work } = fixture();
    work.writeJson('script/0000.json', { version: 2, format: 'plain-text', index: 0, fingerprint: 'script-0', segments: ['One.', 'Two.', 'Three.', 'Four.', 'Five.'].map((text) => ({ speaker: 'narrator', speakerId: 'narrator', text, confidence: 'high' })) });
    const active = new Set<string>();
    let allStarted!: () => void;
    const started = new Promise<void>((resolve) => { allStarted = resolve; });
    const synthesize = vi.fn((request: { text: string; signal: AbortSignal }) => new Promise<Buffer>((_resolve, reject) => {
      active.add(request.text);
      if (active.size === config.ttsConcurrency) allStarted();
      request.signal.addEventListener('abort', () => {
        active.delete(request.text);
        reject(new Error(`aborted ${request.text}`));
      }, { once: true });
    }));
    vi.mocked(getTTSProvider).mockReturnValue({ maxChars: 4000, synthesize } as any);
    const controller = new AbortController();
    const run = runStage({ sourcePath: source, workRoot: root, stage: 'synth', chapterIndexes: [0], rerun: true, signal: controller.signal });
    await started;
    controller.abort();
    await expect(run).rejects.toThrow('aborted');
    expect(active.size).toBe(0);
    expect(synthesize).toHaveBeenCalledTimes(config.ttsConcurrency);
    expect(fs.existsSync(work.path('audio/0000-segments.json'))).toBe(false);
  });
});

describe('assembly freshness and publication', () => {
  function synthesized(indexes = [0]) {
    const data = fixture(indexes);
    for (const index of indexes) {
      fs.writeFileSync(path.join(data.work.dir('audio-cache'), `hash-${index}.mp3`), 'paid');
      data.work.writeJson(`audio/${String(index).padStart(4, '0')}-segments.json`, { version: 2, index, segments: [`hash-${index}`], scriptFingerprint: `script-${index}`, fingerprint: `manifest-${index}`, encoding: { codec: 'aac', bitrate: config.audioBitrate, sampleRate: 44100, channels: 1 } });
    }
    data.work.markChaptersDone('synth', indexes, indexes);
    return data;
  }

  it('sorts authoritative chapters numerically and re-encodes stale chapter files', async () => {
    const { root, source, work } = synthesized([2, 11, 100]);
    fs.writeFileSync(work.path('audio/0011.m4a'), 'stale');
    work.writeJson('audio/0011.m4a.json', { manifestFingerprint: 'old', encoding: {} });
    const encoded: string[] = [];
    command.mockImplementation(async (bin: string, args: string[]) => {
      if (bin === 'ffprobe') return { stdout: '1\n', stderr: '' };
      const output = args.at(-1)!; encoded.push(output); fs.writeFileSync(output, 'audio'); return { stdout: '', stderr: '' };
    });
    await runStage({ sourcePath: source, workRoot: root, stage: 'assemble' });
    expect(encoded.some((file) => file.endsWith('0011.m4a.tmp.m4a'))).toBe(true);
    const metadata = fs.readFileSync(work.path('audio/ffmetadata.txt'), 'utf8');
    expect([...metadata.matchAll(/title=Chapter (\d+)/g)].map((match) => Number(match[1]))).toEqual([2, 11, 100]);
  });

  it('rejects a selected stale chapter outside the current narration plan', async () => {
    const { root, source, work } = synthesized([0]);
    work.writeJson('script/0005.json', { version: 2, format: 'plain-text', index: 5, fingerprint: 'stale-script', segments: [{ speaker: 'narrator', speakerId: 'narrator', text: 'Stale.', confidence: 'high' }] });
    work.writeJson('audio/0005-segments.json', { version: 2, index: 5, segments: [], scriptFingerprint: 'stale-script', fingerprint: 'stale-manifest', encoding: { codec: 'aac', bitrate: config.audioBitrate, sampleRate: 44100, channels: 1 } });
    await expect(runStage({ sourcePath: source, workRoot: root, stage: 'assemble', chapterIndexes: [5] })).rejects.toThrow('current narration plan');
  });

  it('retains a prior successful export when final muxing fails', async () => {
    const { root, source, work } = synthesized();
    const existing = work.path('Book.m4b'); fs.writeFileSync(existing, 'previous success');
    command.mockImplementation(async (bin: string, args: string[]) => {
      if (bin === 'ffprobe') return { stdout: '1\n', stderr: '' };
      const output = args.at(-1)!; fs.writeFileSync(output, 'partial');
      if (output.endsWith('.tmp.m4b')) throw new Error('mux failed');
      return { stdout: '', stderr: '' };
    });
    await expect(runStage({ sourcePath: source, workRoot: root, stage: 'assemble' })).rejects.toThrow('mux failed');
    expect(fs.readFileSync(existing, 'utf8')).toBe('previous success');
  });
});
