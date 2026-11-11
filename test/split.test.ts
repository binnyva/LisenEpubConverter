import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkDir } from '../src/state.js';
import { runExtract } from '../src/pipeline/extract.js';
import { buildStories, validateStories } from '../src/pipeline/stories.js';
import { splitOversizedChapter } from '../src/source/split.js';
import type { BookMetadata, BookProfile } from '../src/types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const prose = (label: string, words: number): string => `${label} ${'word '.repeat(words - 1).trim()}`;
const paragraphsOf = (text: string): string[] => text.split(/\n\s*\n/).filter((paragraph) => paragraph.trim());

describe('splitOversizedChapter', () => {
  it('leaves a chapter within the limit alone', () => {
    const text = [prose('One', 300), prose('Two', 300)].join('\n\n');
    expect(splitOversizedChapter(text, 1000, 500)).toEqual([text]);
  });

  it('cuts at a scene break rather than the nearest paragraph, and loses nothing', () => {
    // Ideal cut is at 1000 words; the scene break sits at 800, a plain paragraph at 1000.
    const text = [prose('A', 400), prose('B', 400), '• • •', prose('C', 200), prose('D', 500), prose('E', 490)].join('\n\n');
    const parts = splitOversizedChapter(text, 1500, 1000);

    expect(parts).toHaveLength(2);
    expect(parts[1].startsWith('• • •\n\nC ')).toBe(true);
    expect(paragraphsOf(parts.join('\n\n'))).toEqual(paragraphsOf(text));
  });

  it('prefers a heading or bold section marker, and keeps a marker with its epigraph', () => {
    const text = [prose('A', 900), '***2***', '***Against stupidity***', prose('B', 800), '## Later', prose('C', 900)].join('\n\n');
    const parts = splitOversizedChapter(text, 1500, 1000);

    expect(parts.map((part) => part.split('\n')[0])).toEqual([expect.stringMatching(/^A /), '***2***', '## Later']);
  });

  it('does not treat an emphasised line of dialogue as a section marker', () => {
    const text = [prose('A', 900), '*"I haven\'t."*', prose('B', 100), prose('C', 900)].join('\n\n');
    const parts = splitOversizedChapter(text, 1500, 1000);

    expect(parts).toHaveLength(2);
    expect(parts[1].startsWith('B ')).toBe(true);
  });

  it('falls back to the nearest paragraph when paragraphs are very long', () => {
    const text = [prose('A', 3000), prose('B', 3000), prose('C', 3000)].join('\n\n');
    expect(splitOversizedChapter(text, 8000, 5000).map((part) => part[0])).toEqual(['A', 'B']);
  });

  it('cannot split a single paragraph', () => {
    const text = prose('A', 9000);
    expect(splitOversizedChapter(text, 8000, 5000)).toEqual([text]);
  });
});

describe('runExtract with an oversized chapter', () => {
  it('writes numbered parts that share a source and keep the first title', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-split-'));
    roots.push(root);
    const source = path.join(root, 'novel.md');
    const body = ['# Novel', prose('Opening', 4000), '## Middle', prose('Middle', 4000), '## End', prose('Closing', 4000)].join('\n\n');
    fs.writeFileSync(source, body);
    const work = new WorkDir(source, path.join(root, 'work'));

    const meta = await runExtract(source, work);

    expect(meta.chapters.map((chapter) => chapter.title)).toEqual(['Novel', 'Novel (part 2)', 'Novel (part 3)']);
    expect(meta.chapters.map((chapter) => chapter.index)).toEqual([0, 1, 2]);
    expect(meta.chapters.map((chapter) => chapter.part)).toEqual([
      { first: 0, number: 1, total: 3 }, { first: 0, number: 2, total: 3 }, { first: 0, number: 3, total: 3 },
    ]);
    expect(new Set(meta.chapters.map((chapter) => chapter.id)).size).toBe(3);
    const texts = meta.chapters.map((chapter) => fs.readFileSync(work.path(chapter.file), 'utf8'));
    expect(texts[1].startsWith('## Middle')).toBe(true);
    expect(texts[2].startsWith('## End')).toBe(true);
    expect(paragraphsOf(texts.join('\n\n'))).toEqual(paragraphsOf(body));
  });
});

describe('story grouping with split chapters', () => {
  const chapter = (index: number, title: string, part?: BookMetadata['chapters'][number]['part']) =>
    ({ index, id: `c${index}`, title, file: `chapters/${index}.md`, words: 5000, isNav: false, part });
  const base = {
    title: 'Collected', author: 'Author', language: 'en', subjects: [], description: '',
    chapters: [
      chapter(0, 'Short'),
      chapter(1, 'Long', { first: 1, number: 1, total: 2 }),
      chapter(2, 'Long (part 2)', { first: 1, number: 2, total: 2 }),
      chapter(3, 'Other'),
    ],
  } as BookMetadata;
  const profiled = (stories: BookProfile['stories']): BookMetadata => ({
    ...base,
    profile: {
      isFiction: true, form: 'short story collection', stories,
      chapters: base.chapters.map(({ index, title }) => ({ index, title, narrate: true, reason: '' })),
    } as unknown as BookProfile,
  });

  it('keeps the parts of one story together by default', () => {
    const stories = buildStories(true, profiled([]));

    expect(stories.stories.map((story) => [story.id, story.title, story.chapters])).toEqual([
      ['story-00', 'Short', [0]], ['story-01', 'Long', [1, 2]], ['story-03', 'Other', [3]],
    ]);
    expect(() => validateStories(stories, profiled([]))).not.toThrow();
  });

  it('merges a proposal that put the parts in separate stories', () => {
    const proposed = profiled([
      { title: 'Short', chapters: [0] }, { title: 'Long', chapters: [1] },
      { title: 'Long, continued', chapters: [2] }, { title: 'Other', chapters: [3] },
    ]);

    expect(buildStories(true, proposed).stories.map((story) => story.chapters)).toEqual([[0], [1, 2], [3]]);
  });
});
