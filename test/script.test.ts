import { describe, expect, it } from 'vitest';
import { filterNarratableSegments } from '../src/pipeline/script.js';

describe('filterNarratableSegments', () => {
  it('removes decorative asterisk section dividers', () => {
    const segments = filterNarratableSegments([
      { speaker: 'narrator', text: 'The chapter continues.', confidence: 'high' },
      { speaker: 'narrator', text: '* * * * * * *  \n    * * * * * * *', confidence: 'high' },
    ]);

    expect(segments).toEqual([
      { speaker: 'narrator', text: 'The chapter continues.', confidence: 'high' },
    ]);
  });

  it('retains non-ASCII prose', () => {
    const segments = filterNarratableSegments([
      { speaker: 'narrator', text: '“Olá, mundo.”', confidence: 'high' },
    ]);

    expect(segments).toHaveLength(1);
  });

  it('normalizes non-breaking spaces in saved script text', () => {
    const segments = filterNarratableSegments([
      { speaker: 'narrator', text: 'One\u00a0two', confidence: 'high' },
    ]);

    expect(segments[0].text).toBe('One two');
  });
});
