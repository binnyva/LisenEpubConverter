import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { doubleQuoteDensity, firstBodyChapter, settleDialogueStyle } from '../src/pipeline/metadata.js';
import type { BookMetadata, ExtractedChapter, Stories } from '../src/types.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const words = (word: string, count: number): string => Array.from({ length: count }, (_, i) => `${word}${i}`).join(' ');
const QUOTED_BODY = `${Array.from({ length: 40 }, (_, i) => `"Line ${i}," said Ann. She waited a while before speaking again.`).join('\n\n')}\n\n${words('body', 2000)}`;

/** A book as Extract leaves it: no profile yet. */
async function extracted(options: { chapters: Array<{ title: string; text: string; isNav?: boolean }>; description?: string; subjects?: string[] }) {
  const helpers = await import('./helpers.js');
  cleanups.push(helpers.removeFixtures);
  const book = helpers.bookFixture({ title: 'The Last Question', chapters: options.chapters, done: ['extract'] });
  const metadata = book.work.readJson<BookMetadata>('metadata.json');
  delete metadata.profile;
  metadata.author = 'Isaac Asimov';
  metadata.description = options.description ?? '';
  metadata.subjects = options.subjects ?? [];
  metadata.chapters.forEach((chapter, index) => { chapter.isNav = options.chapters[index].isNav ?? false; });
  book.work.writeJson('metadata.json', metadata);
  fs.rmSync(book.work.path('stories.json'));
  return book;
}

const reply = (overrides: Record<string, unknown> = {}) => ({
  recognised: true,
  summary: 'Two technicians ask a computer whether entropy can be reversed.',
  author: { sex: 'male', race: 'white', age: '30s', country: 'United States' },
  isFiction: true,
  form: 'short story',
  genres: ['science fiction'],
  narrator: { pointOfView: 'third', sex: 'unknown' },
  dialogueStyle: 'quoted',
  chapters: [
    { index: 0, title: 'Contents', narrate: true, reason: 'model was wrong' },
    { index: 1, title: 'Copyright', narrate: false, reason: 'copyright page' },
    { index: 2, title: 'The Last Question', narrate: true, reason: 'body' },
  ],
  stories: [],
  ...overrides,
});

const BOOK = [
  { title: 'Contents', text: 'Contents\n\n1. The Last Question', isNav: true },
  { title: 'Copyright', text: words('rights', 400) },
  { title: 'THE_LAST_QUESTION.xhtml', text: QUOTED_BODY },
];

/** Run the stage against a stubbed OpenRouter endpoint and return what was sent. */
async function runWith(book: Awaited<ReturnType<typeof extracted>>, response: unknown) {
  vi.stubEnv('LISEN_LLM_PROVIDER', 'openrouter');
  vi.stubEnv('OPENROUTER_API_KEY', 'offline-test');
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(response) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 900, completion_tokens: 200 },
  })));
  vi.stubGlobal('fetch', fetchMock);
  const { runStage } = await import('../src/pipeline/runner.js');
  await runStage({ ...book.run, stage: 'metadata' });
  const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
  return { fetchMock, body, user: body.messages[1].content as string, system: body.messages[0].content as string };
}

describe('Metadata request', () => {
  it('sends source metadata, every chapter\'s opening and one body sample — never the whole book — in one call', async () => {
    const book = await extracted({ chapters: BOOK, description: 'A story about entropy.', subjects: ['Science fiction', 'Short stories'] });

    const { fetchMock, body, user, system } = await runWith(book, reply());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body.response_format.type).toBe('json_schema');
    expect(body).not.toHaveProperty('tools');
    expect(user).toContain('Title: The Last Question\nAuthor: Isaac Asimov\nLanguage: en\nSubjects: Science fiction; Short stories');
    expect(user).toContain("Description from the source file (often the publisher's blurb): A story about entropy.");
    expect(user).toContain('0 — "Contents" — 5 words — navigation document');
    expect(user).toContain('1 — "Copyright" — 400 words\n   Opening: rights0 rights1');
    // 150 words of each opening, not the 151st.
    expect(user).toContain('rights149');
    expect(user).not.toContain('rights150');
    // The sample is the first chapter that is not front matter, cut at about 1,500 words.
    expect(user).toContain('Sample from chapter 2, "THE_LAST_QUESTION.xhtml":\n"Line 0," said Ann.');
    expect(user).toContain('body1000');
    expect(user).not.toContain('body1100');
    expect(user.length).toBeLessThan(QUOTED_BODY.length);
    expect(system).toContain('You are not given the whole book');
    expect(system).toMatch(/recognised: true only if you know this specific book/);
  });
});

