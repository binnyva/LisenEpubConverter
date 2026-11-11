import { describe, expect, it } from 'vitest';
import { addCharacters, chapterCast, consolidateStory, emptyRegistry, labelSharedNames, validateCharacterRegistry } from '../src/pipeline/cast.js';
import { CharacterReportSchema, type CharacterRegistry, type Stories } from '../src/types.js';

const BOOK: Stories = { version: 1, collection: false, stories: [{ id: 'book', title: 'Book', chapters: [0, 1, 2] }] };
const COLLECTION: Stories = { version: 1, collection: true, stories: [
  { id: 'story-00', title: 'Rescue Party', chapters: [0] },
  { id: 'story-01', title: 'The Sentinel', chapters: [1] },
  { id: 'story-02', title: 'Breaking Strain', chapters: [2] },
] };
const report = (name: string, extra = {}) => CharacterReportSchema.parse({ name, ...extra });
const add = (registry: CharacterRegistry, chapter: number, reports: ReturnType<typeof report>[], story = 'book') =>
  addCharacters(registry, reports, { story, chapter, chunk: 0 });
const names = (registry: CharacterRegistry) => registry.characters.map((character) => character.name);

describe('running cast', () => {
  it('adds a new speaker once and fills in what later reports learn', () => {
    const registry = emptyRegistry(BOOK);
    add(registry, 0, [report('Ann', { evidence: 'said Ann' })]);
    add(registry, 1, [report('ann', { sex: 'female', age: '30s', aliases: ['Annie'], evidence: 'Annie laughed' })]);

    expect(registry.characters).toMatchObject([{ name: 'Ann', sex: 'female', age: '30s', aliases: ['Annie'], chapters: [0, 1] }]);
    expect(registry.characters[0].evidence.map((entry) => [entry.chapter, entry.text])).toEqual([[0, 'said Ann'], [1, 'Annie laughed']]);
  });

  it('resolves a report made under an alias to the character who owns it', () => {
    const registry = emptyRegistry(BOOK);
    add(registry, 0, [report('Bertram Lupov', { aliases: ['Lupov', 'Bert'] })]);
    add(registry, 1, [report('Bert', { sex: 'male' })]);

    expect(registry.characters).toMatchObject([{ name: 'Bertram Lupov', sex: 'male' }]);
  });

  it('keeps an unnamed role to its chapter and offers it to no other', () => {
    const registry = emptyRegistry(BOOK);
    add(registry, 0, [report('the guard', { named: false })]);
    add(registry, 2, [report('the guard', { named: false })]);

    expect(names(registry)).toEqual(['the guard (chapter 1)', 'the guard (chapter 3)']);
    expect(chapterCast(registry, 'book', 0).characters.map((character) => character.name)).toEqual(['the guard']);
    expect(chapterCast(registry, 'book', 0).canonical.get('the guard')).toBe('the guard (chapter 1)');
    expect(chapterCast(registry, 'book', 1).characters).toEqual([]);
  });

  it('records a conflict instead of overwriting, and never adds the narrator', () => {
    const registry = emptyRegistry(BOOK);
    add(registry, 0, [report('Sam', { sex: 'male' }), report('Narrator')]);
    add(registry, 1, [report('Sam', { sex: 'female' })]);

    expect(registry.characters).toMatchObject([{ name: 'Sam', sex: 'male', issues: ['Conflicting sex: male / female.'] }]);
  });

  it('offers a story only its own cast', () => {
    const registry = emptyRegistry(COLLECTION);
    add(registry, 0, [report('Ann')], 'story-00');
    add(registry, 1, [report('Bob')], 'story-01');

    expect(chapterCast(registry, 'story-01', 1).characters.map((character) => character.name)).toEqual(['Bob']);
    expect(chapterCast(registry, 'story-01', 1).canonical.has('ann')).toBe(false);
  });
});

