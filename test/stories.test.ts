import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkDir } from '../src/state.js';
import { CharacterObservationSchema, type Analysis, type BookMetadata, type ChapterCharacters } from '../src/types.js';
import {
  buildCharacterRegistry,
  characterChapterFile,
  characterScopeHash,
  legacyCharacterRegistryHash,
  runListCharacters,
} from '../src/pipeline/list-characters.js';
import { buildStories, chaptersForStoryNumbers, readStories, validateStories } from '../src/pipeline/stories.js';
import { runScript } from '../src/pipeline/script.js';
import { runCasting } from '../src/pipeline/casting.js';
import { runVoices } from '../src/pipeline/voices.js';
import { runStage, saveStoryGrouping } from '../src/pipeline/runner.js';
import { loadVoiceLibrary, saveVoiceLibrary } from '../src/voices/library.js';
import { jsonCall } from '../src/providers/llm/openai.js';

vi.mock('../src/providers/llm/openai.js', () => ({ jsonCall: vi.fn() }));
const llm = vi.mocked(jsonCall);
const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const observation = (name: string, extra = {}) => ({
  ...CharacterObservationSchema.parse({ name, named: true, evidence: `${name} said hello.`, confidence: 'high', ...extra }),
  chunk: 0,
});
const chapter = (index: number, observations: ChapterCharacters['observations']): ChapterCharacters => ({ index, observations });
const STORY_TITLES = ['The Sentinel', 'Rescue Party', 'Breaking Strain'];

function fixture(count = 2, collection = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-stories-'));
  roots.push(root);
  const epubPath = path.join(root, 'book.epub');
  fs.writeFileSync(epubPath, crypto.randomBytes(32));
  const work = new WorkDir(epubPath, root);
  const chapters = Array.from({ length: count }, (_, index) => ({
    index, id: `c${index}`, title: STORY_TITLES[index] ?? `Story ${index + 1}`,
    file: `chapters/${index}.md`, words: 400, isNav: false,
  }));
  const metadata = { title: 'Collected Stories', author: 'Author', language: 'en', chapters } as BookMetadata;
  const analysis = {
    isFiction: true, isCollection: collection, collectionReason: 'Independent stories.',
    summary: 'Sampled overview.', characters: [],
    author: { name: 'Author', aliases: [], sex: 'unknown', age: 'unknown', race: 'unknown', class: 'unknown', country: 'unknown', importance: 'minor' },
    chapters: chapters.map(({ index }) => ({ index, narrate: true, reason: '' })),
  } as unknown as Analysis;
  work.writeJson('metadata.json', metadata);
  work.writeJson('analysis.json', analysis);
  work.writeJson('stories.json', buildStories(collection, metadata, analysis));
  work.setCollection(collection);
  work.dir('chapters');
  work.writeJson('chapter-summaries.json', Object.fromEntries(chapters.map(({ index }) => [index, `Summary ${index}.`])));
  work.dir('chapters-clean');
  for (const ch of chapters) {
    fs.writeFileSync(work.path(ch.file), `Chapter ${ch.index}: Hello.`);
    fs.writeFileSync(work.path(`chapters-clean/${String(ch.index).padStart(2, '0')}.md`), '"Hello."');
  }
  work.markDone('extract');
  work.markDone('analyze');
  return { work, metadata, analysis, options: { epubPath, workRoot: root, outDir: path.join(root, 'out') } };
}

