import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkDir } from '../src/state.js';
import { CharacterObservationSchema, type ChapterCharacters } from '../src/types.js';
import { buildCharacterRegistry, characterChapterFile, runListCharacters } from '../src/pipeline/list-characters.js';
import { mergeChapterObservations } from '../src/pipeline/chapters.js';
import { clearArtifactsFrom, recoverStageStateFromArtifacts, runStage } from '../src/pipeline/runner.js';
import { runScript } from '../src/pipeline/script.js';
import { runCasting } from '../src/pipeline/casting.js';
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

function fixture(count = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-characters-'));
  roots.push(root);
  const epubPath = path.join(root, 'book.epub');
  fs.writeFileSync(epubPath, 'offline fixture');
  const work = new WorkDir(epubPath, root);
  const chapters = Array.from({ length: count }, (_, index) => ({ index, title: `Chapter ${index + 1}`, file: `chapters/${index}.md`, words: 400 }));
  work.writeJson('metadata.json', { title: 'Story', author: 'Author', chapters });
  work.writeJson('analysis.json', {
    isFiction: true, summary: 'Sampled overview.', characters: [],
    author: { name: 'Author', sex: 'unknown', age: 'unknown', country: 'unknown' },
    chapters: chapters.map(({ index }) => ({ index, narrate: true })),
  });
  work.dir('chapters');
  for (const ch of chapters) fs.writeFileSync(work.path(ch.file), `Chapter ${ch.index}: Hello.`);
  work.markDone('extract');
  work.markDone('analyze');
  return { work, options: { epubPath, workRoot: root, outDir: path.join(root, 'out') } };
}

describe('book character registry', () => {
  it('merges repeated character observations from separate chapter chunks', () => {
    const merged = mergeChapterObservations([
      observation('Alice', { aliases: ['Al'], evidence: 'Alice speaks.', chunk: 0 }),
      observation(' alice ', { aliases: ['Ally'], evidence: 'Alice answers.', age: 'child', chunk: 2 }),
      observation('Rabbit', { chunk: 1 }),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      name: 'Alice', aliases: ['Al', 'Ally'], age: 'child', chunk: 0,
      evidence: 'Alice speaks. Alice answers.',
    });
    expect(merged[1].name).toBe('Rabbit');
  });

  it('discovers late characters and merges explicit aliases with chapter evidence', () => {
    const registry = buildCharacterRegistry([
      chapter(0, [observation('Alice Smith', { aliases: ['Alice'], age: 'adult' })]),
      chapter(9, [observation('Alice'), observation('Bob')]),
    ]);
    expect(registry.characters.map((c) => c.name)).toEqual(['Alice Smith', 'Bob']);
    expect(registry.characters[0]).toMatchObject({ aliases: ['Alice'], age: 'adult', chapters: [0, 9] });
    expect(registry.characters[0].evidence).toHaveLength(2);
  });

  it('does not merge competing aliases, and exposes conflicting traits', () => {
    const registry = buildCharacterRegistry([chapter(0, [
      observation('Mary Smith', { aliases: ['Mary'], age: 'child' }),
      observation('Mary Jones', { aliases: ['Mary'] }),
      observation('Mary'),
      observation('Mary Smith', { age: 'adult' }),
    ])]);
    expect(registry.characters).toHaveLength(3);
    expect(registry.characters[0].aliases).toEqual([]);
    expect(registry.characters[1].aliases).toEqual([]);
    expect(registry.characters[0].age).toBe('unknown');
    expect(registry.characters[0].issues.join(' ')).toMatch(/Ambiguous alias.*Conflicting age/);
  });

  it('scopes unnamed roles to chapters and does not infer traits from uncertain observations', () => {
    const registry = buildCharacterRegistry([
      chapter(0, [observation('the guard', { named: false, confidence: 'low', country: 'France' })]),
      chapter(1, [observation('the guard', { named: false })]),
    ]);
    expect(registry.characters.map((c) => c.name)).toEqual(['the guard (chapter 1)', 'the guard (chapter 2)']);
    expect(registry.characters[0].country).toBe('unknown');
    expect(registry.characters[0].issues).not.toHaveLength(0);
  });

  it('preserves IDs when later evidence adds a full name', () => {
    const { work } = fixture(1);
    work.writeJson(characterChapterFile(0), chapter(0, [observation('Alice')]));
    const first = runListCharacters(work);
    work.writeJson(characterChapterFile(0), chapter(0, [observation('Alice Smith', { aliases: ['Alice'] })]));
    const next = runListCharacters(work);
    expect(next.characters[0].id).toBe(first.characters[0].id);
    expect(llm).not.toHaveBeenCalled();
  });
});

