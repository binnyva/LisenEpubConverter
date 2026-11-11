import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STAGES } from '../src/config.js';
import { OUTDATED_WORK_FOLDER_MESSAGE, WorkDir } from '../src/state.js';
import { clearArtifactsFrom, discoverBooks, runStage } from '../src/pipeline/runner.js';
import { jsonCall } from '../src/providers/llm/openai.js';
import type { BookMetadata } from '../src/types.js';
import { bookFixture, labelsReply, removeFixtures, tempRoot, writeScript } from './helpers.js';

vi.mock('../src/providers/llm/openai.js', () => ({ jsonCall: vi.fn() }));
const llm = vi.mocked(jsonCall);
afterEach(() => {
  vi.resetAllMocks();
  removeFixtures();
});

describe('stage order', () => {
  it('is the seven stages, in order', () => {
    expect(STAGES).toEqual(['extract', 'metadata', 'script', 'casting', 'voices', 'synth', 'assemble']);
  });

  it('requires each stage\'s predecessor', async () => {
    const { run } = bookFixture({ chapters: ['Prose.'], done: ['extract'] });
    await expect(runStage({ ...run, stage: 'script' })).rejects.toThrow('Run metadata before script.');
    await expect(runStage({ ...run, stage: 'casting' })).rejects.toThrow('Run metadata before casting.');
    await expect(runStage({ ...run, stage: 'voices' })).rejects.toThrow('Run casting before voices.');
    await expect(runStage({ ...run, stage: 'synth' })).rejects.toThrow('Run voices before synth.');
    await expect(runStage({ ...run, stage: 'analyze' as any })).rejects.toThrow('Unknown stage "analyze".');
  });

  it('needs a script before casting', async () => {
    const { run } = bookFixture({ chapters: ['Prose.'] });
    await expect(runStage({ ...run, stage: 'casting' })).rejects.toThrow('Run script for at least one chapter before casting.');
  });
});

describe('a work folder from an earlier pipeline', () => {
  /** The earlier layout: unnumbered folders, an analysis file, and a version-2 state. */
  function earlierFolder() {
    const root = tempRoot();
    const source = path.join(root, 'book.md');
    fs.writeFileSync(source, '# Book\n\n"Hello," said Ann.');
    const folder = path.join(root, 'book-markdown');
    fs.mkdirSync(path.join(folder, 'audio-cache'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'audio-cache', 'abc.mp3'), 'paid audio');
    fs.writeFileSync(path.join(folder, 'analysis.json'), '{"isFiction":true}');
    fs.writeFileSync(path.join(folder, 'metadata.json'), '{"title":"Book","chapters":[]}');
    const state = JSON.stringify({ version: 2, source, sourceHash: 'x', sourceFormat: 'markdown', completed: { extract: 't', analyze: 't' } });
    fs.writeFileSync(path.join(folder, 'state.json'), state);
    return { root, source, folder, state };
  }
  const snapshot = (folder: string): Record<string, string> => Object.fromEntries(
    (fs.readdirSync(folder, { recursive: true }) as string[]).sort()
      .filter((name) => fs.statSync(path.join(folder, name)).isFile())
      .map((name) => [name, fs.readFileSync(path.join(folder, name), 'utf8')]));

  it.each(['extract', 'metadata', 'script', 'synth'] as const)('fails %s with a rebuild instruction and changes nothing', async (stage) => {
    const { root, source, folder } = earlierFolder();
    const before = snapshot(folder);

    await expect(runStage({ sourcePath: source, workRoot: root, stage })).rejects.toThrow(OUTDATED_WORK_FOLDER_MESSAGE);
    await expect(runStage({ sourcePath: source, workRoot: root, stage, rerun: true })).rejects.toThrow('Rebuild it from Extract');

    expect(snapshot(folder)).toEqual(before);
    expect(fs.readdirSync(root).sort()).toEqual(['book-markdown', 'book.md']);
  });

  it('is listed as outdated, with no completion claimed', () => {
    const { root } = earlierFolder();
    expect(discoverBooks(root)).toMatchObject([{ outdated: true, completed: {} }]);
  });

  it('rebuilds from Extract into the current layout and leaves the paid audio alone', async () => {
    const { root, source, folder } = earlierFolder();

    await runStage({ sourcePath: source, workRoot: root, stage: 'extract', rebuild: true });

    expect(fs.readFileSync(path.join(folder, 'audio-cache', 'abc.mp3'), 'utf8')).toBe('paid audio');
    expect(fs.existsSync(path.join(folder, '0-chapters', '00-book.md'))).toBe(true);
    const work = new WorkDir(source, root);
    expect(work.isOutdated()).toBe(false);
    expect(work.snapshot().completed).toEqual({ extract: expect.any(String) });
    expect(work.readJson<BookMetadata>('metadata.json')).toMatchObject({ title: 'Book', subjects: [], description: '' });
  });
});

