import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkDir } from '../src/state.js';
import type { BookMetadata, Casting, Stories } from '../src/types.js';
import { buildStories, chaptersForStoryNumbers, readStories, validateStories } from '../src/pipeline/stories.js';
import { runCasting } from '../src/pipeline/casting.js';
import { runVoices } from '../src/pipeline/voices.js';
import { runStage, saveStoryGrouping } from '../src/pipeline/runner.js';
import { loadVoiceLibrary, saveVoiceLibrary } from '../src/voices/library.js';
import { jsonCall } from '../src/providers/llm/openai.js';
import { bookFixture, labelsReply, readScript, removeFixtures, writeScript } from './helpers.js';

vi.mock('../src/providers/llm/openai.js', () => ({ jsonCall: vi.fn() }));
const llm = vi.mocked(jsonCall);
afterEach(() => {
  vi.resetAllMocks();
  removeFixtures();
});

const TITLES = ['The Sentinel', 'Rescue Party', 'Breaking Strain'];
function fixture(count = 2, collection = true) {
  return bookFixture({
    title: 'Collected Stories', collection,
    chapters: Array.from({ length: count }, (_, index) => ({ title: TITLES[index] ?? `Story ${index + 1}`, text: `"Hello from ${index}," said John.` })),
  });
}
const withProposal = (metadata: BookMetadata, stories: NonNullable<BookMetadata['profile']>['stories']): BookMetadata =>
  ({ ...metadata, profile: { ...metadata.profile!, stories } });
const speaker = (presentation = 'unknown') => ({ voiceProfile: { presentation, age: 'unknown', tone: [], language: 'en', accent: 'unspecified' }, instructions: 'Speak.' });

describe('story grouping', () => {
  it('gives a collection one story per narratable chapter and a continuous work a single scope', () => {
    const { metadata } = fixture(3);
    expect(buildStories(true, metadata).stories.map((story) => [story.id, story.title, story.chapters])).toEqual([
      ['story-00', 'The Sentinel', [0]], ['story-01', 'Rescue Party', [1]], ['story-02', 'Breaking Strain', [2]],
    ]);
    expect(buildStories(false, metadata)).toEqual({ version: 1, collection: false, stories: [{ id: 'book', title: 'Collected Stories', chapters: [0, 1, 2] }] });
  });

  it('uses the proposed grouping, including a story told in two chapters', () => {
    const { metadata } = fixture(3);
    const stories = buildStories(true, withProposal(metadata, [{ title: 'A Tale', chapters: [0, 1] }, { title: '', chapters: [2] }]));
    expect(stories.stories).toEqual([{ id: 'story-00', title: 'A Tale', chapters: [0, 1] }, { id: 'story-02', title: 'Breaking Strain', chapters: [2] }]);
  });

  it('drops chapters the narration backstop skipped and keeps the rest of the proposal', () => {
    const { metadata } = fixture(3);
    metadata.profile!.chapters[1].narrate = false;
    const stories = buildStories(true, withProposal(metadata, [{ title: 'A', chapters: [0, 1] }, { title: 'B', chapters: [2] }]));
    expect(stories.stories.map((story) => story.chapters)).toEqual([[0], [2]]);
  });

  it('rejects a grouping that double-books or abandons a chapter', () => {
    const { metadata } = fixture(3);
    const grouping = (stories: Stories['stories']): Stories => ({ version: 1, collection: true, stories });
    expect(() => validateStories(grouping([{ id: 'a', title: 'A', chapters: [0, 1] }, { id: 'b', title: 'B', chapters: [1, 2] }]), metadata)).toThrow('more than one story');
    expect(() => validateStories(grouping([{ id: 'a', title: 'A', chapters: [0, 1] }]), metadata)).toThrow('chapter 3 does not');
    expect(() => validateStories({ version: 1, collection: false, stories: grouping([{ id: 'a', title: 'A', chapters: [0] }, { id: 'b', title: 'B', chapters: [1, 2] }]).stories }, metadata)).toThrow('continuous work has one story');
  });

  it('resolves 1-based story numbers to their chapters', () => {
    const { work } = fixture(3);
    expect(chaptersForStoryNumbers(readStories(work), [3, 1])).toEqual([0, 2]);
    expect(() => chaptersForStoryNumbers(readStories(work), [4])).toThrow('Story 4 does not exist');
  });
});