describe('consolidateStory', () => {
  it('folds a name into the character that lists it as an alias, keeping evidence and traits', () => {
    const registry = emptyRegistry(BOOK);
    add(registry, 0, [report('Lupov', { sex: 'male', evidence: 'said Lupov' })]);
    add(registry, 1, [report('Bertram Lupov', { aliases: ['Lupov', 'Bert'], age: '30s', evidence: 'Bertram Lupov, at your service' })]);
    // "Lupov" was met first, so it holds the name; the later report could only add an alias to itself.
    registry.characters.push({ id: 'full', name: 'Bertram Lupov', story: 'book', aliases: ['Lupov', 'Bert'], sex: 'unknown', age: '30s', named: true, chapters: [1], evidence: [], issues: [] });
    registry.characters = registry.characters.filter((character) => character.id === 'full' || character.name === 'Lupov');
    registry.characters.find((character) => character.name === 'Lupov')!.aliases = [];

    const renames = consolidateStory(registry, 'book');

    expect([...renames]).toEqual([['Lupov', 'Bertram Lupov']]);
    expect(registry.characters).toMatchObject([{ name: 'Bertram Lupov', aliases: ['Lupov', 'Bert'], sex: 'male', age: '30s', chapters: [0, 1] }]);
  });

  it('does not guess when two characters claim the same name', () => {
    const registry = emptyRegistry(BOOK);
    registry.characters = [
      { id: 'a', name: 'Smith', story: 'book', aliases: [], sex: 'unknown', age: 'unknown', named: true, chapters: [0], evidence: [], issues: [] },
      { id: 'b', name: 'John Smith', story: 'book', aliases: ['Smith'], sex: 'male', age: 'unknown', named: true, chapters: [1], evidence: [], issues: [] },
      { id: 'c', name: 'Mary Smith', story: 'book', aliases: ['Smith'], sex: 'female', age: 'unknown', named: true, chapters: [2], evidence: [], issues: [] },
    ];

    expect(consolidateStory(registry, 'book').size).toBe(0);

    expect(names(registry)).toEqual(['Smith', 'John Smith', 'Mary Smith']);
    expect(registry.characters[0].issues[0]).toContain('listed as an alias of several characters (John Smith, Mary Smith); not merged');
    expect(registry.characters[1].aliases).toEqual([]);
    expect(registry.characters[1].issues).toContain('Ambiguous alias "Smith"; not used for automatic attribution.');
  });

  it('records a merge the traits contradict as an issue on both characters', () => {
    const registry = emptyRegistry(BOOK);
    registry.characters = [
      { id: 'a', name: 'Alex', story: 'book', aliases: [], sex: 'female', age: 'unknown', named: true, chapters: [0], evidence: [], issues: [] },
      { id: 'b', name: 'Alexander Adell', story: 'book', aliases: ['Alex'], sex: 'male', age: 'unknown', named: true, chapters: [1], evidence: [], issues: [] },
    ];

    expect(consolidateStory(registry, 'book').size).toBe(0);
    expect(registry.characters.map((character) => character.issues.some((issue) => issue.includes('their sex differs; not merged')))).toEqual([true, true]);
  });

  it('is idempotent and leaves other stories alone', () => {
    const registry = emptyRegistry(COLLECTION);
    registry.characters = [
      { id: 'a', name: 'Lupov', story: 'story-00', aliases: [], sex: 'unknown', age: 'unknown', named: true, chapters: [0], evidence: [], issues: [] },
      { id: 'b', name: 'Bertram Lupov', story: 'story-01', aliases: ['Lupov'], sex: 'unknown', age: 'unknown', named: true, chapters: [1], evidence: [], issues: [] },
    ];

    expect(consolidateStory(registry, 'story-00').size).toBe(0);
    expect(consolidateStory(registry, 'story-01').size).toBe(0);
    expect(names(registry)).toEqual(['Lupov', 'Bertram Lupov']);
  });
});

describe('labelSharedNames', () => {
  it('labels a name used by two stories with each story title, and a third story later', () => {
    const registry = emptyRegistry(COLLECTION);
    add(registry, 0, [report('John'), report('Ann')], 'story-00');
    add(registry, 1, [report('John')], 'story-01');

    const renames = labelSharedNames(registry, COLLECTION);

    expect(names(registry)).toEqual(['John (Rescue Party)', 'Ann', 'John (The Sentinel)']);
    expect([...renames.get('story-00')!]).toEqual([['John', 'John (Rescue Party)']]);
    expect(labelSharedNames(registry, COLLECTION).size).toBe(0);

    add(registry, 2, [report('John')], 'story-02');
    expect([...labelSharedNames(registry, COLLECTION).keys()]).toEqual(['story-02']);
    expect(names(registry).at(-1)).toBe('John (Breaking Strain)');
    // The label is not part of the name the story's own text uses.
    expect(chapterCast(registry, 'story-02', 2, 'Breaking Strain').characters[0].name).toBe('John');
    expect(chapterCast(registry, 'story-02', 2, 'Breaking Strain').canonical.get('john')).toBe('John (Breaking Strain)');
  });

  it('labels nothing in a continuous work', () => {
    const registry = emptyRegistry(BOOK);
    add(registry, 0, [report('John')]);
    expect(labelSharedNames(registry, BOOK).size).toBe(0);
  });
});

describe('validateCharacterRegistry', () => {
  it('rejects a reserved, empty or duplicated name', () => {
    const character = (id: string, name: string) => ({ id, name, story: 'book', aliases: [], sex: 'unknown' as const, age: 'unknown', named: true, chapters: [], evidence: [], issues: [] });
    const registry = (...characters: ReturnType<typeof character>[]): CharacterRegistry => ({ ...emptyRegistry(BOOK), characters });
    expect(() => validateCharacterRegistry(registry(character('a', 'Narrator')))).toThrow('reserved');
    expect(() => validateCharacterRegistry(registry(character('a', ' ')))).toThrow('needs a name');
    expect(() => validateCharacterRegistry(registry(character('a', 'John'), character('b', 'john')))).toThrow('Two characters are named');
    expect(() => validateCharacterRegistry(registry(character('a', 'John'), character('b', 'Joan')))).not.toThrow();
  });
});
