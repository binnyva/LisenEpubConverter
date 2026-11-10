import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkDir } from '../src/state.js';
import { config } from '../src/config.js';
import { runChapters } from '../src/pipeline/chapters.js';
import { runScript } from '../src/pipeline/script.js';
import { characterChapterFile, runListCharacters } from '../src/pipeline/list-characters.js';
import { runStage } from '../src/pipeline/runner.js';
import { condenseSummary } from '../src/util/text.js';
import { CharacterObservationSchema } from '../src/types.js';
import { jsonCall } from '../src/providers/llm/openai.js';

vi.mock('../src/providers/llm/openai.js', () => ({ jsonCall: vi.fn() }));
const llm = vi.mocked(jsonCall);
const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// Three paragraphs, each close to a full block, so the chapter is three LLM calls.
const paragraph = (label: string): string => `${label} ${'word '.repeat(1000)}end.`;
const PARAGRAPHS = ['First', 'Second', 'Third'].map(paragraph);
const TEXT = PARAGRAPHS.join('\n\n');

function fixture(isFiction: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-checkpoint-'));
  roots.push(root);
  const epubPath = path.join(root, 'book.epub');
  fs.writeFileSync(epubPath, 'offline fixture');
  const work = new WorkDir(epubPath, root);
  work.writeJson('metadata.json', { title: 'Story', author: 'Author', chapters: [{ index: 0, title: 'One', file: 'chapters/0.md', words: 3000 }] });
  work.writeJson('analysis.json', {
    isFiction, summary: 'Sampled overview.', characters: [],
    author: { name: 'Author', sex: 'unknown', age: 'unknown', country: 'unknown' },
    chapters: [{ index: 0, narrate: true }],
  });
  work.dir('chapters');
  fs.writeFileSync(work.path('chapters/0.md'), TEXT);
  work.markDone('extract');
  work.markDone('analyze');
  return { work, options: { sourcePath: epubPath, workRoot: root } };
}

const cleaned = (text: string) => ({ cleanedText: text, partialSummary: `Summary of ${text.slice(0, 6)}.`, characters: [] });
const userPrompt = (call: number): string => (llm.mock.calls[call][0] as { user: string }).user;