describe('story selection and regrouping', () => {
  it('runs a stage for one story only, and refuses both selections at once', async () => {
    const { run, work } = fixture(3);
    llm.mockResolvedValue(labelsReply([[1, 'John']], { characters: [{ name: 'John' }] }) as any);

    const result = await runStage({ ...run, stage: 'script', storyIndexes: [2] });

    expect(result.chapterIndexes).toEqual([1]);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(work.path('1-scripts'))).toEqual(['01-rescue-party.json']);
    expect(new WorkDir(run.epubPath, run.workRoot).isDone('script')).toBe(false);
    await expect(runStage({ ...run, stage: 'script', storyIndexes: [1], chapterIndexes: [0] })).rejects.toThrow('either chapters or stories');
  });

  it('regroups stories when the collection flag changes, clearing the cast and scripts but keeping paid MP3s', async () => {
    const { run, work } = fixture(2);
    llm.mockResolvedValue(labelsReply([[1, 'John']], { characters: [{ name: 'John' }] }) as any);
    await runStage({ ...run, stage: 'script' });
    expect(work.readJson<any>('characters.json').characters.map((c: any) => c.name)).toEqual(['John (The Sentinel)', 'John (Rescue Party)']);
    fs.writeFileSync(path.join(work.dir('2-audio-cache'), 'paid.mp3'), 'paid audio');
    work.writeJson('casting.json', { version: 2, narrator: speaker(), characters: {} });

    await runStage({ ...run, stage: 'script', collection: false });

    expect(work.readJson<Stories>('stories.json')).toMatchObject({ collection: false, stories: [{ id: 'book', chapters: [0, 1] }] });
    expect(fs.existsSync(work.path('casting.json'))).toBe(false);
    expect(fs.existsSync(work.path('2-audio-cache/paid.mp3'))).toBe(true);
    // One continuous work: the two Johns are now one character.
    expect(work.readJson<any>('characters.json').characters.map((c: any) => [c.name, c.chapters])).toEqual([['John', [0, 1]]]);
    expect(readScript(work, 1).segments[0].speaker).toBe('John');
  });

  it('saves a hand-made grouping only when it changes something', () => {
    const { work } = fixture(3);
    const merged: Stories = { version: 1, collection: true, stories: [{ id: 'story-00', title: 'Both', chapters: [0, 1] }, { id: 'story-02', title: 'Breaking Strain', chapters: [2] }] };
    writeScript(work, 0, [{ speaker: 'John', text: 'Hi.' }]);
    expect(saveStoryGrouping(work, merged)).toBe(true);
    expect(fs.existsSync(work.path('1-scripts'))).toBe(false);
    expect(saveStoryGrouping(work, merged)).toBe(false);
  });
});

