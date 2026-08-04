import { describe, expect, it } from 'vitest';
import { splitIntoBlocks, splitSentences } from '../src/util/text.js';

describe('splitIntoBlocks', () => {
  it('returns short text unchanged', () => {
    expect(splitIntoBlocks('hello world', 100)).toEqual(['hello world']);
  });

  it('splits at paragraph boundaries and preserves all text', () => {
    const paras = Array.from({ length: 10 }, (_, i) => `Paragraph ${i} with some words in it.`);
    const text = paras.join('\n\n');
    const blocks = splitIntoBlocks(text, 100);
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) expect(block.length).toBeLessThanOrEqual(100);
    expect(blocks.join('\n\n')).toBe(text);
  });

  it('splits an oversized single paragraph at sentences', () => {
    const text = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} here.`).join(' ');
    const blocks = splitIntoBlocks(text, 80);
    for (const block of blocks) expect(block.length).toBeLessThanOrEqual(80);
    expect(blocks.join(' ').replace(/\s+/g, ' ')).toBe(text);
  });
});

describe('splitSentences', () => {
  it('keeps short text intact', () => {
    expect(splitSentences('One. Two.', 100)).toEqual(['One. Two.']);
  });

  it('never exceeds the limit', () => {
    const text = 'A'.repeat(50) + ' ' + 'B'.repeat(50) + ' ' + 'C'.repeat(50);
    for (const piece of splitSentences(text, 60)) {
      expect(piece.length).toBeLessThanOrEqual(60);
    }
  });

  it('preserves all words', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Word${i} is here.`).join(' ');
    const pieces = splitSentences(text, 50);
    const rejoined = pieces.join(' ').replace(/\s+/g, ' ').trim();
    expect(rejoined).toBe(text);
  });
});