describe('story grouping', () => {
  it('gives a collection one story per narratable chapter and a continuous work a single scope', () => {
    const { work, metadata, analysis } = fixture(3);
    expect(readStories(work)).toEqual({
      version: 1,
      collection: true,
      stories: [
        { id: 'story-00', title: 'The Sentinel', chapters: [0] },
        { id: 'story-01', title: 'Rescue Party', chapters: [1] },
        { id: 'story-02', title: 'Breaking Strain', chapters: [2] },
      ],
    });
    const continuous = buildStories(false, metadata, analysis);
    expect(continuous.stories).toEqual([{ id: 'book', title: 'Collected Stories', chapters: [0, 1, 2] }]);
  });

  it('uses the proposed grouping, including a story told in two chapters', () => {
    const { metadata, analysis } = fixture(3);
    analysis.stories = [
      { title: '', chapters: [0] },
      { title: 'Rescue Party, Parts I and II', chapters: [2, 1] },
    ];

    expect(buildStories(true, metadata, analysis).stories).toEqual([
      { id: 'story-00', title: 'The Sentinel', chapters: [0] },
      { id: 'story-01', title: 'Rescue Party, Parts I and II', chapters: [1, 2] },
    ]);
  });

  it('drops chapters the narration backstop skipped and keeps the rest of the proposal', () => {
    const { metadata, analysis } = fixture(3);
    analysis.chapters[2].narrate = false;
    analysis.stories = [{ title: 'One', chapters: [0] }, { title: 'Two', chapters: [1, 2] }];

    expect(buildStories(true, metadata, analysis).stories).toEqual([
      { id: 'story-00', title: 'One', chapters: [0] },
      { id: 'story-01', title: 'Two', chapters: [1] },
    ]);
  });

  it('falls back to one story per chapter when a proposal does not cover the book', () => {
    const { metadata, analysis } = fixture(3);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    analysis.stories = [{ title: 'One', chapters: [0] }, { title: 'Two', chapters: [1] }];

    expect(buildStories(true, metadata, analysis).stories.map((story) => story.chapters)).toEqual([[0], [1], [2]]);
    expect(warn.mock.calls.join(' ')).toContain('chapter 3 does not');
    warn.mockRestore();
  });

  it('rejects a grouping that double-books or abandons a chapter', () => {
    const { metadata, analysis } = fixture(2);
    const grouping = (chapters: number[][]) => ({
      version: 1 as const, collection: true,
      stories: chapters.map((list, position) => ({ id: `story-${position}`, title: '', chapters: list })),
    });
    expect(() => validateStories(grouping([[0], [0, 1]]), metadata, analysis)).toThrow('belongs to more than one story');
    expect(() => validateStories(grouping([[0]]), metadata, analysis)).toThrow('chapter 2 does not');
    expect(() => validateStories(grouping([[1], [0]]), metadata, analysis)).toThrow('in chapter order');
    expect(() => validateStories({ ...grouping([[0], [1]]), collection: false }, metadata, analysis))
      .toThrow('A continuous work has one story');
  });

  it('skips chapters that are not narrated', () => {
    const { metadata, analysis } = fixture(3);
    analysis.chapters[1].narrate = false;
    expect(buildStories(true, metadata, analysis).stories.map((story) => story.chapters)).toEqual([[0], [2]]);
  });
});

