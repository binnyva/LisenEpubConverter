import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkDir } from '../src/state.js';
import { config } from '../src/config.js';
import { attributionBlocks, filterNarratableSegments, runScript } from '../src/pipeline/script.js';
import { runVoices } from '../src/pipeline/voices.js';
import { runStage, type PipelineEvent } from '../src/pipeline/runner.js';
import { isSceneBreak } from '../src/util/text.js';
import { jsonCall } from '../src/providers/llm/openai.js';
import { getTTSProvider } from '../src/providers/tts/openai.js';

vi.mock('../src/providers/llm/openai.js', () => ({ jsonCall: vi.fn() }));
vi.mock('../src/providers/tts/openai.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/tts/openai.js')>()),
  getTTSProvider: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFile: Object.assign(vi.fn(), {
  [Symbol.for('nodejs.util.promisify.custom')]: vi.fn(),
}) }));
const command = vi.mocked((execFile as any)[promisify.custom]);
const llm = vi.mocked(jsonCall);
const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A one-chapter book whose cleaned text carries a "• • •" scene break. */
function fixture({ fiction = true, cleaned = 'Before the break.\n\n• • •\n\nAfter the break.' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-scene-breaks-'));
  roots.push(root);
  const epubPath = path.join(root, 'book.epub');
  fs.writeFileSync(epubPath, 'offline fixture');
  const work = new WorkDir(epubPath, root);
  const chapters = [{ index: 0, title: 'One', file: 'chapters/0.md', words: 20 }];
  work.writeJson('metadata.json', { title: 'Book', author: 'Author', language: 'en', chapters });
  work.writeJson('analysis.json', {
    isFiction: fiction, summary: 'Story.', characters: [],
    author: { name: 'Author', sex: 'unknown', age: 'unknown', country: 'unknown' },
    chapters: [{ index: 0, narrate: true }],
  });
  work.writeJson('characters.json', { version: 1, chapters: [0], characters: [] });
  work.writeJson('chapter-summaries.json', { 0: 'Two scenes.' });
  work.dir('chapters');
  fs.writeFileSync(work.path('chapters/0.md'), cleaned);
  fs.writeFileSync(work.dir('chapters-clean') + '/00.md', cleaned);
  for (const stage of ['extract', 'analyze', 'chapters', 'list-characters'] as const) work.markDone(stage);
  const events: PipelineEvent[] = [];
  return { work, events, options: { epubPath, workRoot: root, outDir: path.join(root, 'out'), onEvent: (event: PipelineEvent) => events.push(event) } };
}

describe('attributionBlocks', () => {
  it('cuts a chapter at its scene breaks and keeps the divider out of the request text', () => {
    expect(attributionBlocks('One.\n\n• • •\n\nTwo.\n\nThree.', 6000)).toEqual([
      { text: 'One.', sceneBreak: '• • •' },
      { text: 'Two.\n\nThree.' },
    ]);
  });

  it('splits an oversized section by size and marks only its last block', () => {
    const blocks = attributionBlocks(`${'A'.repeat(60)}\n\n${'B'.repeat(60)}\n\n* * *\n\nTail.`, 100);

    expect(blocks.map((block) => block.sceneBreak)).toEqual([undefined, '* * *', undefined]);
    expect(blocks.map((block) => block.text.length)).toEqual([60, 60, 5]);
  });

  it('keeps a break that opens a chapter as a block of its own', () => {
    expect(attributionBlocks('———\n\nOne.', 6000)).toEqual([{ text: '', sceneBreak: '———' }, { text: 'One.' }]);
  });
});

describe('filterNarratableSegments with pauses', () => {
  it('keeps a pause segment while still dropping a layout-only one', () => {
    const segments = filterNarratableSegments([
      { speaker: 'narrator', text: 'Prose.', confidence: 'high' },
      { speaker: 'narrator', text: '• • •', confidence: 'high', kind: 'pause', pauseMs: 2000 },
      { speaker: 'narrator', text: '* * *', confidence: 'high' },
    ]);

    expect(segments).toEqual([
      { speaker: 'narrator', text: 'Prose.', confidence: 'high' },
      { speaker: 'narrator', text: '• • •', confidence: 'high', kind: 'pause', pauseMs: 2000 },
    ]);
  });
});

describe('Script scene breaks', () => {
  it('turns a fiction scene break into a pause between separately attributed sections', async () => {
    const { work } = fixture();
    llm.mockResolvedValueOnce({ segments: [{ speaker: 'narrator', text: 'Before the break.', confidence: 'high' }] });
    llm.mockResolvedValueOnce({ segments: [{ speaker: 'narrator', text: 'After the break.', confidence: 'high' }] });

    await runScript(work);

    expect(llm).toHaveBeenCalledTimes(2);
    expect(work.readJson<any>('script/00.json').segments).toEqual([
      { speaker: 'narrator', text: 'Before the break.', confidence: 'high' },
      { speaker: 'narrator', text: '• • •', confidence: 'high', kind: 'pause', pauseMs: config.sceneBreakPauseMs },
      { speaker: 'narrator', text: 'After the break.', confidence: 'high' },
    ]);
    // The model is never shown the divider it must not read out; the second
    // request still learns that a scene ended.
    for (const call of llm.mock.calls) expect((call[0] as { user: string }).user).not.toContain('•');
    expect((llm.mock.calls[1][0] as { user: string }).user).toContain('[scene break]');
  });

  it('turns a non-fiction scene break into a pause with no model call', async () => {
    const { work } = fixture({ fiction: false });

    await runScript(work);

    expect(llm).not.toHaveBeenCalled();
    expect(work.readJson<any>('script/00.json').segments.map((segment: any) => segment.kind))
      .toEqual([undefined, 'pause', undefined]);
  });

  it('restores scene breaks dropped by an earlier Chapters run and saves the repaired text', async () => {
    const { work } = fixture({ fiction: false, cleaned: 'Before the break.\n\nAfter the break.' });
    // The extracted chapter still has the divider the old cleanup removed.
    fs.writeFileSync(work.path('chapters/0.md'), 'Before the break.\n\n• • •\n\nAfter the break.');

    await runScript(work);

    expect(fs.readFileSync(work.path('chapters-clean/00.md'), 'utf8'))
      .toBe('Before the break.\n\n• • •\n\nAfter the break.');
    expect(work.readJson<any>('script/00.json').segments[1]).toMatchObject({ kind: 'pause' });
  });

  it('asks for a rerun when an existing script predates scene breaks', async () => {
    const { work, options, events } = fixture({ fiction: false });
    await runScript(work);
    const script = work.readJson<any>('script/00.json');
    work.writeJson('script/00.json', { ...script, segments: script.segments.filter((segment: any) => segment.kind !== 'pause') });

    await runStage({ ...options, stage: 'script' });

    expect(events.map((event) => event.message ?? '').join(' ')).toContain('scripted before scene breaks were kept');
    expect(work.readJson<any>('script/00.json').segments.some((segment: any) => segment.kind === 'pause')).toBe(false);
  });
});

describe('Synth and assembly of scene breaks', () => {
  function synthFixture() {
    const { work, options, events } = fixture({ fiction: false });
    work.writeJson('casting.json', { version: 2, narrator: { voiceProfile: {}, instructions: 'Steady.' }, characters: {} });
    runVoices(work, { provider: 'openai', model: 'gpt-4o-mini-tts' }, path.resolve('library/voices.json'));
    for (const stage of ['script', 'casting', 'voices'] as const) work.markDone(stage);
    return { work, options, events };
  }

  it('records a pause in the chapter manifest without paying for a TTS request', async () => {
    const { work, options } = synthFixture();
    await runScript(work);
    const synthesize = vi.fn(async () => Buffer.from('audio'));
    vi.mocked(getTTSProvider).mockReturnValue({ maxChars: 4000, synthesize } as any);

    await runStage({ ...options, stage: 'synth', rerun: true });

    const { segments } = work.readJson<any>('audio/00-segments.json');
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(segments).toHaveLength(3);
    expect(segments[1]).toEqual({ pauseMs: config.sceneBreakPauseMs });
  });

  it('encodes silence matching the synthesized audio and concatenates it in place', async () => {
    const { work, options } = synthFixture();
    work.writeJson('audio/00-segments.json', { index: 0, segments: ['aaa', { pauseMs: 2000 }, 'bbb'] });
    for (const hash of ['aaa', 'bbb']) fs.writeFileSync(path.join(work.dir('audio-cache'), `${hash}.mp3`), 'paid audio');
    work.markDone('synth');
    let concatList = '';
    command.mockImplementation(async (bin: string, args: string[]) => {
      if (bin === 'ffprobe' && args.includes('stream=sample_rate,channels')) {
        return { stdout: 'sample_rate=24000\nchannels=1\n', stderr: '' };
      }
      if (bin === 'ffprobe') return { stdout: '1\n', stderr: '' };
      const input = args[args.indexOf('-i') + 1];
      if (input?.endsWith(`concat-0.txt`)) concatList = fs.readFileSync(input, 'utf8');
      fs.writeFileSync(args.at(-1)!, 'encoded audio');
      return { stdout: '', stderr: '' };
    });

    await runStage({ ...options, stage: 'assemble' });

    const silence = work.path('audio', 'silence-2000ms-24000-1.mp3');
    expect(fs.existsSync(silence)).toBe(true);
    expect(concatList.split('\n')).toEqual([
      `file '${work.path('audio-cache', 'aaa.mp3')}'`,
      `file '${silence}'`,
      `file '${work.path('audio-cache', 'bbb.mp3')}'`,
    ]);
    const silenceCall = command.mock.calls.find(([, args]: any) => String(args).includes('anullsrc'));
    expect(String(silenceCall?.[1])).toContain('anullsrc=r=24000:cl=mono');
    expect(String(silenceCall?.[1])).toContain('2');
  });

  it('re-encodes a chapter whose manifest gained a pause after the last encode', async () => {
    const { work, options } = synthFixture();
    fs.writeFileSync(work.path(work.dir('audio') && 'audio/00.m4a'), 'stale encoding');
    await new Promise((resolve) => setTimeout(resolve, 5));
    work.writeJson('audio/00-segments.json', { index: 0, segments: ['aaa', { pauseMs: 2000 }] });
    fs.writeFileSync(path.join(work.dir('audio-cache'), 'aaa.mp3'), 'paid audio');
    work.markDone('synth');
    command.mockImplementation(async (bin: string, args: string[]) => {
      if (bin === 'ffprobe' && args.includes('stream=sample_rate,channels')) {
        return { stdout: 'sample_rate=24000\nchannels=1\n', stderr: '' };
      }
      if (bin === 'ffprobe') return { stdout: '1\n', stderr: '' };
      fs.writeFileSync(args.at(-1)!, 'encoded audio');
      return { stdout: '', stderr: '' };
    });

    await runStage({ ...options, stage: 'assemble' });

    expect(fs.readFileSync(work.path('audio/00.m4a'), 'utf8')).toBe('encoded audio');
  });
});

describe('isSceneBreak', () => {
  it('accepts dividers and rejects prose and emptiness', () => {
    expect(['• • •', '* * *', '———', '~'].every(isSceneBreak)).toBe(true);
    expect(['', '   \n  ', 'Chapter 3', '# One'].some(isSceneBreak)).toBe(false);
  });
});
