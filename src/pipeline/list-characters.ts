import crypto from 'node:crypto';
import fs from 'node:fs';
import { BookAnnotationsSchema, CharacterRegistrySchema, CorrectionsSchema, type BookAnnotations, type CharacterRegistry, type ChapterCharacters, type Corrections } from '../types.js';
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
      sourceEntityIds: [],
      sourceQuoteIds: [],
      inferredPronouns: [],
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
  reportProgress({ activity: 'Reading BookNLP entities and attributed quotations' });
  const annotations = BookAnnotationsSchema.parse(work.readJson('booknlp/annotations.json'));
  const corrections = fs.existsSync(work.path('corrections.json'))
    ? CorrectionsSchema.parse(work.readJson('corrections.json'))
    : CorrectionsSchema.parse({ version: 1 });
  const previous = fs.existsSync(work.path(CHARACTER_REGISTRY_FILE)) ? readCharacterRegistry(work) : undefined;
  const registry = registryFromAnnotations(annotations, previous, corrections);
  work.writeJson(CHARACTER_REGISTRY_FILE, registry);
  const review = registry.characters.filter((character) => character.issues.length);
  if (review.length) reportWarning(`${review.length} character profile(s) need review in characters.json: ${review.map((c) => c.name).join(', ')}.`);
  reportProgress({ activity: `Saved ${registry.characters.length} character profiles; ${review.length} need review`, phase: 'completed' });
  return registry;
}

export function registryFromAnnotations(
  annotations: BookAnnotations,
  previous?: CharacterRegistry,
  corrections: Corrections = CorrectionsSchema.parse({ version: 1 }),
): CharacterRegistry {
  const quotesByEntity = new Map<string, BookAnnotations['quotations']>();
  for (const quote of annotations.quotations) {
    // BookNLP reserves entity 0 for first-person narration. It uses Lisen's
    // narrator voice and is not a separately cast character.
    if (!quote.entityId || quote.entityId === 'booknlp:0') continue;
    const list = quotesByEntity.get(quote.entityId) ?? [];
    list.push(quote);
    quotesByEntity.set(quote.entityId, list);
  }
  const mentionsByEntity = new Map<string, BookAnnotations['mentions']>();
  for (const mention of annotations.mentions) {
    const list = mentionsByEntity.get(mention.entityId) ?? [];
    list.push(mention);
    mentionsByEntity.set(mention.entityId, list);
  }

  const candidates = [...quotesByEntity.entries()].map(([entityId, quotes], position) => {
    const mentions = mentionsByEntity.get(entityId) ?? [];
    const proper = rankedLabels(mentions.filter((mention) => mention.kind === 'proper').map((mention) => mention.text));
    const common = rankedLabels(mentions.filter((mention) => mention.kind === 'common').map((mention) => mention.text));
    const pronouns = rankedLabels(mentions.filter((mention) => mention.kind === 'pronoun').map((mention) => mention.text));
    const labels = [...proper, ...common];
    const name = labels[0] ?? `Unnamed speaker ${position + 1}`;
    const aliases = labels.slice(1).filter((label) => key(label) !== key(name));
    const quoteIds = quotes.map((quote) => quote.id);
    const chapters = [...new Set(quotes.flatMap((quote) => quote.chapterIndex === null ? [] : [quote.chapterIndex]))].sort((a, b) => a - b);
    return {
      id: '', name, aliases, sex: 'unknown' as 'male' | 'female' | 'unknown', age: 'unknown', race: 'unknown', class: 'unknown', country: 'unknown',
      importance: quotes.length >= 20 ? 'main' as const : quotes.length >= 5 ? 'secondary' as const : 'minor' as const,
      chapters,
      evidence: quotes.slice(0, 5).map((quote) => ({ chapter: quote.chapterIndex ?? 0, chunk: 0, text: quote.text })),
      issues: [] as string[], sourceEntityIds: [entityId], sourceQuoteIds: quoteIds, inferredPronouns: pronouns,
    };
  });

  const usedPrevious = new Set<string>();
  for (const candidate of candidates) {
    const matches = previous?.characters.filter((old) => !usedPrevious.has(old.id) && reconciliationScore(candidate, old) > 0) ?? [];
    const ranked = matches.map((old) => ({ old, score: reconciliationScore(candidate, old) })).sort((a, b) => b.score - a.score);
    if (ranked[0] && (!ranked[1] || ranked[0].score > ranked[1].score)) {
      candidate.id = ranked[0].old.id;
      usedPrevious.add(candidate.id);
    } else {
      candidate.id = `speaker-${crypto.createHash('sha256').update(`${candidate.name}\x1f${candidate.sourceQuoteIds[0] ?? candidate.sourceEntityIds[0]}`).digest('hex').slice(0, 16)}`;
      if (ranked.length > 1) candidate.issues.push('Ambiguous reconciliation with the previous character registry; manual corrections were not guessed.');
    }
    const correction = corrections.characters[candidate.id];
    if (correction) {
      if (correction.name) candidate.name = correction.name;
      if (correction.aliases) candidate.aliases = [...correction.aliases];
      if (correction.presentation === 'male' || correction.presentation === 'female') candidate.sex = correction.presentation;
      for (const field of ['age', 'race', 'class', 'country'] as const) if (correction[field]) candidate[field] = correction[field]!;
    }
  }

  for (const character of candidates) {
    const mergeInto = corrections.characters[character.id]?.mergeInto;
    if (!mergeInto) continue;
    const target = candidates.find((entry) => entry.id === mergeInto);
    if (!target) character.issues.push(`Correction requests merge into missing speaker ${mergeInto}.`);
    else {
      target.aliases = [...new Set([...target.aliases, character.name, ...character.aliases])];
      target.sourceEntityIds.push(...character.sourceEntityIds);
      target.sourceQuoteIds.push(...character.sourceQuoteIds);
      target.chapters = [...new Set([...target.chapters, ...character.chapters])].sort((a, b) => a - b);
      character.issues.push(`Merged into ${target.name}; retained as a review record until split/merge editing is finalized.`);
    }
  }
  return CharacterRegistrySchema.parse({
    version: 2,
    chapters: [...new Set(annotations.quotations.flatMap((quote) => quote.chapterIndex === null ? [] : [quote.chapterIndex]))].sort((a, b) => a - b),
    characters: candidates,
  });
}

function rankedLabels(labels: string[]): string[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const label of labels.map((value) => value.trim()).filter(Boolean)) {
    const normalized = key(label);
    const entry = counts.get(normalized) ?? { label, count: 0 };
    entry.count++;
    if (label.length > entry.label.length) entry.label = label;
    counts.set(normalized, entry);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || b.label.length - a.label.length).map((entry) => entry.label);
}

function reconciliationScore(candidate: CharacterRegistry['characters'][number], old: CharacterRegistry['characters'][number]): number {
  const quoteOverlap = candidate.sourceQuoteIds.filter((id) => old.sourceQuoteIds.includes(id)).length;
  const names = new Set([candidate.name, ...candidate.aliases].map(key));
  const nameOverlap = [old.name, ...old.aliases].filter((name) => names.has(key(name))).length;
  return quoteOverlap * 100 + nameOverlap;
}
