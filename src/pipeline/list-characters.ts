import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  BOOK_STORY_ID,
  CharacterRegistrySchema,
  ChapterCharactersSchema,
  type Analysis,
  type BookMetadata,
  type CharacterRegistry,
  type ChapterCharacters,
  type Stories,
} from '../types.js';
import type { WorkDir } from '../state.js';
import { reportWarning } from '../util/warnings.js';
import { reportProgress } from '../util/progress.js';
import { readStories, storyIdFor, storyLabels } from './stories.js';

export const CHARACTER_REGISTRY_FILE = 'characters.json';
export const characterChapterFile = (index: number): string => `chapter-characters/${String(index).padStart(2, '0')}.json`;
const key = (name: string): string => name.normalize('NFKC').trim().toLowerCase();
/** Identities are scoped as `<story>\x1f<name>`; this recovers the name part. */
const bareKey = (identity: string): string => identity.slice(identity.indexOf('\x1f') + 1);
const storyOf = (character: { story?: string }): string => character.story || BOOK_STORY_ID;

/** Every narratable chapter in one scope: the grouping for a continuous work. */
function singleScope(chapters: ChapterCharacters[]): Stories {
  return { version: 1, collection: false, stories: [{ id: BOOK_STORY_ID, title: '', chapters: chapters.map((chapter) => chapter.index) }] };
}

/**
 * Fill story scopes that a version-1 registry or a hand edit does not carry.
 * A character consolidated before story scopes existed is attributed to the
 * story holding its first chapter; the next List Characters run rebuilds it.
 */
export function withStoryScopes(registry: CharacterRegistry, stories: Stories): CharacterRegistry {
  return {
    ...registry,
    version: 2,
    stories: registry.stories.length ? registry.stories : stories.stories.map(({ id, title }) => ({ id, title })),
    characters: registry.characters.map((character) => character.story
      ? character
      : { ...character, story: character.chapters.length ? storyIdFor(stories, character.chapters[0]) : BOOK_STORY_ID }),
  };
}

export function readCharacterRegistry(work: WorkDir): CharacterRegistry {
  if (!fs.existsSync(work.path(CHARACTER_REGISTRY_FILE))) {
    throw new Error('Run list-characters before Script or Casting to create the book character registry.');
  }
  return withStoryScopes(CharacterRegistrySchema.parse(work.readJson(CHARACTER_REGISTRY_FILE)), readStories(work));
}

/**
 * Hash only what Script depends on — the names, aliases and chapters it uses
 * to attribute dialogue — and only within one story. Schema growth and edits
 * to another story therefore cannot invalidate a chapter's paid script.
 */
