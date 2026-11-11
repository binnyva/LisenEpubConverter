import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveCharacterRegistry } from '../src/ui/server.js';
import { WorkDir } from '../src/state.js';
import type { CharacterRegistry } from '../src/types.js';
import { bookFixture, readScript, removeFixtures, writeScript } from './helpers.js';

afterEach(removeFixtures);

const character = (id: string, name: string, aliases: string[] = []) =>
  ({ id, name, story: 'book', aliases, sex: 'unknown' as const, age: 'unknown', named: true, chapters: [0], evidence: [], issues: [] });

function reviewed() {
  const book = bookFixture({ chapters: ['"Hi," said Lupov. "Hi," said Bert.'], done: ['extract', 'metadata', 'script', 'casting', 'voices'] });
  const registry: CharacterRegistry = { version: 3, stories: [], characters: [character('a', 'Lupov'), character('b', 'Bert')], unresolved: [] };
  book.work.writeJson('characters.json', registry);
  book.work.writeJson('casting.json', {});
  writeScript(book.work, 0, [{ speaker: 'Lupov', text: '"Hi,"' }, { speaker: 'Bert', text: '"Hi,"' }]);
  fs.writeFileSync(path.join(book.work.dir('2-audio-cache'), 'paid.mp3'), 'paid audio');
  return { ...book, registry };
}

describe('saving a reviewed cast', () => {
  it('renames a character in the saved scripts and makes only Casting onward stale', () => {
    const { work, run, registry } = reviewed();
    saveCharacterRegistry(work, { ...registry, characters: [character('a', 'Bertram Lupov'), character('b', 'Bert')] });

    expect(readScript(work, 0).segments.map((segment) => segment.speaker)).toEqual(['Bertram Lupov', 'Bert']);
    expect(Object.keys(new WorkDir(run.epubPath, run.workRoot).snapshot().completed).sort()).toEqual(['extract', 'metadata', 'script']);
    expect(fs.existsSync(work.path('casting.json'))).toBe(false);
    expect(fs.existsSync(work.path('2-audio-cache/paid.mp3'))).toBe(true);
  });

  it('merges a removed character into the one that now lists its name as an alias', () => {
    const { work, registry } = reviewed();
    saveCharacterRegistry(work, { ...registry, characters: [character('a', 'Lupov', ['Bert'])] });
    expect(readScript(work, 0).segments.map((segment) => segment.speaker)).toEqual(['Lupov', 'Lupov']);
  });

  it('refuses to drop a character who still has lines, and changes nothing', () => {
    const { work, registry } = reviewed();
    expect(() => saveCharacterRegistry(work, { ...registry, characters: [character('a', 'Lupov')] })).toThrow('Bert still has lines in the script');
    expect(work.readJson<CharacterRegistry>('characters.json').characters).toHaveLength(2);
    expect(fs.existsSync(work.path('casting.json'))).toBe(true);
  });
});