describe('character discovery orchestration', () => {
  it('collects observations while cleaning, resumes selected chapters, and lists only after all chapters', async () => {
    const { work, options } = fixture();
    llm.mockResolvedValueOnce({ cleanedText: 'First.', partialSummary: 'First.', characters: [observation('Alice')] });
    await runStage({ ...options, stage: 'chapters', chapterIndexes: [0] });
    expect(new WorkDir(options.epubPath, options.workRoot).completedChapters('chapters')).toEqual([0]);
    await expect(runStage({ ...options, stage: 'list-characters' })).rejects.toThrow('Run chapters');
    llm.mockResolvedValueOnce({ cleanedText: 'Second.', partialSummary: 'Second.', characters: [observation('Bob')] });
    await runStage({ ...options, stage: 'chapters', chapterIndexes: [1] });
    expect(llm.mock.calls[1][0].user).toContain('Alice');
    expect(new WorkDir(options.epubPath, options.workRoot).isDone('chapters')).toBe(true);
    await runStage({ ...options, stage: 'list-characters' });
    expect(work.readJson<any>('characters.json').characters.map((c: any) => c.name)).toEqual(['Alice', 'Bob']);
    await runStage({ ...options, stage: 'chapters' });
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it('backfills legacy observations without rewriting cleaned text or summaries', async () => {
    const { work, options } = fixture(1);
    work.writeJson('chapter-summaries.json', { 0: 'Existing summary.' });
    fs.writeFileSync(path.join(work.dir('chapters-clean'), '00.md'), 'Existing cleaned text.');
    work.markDone('chapters');
    llm.mockResolvedValueOnce({ characters: [observation('Late speaker')] });
    await runStage({ ...options, stage: 'chapters' });
    expect(fs.readFileSync(work.path('chapters-clean/00.md'), 'utf8')).toBe('Existing cleaned text.');
    expect(work.readJson('chapter-summaries.json')).toEqual({ 0: 'Existing summary.' });
    expect(work.readJson<any>(characterChapterFile(0)).observations[0].name).toBe('Late speaker');
    expect(llm.mock.calls[0][0].system).not.toContain('cleanedText');
  });

  it('replaces rerun chapter observations while retaining other chapter discoveries and audio cache', async () => {
    const { work, options } = fixture();
    work.writeJson(characterChapterFile(0), chapter(0, [observation('Old')]));
    work.writeJson(characterChapterFile(1), chapter(1, [observation('Keep')]));
    work.writeJson('chapter-summaries.json', { 0: 'Old', 1: 'Keep' });
    fs.writeFileSync(path.join(work.dir('chapters-clean'), '00.md'), 'Old.');
    fs.writeFileSync(work.path('chapters-clean/01.md'), 'Keep.');
    work.writeJson('audio-cache/paid.mp3', 'paid output');
    work.markDone('chapters');
    work.markDone('list-characters');
    work.markDone('script');
    llm.mockResolvedValueOnce({ cleanedText: 'New.', partialSummary: 'New.', characters: [observation('New')] });
    await runStage({ ...options, stage: 'chapters', chapterIndexes: [0], rerun: true });
    expect(work.readJson<any>(characterChapterFile(0)).observations[0].name).toBe('New');
    expect(work.readJson<any>(characterChapterFile(1)).observations[0].name).toBe('Keep');
    expect(new WorkDir(options.epubPath, options.workRoot).isDone('list-characters')).toBe(false);
    expect(new WorkDir(options.epubPath, options.workRoot).isDone('chapters')).toBe(true);
    await runStage({ ...options, stage: 'list-characters' });
    expect(work.readJson<any>('characters.json').characters.map((c: any) => c.name)).toEqual(['New', 'Keep']);
    clearArtifactsFrom(work, 'list-characters');
    expect(fs.existsSync(work.path(characterChapterFile(1)))).toBe(true);
    expect(fs.existsSync(work.path('audio-cache/paid.mp3'))).toBe(true);
  });

  it('accumulates selected Script reruns while invalidating only downstream stages', async () => {
    const { work, options } = fixture();
    work.writeJson('analysis.json', { ...work.readJson<object>('analysis.json'), isFiction: false });
    work.writeJson('chapter-summaries.json', { 0: 'First.', 1: 'Second.' });
    work.dir('chapters-clean');
    fs.writeFileSync(work.path('chapters-clean/00.md'), 'First.');
    fs.writeFileSync(work.path('chapters-clean/01.md'), 'Second.');
    work.writeJson('characters.json', { version: 1, chapters: [0, 1], characters: [] });
    work.markDone('chapters');
    work.markDone('list-characters');
    work.markDone('casting');

    await runStage({ ...options, stage: 'script', chapterIndexes: [0], rerun: true });
    let current = new WorkDir(options.epubPath, options.workRoot);
    expect(current.completedChapters('script')).toEqual([0]);
    expect(current.isDone('casting')).toBe(false);

    await runStage({ ...options, stage: 'script', chapterIndexes: [1], rerun: true });
    current = new WorkDir(options.epubPath, options.workRoot);
    expect(current.completedChapters('script')).toEqual([0, 1]);
    expect(current.isDone('script')).toBe(true);
  });

  it('rejects chapter selection for the whole-book stage before invalidating output', async () => {
    const { work, options } = fixture(1);
    work.markDone('list-characters');
    await expect(runStage({ ...options, stage: 'list-characters', chapterIndexes: [0], rerun: true })).rejects.toThrow('omit --chapters');
    expect(new WorkDir(options.epubPath, options.workRoot).isDone('list-characters')).toBe(true);
  });

  it('invalidates scripts and encoded audio after registry changes, retaining paid MP3s', async () => {
    const { work, options } = fixture(1);
    work.markDone('chapters');
    work.writeJson(characterChapterFile(0), chapter(0, [observation('Alice')]));
    await runStage({ ...options, stage: 'list-characters' });
    const current = new WorkDir(options.epubPath, options.workRoot);
    current.markDone('script');
    current.markDone('synth');
    current.writeJson('audio/00.m4a', 'old encoding');
    current.writeJson('audio-cache/paid.mp3', 'paid output');
    current.writeJson(characterChapterFile(0), chapter(0, [observation('Alice'), observation('Bob')]));
    await runStage({ ...options, stage: 'list-characters', rerun: true });
    expect(new WorkDir(options.epubPath, options.workRoot).isDone('script')).toBe(false);
    expect(fs.existsSync(work.path('audio/00.m4a'))).toBe(false);
    expect(fs.existsSync(work.path('audio-cache/paid.mp3'))).toBe(true);
  });

  it('backfills non-fiction and builds an empty registry without LLM calls', async () => {
    const { work, options } = fixture(1);
    work.writeJson('analysis.json', { ...work.readJson<object>('analysis.json'), isFiction: false });
    work.writeJson('chapter-summaries.json', { 0: 'Existing.' });
    fs.writeFileSync(path.join(work.dir('chapters-clean'), '00.md'), 'Existing.');
    work.markDone('chapters');
    await runStage({ ...options, stage: 'chapters' });
    await runStage({ ...options, stage: 'list-characters' });
    await runStage({ ...options, stage: 'script' });
    expect(work.readJson<any>('characters.json').characters).toEqual([]);
    expect(work.readJson<any>('script/00.json').segments[0].speaker).toBe('narrator');
    expect(llm).not.toHaveBeenCalled();
  });

  it('does not recover the new stage from legacy scripts alone', () => {
    const { work } = fixture(1);
    work.invalidateFrom('extract');
    work.writeJson('chapter-summaries.json', { 0: 'Existing.' });
    fs.writeFileSync(path.join(work.dir('chapters-clean'), '00.md'), 'Existing.');
    work.writeJson('script/00.json', { index: 0, segments: [] });
    recoverStageStateFromArtifacts(work);
    expect(work.isDone('chapters')).toBe(false);
    expect(work.isDone('list-characters')).toBe(false);
    expect(work.isDone('script')).toBe(false);
  });
});

describe('registry consumers', () => {
  it('attributes dialogue with an empty Analyze cast and refreshes scripts when the registry changes', async () => {
    const { work } = fixture(1);
    work.writeJson(characterChapterFile(0), chapter(0, [observation('Late speaker')]));
    runListCharacters(work);
    work.writeJson('chapter-summaries.json', { 0: 'Someone speaks.' });
    fs.writeFileSync(path.join(work.dir('chapters-clean'), '00.md'), 'Hello.');
    llm.mockResolvedValue({ segments: [{ speaker: 'Late speaker', text: 'Hello.', confidence: 'high' }] });
    await runScript(work);
    expect(llm.mock.calls[0][0].user).toContain('Late speaker');
    await runScript(work);
    expect(llm).toHaveBeenCalledTimes(1);
    work.writeJson(characterChapterFile(0), chapter(0, [observation('Late speaker'), observation('Another')]));
    runListCharacters(work);
    await runScript(work);
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it('saves unknown speakers for review instead of replacing their dialogue with narration', async () => {
    const { work } = fixture(1);
    work.writeJson(characterChapterFile(0), chapter(0, []));
    runListCharacters(work);
    work.writeJson('chapter-summaries.json', { 0: 'Someone speaks.' });
    fs.writeFileSync(path.join(work.dir('chapters-clean'), '00.md'), 'Hello.');
    llm.mockResolvedValueOnce({ segments: [{ speaker: 'Bob', text: 'Hello.', confidence: 'low' }] });
    llm.mockResolvedValueOnce({ attributions: [{ id: 0, speaker: 'Bob' }] });
    await expect(runScript(work)).rejects.toThrow('New or unresolved speakers');
    expect(work.readJson<any>('character-candidates/00.json').candidates[0]).toMatchObject({ speaker: 'Bob', text: 'Hello.' });
    expect(fs.existsSync(work.path('script/00.json'))).toBe(false);
  });

  it('casts using registry traits rather than provisional analysis candidates', async () => {
    const { work } = fixture(1);
    work.writeJson(characterChapterFile(0), chapter(0, [observation('Bob', { age: 'elderly' })]));
    runListCharacters(work);
    work.writeJson('script/00.json', { index: 0, segments: [{ speaker: 'Bob', text: 'Hello.' }] });
    llm.mockResolvedValue({ version: 2, narrator: {}, characters: {} });
    const cast = await runCasting(work);
    expect(llm.mock.calls[0][0].user).toContain('age elderly');
    expect(cast.characters.Bob.voiceProfile.age).toBe('elderly');
  });
});