describe('story-scoped character registry', () => {
  it('keeps one name used by two stories as two characters, labelled by story', () => {
    const { work } = fixture(2);
    work.writeJson(characterChapterFile(0), chapter(0, [observation('John', { sex: 'male', age: '40s' }), observation('Alice')]));
    work.writeJson(characterChapterFile(1), chapter(1, [observation('John', { sex: 'female', age: 'child' })]));

    const registry = runListCharacters(work);

    expect(registry.characters.map((character) => character.name).sort()).toEqual([
      'Alice', 'John (Rescue Party)', 'John (The Sentinel)',
    ]);
    const sentinel = registry.characters.find((character) => character.name === 'John (The Sentinel)')!;
    const rescue = registry.characters.find((character) => character.name === 'John (Rescue Party)')!;
    expect(sentinel.story).toBe('story-00');
    expect(rescue.story).toBe('story-01');
    // Separate people keep their own traits instead of reporting a conflict.
    expect([sentinel.sex, sentinel.age]).toEqual(['male', '40s']);
    expect([rescue.sex, rescue.age]).toEqual(['female', 'child']);
    expect(registry.characters.flatMap((character) => character.issues)).toEqual([]);
  });

  it('merges a name and its aliases across the chapters of one multi-chapter story', () => {
    const { work, metadata, analysis } = fixture(2);
    const stories = buildStories(true, metadata, analysis);
    stories.stories = [{ id: 'story-00', title: 'The Sentinel', chapters: [0, 1] }];
    const registry = buildCharacterRegistry([
      chapter(0, [observation('Helen Pryor', { aliases: ['Helen'] })]),
      chapter(1, [observation('Helen', { age: '30s' })]),
    ], stories);

    expect(registry.characters).toHaveLength(1);
    expect(registry.characters[0]).toMatchObject({ name: 'Helen Pryor', story: 'story-00', chapters: [0, 1], age: '30s' });
  });

  it('does not let an alias in one story claim a name in another', () => {
    const { work } = fixture(2);
    work.writeJson(characterChapterFile(0), chapter(0, [observation('Helen Pryor', { aliases: ['Helen'] })]));
    work.writeJson(characterChapterFile(1), chapter(1, [observation('Helen')]));

    const registry = runListCharacters(work);

    expect(registry.characters.map((character) => [character.name, character.story])).toEqual([
      ['Helen Pryor', 'story-00'], ['Helen', 'story-01'],
    ]);
    expect(registry.characters.flatMap((character) => character.issues)).toEqual([]);
  });

  it('keeps unnamed roles chapter-scoped and leaves a continuous work unchanged', () => {
    const { work } = fixture(2, false);
    work.writeJson(characterChapterFile(0), chapter(0, [observation('the guard', { named: false })]));
    work.writeJson(characterChapterFile(1), chapter(1, [observation('the guard', { named: false }), observation('Alice')]));

    const registry = runListCharacters(work);

    expect(registry.characters.map((character) => character.name).sort()).toEqual([
      'Alice', 'the guard (chapter 1)', 'the guard (chapter 2)',
    ]);
    expect(new Set(registry.characters.map((character) => character.story))).toEqual(new Set(['book']));
    // IDs of a continuous work must not churn when story scopes are introduced.
    expect(registry.characters.find((character) => character.name === 'Alice')!.id)
      .toBe(`char-${crypto.createHash('sha256').update('alice').digest('hex').slice(0, 16)}`);
  });

  it('labels a manually added speaker that shares a name with another story', () => {
    const { work } = fixture(2);
    work.writeJson(characterChapterFile(0), chapter(0, [observation('John')]));
    work.writeJson(characterChapterFile(1), chapter(1, [observation('Alice')]));
    const registry = runListCharacters(work);
    expect(registry.characters.map((character) => character.name)).toEqual(['John', 'Alice']);

    // A speaker added in Character Review, as the workspace saves it.
    registry.characters.push({
      ...structuredClone(registry.characters[0]),
      id: 'manual-john', name: 'John', story: 'story-01', chapters: [1],
    });
    work.writeJson('characters.json', registry);

    const rebuilt = runListCharacters(work);

    expect(rebuilt.characters.map((character) => [character.name, character.story]).sort()).toEqual([
      ['Alice', 'story-01'], ['John (Rescue Party)', 'story-01'], ['John (The Sentinel)', 'story-00'],
    ]);
  });
});

describe('character scope hashes', () => {
  it('changes only for the story whose cast changed, and ignores unrelated fields', () => {
    const { work } = fixture(2);
    work.writeJson(characterChapterFile(0), chapter(0, [observation('Alice')]));
    work.writeJson(characterChapterFile(1), chapter(1, [observation('Bob')]));
    const before = runListCharacters(work);

    work.writeJson(characterChapterFile(1), chapter(1, [observation('Bob'), observation('Carol')]));
    const after = runListCharacters(work);

    expect(characterScopeHash(after, 'story-00')).toBe(characterScopeHash(before, 'story-00'));
    expect(characterScopeHash(after, 'story-01')).not.toBe(characterScopeHash(before, 'story-01'));

    const reviewed = structuredClone(after);
    reviewed.characters[0].issues = ['Reviewed.'];
    reviewed.characters[0].age = '50s';
    reviewed.characters[0].evidence = [];
    expect(characterScopeHash(reviewed, 'story-00')).toBe(characterScopeHash(after, 'story-00'));
  });

  it('keeps a script written before story scopes instead of paying for attribution again', async () => {
    const { work } = fixture(1, false);
    const v1 = {
      version: 1,
      chapters: [0],
      characters: [{
        id: 'char-legacy', name: 'Alice', aliases: [], sex: 'female', age: 'unknown', race: 'unknown',
        class: 'unknown', country: 'unknown', importance: 'minor', chapters: [0],
        evidence: [{ chapter: 0, chunk: 0, text: 'Alice said hello.' }], issues: [],
      }],
    };
    work.writeJson('characters.json', v1);
    // The hash the pipeline wrote into scripts before story scopes existed.
    const legacy = crypto.createHash('sha256').update(JSON.stringify(v1)).digest('hex');
    work.writeJson('script/00.json', {
      index: 0, characterRegistryHash: legacy,
      segments: [{ speaker: 'Alice', text: '"Hello."', confidence: 'high' }],
    });

    await runScript(work, undefined, () => {});

    expect(llm).not.toHaveBeenCalled();
    const script = work.readJson<{ characterScopeHash?: string; story?: string; segments: unknown[] }>('script/00.json');
    expect(script.story).toBe('book');
    expect(script.characterScopeHash).toBe(characterScopeHash(
      { ...v1, stories: [], characters: v1.characters.map((c) => ({ ...c, story: 'book' })) } as never, 'book'));
    expect(script.segments).toEqual([{ speaker: 'Alice', text: '"Hello."', confidence: 'high' }]);
  });
});

