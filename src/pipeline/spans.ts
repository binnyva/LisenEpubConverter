import type { ScriptSegment } from '../types.js';
import { hasNarratableText, paragraphsOf } from '../util/text.js';

/**
 * One numbered piece of a passage: narration, or text inside double quotation
 * marks. '"Hello," said Tom. "Goodbye."' is three spans — a quote, its tag, and
 * the rest of the quote — so a model only has to say who speaks each quote.
 */
export interface Span {
  /** 1-based position in the passage. */
  id: number;
  kind: 'narration' | 'quote';
  text: string;
  /** Paragraph of the passage the span came from, 0-based. */
  paragraph: number;
  /** What separated it from the previous span of the same paragraph. */
  joiner: '' | ' ';
}

const OPENERS = new Set([undefined, '(', '[', '{', '—', '–', '-', '‘', "'", '*', '_']);

/**
 * Inclusive [start, end] ranges of quoted text in one paragraph.
 *
 * - Curly and straight double quotes are both paired; a straight mark is read
 *   as opening or closing from the characters around it, so an inch mark
 *   (6' 2") does not open a quote.
 * - A quote still open at the end of the paragraph runs to its end. That is
 *   how books print speech continuing over several paragraphs: each opens with
 *   a mark and only the last one closes.
 * - A second opening mark while a quote is open means the first was never
 *   closed; the first ends there.
 * - Single quotes are never delimiters, so a quote within a quote stays inside
 *   its outer span and apostrophes are harmless.
 */
export function quotedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let opening: number | undefined;
  let style: 'straight' | 'curly' | undefined;
  const open = (at: number, kind: 'straight' | 'curly'): void => {
    opening = at;
    style = kind;
  };
  const close = (end: number): void => {
    if (opening !== undefined && end >= opening) ranges.push([opening, end]);
    opening = undefined;
    style = undefined;
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '“') {
      if (opening === undefined) open(i, 'curly');
      else if (style === 'curly') {
        close(i - 1);
        open(i, 'curly');
      }
    } else if (char === '”') {
      if (opening !== undefined && style === 'curly') close(i);
    } else if (char === '"') {
      const previous = text[i - 1];
      const next = text[i + 1];
      const canOpen = next !== undefined && !/\s/.test(next) && (OPENERS.has(previous) || /\s/.test(previous!));
      const canClose = previous !== undefined && !/\s/.test(previous);
      if (opening === undefined) {
        if (canOpen) open(i, 'straight');
      } else if (style === 'straight') {
        if (canOpen && !canClose) {
          close(i - 1);
          open(i, 'straight');
        } else {
          close(i);
        }
      }
    }
  }
  if (opening !== undefined) close(text.length - 1);
  return ranges;
}

/**
 * Cutting a paragraph at its quotation marks can separate an emphasis marker
 * from its partner (*"Hello," he said.*). A lone marker would be read aloud,
 * so one left dangling at the edge of a span is dropped.
 */
function withoutDanglingEmphasis(text: string): string {
  let result = text;
  for (const marker of ['*', '_']) {
    const runs = result.match(marker === '*' ? /\*+/g : /_+/g) ?? [];
    if (runs.length % 2 === 0) continue;
    if (result.startsWith(marker)) result = result.slice(runs[0]!.length).trimStart();
    else if (result.endsWith(marker)) result = result.slice(0, -runs.at(-1)!.length).trimEnd();
  }
  return result;
}

function paragraphSpans(paragraph: string, paragraphIndex: number, quoted: boolean): Array<Omit<Span, 'id'>> {
  const pieces: Array<{ kind: Span['kind']; raw: string }> = [];
  let cursor = 0;
  for (const [start, end] of quoted ? quotedRanges(paragraph) : []) {
    if (start > cursor) pieces.push({ kind: 'narration', raw: paragraph.slice(cursor, start) });
    pieces.push({ kind: 'quote', raw: paragraph.slice(start, end + 1) });
    cursor = end + 1;
  }
  if (cursor < paragraph.length) pieces.push({ kind: 'narration', raw: paragraph.slice(cursor) });

  // Stray punctuation between spans is kept, attached to a neighbour, so the
  // spans together still hold every character of the paragraph.
  const folded: typeof pieces = [];
  let prefix = '';
  for (const piece of pieces) {
    if (hasNarratableText(piece.raw)) {
      folded.push({ kind: piece.kind, raw: prefix + piece.raw });
      prefix = '';
    } else if (folded.length) {
      folded.at(-1)!.raw += piece.raw;
    } else {
      prefix += piece.raw;
    }
  }
  return folded.map((piece, position) => ({
    kind: piece.kind,
    text: withoutDanglingEmphasis(piece.raw.trim()),
    paragraph: paragraphIndex,
    joiner: position > 0 && (/\s$/.test(folded[position - 1].raw) || /^\s/.test(piece.raw)) ? ' ' as const : '' as const,
  })).filter((span) => hasNarratableText(span.text));
}

/**
 * Split a passage into numbered spans. With `quoted` false every paragraph is
 * one narration span, which is all non-fiction needs.
 */
export function splitSpans(text: string, quoted = true): Span[] {
  return paragraphsOf(text)
    .flatMap((paragraph, index) => paragraphSpans(paragraph, index, quoted))
    .map((span, position) => ({ id: position + 1, ...span }));
}

/** Whether text carries any double quotation mark at all. */
export function hasQuotationMarks(text: string): boolean {
  return /["“”]/.test(text);
}

/** The passage as a model sees it: one span per line, paragraphs apart, quotes marked. */
export function formatSpans(spans: Span[]): string {
  return spans
    .map((span, position) => `${position > 0 && spans[position - 1].paragraph !== span.paragraph ? '\n' : ''}[${span.id}${span.kind === 'quote' ? ' QUOTE' : ''}] ${span.text}`)
    .join('\n');
}

/** A span with its speaker decided, before narration is joined into segments. */
export interface LabelledSpan {
  span: Span;
  text: string;
  speaker: string;
  confidence: 'high' | 'low';
  delivery?: string;
}

/**
 * Turn labelled spans into script segments. Speech stays one segment per
 * quote. Narration — including a quoted title or phrase the model handed back
 * to the narrator — is joined into segments of at most `maxChars`, so the
 * narrator reads in paragraphs rather than fragments.
 */
export function spansToSegments(labelled: LabelledSpan[], maxChars: number): ScriptSegment[] {
  const segments: ScriptSegment[] = [];
  let open: { text: string; paragraph: number } | undefined;
  for (const item of labelled) {
    if (!hasNarratableText(item.text)) continue;
    const plainNarration = item.speaker === 'narrator' && item.confidence === 'high' && !item.delivery;
    if (!plainNarration) {
      open = undefined;
      segments.push({ speaker: item.speaker, text: item.text, confidence: item.confidence, ...(item.delivery ? { delivery: item.delivery } : {}) });
      continue;
    }
    const joiner = open && open.paragraph === item.span.paragraph ? item.span.joiner : '\n\n';
    if (open && open.text.length + joiner.length + item.text.length <= maxChars) {
      open.text += joiner + item.text;
      open.paragraph = item.span.paragraph;
      segments.at(-1)!.text = open.text;
    } else {
      open = { text: item.text, paragraph: item.span.paragraph };
      segments.push({ speaker: 'narrator', text: item.text, confidence: 'high' });
    }
  }
  return segments;
}
