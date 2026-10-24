import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkDir } from '../src/state.js';
import { runAnalyze } from '../src/pipeline/analyze.js';
import { runStage } from '../src/pipeline/runner.js';
import { prepareBookNlpInput } from '../src/pipeline/booknlp.js';
import { jsonCall } from '../src/providers/llm/openai.js';
import type { Analysis, BookMetadata } from '../src/types.js';

vi.mock('../src/providers/llm/openai.js', () => ({ jsonCall: vi.fn() }));

const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-empty-chapters-'));
  roots.push(root);
  const source = path.join(root, 'book.epub');
  fs.writeFileSync(source, 'fixture');
  const work = new WorkDir(source, root);
  const chapters = [
    { index: 0, id: 'part', title: 'Part 2: Mongolian Mark', file: 'chapters/0000-part.txt', words: 0, isNav: false },
    { index: 1, id: 'body', title: 'Section 2', file: 'chapters/0001-body.txt', words: 11, isNav: false },
    { index: 2, id: 'divider', title: 'Part 3', file: 'chapters/0002-divider.txt', words: 0, isNav: false },
  ];
  const metadata: BookMetadata = { title: 'Book', author: 'Author', language: 'en', chapters };
  work.writeJson('metadata.json', metadata);
  fs.mkdirSync(work.path('chapters'));
  fs.writeFileSync(work.path(chapters[0].file), '');
  fs.writeFileSync(work.path(chapters[1].file), 'Actual body text.');
  fs.writeFileSync(work.path(chapters[2].file), '  — * * * —  ');
  const analysis: Analysis = {
    isFiction: true,
    summary: '',
    characters: [],
    author: { name: 'Author', aliases: [], sex: 'unknown', age: 'unknown', race: 'unknown', class: 'unknown', country: 'unknown', importance: 'minor' },
    chapters: chapters.map((chapter) => ({ index: chapter.index, narrate: true, reason: 'story chapter' })),
  };
  return { root, source, work, analysis };
}

describe('empty structural chapters', () => {
  it('skips them during analysis even when their title starts with Part', async () => {
    const { work, analysis } = fixture();
    vi.mocked(jsonCall).mockResolvedValue(analysis);

    const result = await runAnalyze(work);

    expect(result.chapters.map((chapter) => chapter.narrate)).toEqual([false, true, false]);
    expect(result.chapters[0].reason).toBe('empty chapter');
    expect(result.chapters[2].reason).toBe('empty chapter');
  });

  it('repairs a saved narration plan and omits empty chapters from BookNLP', async () => {
    const { root, source, work, analysis } = fixture();
    work.writeJson('analysis.json', analysis);
    work.markDone('extract');
    work.markDone('analyze');

    const result = await runStage({ sourcePath: source, workRoot: root, stage: 'chapters' });

    expect(work.readJson<Analysis>('analysis.json').chapters.map((chapter) => chapter.narrate)).toEqual([false, true, false]);
    expect(result.work.isDone('chapters')).toBe(true);
    expect(result.work.completedChapters('chapters')).toEqual([1]);
    expect(fs.existsSync(work.path('chapters-clean/0000.txt'))).toBe(false);
    expect(fs.readFileSync(work.path('chapters-clean/0001.txt'), 'utf8')).toBe('Actual body text.');
    expect(prepareBookNlpInput(work).map.chapters.map((chapter) => chapter.index)).toEqual([1]);
  });
});