describe('story-scoped scripting', () => {
  it('offers only this story\'s cast and resolves the name the text uses', async () => {
    const { work } = fixture(2);
    work.writeJson(characterChapterFile(0), chapter(0, [observation('Alice')]));
    work.writeJson(characterChapterFile(1), chapter(1, [observation('Alice'), observation('Bob')]));
    runListCharacters(work);
    llm.mockResolvedValueOnce({ segments: [{ speaker: 'Alice', text: '"Hello."', confidence: 'high' }] })
      .mockResolvedValueOnce({ attributions: [{ id: 0, speaker: 'Alice' }] });

    await runScript(work, [0], () => {});

    const prompt = llm.mock.calls[0][0].user;
    expect(prompt).toContain('The Sentinel');
    expect(prompt).toContain('- Alice');
    expect(prompt).not.toContain('Bob');
    // The cast list uses the book's own name; the script stores the scoped one.
    expect(work.readJson<{ segments: Array<{ speaker: string }> }>('script/00.json').segments.map((s) => s.speaker))
      .toEqual(['Alice (The Sentinel)']);
  });

  it('reports a speaker from another story for review instead of accepting it', async () => {
    const { work } = fixture(2);
    work.writeJson(characterChapterFile(0), chapter(0, [observation('Alice')]));
    work.writeJson(characterChapterFile(1), chapter(1, [observation('Bob')]));
    runListCharacters(work);
    llm.mockResolvedValueOnce({ segments: [{ speaker: 'Alice', text: '"Hello."', confidence: 'high' }] })
      .mockResolvedValueOnce({ attributions: [{ id: 0, speaker: 'Alice' }] });

    await expect(runScript(work, [1], () => {})).rejects.toThrow('chapter 2 (story "Rescue Party"): Alice');
    expect(work.readJson<{ story: string }>('character-candidates/01.json').story).toBe('story-01');
  });
});

describe('story-scoped casting and voices', () => {
  it('casts one story at a time and keeps a single narrator', async () => {
    const { work } = fixture(2);
    work.writeJson(characterChapterFile(0), chapter(0, [observation('Alice')]));
    work.writeJson(characterChapterFile(1), chapter(1, [observation('Bob')]));
    runListCharacters(work);
    work.writeJson('script/00.json', { index: 0, story: 'story-00', segments: [{ speaker: 'Alice', text: '"Hi."' }] });
    work.writeJson('script/01.json', { index: 1, story: 'story-01', segments: [{ speaker: 'Bob', text: '"Ho."' }] });
    llm.mockResolvedValueOnce({ narrator: { voiceProfile: {}, instructions: 'Steady narrator.' } })
      .mockResolvedValueOnce({ characters: { Alice: { voiceProfile: {}, instructions: 'Curious.' } } })
      .mockResolvedValueOnce({ characters: { Bob: { voiceProfile: {}, instructions: 'Gruff.' } } });

    const casting = await runCasting(work);

    expect(llm).toHaveBeenCalledTimes(3);
    expect(llm.mock.calls[1][0].user).toContain('The Sentinel');
    expect(llm.mock.calls[1][0].user).not.toContain('Bob');
    expect(casting.narrator.instructions).toBe('Steady narrator.');
    expect(Object.keys(casting.characters)).toEqual(['Alice', 'Bob']);
  });

  it('casts a continuous work in one request', async () => {
    const { work } = fixture(2, false);
    work.writeJson(characterChapterFile(0), chapter(0, [observation('Alice')]));
    work.writeJson(characterChapterFile(1), chapter(1, [observation('Bob')]));
    runListCharacters(work);
    work.writeJson('script/00.json', { index: 0, segments: [{ speaker: 'Alice', text: '"Hi."' }] });
    llm.mockResolvedValueOnce({ version: 2, narrator: { voiceProfile: {}, instructions: 'N.' }, characters: { Alice: { voiceProfile: {}, instructions: 'A.' } } });

    await runCasting(work);

    expect(llm).toHaveBeenCalledTimes(1);
  });

  it('reuses a voice across stories but not within one', () => {
    const { work, options } = fixture(2);
    const libraryFile = path.join(options.workRoot, 'library.json');
    saveVoiceLibrary(loadVoiceLibrary(path.resolve('library/voices.json')), libraryFile);
    work.writeJson(characterChapterFile(0), chapter(0, [observation('Alice', { sex: 'female' }), observation('Ada', { sex: 'female' })]));
    work.writeJson(characterChapterFile(1), chapter(1, [observation('Beth', { sex: 'female' })]));
    runListCharacters(work);
    const profile = { presentation: 'female', age: 'unknown', tone: [], language: 'en', accent: 'unspecified' };
    work.writeJson('casting.json', {
      version: 2,
      narrator: { voiceProfile: { ...profile, presentation: 'male' }, instructions: 'Narrate.' },
      characters: {
        Alice: { voiceProfile: profile, instructions: '' },
        Ada: { voiceProfile: profile, instructions: '' },
        Beth: { voiceProfile: profile, instructions: '' },
      },
    });

    const bindings = runVoices(work, { provider: 'openai', model: 'gpt-4o-mini-tts' }, libraryFile);

    const { Alice, Ada, Beth } = bindings.characters;
    expect(Alice.libraryVoiceId).not.toBe(Ada.libraryVoiceId);
    expect(Beth.libraryVoiceId).toBe(Alice.libraryVoiceId);
    expect(Beth.libraryVoiceId).not.toBe(bindings.narrator.libraryVoiceId);
  });
});