describe('per-block checkpoints', () => {
  it('resumes Chapters after a failed block without repeating finished ones', async () => {
    const { work } = fixture(false);
    llm.mockResolvedValueOnce(cleaned(PARAGRAPHS[0]))
      .mockResolvedValueOnce(cleaned(PARAGRAPHS[1]))
      .mockRejectedValueOnce(new Error('LLM request timed out'));

    await expect(runChapters(work)).rejects.toThrow('timed out');
    expect(fs.existsSync(work.path('chapters-clean/00.md'))).toBe(false);
    expect(fs.existsSync(work.path('checkpoints/chapters-00.json'))).toBe(true);

    llm.mockResolvedValueOnce(cleaned(PARAGRAPHS[2]));
    await runChapters(work);

    expect(llm).toHaveBeenCalledTimes(4);
    expect(userPrompt(3)).toContain('(part 3 of 3)');
    expect(fs.readFileSync(work.path('chapters-clean/00.md'), 'utf8')).toBe(TEXT);
    expect(work.readJson<Record<string, string>>('chapter-summaries.json')[0]).toBe('Summary of First . Summary of Second. Summary of Third .');
    expect(fs.existsSync(work.path('checkpoints/chapters-00.json'))).toBe(false);
  });

  it('ignores a Chapters checkpoint when the chapter text changed', async () => {
    const { work } = fixture(false);
    llm.mockResolvedValueOnce(cleaned(PARAGRAPHS[0])).mockRejectedValueOnce(new Error('boom'));
    await expect(runChapters(work)).rejects.toThrow('boom');

    fs.writeFileSync(work.path('chapters/0.md'), 'A short replacement chapter.');
    llm.mockResolvedValueOnce(cleaned('A short replacement chapter.'));
    await runChapters(work);

    expect(fs.readFileSync(work.path('chapters-clean/00.md'), 'utf8')).toBe('A short replacement chapter.');
  });

  it('starts Chapters over on an explicit rerun', async () => {
    const { work, options } = fixture(false);
    llm.mockResolvedValueOnce(cleaned(PARAGRAPHS[0])).mockRejectedValueOnce(new Error('boom'));
    await expect(runStage({ ...options, stage: 'chapters', onEvent: () => {} })).rejects.toThrow('boom');

    llm.mockImplementation(async (opts) => cleaned((opts as { user: string }).user.split('Text:\n')[1]));
    await runStage({ ...options, stage: 'chapters', rerun: true, onEvent: () => {} });

    // Two calls before the failure, then all three blocks again.
    expect(llm).toHaveBeenCalledTimes(5);
  });

  it('resumes Script after a failed block and keeps the checkpoint out of the saved script', async () => {
    const { work } = fixture(true);
    work.writeJson(characterChapterFile(0), { index: 0, observations: [] });
    runListCharacters(work);
    work.writeJson('chapter-summaries.json', { 0: 'Things happen.' });
    fs.writeFileSync(work.dir('chapters-clean') + '/00.md', TEXT);
    const narrated = (text: string) => ({ segments: [{ speaker: 'Narrator', text, confidence: 'high' }] });
    llm.mockResolvedValueOnce(narrated(PARAGRAPHS[0]))
      .mockResolvedValueOnce(narrated(PARAGRAPHS[1]))
      .mockRejectedValueOnce(new Error('LLM response reached its completion token limit'));

    await expect(runScript(work, undefined, () => {})).rejects.toThrow('token limit');
    expect(fs.existsSync(work.path('script/00.json'))).toBe(false);

    llm.mockResolvedValueOnce(narrated(PARAGRAPHS[2]));
    await runScript(work, undefined, () => {});

    expect(llm).toHaveBeenCalledTimes(4);
    expect(userPrompt(3)).toContain('(part 3 of 3)');
    // The resumed block still sees the tail of the restored blocks as context.
    expect(userPrompt(3)).toContain('[Narrator] Second');
    const script = work.readJson<{ segments: Array<{ speaker: string; text: string }> }>('script/00.json');
    expect(script.segments.map((segment) => segment.text)).toEqual(PARAGRAPHS);
    expect(script.segments.every((segment) => segment.speaker === 'narrator')).toBe(true);
    expect(fs.existsSync(work.path('checkpoints/script-00.json'))).toBe(false);
  });

  it('reuses attributed blocks after an unresolved speaker is added to the registry', async () => {
    const { work } = fixture(true);
    work.writeJson(characterChapterFile(0), { index: 0, observations: [] });
    runListCharacters(work);
    work.writeJson('chapter-summaries.json', { 0: 'Bob speaks.' });
    fs.writeFileSync(work.dir('chapters-clean') + '/00.md', '"Hello."');
    llm.mockResolvedValueOnce({ segments: [{ speaker: 'Bob', text: '"Hello."', confidence: 'high' }] })
      .mockResolvedValueOnce({ attributions: [{ id: 0, speaker: 'Bob' }] });

    await expect(runScript(work, undefined, () => {})).rejects.toThrow('New or unresolved speakers in chapter 1: Bob');
    expect(llm).toHaveBeenCalledTimes(2);

    work.writeJson(characterChapterFile(0), { index: 0, observations: [{
      ...CharacterObservationSchema.parse({ name: 'Bob', named: true, evidence: 'Bob said hello.', confidence: 'high' }), chunk: 0,
    }] });
    runListCharacters(work);
    await runScript(work, undefined, () => {});

    // No further model calls: the saved attribution now matches the cast.
    expect(llm).toHaveBeenCalledTimes(2);
    expect(work.readJson<{ segments: Array<{ speaker: string }> }>('script/00.json').segments.map((s) => s.speaker)).toEqual(['Bob']);
    expect(fs.existsSync(work.path('checkpoints/script-00.json'))).toBe(false);
    expect(fs.existsSync(work.path('character-candidates/00.json'))).toBe(false);
  });

  it('caps the chapter summary sent with every Script block', async () => {
    const { work } = fixture(true);
    work.writeJson(characterChapterFile(0), { index: 0, observations: [] });
    runListCharacters(work);
    const long = Array.from({ length: 200 }, (_, i) => `Event number ${i} happens here.`).join(' ');
    work.writeJson('chapter-summaries.json', { 0: long });
    fs.writeFileSync(work.dir('chapters-clean') + '/00.md', 'A short chapter.');
    llm.mockResolvedValueOnce({ segments: [{ speaker: 'narrator', text: 'A short chapter.', confidence: 'high' }] });

    await runScript(work, undefined, () => {});

    const summary = userPrompt(0).match(/Chapter summary: (.*)/)![1];
    expect(summary.length).toBeLessThanOrEqual(config.promptSummaryChars + 3);
    expect(summary).toContain('Event number 0 happens here.');
    expect(summary).toContain('Event number 199 happens here.');
  });
});

describe('condenseSummary', () => {
  it('returns a short summary unchanged', () => {
    expect(condenseSummary('One.  Two.', 100)).toBe('One. Two.');
  });

  it('keeps whole sentences from the start and the end', () => {
    const text = 'Alpha begins. Beta follows. Gamma continues. Delta ends.';
    expect(condenseSummary(text, 30)).toBe('Alpha begins. … Delta ends.');
  });

  it('cuts a single oversized sentence', () => {
    expect(condenseSummary('x'.repeat(500), 50)).toBe(`${'x'.repeat(50)} …`);
  });
});
