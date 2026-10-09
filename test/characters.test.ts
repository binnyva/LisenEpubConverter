import { describe, expect, it } from 'vitest';
import { CorrectionsSchema, type BookAnnotations, type CharacterRegistry } from '../src/types.js';
import { registryFromAnnotations } from '../src/pipeline/list-characters.js';

const provenance = { tool: 'booknlp' as const, toolVersion: '1.0.8', model: 'small' as const, pipeline: 'entity,quote,coref' as const, adapterVersion: '1', fingerprint: 'f' };

function annotations(): BookAnnotations {
  return {
    version: 1, source: { inputSha256: 'x', offsetConvention: 'unicode-code-points-half-open' }, provenance,
    mentions: [
      { entityId: 'booknlp:1', startToken: 0, endToken: 0, start: 0, end: 4, text: 'Alex', kind: 'proper', category: 'PER' },
      { entityId: 'booknlp:1', startToken: 1, endToken: 1, start: 5, end: 7, text: 'he', kind: 'pronoun', category: 'PER' },
      { entityId: 'booknlp:2', startToken: 2, endToken: 2, start: 8, end: 12, text: 'Alex', kind: 'proper', category: 'PER' },
      { entityId: 'booknlp:3', startToken: 3, endToken: 3, start: 13, end: 21, text: 'the ship', kind: 'common', category: 'VEH' },
      { entityId: 'booknlp:4', startToken: 4, endToken: 4, start: 22, end: 24, text: 'it', kind: 'pronoun', category: 'ORG' },
    ],
    quotations: [
      { id: 'q1', startToken: 5, endToken: 5, start: 25, end: 30, text: '“A.”', chapterIndex: 0, entityId: 'booknlp:1', mention: null, assignment: 'generated' },
      { id: 'q2', startToken: 6, endToken: 6, start: 31, end: 36, text: '“B.”', chapterIndex: 1, entityId: 'booknlp:2', mention: null, assignment: 'generated' },
      { id: 'q3', startToken: 7, endToken: 7, start: 37, end: 42, text: '“C.”', chapterIndex: 1, entityId: 'booknlp:3', mention: null, assignment: 'generated' },
      { id: 'q4', startToken: 8, endToken: 8, start: 43, end: 48, text: '“D.”', chapterIndex: 1, entityId: 'booknlp:4', mention: null, assignment: 'generated' },
    ],
  };
}

describe('BookNLP character registry', () => {
  it('keeps duplicate names distinct and includes minor, unnamed and nonhuman attributed speakers', () => {
    const registry = registryFromAnnotations(annotations());
    expect(registry.characters).toHaveLength(4);
    const alexes = registry.characters.filter((character) => character.name === 'Alex');
    expect(alexes).toHaveLength(2);
    expect(new Set(alexes.map((character) => character.id)).size).toBe(2);
    expect(registry.characters.find((character) => character.name === 'the ship')?.sourceEntityIds).toEqual(['booknlp:3']);
    expect(registry.characters.some((character) => character.name.startsWith('Unnamed speaker'))).toBe(true);
    expect(alexes[0].sex).toBe('unknown');
    expect(registry.characters.find((character) => character.sourceEntityIds.includes('booknlp:1'))?.inferredPronouns).toEqual(['he']);
  });

  it('does not add BookNLP narrator entity zero to the character registry', () => {
    const source = annotations();
    source.quotations.push({ id: 'q0', startToken: 9, endToken: 9, start: 49, end: 54, text: '“I.”', chapterIndex: 1, entityId: 'booknlp:0', mention: null, assignment: 'generated' });
    expect(registryFromAnnotations(source).characters.some((character) => character.sourceEntityIds.includes('booknlp:0'))).toBe(false);
  });

  it('reconciles by stable quote evidence and reapplies corrections when BookNLP ids change', () => {
    const first = registryFromAnnotations(annotations());
    const original = first.characters.find((character) => character.sourceQuoteIds.includes('q1'))!;
    const rerun = annotations();
    rerun.mentions = rerun.mentions.map((mention) => mention.entityId === 'booknlp:1' ? { ...mention, entityId: 'booknlp:99' } : mention);
    rerun.quotations = rerun.quotations.map((quote) => quote.id === 'q1' ? { ...quote, entityId: 'booknlp:99' } : quote);
    const corrections = CorrectionsSchema.parse({ version: 1, characters: { [original.id]: { name: 'Alex Prime', aliases: ['Captain Alex'], age: 'adult' } } });
    const next = registryFromAnnotations(rerun, first, corrections);
    const reconciled = next.characters.find((character) => character.sourceQuoteIds.includes('q1'))!;
    expect(reconciled.id).toBe(original.id);
    expect(reconciled).toMatchObject({ name: 'Alex Prime', aliases: ['Captain Alex'], age: 'adult' });
  });

  it('surfaces ambiguous reconciliation instead of guessing', () => {
    const current = annotations(); current.quotations[0].id = 'new';
    const base = { name: 'Alex', aliases: [], sex: 'unknown' as const, age: 'unknown', race: 'unknown', class: 'unknown', country: 'unknown', importance: 'minor' as const, chapters: [0], evidence: [], issues: [], sourceEntityIds: [], sourceQuoteIds: [], inferredPronouns: [] };
    const previous: CharacterRegistry = { version: 2, chapters: [0], characters: [{ ...base, id: 'a' }, { ...base, id: 'b' }] };
    const registry = registryFromAnnotations(current, previous);
    expect(registry.characters.find((character) => character.sourceQuoteIds.includes('new'))?.issues.join(' ')).toContain('Ambiguous reconciliation');
  });
});
