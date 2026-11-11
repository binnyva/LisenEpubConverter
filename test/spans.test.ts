import { describe, expect, it } from 'vitest';
import { formatSpans, quotedRanges, spansToSegments, splitSpans, type LabelledSpan } from '../src/pipeline/spans.js';

const shape = (text: string) => splitSpans(text).map((span) => [span.kind, span.text]);

describe('splitSpans', () => {
  it('splits the first Asimov example into narration, quotes and the tag between them', () => {
    const text = `Lupov cocked his head sideways. He had a trick of doing that when he wanted to be contrary, and he wanted to be contrary now, partly because he had had to carry the ice and glassware. "Not forever," he said.

"Oh, hell, just about forever. Till the sun runs down, Bert. Ten billion, maybe. Are you satisfied?"

Lupov put his fingers through his thinning hair as though to reassure himself that some was still left and sipped gently at his own drink. "Ten billion years isn't forever."

"Well, it will last our time, won't it?"`;

    expect(shape(text)).toEqual([
      ['narration', 'Lupov cocked his head sideways. He had a trick of doing that when he wanted to be contrary, and he wanted to be contrary now, partly because he had had to carry the ice and glassware.'],
      ['quote', '"Not forever,"'],
      ['narration', 'he said.'],
      ['quote', '"Oh, hell, just about forever. Till the sun runs down, Bert. Ten billion, maybe. Are you satisfied?"'],
      ['narration', 'Lupov put his fingers through his thinning hair as though to reassure himself that some was still left and sipped gently at his own drink.'],
      ['quote', '"Ten billion years isn\'t forever."'],
      ['quote', '"Well, it will last our time, won\'t it?"'],
    ]);
    expect(splitSpans(text).map((span) => span.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(splitSpans(text).map((span) => span.paragraph)).toEqual([0, 0, 0, 1, 2, 2, 3]);
  });

  it('splits the second Asimov example: a quote, its tag, and the rest of the quote', () => {
    const text = `Jerrodine's eyes were moist as she watched the visiplate. "I can't help it. I feel funny about leaving Earth."

"Why, for Pete's sake?" demanded Jerrodd. "We had nothing there." Then, after a reflective pause, "I tell you, it's a lucky thing the computers worked out interstellar travel the way the race is growing."

"I know, I know," said Jerrodine miserably.`;

    expect(shape(text)).toEqual([
      ['narration', "Jerrodine's eyes were moist as she watched the visiplate."],
      ['quote', '"I can\'t help it. I feel funny about leaving Earth."'],
      ['quote', '"Why, for Pete\'s sake?"'],
      ['narration', 'demanded Jerrodd.'],
      ['quote', '"We had nothing there."'],
      ['narration', 'Then, after a reflective pause,'],
      ['quote', '"I tell you, it\'s a lucky thing the computers worked out interstellar travel the way the race is growing."'],
      ['quote', '"I know, I know,"'],
      ['narration', 'said Jerrodine miserably.'],
    ]);
  });

  it('pairs curly quotes the same way', () => {
    expect(shape('“Stop,” she said. “Now.”')).toEqual([
      ['quote', '“Stop,”'], ['narration', 'she said.'], ['quote', '“Now.”'],
    ]);
  });

  it('runs an unclosed quote to the end of its paragraph and starts the next paragraph clean', () => {
    expect(shape('He looked up. "I never meant\n\nShe waited for him to finish.')).toEqual([
      ['narration', 'He looked up.'], ['quote', '"I never meant'], ['narration', 'She waited for him to finish.'],
    ]);
  });

  it('treats a speech continuing over paragraphs as one quote per paragraph', () => {
    expect(shape('“It began in winter.\n\n“We had no coal, and less hope.\n\n“Then the letter came,” he said.')).toEqual([
      ['quote', '“It began in winter.'],
      ['quote', '“We had no coal, and less hope.'],
      ['quote', '“Then the letter came,”'],
      ['narration', 'he said.'],
    ]);
  });

  it('ends a quote at a second opening mark when its closing mark is missing', () => {
    expect(shape('“Hello, said Tom. “Goodbye.”')).toEqual([['quote', '“Hello, said Tom.'], ['quote', '“Goodbye.”']]);
    expect(shape('"Hello, said Tom. "Goodbye."')).toEqual([['quote', '"Hello, said Tom.'], ['quote', '"Goodbye."']]);
  });

  it('keeps a quote within a quote, and apostrophes, inside the outer span', () => {
    expect(shape(`"He told me, 'Run,' and I didn't wait," she said.`)).toEqual([
      ['quote', `"He told me, 'Run,' and I didn't wait,"`], ['narration', 'she said.'],
    ]);
    expect(shape('“He told me, ‘Run,’ and I ran,” she said.')).toEqual([
      ['quote', '“He told me, ‘Run,’ and I ran,”'], ['narration', 'she said.'],
    ]);
  });

  it('does not open a quote at an inch mark or a stray closing mark', () => {
    expect(shape(`He was 6' 2" tall and said nothing.`)).toEqual([['narration', `He was 6' 2" tall and said nothing.`]]);
    expect(shape('She left.” Nobody followed.')).toEqual([['narration', 'She left.” Nobody followed.']]);
  });

  it('keeps stray punctuation with a neighbouring span instead of losing it', () => {
    const spans = splitSpans('The so-called "expert". Nobody laughed.');
    expect(spans.map((span) => [span.kind, span.text, span.joiner])).toEqual([
      ['narration', 'The so-called', ''], ['quote', '"expert"', ' '], ['narration', '. Nobody laughed.', ''],
    ]);
  });

  it('drops an emphasis marker left dangling by the cut', () => {
    expect(shape('*"Hello," he said.*')).toEqual([['quote', '"Hello,"'], ['narration', 'he said.']]);
  });

  it('makes each paragraph one narration span when quotes are not split', () => {
    expect(splitSpans('He said "no" twice.\n\nThen he left.', false).map((span) => [span.kind, span.text])).toEqual([
      ['narration', 'He said "no" twice.'], ['narration', 'Then he left.'],
    ]);
  });
});

describe('quotedRanges', () => {
  it('returns inclusive ranges', () => {
    expect(quotedRanges('A "b" c')).toEqual([[2, 4]]);
  });
});

describe('formatSpans', () => {
  it('numbers every span, marks quotes, and separates paragraphs', () => {
    expect(formatSpans(splitSpans('"Hi," said Tom.\n\nHe left.'))).toBe('[1 QUOTE] "Hi,"\n[2] said Tom.\n\n[3] He left.');
  });
});

describe('spansToSegments', () => {
  const label = (text: string, speakers: Record<number, string>, low: number[] = []): LabelledSpan[] =>
    splitSpans(text).map((span) => ({
      span, text: span.text, speaker: span.kind === 'quote' ? speakers[span.id] ?? 'narrator' : 'narrator',
      confidence: low.includes(span.id) ? 'low' : 'high',
    }));

  it('keeps one segment per line of speech and joins narration across paragraphs', () => {
    const segments = spansToSegments(label('The door opened.\n\nRain came in. "Shut it," said Ann. Nobody moved.\n\nThe clock ticked.', { 3: 'Ann' }), 1500);
    expect(segments).toEqual([
      { speaker: 'narrator', text: 'The door opened.\n\nRain came in.', confidence: 'high' },
      { speaker: 'Ann', text: '"Shut it,"', confidence: 'high' },
      { speaker: 'narrator', text: 'said Ann. Nobody moved.\n\nThe clock ticked.', confidence: 'high' },
    ]);
  });

  it('puts a quoted phrase the narrator keeps back into its sentence exactly', () => {
    expect(spansToSegments(label('He read "War and Peace" twice, the so-called "classic".', {}), 1500)).toEqual([
      { speaker: 'narrator', text: 'He read "War and Peace" twice, the so-called "classic".', confidence: 'high' },
    ]);
  });

  it('starts a new narration segment at the size limit and never merges an uncertain label', () => {
    expect(spansToSegments(label('One two three.\n\nFour five six.', {}), 20).map((segment) => segment.text)).toEqual(['One two three.', 'Four five six.']);
    const uncertain = spansToSegments(label('He said "maybe" again.', {}, [2]), 1500);
    expect(uncertain.map((segment) => [segment.text, segment.confidence])).toEqual([['He said', 'high'], ['"maybe"', 'low'], ['again.', 'high']]);
  });
});
