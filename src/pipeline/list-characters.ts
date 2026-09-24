import crypto from 'node:crypto';
import fs from 'node:fs';
import { CharacterRegistrySchema, ChapterCharactersSchema, type Analysis, type BookMetadata, type CharacterRegistry, type ChapterCharacters } from '../types.js';
import type { WorkDir } from '../state.js';
import { reportWarning } from '../util/warnings.js';
import { reportProgress } from '../util/progress.js';

export const CHARACTER_REGISTRY_FILE = 'characters.json';
export const characterChapterFile = (index: number): string => `chapter-characters/${String(index).padStart(2, '0')}.json`;
const key = (name: string): string => name.normalize('NFKC').trim().toLowerCase();

export function readCharacterRegistry(work: WorkDir): CharacterRegistry {
  if (!fs.existsSync(work.path(CHARACTER_REGISTRY_FILE))) {
    throw new Error('Run list-characters before Script or Casting to create the book character registry.');
  }
  return CharacterRegistrySchema.parse(work.readJson(CHARACTER_REGISTRY_FILE));
}

export function characterRegistryHash(registry: CharacterRegistry): string {
  return crypto.createHash('sha256').update(JSON.stringify(registry)).digest('hex');
}

/** Offline reconciliation: exact names and unambiguous, explicit aliases only. */
export function buildCharacterRegistry(chapters: ChapterCharacters[]): CharacterRegistry {
  type Observation = ChapterCharacters['observations'][number] & { chapter: number };
  const groups = new Map<string, Observation[]>();
  for (const chapter of [...chapters].sort((a, b) => a.index - b.index)) {
    for (const observation of chapter.observations) {
      const name = observation.name.trim();
      if (!name || key(name) === 'narrator') continue;
      // A generic role in two chapters is not sufficient evidence of one identity.
      const identity = observation.named ? key(name) : `${key(name)} (chapter ${chapter.index + 1})`;
      const list = groups.get(identity) ?? [];
      list.push({ ...observation, name, chapter: chapter.index });
      groups.set(identity, list);
    }
  }
  const owners = new Map<string, Set<string>>();
  for (const [identity, observations] of groups) {
    for (const observation of observations.filter((o) => o.named && o.confidence === 'high')) {
      for (const alias of observation.aliases.filter((a) => key(a) && key(a) !== identity)) {
        const names = owners.get(key(alias)) ?? new Set<string>();
        names.add(identity);
        owners.set(key(alias), names);
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
    const issues = new Set<string>();
    const aliases = new Set<string>();
    for (const observation of observations) {
      if (observation.confidence === 'low') issues.add('Identity or traits need review; see chapter evidence.');
      for (const alias of [observation.name, ...observation.aliases]) {
        if (key(alias) === identity || key(alias) === 'narrator' || !key(alias)) continue;
        if ((owners.get(key(alias))?.size ?? 0) > 1) {
          issues.add(`Ambiguous alias "${alias}"; not used for automatic attribution.`);
        } else if (observation.named && observation.confidence === 'high') aliases.add(alias.trim());
      }
    }
    const trait = (field: 'sex' | 'age' | 'race' | 'class' | 'country'): string => {
      const values = [...new Set(observations.filter((o) => o.confidence === 'high').map((o) => o[field]).filter((v) => key(v) !== 'unknown' && key(v)))];
      if (values.length > 1) issues.add(`Conflicting ${field}: ${values.join(' / ')}.`);
      return values.length === 1 ? values[0] : 'unknown';
    };
    const character = {
      id: `char-${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16)}`,
      name: first.named ? first.name : `${first.name} (chapter ${first.chapter + 1})`,
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
  // An alias must never shadow another character's canonical name.
  const aliasOwners = new Map<string, Set<string>>();
  for (const character of characters) {
    for (const name of [character.name, ...character.aliases]) {
      const ids = aliasOwners.get(key(name)) ?? new Set<string>();
      ids.add(character.id);
      aliasOwners.set(key(name), ids);
    }
  }
  for (const character of characters) {
    character.aliases = character.aliases.filter((alias) => {
      const collision = aliasOwners.get(key(alias))!.size > 1;
      if (collision) character.issues.push(`Ambiguous alias "${alias}"; not used for automatic attribution.`);
      return !collision;
    });
  }
  return { version: 1, chapters: chapters.map((c) => c.index).sort((a, b) => a - b), characters };
}

export function runListCharacters(work: WorkDir): CharacterRegistry {
  const analysis = work.readJson<Analysis>('analysis.json');
  const metadata = work.readJson<BookMetadata>('metadata.json');
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
  reportProgress({ activity: 'Merging supported names and aliases into the book character registry' });
  const registry = buildCharacterRegistry(observations);
  if (fs.existsSync(work.path(CHARACTER_REGISTRY_FILE))) {
    const previous = readCharacterRegistry(work);
    const used = new Set<string>();
    for (const character of registry.characters) {
      const names = new Set([character.name, ...character.aliases].map(key));
      const matches = previous.characters.filter((old) => !used.has(old.id) && [old.name, ...old.aliases].some((name) => names.has(key(name))));
      const oldNames = matches.length === 1 ? new Set([matches[0].name, ...matches[0].aliases].map(key)) : new Set<string>();
      const successors = registry.characters.filter((next) => [next.name, ...next.aliases].some((name) => oldNames.has(key(name))));
      if (matches.length === 1 && successors.length === 1) {
        character.id = matches[0].id;
        used.add(character.id);
      }
    }
  }
  work.writeJson(CHARACTER_REGISTRY_FILE, registry);
  const review = registry.characters.filter((character) => character.issues.length);
  if (review.length) reportWarning(`${review.length} character profile(s) need review in characters.json: ${review.map((c) => c.name).join(', ')}.`);
  reportProgress({ activity: `Saved ${registry.characters.length} character profiles; ${review.length} need review`, phase: 'completed' });
  return registry;
}