describe('story selection', () => {
  it('resolves 1-based story numbers to their chapters', () => {
    const { work } = fixture(3);
    saveStoryGrouping(work, {
      version: 1, collection: true,
      stories: [
        { id: 'story-00', title: 'The Sentinel', chapters: [0] },
        { id: 'story-01', title: 'Rescue Party', chapters: [1, 2] },
      ],
    });

    expect(chaptersForStoryNumbers(readStories(work), [2])).toEqual([1, 2]);
    expect(() => chaptersForStoryNumbers(readStories(work), [3])).toThrow('Story 3 does not exist');
  });

  it('runs a stage for one story only, and refuses both selections at once', async () => {
    const { work, options } = fixture(2);
    work.markDone('chapters');
    work.writeJson(characterChapterFile(0), chapter(0, [observation('Alice')]));
    work.writeJson(characterChapterFile(1), chapter(1, [observation('Bob')]));
    await runStage({ ...options, stage: 'list-characters' });
    work.writeJson('analysis.json', { ...work.readJson<object>('analysis.json'), isFiction: false });

    await runStage({ ...options, stage: 'script', storyIndexes: [2] });

    expect(fs.existsSync(work.path('script/01.json'))).toBe(true);
    expect(fs.existsSync(work.path('script/00.json'))).toBe(false);
    await expect(runStage({ ...options, stage: 'script', chapterIndexes: [0], storyIndexes: [1] }))
      .rejects.toThrow('Select either chapters or stories, not both.');
  });
});

