import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  BOOK_STORY_ID,
  CharacterRegistrySchema,
  ChapterScriptSchema,
  type CastCharacter,
  type CharacterRegistry,
  type CharacterReport,
  type Stories,
  type UnresolvedSpeakerRecord,
} from '../types.js';
import type { WorkDir } from '../state.js';
import { CHARACTERS_FILE, SCRIPTS_DIR, findChapterFile } from '../layout.js';
import { storyLabels, withoutStoryLabel } from './stories.js';

/** How two spellings of a name are compared. */
export const nameKey = (name: string): string => name.normalize('NFKC').trim().toLowerCase();

const storyOf = (character: { story?: string }): string => character.story || BOOK_STORY_ID;
const known = (value: string): boolean => Boolean(nameKey(value)) && nameKey(value) !== 'unknown';
const chapterSuffix = (chapter: number): string => ` (chapter ${chapter + 1})`;

export function emptyRegistry(stories: Stories): CharacterRegistry {
  return { version: 3, stories: stories.stories.map(({ id, title }) => ({ id, title })), characters: [], unresolved: [] };
}

/** The running cast. A book that has not been scripted yet has an empty one. */
export function readCharacterRegistry(work: WorkDir, stories: Stories): CharacterRegistry {
  if (!fs.existsSync(work.path(CHARACTERS_FILE))) return emptyRegistry(stories);
  let registry: CharacterRegistry;
  try {
    registry = CharacterRegistrySchema.parse(work.readJson(CHARACTERS_FILE));
  } catch (err) {
    throw new Error(`${CHARACTERS_FILE} is not a valid character registry (${(err as Error).message.slice(0, 300)}). Fix the file, or rerun Script with --rerun to rebuild it.`);
  }
  return { ...registry, stories: stories.stories.map(({ id, title }) => ({ id, title })) };
}

export function writeCharacterRegistry(work: WorkDir, registry: CharacterRegistry): void {
  work.writeJson(CHARACTERS_FILE, registry);
}

