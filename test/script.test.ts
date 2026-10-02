import { describe, expect, it } from 'vitest';
import { filterNarratableSegments, findNarrationAuditCandidates, splitCharacterDialogueAndNarration, splitLeadingChapterTitle, splitTaggedNarratorDialogue, withChapterTitle } from '../src/pipeline/script.js';

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

  it('turns an opening Markdown heading into a paused narrator title cue', () => {
    const { title, content } = splitLeadingChapterTitle('# **VIEWFINDER**\n\nA man came to the door.');
    const segments = withChapterTitle([
      { speaker: 'narrator', text: 'A man came to the door.', confidence: 'high' },
    ], title);

    expect(content).toBe('A man came to the door.');
    expect(segments).toEqual([
      {
        speaker: 'narrator',
        text: '… VIEWFINDER …',
        delivery: 'Announce the chapter title clearly, with a brief pause before and after.',
        confidence: 'high',
      },
      { speaker: 'narrator', text: 'A man came to the door.', confidence: 'high' },
    ]);
  });

  it('does not duplicate a title that an existing script already contains', () => {
    const segments = withChapterTitle([
      { speaker: 'narrator', text: 'Viewfinder', confidence: 'high' },
      { speaker: 'narrator', text: 'A man came to the door.', confidence: 'high' },
    ], 'Viewfinder');

    expect(segments).toHaveLength(2);
    expect(segments[0].text).toBe('… Viewfinder …');
  });
});

describe('findNarrationAuditCandidates', () => {
  it('flags a character segment that mixes quoted dialogue with narration', () => {
    expect(findNarrationAuditCandidates([
      {
        speaker: 'Alexander Adell',
        text: '"It is amazing," said Adell. He stirred his drink. "Forever."',
        confidence: 'high',
      },
      { speaker: 'Alexander Adell', text: '"Only dialogue."', confidence: 'high' },
      { speaker: 'narrator', text: 'Adell stirred his drink.', confidence: 'high' },
    ])).toEqual([0]);
  });

  it('also flags a narrator segment with an explicit dialogue tag', () => {
    expect(findNarrationAuditCandidates([
      { speaker: 'narrator', text: '"It is amazing," said Adell. He stirred his drink.', confidence: 'high' },
    ])).toEqual([0]);
  });

  it('separates quoted character dialogue from a trailing dialogue tag', () => {
    expect(splitCharacterDialogueAndNarration({
      speaker: 'Bertram Lupov', text: '"Not forever," he said.', confidence: 'high',
    })).toEqual([
      { speaker: 'Bertram Lupov', text: '"Not forever,"', confidence: 'high' },
      { speaker: 'narrator', text: 'he said.', confidence: 'high' },
    ]);
  });

  it('recovers a quoted narrator segment when its tag names a unique character surname', () => {
    expect(splitTaggedNarratorDialogue({
      speaker: 'narrator', text: '"It is amazing," said Adell. He stirred his drink.', confidence: 'high',
    }, [{
      name: 'Alexander Adell', aliases: [], sex: 'male', age: 'unknown', race: 'unknown', class: 'unknown', country: 'unknown', importance: 'main',
    }])).toEqual([
      { speaker: 'Alexander Adell', text: '"It is amazing,"', confidence: 'high' },
      { speaker: 'narrator', text: 'said Adell. He stirred his drink.', confidence: 'high' },
    ]);
  });
});