describe('rebuilds', () => {
  function produced() {
    const book = bookFixture({ chapters: ['"Hello," said Ann.'], done: ['extract', 'metadata', 'script', 'casting', 'voices', 'synth'] });
    const { work } = book;
    writeScript(work, 0, [{ speaker: 'Ann', text: '"Hello,"' }]);
    work.writeJson('characters.json', { version: 3, characters: [] });
    work.writeJson('casting.json', {});
    work.writeJson('voice-bindings.json', {});
    work.writeJson('3-audio/00-chapter-1.json', { index: 0, segments: ['abc'] });
    work.writeJson('checkpoints/script-00.json', { key: 'k', blocks: [] });
    work.writeJson('usage.json', []);
    fs.writeFileSync(path.join(work.dir('2-audio-cache'), 'abc.mp3'), 'paid audio');
    return book;
  }
  const present = (work: WorkDir): string[] => fs.readdirSync(work.root).filter((name) => !['book.epub', 'state.json'].includes(name)).sort();

  it.each([
    ['metadata', ['0-chapters', '2-audio-cache', 'metadata.json', 'usage.json']],
    ['script', ['0-chapters', '2-audio-cache', 'metadata.json', 'stories.json', 'usage.json']],
    ['casting', ['0-chapters', '1-scripts', '2-audio-cache', 'characters.json', 'checkpoints', 'metadata.json', 'stories.json', 'usage.json']],
    ['synth', ['0-chapters', '1-scripts', '2-audio-cache', 'casting.json', 'characters.json', 'checkpoints', 'metadata.json', 'stories.json', 'usage.json', 'voice-bindings.json']],
  ] as const)('clearing from %s keeps earlier artifacts and always the audio cache', (stage, expected) => {
    const { work } = produced();
    clearArtifactsFrom(work, stage);
    expect(present(work).filter((name) => name !== 'checkpoints' || fs.readdirSync(work.path(name)).length > 0)).toEqual(expected);
    expect(fs.readFileSync(work.path('2-audio-cache/abc.mp3'), 'utf8')).toBe('paid audio');
  });

  it('clearing from Metadata removes only the profile from metadata.json', () => {
    const { work } = produced();
    clearArtifactsFrom(work, 'metadata');
    const metadata = work.readJson<BookMetadata>('metadata.json');
    expect(metadata.profile).toBeUndefined();
    expect(metadata.chapters).toHaveLength(1);
    expect(fs.existsSync(work.path(metadata.chapters[0].file))).toBe(true);
  });

  it('a Script rebuild rediscovers the cast and invalidates what depends on it', async () => {
    const { work, run } = produced();
    llm.mockResolvedValueOnce(labelsReply([[1, 'Ann']], { characters: [{ name: 'Ann' }] }) as any);

    await runStage({ ...run, stage: 'script', rebuild: true });

    expect(work.readJson<any>('characters.json').characters.map((c: any) => c.name)).toEqual(['Ann']);
    const state = new WorkDir(run.epubPath, run.workRoot).snapshot();
    expect(Object.keys(state.completed).sort()).toEqual(['extract', 'metadata', 'script']);
    expect(fs.existsSync(work.path('2-audio-cache/abc.mp3'))).toBe(true);
  });
});