describe('collection invalidation', () => {
  it('re-attributes only the story whose cast changed, retaining other encoded audio and paid MP3s', async () => {
    const { work, options } = fixture(2);
    work.markDone('chapters');
    work.writeJson(characterChapterFile(0), chapter(0, [observation('Alice')]));
    work.writeJson(characterChapterFile(1), chapter(1, [observation('Bob')]));
    await runStage({ ...options, stage: 'list-characters' });
    llm.mockResolvedValue({ segments: [{ speaker: 'narrator', text: 'Quiet.', confidence: 'high' }] });
    await runScript(work, undefined, () => {});
    const firstStory = fs.readFileSync(work.path('script/00.json'), 'utf8');

    for (const name of ['00', '01']) {
      work.writeJson(`audio/${name}.m4a`, 'encoded');
      work.writeJson(`audio/${name}-segments.json`, { index: Number(name), segments: [] });
    }
    work.writeJson('audio-cache/paid.mp3', 'paid output');
    work.markDone('casting');
    work.writeJson(characterChapterFile(1), chapter(1, [observation('Bob'), observation('Carol')]));

    await runStage({ ...options, stage: 'list-characters', rerun: true });
    llm.mockClear();
    await runScript(work, undefined, () => {});

    // The first story's cast is untouched, so its paid attribution is reused.
    expect(llm).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(work.path('script/00.json'), 'utf8')).toBe(firstStory);
    expect(new WorkDir(options.epubPath, options.workRoot).isDone('casting')).toBe(false);
    expect(fs.existsSync(work.path('audio/00.m4a'))).toBe(true);
    expect(fs.existsSync(work.path('audio/01.m4a'))).toBe(false);
    expect(fs.existsSync(work.path('audio-cache/paid.mp3'))).toBe(true);
  });

  it('keeps the unaffected chapters complete when a stale registry is rebuilt', async () => {
    const { work, options } = fixture(2);
    work.markDone('chapters');
    work.writeJson(characterChapterFile(0), chapter(0, [observation('Alice')]));
    work.writeJson(characterChapterFile(1), chapter(1, [observation('Bob')]));
    await runStage({ ...options, stage: 'list-characters' });

    const current = new WorkDir(options.epubPath, options.workRoot);
    current.markChaptersDone('script', [0, 1], [0, 1]);
    current.markChaptersDone('synth', [0, 1], [0, 1]);
    current.writeJson(characterChapterFile(1), chapter(1, [observation('Bob'), observation('Carol')]));
    // A stale registry on its own, as a reviewed chapter rerun leaves it.
    current.invalidateStage('list-characters');

    await runStage({ ...options, stage: 'list-characters' });

    const after = new WorkDir(options.epubPath, options.workRoot);
    expect(after.completedChapters('script')).toEqual([0]);
    expect(after.completedChapters('synth')).toEqual([0]);
    expect(after.isDone('script')).toBe(false);
  });

  it('merges one story\'s characters across its chapters after a regrouping', async () => {
    const { work, options } = fixture(2);
    work.markDone('chapters');
    work.writeJson(characterChapterFile(0), chapter(0, [observation('Helen Pryor', { aliases: ['Helen'] })]));
    work.writeJson(characterChapterFile(1), chapter(1, [observation('Helen', { age: '30s' })]));
    await runStage({ ...options, stage: 'list-characters' });
    expect(work.readJson<{ characters: unknown[] }>('characters.json').characters).toHaveLength(2);
    work.writeJson('script/00.json', { index: 0, story: 'story-00', segments: [] });

    // What the workspace grouping panel saves when two chapters are merged.
    const changed = saveStoryGrouping(work, {
      version: 1, collection: true,
      stories: [{ id: 'story-00', title: 'Helen, Parts I and II', chapters: [0, 1] }],
    });
    await runStage({ ...options, stage: 'list-characters' });

    expect(changed).toBe(true);
    expect(fs.existsSync(work.path('script/00.json'))).toBe(false);
    const characters = work.readJson<{ characters: Array<{ name: string; chapters: number[]; age: string }> }>('characters.json').characters;
    expect(characters).toHaveLength(1);
    expect(characters[0]).toMatchObject({ name: 'Helen Pryor', chapters: [0, 1], age: '30s' });
  });

  it('regroups stories when the collection flag changes, keeping cleaned text and paid MP3s', async () => {
    const { work, options } = fixture(2, false);
    work.markDone('chapters');
    work.writeJson(characterChapterFile(0), chapter(0, [observation('Alice')]));
    work.writeJson(characterChapterFile(1), chapter(1, [observation('Alice')]));
    await runStage({ ...options, stage: 'list-characters' });
    work.writeJson('script/00.json', { index: 0, segments: [] });
    work.writeJson('casting.json', { version: 2, narrator: { voiceProfile: {}, instructions: '' }, characters: {} });
    work.writeJson('audio-cache/paid.mp3', 'paid output');

    await runStage({ ...options, stage: 'list-characters', collection: true, rerun: true });

    const after = new WorkDir(options.epubPath, options.workRoot);
    expect(after.collection()).toBe(true);
    expect(readStories(after).stories).toHaveLength(2);
    expect(after.readJson<{ characters: Array<{ name: string }> }>('characters.json').characters.map((c) => c.name))
      .toEqual(['Alice (The Sentinel)', 'Alice (Rescue Party)']);
    expect(fs.existsSync(work.path('script/00.json'))).toBe(false);
    expect(fs.existsSync(work.path('casting.json'))).toBe(false);
    expect(fs.existsSync(work.path('chapters-clean/00.md'))).toBe(true);
    expect(fs.existsSync(work.path('audio-cache/paid.mp3'))).toBe(true);
  });
});