export function characterScopeHash(registry: CharacterRegistry, storyId?: string): string {
  const characters = registry.characters
    .filter((character) => storyId === undefined || storyOf(character) === storyId)
    .map((character) => ({
      name: character.name,
      aliases: [...character.aliases].sort(),
      chapters: [...character.chapters].sort((left, right) => left - right),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return crypto.createHash('sha256').update(JSON.stringify(characters)).digest('hex');
}

/** Scope hash per story, for deciding which scripts a registry change invalidates. */
export function characterScopeHashes(registry: CharacterRegistry, stories: Stories): Map<string, string> {
  return new Map(stories.stories.map((story) => [story.id, characterScopeHash(registry, story.id)]));
}

/**
 * The whole-registry hash written into scripts before story scopes existed.
 * Reconstructing the version-1 shape lets an unchanged registry keep its
 * existing scripts instead of paying for attribution again.
 */
export function legacyCharacterRegistryHash(registry: CharacterRegistry): string {
  const legacy = {
    version: 1,
    chapters: registry.chapters,
    characters: registry.characters.map((character) => ({
      id: character.id,
      name: character.name,
      aliases: character.aliases,
      sex: character.sex,
      age: character.age,
      race: character.race,
      class: character.class,
      country: character.country,
      importance: character.importance,
      chapters: character.chapters,
      evidence: character.evidence,
      issues: character.issues,
    })),
  };
  return crypto.createHash('sha256').update(JSON.stringify(legacy)).digest('hex');
}

/**
 * Two stories can use one name for two people. Casting, bindings and script
 * segments are all keyed by name, so a name shared by two stories is labelled
 * with its story. Labelling is idempotent: an already-labelled name no longer
 * collides, so it is not labelled twice.
 */
function labelSharedNames(characters: Array<{ name: string; story: string }>, labels: Map<string, string>): void {
  const sharing = new Map<string, Set<string>>();
  for (const character of characters) {
    const stories = sharing.get(key(character.name)) ?? new Set<string>();
    stories.add(character.story);
    sharing.set(key(character.name), stories);
  }
  for (const character of characters) {
    if ((sharing.get(key(character.name))?.size ?? 0) < 2) continue;
    const label = labels.get(character.story);
    if (label) character.name = `${character.name} (${label})`;
  }
}

/**
 * Offline reconciliation: exact names and unambiguous, explicit aliases only.
 * Names are consolidated within one story, so two stories in a collection that
 * each have a "John" keep separate profiles, traits and voices.
 */
export function buildCharacterRegistry(chapters: ChapterCharacters[], stories?: Stories): CharacterRegistry {
  const grouping = stories ?? singleScope(chapters);
  const labels = storyLabels(grouping);
  type Observation = ChapterCharacters['observations'][number] & { chapter: number };
  const groups = new Map<string, Observation[]>();
  const storyOfIdentity = new Map<string, string>();
  for (const chapter of [...chapters].sort((a, b) => a.index - b.index)) {
    const story = storyIdFor(grouping, chapter.index);
    for (const observation of chapter.observations) {
      const name = observation.name.trim();
      if (!name || key(name) === 'narrator') continue;
      // A generic role in two chapters is not sufficient evidence of one identity.
      const identity = `${story}\x1f${observation.named ? key(name) : `${key(name)} (chapter ${chapter.index + 1})`}`;
      const list = groups.get(identity) ?? [];
      list.push({ ...observation, name, chapter: chapter.index });
      groups.set(identity, list);
      storyOfIdentity.set(identity, story);
    }
  }
  const owners = new Map<string, Set<string>>();
  for (const [identity, observations] of groups) {
    const story = storyOfIdentity.get(identity)!;
    for (const observation of observations.filter((o) => o.named && o.confidence === 'high')) {
      for (const alias of observation.aliases.filter((a) => key(a) && `${story}\x1f${key(a)}` !== identity)) {
        const names = owners.get(`${story}\x1f${key(alias)}`) ?? new Set<string>();
        names.add(identity);
        owners.set(`${story}\x1f${key(alias)}`, names);
      }
    }
  }
  const parent = new Map([...groups.keys()].map((name) => [name, name]));
  const root = (name: string): string => parent.get(name) === name ? name : root(parent.get(name)!);
  for (const [alias, names] of owners) {
    if (names.size !== 1 || !groups.has(alias)) continue;
    const owner = root([...names][0]);
    const target = root(alias);
    if (owner !== target) parent.set(target, owner);
  }
  const merged = new Map<string, Observation[]>();
  for (const [identity, observations] of groups) {
    const name = root(identity);
    merged.set(name, [...(merged.get(name) ?? []), ...observations]);
  }
  const characters = [...merged.entries()].map(([identity, observations]) => {
    const first = groups.get(identity)![0];
    const story = storyOfIdentity.get(identity)!;
    const issues = new Set<string>();
    const aliases = new Set<string>();
    for (const observation of observations) {
      if (observation.confidence === 'low') issues.add('Identity or traits need review; see chapter evidence.');
      for (const alias of [observation.name, ...observation.aliases]) {
        if (key(alias) === bareKey(identity) || key(alias) === 'narrator' || !key(alias)) continue;
        if ((owners.get(`${story}\x1f${key(alias)}`)?.size ?? 0) > 1) {
          issues.add(`Ambiguous alias "${alias}"; not used for automatic attribution.`);
        } else if (observation.named && observation.confidence === 'high') aliases.add(alias.trim());
      }
    }
    const trait = (field: 'sex' | 'age' | 'race' | 'class' | 'country'): string => {
      const values = [...new Set(observations.filter((o) => o.confidence === 'high').map((o) => o[field]).filter((v) => key(v) !== 'unknown' && key(v)))];
      if (values.length > 1) issues.add(`Conflicting ${field}: ${values.join(' / ')}.`);
      return values.length === 1 ? values[0] : 'unknown';
    };
    // Keep generated IDs stable for a continuous work, where the single scope
    // adds no information: an existing registry must not churn its IDs.
    const idSource = grouping.collection ? identity : bareKey(identity);
    const character = {
      id: `char-${crypto.createHash('sha256').update(idSource).digest('hex').slice(0, 16)}`,
      name: first.named ? first.name : `${first.name} (chapter ${first.chapter + 1})`,
      story,
      aliases: [...aliases],
      sex: trait('sex') as 'male' | 'female' | 'unknown',
      age: trait('age'), race: trait('race'), class: trait('class'), country: trait('country'),
      importance: observations.some((o) => o.importance === 'main') ? 'main' as const
        : observations.some((o) => o.importance === 'secondary') ? 'secondary' as const : 'minor' as const,
      chapters: [...new Set(observations.map((o) => o.chapter))].sort((a, b) => a - b),
      evidence: observations.map((o) => ({ chapter: o.chapter, chunk: o.chunk, text: o.evidence })),
      issues: [...issues],
    };
    return character;
  });
  if (grouping.collection) labelSharedNames(characters, labels);
  // An alias must never shadow another character's canonical name in the same story.
  const aliasOwners = new Map<string, Set<string>>();
  for (const character of characters) {
    for (const name of [character.name, ...character.aliases]) {
      const ids = aliasOwners.get(`${character.story}\x1f${key(name)}`) ?? new Set<string>();
      ids.add(character.id);
      aliasOwners.set(`${character.story}\x1f${key(name)}`, ids);
    }
  }
  for (const character of characters) {
    character.aliases = character.aliases.filter((alias) => {
      const collision = aliasOwners.get(`${character.story}\x1f${key(alias)}`)!.size > 1;
      if (collision) character.issues.push(`Ambiguous alias "${alias}"; not used for automatic attribution.`);
      return !collision;
    });
  }
  return {
    version: 2,
    chapters: chapters.map((c) => c.index).sort((a, b) => a - b),
    stories: grouping.stories.map(({ id, title }) => ({ id, title })),
    characters,
  };
}

export function runListCharacters(work: WorkDir): CharacterRegistry {
  const analysis = work.readJson<Analysis>('analysis.json');
  const metadata = work.readJson<BookMetadata>('metadata.json');
  const stories = readStories(work);
  const chapters = metadata.chapters.filter((ch) => analysis.chapters.some((p) => p.index === ch.index && p.narrate));
  reportProgress({ activity: 'Reading chapter character observations', completedUnits: 0, totalUnits: chapters.length, unit: 'chapters read' });
  const observations = chapters.map((chapter, position) => {
    const file = characterChapterFile(chapter.index);
    if (!fs.existsSync(work.path(file))) {
      throw new Error(`Character observations are missing for chapter ${chapter.index + 1}. Run chapters to backfill them, then run list-characters.`);
    }
    const result = ChapterCharactersSchema.parse(work.readJson(file));
    if (result.index !== chapter.index) throw new Error(`Chapter index mismatch in ${file}. Rerun chapters for index ${chapter.index}.`);
    reportProgress({ activity: 'Reading chapter character observations', completedUnits: position + 1, totalUnits: chapters.length, unit: 'chapters read' });
    return result;
  });
  reportProgress({
    activity: stories.collection
      ? `Merging supported names and aliases within each of ${stories.stories.length} stories`
      : 'Merging supported names and aliases into the book character registry',
  });
  const registry = buildCharacterRegistry(observations, stories);
  if (fs.existsSync(work.path(CHARACTER_REGISTRY_FILE))) {
    const previous = readCharacterRegistry(work);
    const used = new Set<string>();
    for (const character of registry.characters) {
      const generatedId = character.id;
      const names = new Set([character.name, ...character.aliases].map(key));
      // A reviewed profile is only carried forward within its own story.
      const matches = previous.characters.filter((old) => !used.has(old.id) && storyOf(old) === character.story &&
        (old.id === generatedId || [old.name, ...old.aliases].some((name) => names.has(key(name)))));
      const oldNames = matches.length === 1 ? new Set([matches[0].name, ...matches[0].aliases].map(key)) : new Set<string>();
      const successors = registry.characters.filter((next) => next.story === character.story && (next.id === matches[0]?.id ||
        [next.name, ...next.aliases].some((name) => oldNames.has(key(name)))));
      if (matches.length === 1 && successors.length === 1) {
        const old = matches[0];
        // The stable generated ID reveals a renamed profile in Character Review.
        // Keep that name while retaining the observed label as an alias.
        if (old.id === generatedId && key(old.name) !== key(character.name)
          && !registry.characters.some((other) => other !== character && other.story === character.story && key(other.name) === key(old.name))) {
          character.aliases.push(character.name);
          character.name = old.name;
        }
        character.id = old.id;
        character.aliases = [...new Set([...character.aliases, ...old.aliases].filter((alias) => key(alias) !== key(character.name)))];
        used.add(character.id);
      }
    }
    // A manually added speaker may not appear in chapter observations. Keep it
    // across an ordinary List Characters rerun so resolving Script can stick.
    for (const old of previous.characters) {
      if (old.id.startsWith('manual-') && !used.has(old.id)
        && !registry.characters.some((character) => character.story === storyOf(old) && key(character.name) === key(old.name))) {
        registry.characters.push({ ...old, story: storyOf(old) });
      }
    }
    // A manually added speaker can share its name with another story's
    // character, which would make the two indistinguishable to casting.
    if (stories.collection) labelSharedNames(registry.characters, storyLabels(stories));
    const owners = new Map<string, Set<string>>();
    for (const character of registry.characters) {
      for (const name of [character.name, ...character.aliases]) {
        const ids = owners.get(`${character.story}\x1f${key(name)}`) ?? new Set<string>();
        ids.add(character.id);
        owners.set(`${character.story}\x1f${key(name)}`, ids);
      }
    }
    for (const character of registry.characters) {
      character.aliases = character.aliases.filter((alias) => {
        if (owners.get(`${character.story}\x1f${key(alias)}`)!.size === 1) return true;
        character.issues.push(`Ambiguous alias "${alias}"; not used for automatic attribution.`);
        return false;
      });
    }
  }
  work.writeJson(CHARACTER_REGISTRY_FILE, registry);
  const review = registry.characters.filter((character) => character.issues.length);
  if (review.length) reportWarning(`${review.length} character profile(s) need review in characters.json: ${review.map((c) => c.name).join(', ')}.`);
  reportProgress({ activity: `Saved ${registry.characters.length} character profiles; ${review.length} need review`, phase: 'completed' });
  return registry;
}