describe('story-scoped casting and voices', () => {
  function scripted(collection: boolean) {
    const book = fixture(2, collection);
    const names = collection ? ['John (The Sentinel)', 'John (Rescue Party)'] : ['John', 'Mary'];
    book.work.writeJson('characters.json', { version: 3, characters: names.map((name, index) => ({
      id: `c${index}`, name, story: collection ? `story-0${index}` : 'book', aliases: [], sex: index ? 'female' : 'male', age: '40s', named: true, chapters: [index], evidence: [], issues: [],
    })) });
    names.forEach((name, index) => writeScript(book.work, index, [{ speaker: 'narrator', text: 'It began.' }, { speaker: name, text: '"Hello."' }]));
    return { ...book, names };
  }

  it('casts one narrator, then one request per story with only that story\'s speakers', async () => {
    const { work, names } = scripted(true);
    llm.mockResolvedValueOnce({ narrator: speaker('female') } as any)
      .mockResolvedValueOnce({ characters: { [names[0]]: speaker('male'), Intruder: speaker() } } as any)
      .mockResolvedValueOnce({ characters: { [names[1]]: speaker('female') } } as any);

    const casting = await runCasting(work);

    expect(llm).toHaveBeenCalledTimes(3);
    expect(llm.mock.calls[0][0].user).toContain('Stories: The Sentinel; Rescue Party');
    expect(llm.mock.calls[1][0].user).toContain('Story: "The Sentinel"');
    expect(llm.mock.calls[1][0].user).toContain(`- ${names[0]} (1 spoken segments): male, age 40s`);
    expect(llm.mock.calls[1][0].user).not.toContain(names[1]);
    expect(Object.keys(casting.characters)).toEqual(names);
    expect(work.readJson<Casting>('casting.json').narrator.voiceProfile.presentation).toBe('female');
  });

  it('casts a continuous work as one story plus the narrator, and fills in a speaker the reply omitted', async () => {
    const { work, events, run } = scripted(false);
    llm.mockResolvedValueOnce({ narrator: speaker() } as any).mockResolvedValueOnce({ characters: { John: speaker('male') } } as any);

    await runStage({ ...run, stage: 'casting' });

    expect(llm).toHaveBeenCalledTimes(2);
    expect(work.readJson<Casting>('casting.json').characters.Mary.voiceProfile).toMatchObject({ presentation: 'female', age: '40s' });
    expect(events.some((event) => event.type === 'warning' && event.message.includes('Casting omitted 1 speaker(s)'))).toBe(true);
  });

  it('takes the narrator\'s sex from a first-person narrator before the author', async () => {
    const { work, metadata } = scripted(false);
    work.writeJson('metadata.json', { ...metadata, profile: { ...metadata.profile, narrator: { pointOfView: 'first', sex: 'female' }, author: { ...metadata.profile!.author, sex: 'male' } } });
    llm.mockResolvedValueOnce({ narrator: speaker('male') } as any).mockResolvedValue({ characters: {} } as any);

    const casting = await runCasting(work);

    expect(llm.mock.calls[0][0].user).toContain('Narration: first person, narrator apparently female');
    expect(llm.mock.calls[0][0].user).toContain('Author profile: male');
    expect(casting.narrator.voiceProfile.presentation).toBe('female');
  });

  it('follows the author for third-person narration, and needs no model when nobody speaks', async () => {
    const { work, metadata } = bookFixture({ chapters: ['Plain prose.'], profile: { isFiction: false, form: 'non-fiction' } });
    work.writeJson('metadata.json', { ...metadata, profile: { ...metadata.profile, author: { sex: 'female', race: 'unknown', age: '50s', country: 'United Kingdom' } } });
    writeScript(work, 0, [{ speaker: 'narrator', text: 'Plain prose.' }]);

    const casting = await runCasting(work);

    expect(llm).not.toHaveBeenCalled();
    expect(casting.narrator.voiceProfile).toMatchObject({ presentation: 'female', age: '50s', accent: 'United Kingdom' });
  });

  it('reuses a voice across stories but not within one', () => {
    const { work, names } = scripted(true);
    const libraryFile = path.join(work.root, 'library.json');
    const library = loadVoiceLibrary(path.resolve('library/voices.json'));
    const target = { provider: 'openai' as const, model: 'gpt-4o-mini-tts' };
    const compatible = library.voices.filter((voice) => voice.models.includes('openai:gpt-4o-mini-tts'));
    // Narrator plus two: enough for one story, not enough for the book.
    saveVoiceLibrary({ ...library, voices: compatible.slice(0, 3) }, libraryFile);
    work.writeJson('characters.json', { version: 3, characters: [
      ...[names[0], 'Extra One'].map((name, i) => ({ id: `a${i}`, name, story: 'story-00', aliases: [], sex: 'unknown', age: 'unknown', named: true, chapters: [0], evidence: [], issues: [] })),
      ...[names[1], 'Extra Two'].map((name, i) => ({ id: `b${i}`, name, story: 'story-01', aliases: [], sex: 'unknown', age: 'unknown', named: true, chapters: [1], evidence: [], issues: [] })),
    ] });
    work.writeJson('casting.json', { version: 2, narrator: speaker(), characters: Object.fromEntries([names[0], 'Extra One', names[1], 'Extra Two'].map((name) => [name, speaker()])) });

    const bindings = runVoices(work, target, libraryFile);

    const voice = (name: string) => bindings.characters[name].libraryVoiceId;
    expect(voice(names[0])).not.toBe(voice('Extra One'));
    expect(voice(names[1])).not.toBe(voice('Extra Two'));
    expect(new Set([voice(names[0]), voice('Extra One')])).toEqual(new Set([voice(names[1]), voice('Extra Two')]));
    expect([names[0], 'Extra One', names[1], 'Extra Two'].map(voice)).not.toContain(bindings.narrator.libraryVoiceId);
  });
});
