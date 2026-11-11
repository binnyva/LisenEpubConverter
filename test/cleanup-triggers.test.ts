import { describe, expect, it } from 'vitest';
import { cleanupTriggers } from '../src/pipeline/cleanup-triggers.js';

describe('cleanupTriggers', () => {
  it.each([
    ['Half of all women.12 That was the finding.', 'digits attached to a word'],
    ['The figure doubled12 within a year.', 'digits attached to a word'],
    ['As shown earlier [12], the effect holds.', 'bracketed number'],
    ['As shown earlier \\[3\\], the effect holds.', 'bracketed number'],
    ['The effect holds.[^4]', 'bracketed number'],
    ['The effect holds².', 'bracketed number'],
    ['Fruit, e.g. apples, keeps well.', 'abbreviation'],
    ['Bread, milk, etc. were scarce.', 'abbreviation'],
    ['See p. 42 and vol. 2 for details.', 'abbreviation'],
    ['They walked 5 km before noon.', 'unit'],
    ['It weighed 12kg.', 'unit'],
    ['Water boils at 100°C.', 'unusual symbol'],
    ['Section § 4 applies.', 'unusual symbol'],
    ['Write to info@example.org or see https://example.org.', 'unusual symbol'],
  ])('flags %j as %s', (text, trigger) => {
    expect(cleanupTriggers(text)).toContain(trigger);
  });

  it.each([
    'It was the best of times, it was the worst of times.',
    'In 1984 she turned 30, and he said no. Then nothing.',
    'Mr. Smith arrived at 5:30 with 3.14 reasons and $20.',
    'She paid 50% more for the *second* edition (1999).',
    '# Chapter 3\n\nThe 1990s were over by page 12.',
    `He was 6' 2" and didn't care — not at all…`,
  ])('lets clean prose through: %j', (text) => {
    expect(cleanupTriggers(text)).toEqual([]);
  });
});
