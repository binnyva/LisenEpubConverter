import { describe, expect, it } from 'vitest';
import { applyCleanupEdits, applySpanEdits, dropEmptyParagraphs } from '../src/pipeline/cleanup.js';

describe('applyCleanupEdits', () => {
  it('replaces every occurrence and leaves the rest of the text untouched', () => {
    const source = 'It rained, i.e. it poured. We stayed in, i.e. we read.';
    const result = applyCleanupEdits(source, [{ find: 'i.e.', replace: 'that is' }]);

    expect(result).toEqual({ text: 'It rained, that is it poured. We stayed in, that is we read.', applied: 1, skipped: [] });
  });

  it('matches a quotation whose quotes, ellipsis or spacing the model normalised', () => {
    const source = '“Don’t go…” she said.12\nHe left.';
    const result = applyCleanupEdits(source, [{ find: `"Don't go..." she said.12 He left.`, replace: '“Don’t go…” she said.\nHe left.' }]);

    expect(result.text).toBe('“Don’t go…” she said.\nHe left.');
    expect(result.skipped).toEqual([]);
  });

  it('only matches whole words', () => {
    const result = applyCleanupEdits('Akmal ran 5 km to the km marker.', [{ find: 'km', replace: 'kilometres' }]);

    expect(result.text).toBe('Akmal ran 5 kilometres to the kilometres marker.');
  });

  it('skips an edit that does not quote the text', () => {
    const result = applyCleanupEdits('The cat sat.', [{ find: 'The dog sat.', replace: 'The dog stood.' }]);

    expect(result.text).toBe('The cat sat.');
    expect(result.skipped).toEqual([{ find: 'The dog sat.', reason: 'not found in the text' }]);
  });

  it('skips a bare number that would also delete real numbers', () => {
    const source = 'In 12 countries, women earn less.12';

    expect(applyCleanupEdits(source, [{ find: '12', replace: '' }]).text).toBe(source);
    expect(applyCleanupEdits(source, [{ find: 'less.12', replace: 'less.' }]).text).toBe('In 12 countries, women earn less.');
  });

  it('refuses to delete or rewrite a passage', () => {
    const passage = `${'A long sentence that the model would rather not read aloud. '.repeat(4)}End.`;
    const source = `Before. ${passage} After.`;

    expect(applyCleanupEdits(source, [{ find: passage, replace: '' }])).toMatchObject({ text: source, applied: 0 });
    expect(applyCleanupEdits(source, [{ find: 'Before.', replace: 'x'.repeat(400) }])).toMatchObject({ text: source, applied: 0 });
    expect(applyCleanupEdits(source, [{ find: `${passage} ${passage}`, replace: passage }]).skipped[0].reason).toContain('too much');
  });

  it('treats a replacement literally', () => {
    expect(applyCleanupEdits('Cost: 5 USD.', [{ find: '5 USD', replace: '$5 & $&' }]).text).toBe('Cost: $5 & $&.');
  });
});

describe('dropEmptyParagraphs', () => {
  it('keeps scene-break dividers alongside prose and headings', () => {
    expect(dropEmptyParagraphs('# One\n\nFirst.\n\n• • •\n\n   \n\nSecond.'))
      .toBe('# One\n\nFirst.\n\n• • •\n\nSecond.');
  });
});

describe('applySpanEdits', () => {
  it('applies an edit inside the span it quotes and leaves the others untouched', () => {
    const result = applySpanEdits(['They walked 5 km', '"Only 5 km?"', 'she asked.'], [{ find: '5 km', replace: '5 kilometres' }]);
    expect(result.texts).toEqual(['They walked 5 kilometres', '"Only 5 kilometres?"', 'she asked.']);
    expect(result.applied).toBe(1);
    expect(result.skipped).toEqual([]);
  });

  it('skips an edit whose quotation only exists across two spans', () => {
    const result = applySpanEdits(['"Stop,"', 'said Tom.12'], [
      { find: '," said', replace: ', said' },
      { find: 'Tom.12', replace: 'Tom.' },
    ]);
    expect(result.texts).toEqual(['"Stop,"', 'said Tom.']);
    expect(result.skipped).toEqual([{ find: '," said', reason: 'crosses a span boundary' }]);
  });

  it('counts a bare number across every span before deleting it', () => {
    const result = applySpanEdits(['In 12 days', 'he counted 12 ships.'], [{ find: '12', replace: '' }]);
    expect(result.texts).toEqual(['In 12 days', 'he counted 12 ships.']);
    expect(result.skipped[0].reason).toContain('more than once');
  });

  it('keeps the size guards', () => {
    const long = 'word '.repeat(40).trim();
    expect(applySpanEdits([long], [{ find: long, replace: 'gone' }]).skipped[0].reason).toBe('would remove too much text');
  });
});