describe('Metadata response', () => {
  it('saves the profile beside what Extract wrote, with backstopped chapter plans and cleaned titles', async () => {
    const book = await extracted({ chapters: BOOK });
    const before = book.work.readJson<BookMetadata>('metadata.json');

    await runWith(book, reply());

    const saved = book.work.readJson<BookMetadata>('metadata.json');
    expect({ ...saved, profile: undefined }).toEqual({ ...before, profile: undefined });
    expect(saved.profile).toMatchObject({
      recognised: true, summarySource: 'model', isFiction: true, form: 'short story', genres: ['science fiction'],
      author: { sex: 'male', country: 'United States' }, narrator: { pointOfView: 'third' }, dialogueStyle: 'quoted',
    });
    expect(saved.profile!.chapters).toEqual([
      { index: 0, title: 'Contents', narrate: false, reason: 'nav/TOC document' },
      { index: 1, title: 'Copyright', narrate: false, reason: 'title matches skip list: "Copyright"' },
      { index: 2, title: 'The Last Question', narrate: true, reason: 'body' },
    ]);
    expect(book.work.readJson<Stories>('stories.json')).toMatchObject({ collection: false, stories: [{ id: 'book', chapters: [2] }] });
    expect(book.work.isDone('extract')).toBe(true);
  });

  it('logs the call, its tokens and wall time for the stage', async () => {
    const book = await extracted({ chapters: BOOK });
    await runWith(book, reply());

    const usage = book.work.readJson<any[]>('usage.json');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      stage: 'metadata', outcome: 'completed',
      llm: { calls: 1, promptTokens: 900, completionTokens: 200, reasoningTokens: 0 },
      models: { 'gpt-4.1': { calls: 1, promptTokens: 900, completionTokens: 200 } },
      tts: { calls: 0, characters: 0 },
    });
    expect(usage[0].wallMs).toBeGreaterThanOrEqual(0);
    const event = book.events.find((entry) => entry.type === 'usage');
    expect(event?.message).toMatch(/^metadata usage: 1 LLM call · 900 prompt \+ 200 completion tokens · \d+s$/);
    expect(event?.usage).toEqual(usage[0]);
  });

  it('keeps no summary from memory of a book the model does not recognise', async () => {
    const withBlurb = await extracted({ chapters: BOOK, description: 'The publisher says it is good.' });
    await runWith(withBlurb, reply({ recognised: false, summary: 'An invented plot.' }));
    expect(withBlurb.work.readJson<BookMetadata>('metadata.json').profile).toMatchObject({ summary: 'The publisher says it is good.', summarySource: 'blurb' });

    const bare = await extracted({ chapters: BOOK });
    await runWith(bare, reply({ recognised: false, summary: 'An invented plot.' }));
    expect(bare.work.readJson<BookMetadata>('metadata.json').profile).toMatchObject({ summary: '', summarySource: 'none' });
  });

  it('lets the text overrule the dialogue style a short sample suggested', async () => {
    const dashes = await extracted({ chapters: [{ title: 'Um', text: `${words('palavra', 600)}\n\n— Bom dia, disse ele.` }] });
    await runWith(dashes, reply({ chapters: [{ index: 0, title: 'Um', narrate: true, reason: '' }] }));
    const profile = dashes.work.readJson<BookMetadata>('metadata.json').profile!;
    expect(profile.dialogueStyle).toBe('unquoted');
    expect(profile.dialogueStyleNote).toContain('0.0 double-quote pairs per 1,000 words');

    const quoted = await extracted({ chapters: BOOK });
    await runWith(quoted, reply({ dialogueStyle: 'unquoted' }));
    expect(quoted.work.readJson<BookMetadata>('metadata.json').profile!.dialogueStyle).toBe('quoted');
  });

  it('groups a collection as proposed, and falls back to a story per chapter when the proposal is invalid', async () => {
    const stories = [{ title: 'One', text: QUOTED_BODY }, { title: 'One, continued', text: QUOTED_BODY }, { title: 'Two', text: QUOTED_BODY }];
    const plans = stories.map((story, index) => ({ index, title: story.title, narrate: true, reason: '' }));

    const grouped = await extracted({ chapters: stories });
    await runWith(grouped, reply({ form: 'short story collection', chapters: plans, stories: [{ title: 'One', chapters: [0, 1] }, { title: 'Two', chapters: [2] }] }));
    expect(grouped.work.readJson<Stories>('stories.json').stories.map((story) => [story.id, story.chapters])).toEqual([['story-00', [0, 1]], ['story-02', [2]]]);

    const invalid = await extracted({ chapters: stories });
    await runWith(invalid, reply({ form: 'short story collection', chapters: plans, stories: [{ title: 'One', chapters: [0] }] }));
    expect(invalid.work.readJson<Stories>('stories.json').stories.map((story) => story.chapters)).toEqual([[0], [1], [2]]);
    expect(invalid.events.some((event) => event.type === 'warning' && event.message.includes('Ignored the proposed story grouping'))).toBe(true);
  });

  it('rebuilds on its own without Extract, and the collection override survives', async () => {
    const book = await extracted({ chapters: BOOK });
    await runWith(book, reply());
    const chapterFile = book.work.path(book.metadata.chapters[2].file);
    const extractedAt = fs.statSync(chapterFile).mtimeMs;

    const { runStage } = await import('../src/pipeline/runner.js');
    await runStage({ ...book.run, stage: 'metadata', rebuild: true, collection: true });

    const saved = book.work.readJson<BookMetadata>('metadata.json');
    expect(saved.chapters).toHaveLength(3);
    expect(saved.profile?.form).toBe('short story');
    expect(fs.statSync(chapterFile).mtimeMs).toBe(extractedAt);
    expect(book.work.readJson<Stories>('stories.json')).toMatchObject({ collection: true, stories: [{ id: 'story-02', chapters: [2] }] });
  });
});