/** The name a character is written as in the book's own text. */
function displayName(character: CastCharacter, storyLabel: string | undefined): string {
  const name = withoutStoryLabel(character.name, storyLabel);
  if (character.named) return name;
  const suffix = character.chapters.length ? chapterSuffix(character.chapters[0]) : '';
  return suffix && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

export interface ChapterCast {
  /** The cast as a prompt shows it: the book's own names, no story labels. */
  characters: Array<Pick<CastCharacter, 'name' | 'aliases' | 'sex' | 'age'>>;
  /** Lower-cased name, written name or unambiguous alias to canonical name. */
  canonical: Map<string, string>;
}

/**
 * Who can speak in one chapter: the story's named characters, and the unnamed
 * roles first met in this chapter. A "guard" in chapter 9 is not assumed to be
 * the guard of chapter 2, and another story's cast is never offered.
 */
export function chapterCast(registry: CharacterRegistry, storyId: string, chapter: number, storyLabel?: string): ChapterCast {
  const scoped = registry.characters.filter((character) => storyOf(character) === storyId
    && (character.named || character.chapters.includes(chapter)));
  const canonical = new Map<string, string>();
  for (const character of scoped) canonical.set(nameKey(character.name), character.name);
  for (const character of scoped) {
    const written = nameKey(displayName(character, storyLabel));
    if (!canonical.has(written)) canonical.set(written, character.name);
  }
  const owners = new Map<string, Set<string>>();
  for (const character of scoped) {
    for (const alias of character.aliases) {
      const set = owners.get(nameKey(alias)) ?? new Set<string>();
      set.add(character.id);
      owners.set(nameKey(alias), set);
    }
  }
  for (const character of scoped) {
    for (const alias of character.aliases) {
      const id = nameKey(alias);
      // An alias two characters claim identifies neither of them.
      if (id && !canonical.has(id) && owners.get(id)!.size === 1) canonical.set(id, character.name);
    }
  }
  return {
    characters: scoped.map((character) => ({
      name: displayName(character, storyLabel), aliases: character.aliases, sex: character.sex, age: character.age,
    })),
    canonical,
  };
}

const characterId = (story: string, name: string): string =>
  `char-${crypto.createHash('sha256').update(`${story}\x1f${nameKey(name)}`).digest('hex').slice(0, 16)}`;

function addAliases(character: CastCharacter, aliases: string[]): void {
  const have = new Set([character.name, ...character.aliases].map(nameKey));
  for (const alias of aliases.map((value) => value.trim())) {
    const id = nameKey(alias);
    if (!id || id === 'narrator' || have.has(id)) continue;
    have.add(id);
    character.aliases.push(alias);
  }
}

function addIssue(character: CastCharacter, issue: string): void {
  if (!character.issues.includes(issue)) character.issues.push(issue);
}

/**
 * Add the speakers one Script call reported to the running cast. A report of
 * someone already in this chapter's cast adds to that character's record
 * rather than creating a second one. Returns the canonical names involved.
 */
export function addCharacters(
  registry: CharacterRegistry,
  reports: CharacterReport[],
  where: { story: string; chapter: number; chunk: number; storyLabel?: string },
): string[] {
  const names: string[] = [];
  for (const report of reports) {
    const name = report.name.trim();
    if (!name || nameKey(name) === 'narrator') continue;
    const { canonical } = chapterCast(registry, where.story, where.chapter, where.storyLabel);
    const existingName = canonical.get(nameKey(name));
    let character = existingName === undefined
      ? undefined
      : registry.characters.find((entry) => storyOf(entry) === where.story && entry.name === existingName);
    if (!character) {
      // A generic role in two chapters is not evidence of one identity.
      const canonicalName = report.named ? name : `${name}${chapterSuffix(where.chapter)}`;
      character = {
        id: characterId(where.story, canonicalName), name: canonicalName, story: where.story, aliases: [],
        sex: 'unknown', age: 'unknown', named: report.named, chapters: [], evidence: [], issues: [],
      };
      registry.characters.push(character);
    }
    if (character.named) addAliases(character, report.aliases);
    if (report.sex !== 'unknown') {
      if (character.sex === 'unknown') character.sex = report.sex;
      else if (character.sex !== report.sex) addIssue(character, `Conflicting sex: ${character.sex} / ${report.sex}.`);
    }
    if (!known(character.age) && known(report.age)) character.age = report.age;
    if (!character.chapters.includes(where.chapter)) character.chapters = [...character.chapters, where.chapter].sort((a, b) => a - b);
    const evidence = report.evidence.trim();
    if (evidence && !character.evidence.some((entry) => entry.text === evidence)) {
      character.evidence.push({ chapter: where.chapter, chunk: where.chunk, text: evidence });
    }
    names.push(character.name);
  }
  return names;
}

/**
 * Offline consolidation of one story's cast: exact names and unambiguous
 * aliases only. "Lupov", met in chapter 1, is folded into "Bertram Lupov" once
 * a later chapter names him in full and lists the surname as an alias. A merge
 * the text does not settle is recorded as an issue and left for review.
 * Returns the renames to apply to that story's saved scripts.
 */
export function consolidateStory(registry: CharacterRegistry, storyId: string): Map<string, string> {
  const scoped = registry.characters.filter((character) => storyOf(character) === storyId && character.named);
  const parent = new Map(scoped.map((character) => [character.id, character.id]));
  const byId = new Map(scoped.map((character) => [character.id, character]));
  const root = (id: string): string => (parent.get(id) === id ? id : root(parent.get(id)!));

  const byName = new Map<string, CastCharacter[]>();
  for (const character of scoped) byName.set(nameKey(character.name), [...(byName.get(nameKey(character.name)) ?? []), character]);
  // The same name twice can only come from a hand edit; it is one person.
  for (const group of byName.values()) for (const other of group.slice(1)) parent.set(root(other.id), root(group[0].id));

  const aliasOwners = new Map<string, CastCharacter[]>();
  for (const character of scoped) {
    for (const alias of character.aliases) aliasOwners.set(nameKey(alias), [...(aliasOwners.get(nameKey(alias)) ?? []), character]);
  }
  for (const character of scoped) {
    const owners = (aliasOwners.get(nameKey(character.name)) ?? []).filter((owner) => owner.id !== character.id);
    if (!owners.length) continue;
    if (owners.length > 1) {
      addIssue(character, `"${character.name}" is listed as an alias of several characters (${owners.map((owner) => owner.name).join(', ')}); not merged.`);
      continue;
    }
    const owner = owners[0];
    if (character.sex !== 'unknown' && owner.sex !== 'unknown' && character.sex !== owner.sex) {
      const issue = (other: CastCharacter): string => `Possible duplicate of "${other.name}", but their sex differs; not merged.`;
      addIssue(character, issue(owner));
      addIssue(owner, issue(character));
      continue;
    }
    if (root(owner.id) === root(character.id)) continue;
    // When each lists the other, the fuller name is the one to keep.
    const mutual = owner.aliases.some((alias) => nameKey(alias) === nameKey(character.name))
      && character.aliases.some((alias) => nameKey(alias) === nameKey(owner.name));
    const keep = mutual && character.name.length > owner.name.length ? character : owner;
    const fold = keep === owner ? character : owner;
    parent.set(root(fold.id), root(keep.id));
  }

  const renames = new Map<string, string>();
  const removed = new Set<string>();
  for (const character of scoped) {
    const target = byId.get(root(character.id))!;
    if (target === character) continue;
    if (character.name !== target.name) renames.set(character.name, target.name);
    addAliases(target, [character.name, ...character.aliases]);
    if (target.sex === 'unknown') target.sex = character.sex;
    if (!known(target.age) && known(character.age)) target.age = character.age;
    target.chapters = [...new Set([...target.chapters, ...character.chapters])].sort((a, b) => a - b);
    target.evidence.push(...character.evidence.filter((entry) => !target.evidence.some((have) => have.text === entry.text)));
    for (const issue of character.issues) addIssue(target, issue);
    removed.add(character.id);
  }
  registry.characters = registry.characters.filter((character) => !removed.has(character.id));

  // An alias must identify one character: never another's name, never shared.
  const remaining = registry.characters.filter((character) => storyOf(character) === storyId);
  const claims = new Map<string, Set<string>>();
  for (const character of remaining) {
    for (const name of [character.name, ...character.aliases]) {
      const set = claims.get(nameKey(name)) ?? new Set<string>();
      set.add(character.id);
      claims.set(nameKey(name), set);
    }
  }
  for (const character of remaining) {
    character.aliases = character.aliases.filter((alias) => {
      if (claims.get(nameKey(alias))!.size === 1) return true;
      addIssue(character, `Ambiguous alias "${alias}"; not used for automatic attribution.`);
      return false;
    });
  }
  return renames;
}

/**
 * Two stories can use one name for two people. Casting, bindings and script
 * segments are all keyed by name, so a name shared by two stories is labelled
 * with its story title ("John (Rescue Party)"). Returns renames per story.
 */
export function labelSharedNames(registry: CharacterRegistry, stories: Stories): Map<string, Map<string, string>> {
  const renames = new Map<string, Map<string, string>>();
  if (!stories.collection) return renames;
  const labels = storyLabels(stories);
  const written = (character: CastCharacter): string => nameKey(withoutStoryLabel(character.name, labels.get(storyOf(character))));
  const sharing = new Map<string, Set<string>>();
  for (const character of registry.characters) {
    const set = sharing.get(written(character)) ?? new Set<string>();
    set.add(storyOf(character));
    sharing.set(written(character), set);
  }
  for (const character of registry.characters) {
    const label = labels.get(storyOf(character));
    if (!label || (sharing.get(written(character))?.size ?? 0) < 2) continue;
    const labelled = `${withoutStoryLabel(character.name, label)} (${label})`;
    if (labelled === character.name) continue;
    const story = renames.get(storyOf(character)) ?? new Map<string, string>();
    story.set(character.name, labelled);
    renames.set(storyOf(character), story);
    character.name = labelled;
  }
  return renames;
}

/** Rename speakers in a story's saved scripts. No model is involved. */
export function renameSpeakers(work: WorkDir, chapters: number[], renames: Map<string, string>): void {
  if (!renames.size) return;
  for (const index of chapters) {
    const file = findChapterFile(work.root, SCRIPTS_DIR, index, '.json');
    if (!file) continue;
    const script = ChapterScriptSchema.parse(work.readJson(file));
    let changed = false;
    for (const segment of script.segments) {
      const renamed = renames.get(segment.speaker);
      if (renamed === undefined) continue;
      segment.speaker = renamed;
      changed = true;
    }
    if (changed) work.writeJson(file, script);
  }
}

/** Record the chapter against everyone who speaks in it, known or newly met. */
export function noteAppearances(registry: CharacterRegistry, storyId: string, chapter: number, speakers: Iterable<string>): void {
  const names = new Set(speakers);
  for (const character of registry.characters) {
    if (storyOf(character) !== storyId || !names.has(character.name) || character.chapters.includes(chapter)) continue;
    character.chapters = [...character.chapters, chapter].sort((a, b) => a - b);
  }
}

/** Replace what is recorded as unresolved for one chapter. */
export function setUnresolved(registry: CharacterRegistry, chapter: number, records: UnresolvedSpeakerRecord[]): void {
  registry.unresolved = [...registry.unresolved.filter((record) => record.chapter !== chapter), ...records]
    .sort((left, right) => left.chapter - right.chapter || left.speaker.localeCompare(right.speaker));
}

/** A registry a person edited must still give every speaker one identity. */
export function validateCharacterRegistry(registry: CharacterRegistry): void {
  const ids = new Set<string>();
  const names = new Map<string, string>();
  for (const character of registry.characters) {
    if (!character.id.trim()) throw new Error('Every character needs an id.');
    if (ids.has(character.id)) throw new Error(`Duplicate character id "${character.id}".`);
    ids.add(character.id);
    const name = character.name.trim();
    if (!name) throw new Error('Every character needs a name.');
    if (nameKey(name) === 'narrator') throw new Error('"narrator" is reserved and cannot be a character name.');
    // casting.json and voice-bindings.json are keyed by name across the book.
    if (names.has(nameKey(name))) throw new Error(`Two characters are named "${name}". Give each a distinct name, such as "${name} (story title)".`);
    names.set(nameKey(name), character.id);
  }
}
