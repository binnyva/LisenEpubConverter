import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { attributionBlocks, filterNarratableSegments, runScript } from '../src/pipeline/script.js';
import { runVoices } from '../src/pipeline/voices.js';
import { runStage } from '../src/pipeline/runner.js';
import { isSceneBreak } from '../src/util/text.js';
import { jsonCall } from '../src/providers/llm/openai.js';
import { getTTSProvider } from '../src/providers/tts/openai.js';
import { bookFixture, labelsReply, readScript, removeFixtures } from './helpers.js';

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
afterEach(() => {
  vi.resetAllMocks();
  removeFixtures();
});

/** A one-chapter book whose text carries a "• • •" scene break. */
function fixture({ fiction = true, text = 'Before the break.\n\n• • •\n\nAfter the break.' } = {}) {
  const book = bookFixture({ chapters: [text], profile: fiction ? {} : { isFiction: false, form: 'non-fiction' } });
  return { work: book.work, events: book.events, options: book.run };
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
  it('turns a scene break into a pause between separately labelled sections, and never shows the divider', async () => {
    const { work } = fixture({ text: '"Go," said Ann.\n\n• • •\n\n"Stay," said Ann.' });
    llm.mockResolvedValue(labelsReply([[1, 'Ann']], { characters: [{ name: 'Ann' }] }) as any);

    await runScript(work, undefined, () => {});

    expect(llm).toHaveBeenCalledTimes(2);
    for (const [request] of llm.mock.calls) expect(request.user).not.toContain('•');
    expect(llm.mock.calls[1][0].user).toContain('[scene break]');
    expect(readScript(work, 0).segments.map((segment) => [segment.kind ?? 'speech', segment.speaker, segment.text])).toEqual([
      ['speech', 'Ann', '"Go,"'], ['speech', 'narrator', 'said Ann.'],
      ['pause', 'narrator', '• • •'],
      ['speech', 'Ann', '"Stay,"'], ['speech', 'narrator', 'said Ann.'],
    ]);
    expect(readScript(work, 0).segments[2].pauseMs).toBe(config.sceneBreakPauseMs);
  });

  it('turns a non-fiction scene break into a pause with no model call', async () => {
    const { work } = fixture({ fiction: false });

    await runScript(work, undefined, () => {});

    expect(llm).not.toHaveBeenCalled();
    expect(readScript(work, 0).segments.map((segment) => segment.kind ?? 'speech')).toEqual(['speech', 'pause', 'speech']);
  });
});

describe('Synth and assembly of scene breaks', () => {
  function synthFixture() {
    const { work, options, events } = fixture({ fiction: false });
    work.writeJson('casting.json', { version: 2, narrator: { voiceProfile: {}, instructions: 'Steady.' }, characters: {} });
    runVoices(work, { provider: 'openai', model: 'gpt-4o-mini-tts' }, path.resolve('library/voices.json'));
    for (const stage of ['script', 'casting', 'voices'] as const) work.markDone(stage);
    work.dir('3-audio');
    return { work, options, events };
  }

  it('records a pause in the chapter manifest without paying for a TTS request', async () => {
    const { work, options } = synthFixture();
    await runScript(work, undefined, () => {});
    const synthesize = vi.fn(async () => Buffer.from('audio'));
    vi.mocked(getTTSProvider).mockReturnValue({ maxChars: 4000, synthesize } as any);

    await runStage({ ...options, stage: 'synth', rerun: true });

    const { segments } = work.readJson<any>('3-audio/00-chapter-1.json');
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(segments).toHaveLength(3);
    expect(segments[1]).toEqual({ pauseMs: config.sceneBreakPauseMs });
  });

  it('encodes silence matching the synthesized audio and concatenates it in place', async () => {
    const { work, options } = synthFixture();
    work.writeJson('3-audio/00-chapter-1.json', { index: 0, segments: ['aaa', { pauseMs: 2000 }, 'bbb'] });
    for (const hash of ['aaa', 'bbb']) fs.writeFileSync(path.join(work.dir('2-audio-cache'), `${hash}.mp3`), 'paid audio');
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

    const silence = work.path('3-audio', 'silence-2000ms-24000-1.mp3');
    expect(fs.existsSync(silence)).toBe(true);
    expect(concatList.split('\n')).toEqual([
      `file '${work.path('2-audio-cache', 'aaa.mp3')}'`,
      `file '${silence}'`,
      `file '${work.path('2-audio-cache', 'bbb.mp3')}'`,
    ]);
    const silenceCall = command.mock.calls.find(([, args]: any) => String(args).includes('anullsrc'));
    expect(String(silenceCall?.[1])).toContain('anullsrc=r=24000:cl=mono');
    expect(String(silenceCall?.[1])).toContain('2');
  });

  it('re-encodes a chapter whose manifest gained a pause after the last encode', async () => {
    const { work, options } = synthFixture();
    fs.writeFileSync(work.path('3-audio/00-chapter-1.m4a'), 'stale encoding');
    await new Promise((resolve) => setTimeout(resolve, 5));
    work.writeJson('3-audio/00-chapter-1.json', { index: 0, segments: ['aaa', { pauseMs: 2000 }] });
    fs.writeFileSync(path.join(work.dir('2-audio-cache'), 'aaa.mp3'), 'paid audio');
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

    expect(fs.readFileSync(work.path('3-audio/00-chapter-1.m4a'), 'utf8')).toBe('encoded audio');
  });
});

describe('isSceneBreak', () => {
  it('accepts dividers and rejects prose and emptiness', () => {
    expect(['• • •', '* * *', '———', '~'].every(isSceneBreak)).toBe(true);
    expect(['', '   \n  ', 'Chapter 3', '# One'].some(isSceneBreak)).toBe(false);
  });
});