describe('Metadata helpers', () => {
  const chapter = (index: number, title: string, wordCount: number, isNav = false) => ({ index, title, words: wordCount, isNav }) as ExtractedChapter;

  it('picks the first chapter that does not look like front matter', () => {
    const chapters = [chapter(0, 'Cover', 2), chapter(1, 'Contents', 80, true), chapter(2, 'Introduction by the Editor', 3000), chapter(3, 'Dedication', 400), chapter(4, 'Prologue', 900), chapter(5, 'Chapter One', 4000)];
    expect(firstBodyChapter(chapters)?.index).toBe(4);
    expect(firstBodyChapter([chapter(0, 'Preface', 500), chapter(1, 'Foreword', 900)])?.index).toBe(1);
  });

  it('measures double-quote pairs per thousand words and settles the style on it', () => {
    expect(doubleQuoteDensity(`${words('w', 998)} "a b"`)).toBeCloseTo(1, 1);
    expect(settleDialogueStyle('quoted', 12)).toEqual({ dialogueStyle: 'quoted' });
    expect(settleDialogueStyle('unquoted', 0.2)).toEqual({ dialogueStyle: 'unquoted' });
    expect(settleDialogueStyle('quoted', 0.2).dialogueStyle).toBe('unquoted');
    expect(settleDialogueStyle('unquoted', 12).dialogueStyle).toBe('quoted');
  });
});
