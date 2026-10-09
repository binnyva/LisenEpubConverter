/**
 * Split text into blocks of at most maxChars, breaking at paragraph
 * boundaries (blank lines) where possible, falling back to sentence breaks.
 */
export function splitIntoBlocks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const paragraphs = text.split(/\n\s*\n/);
  const blocks: string[] = [];
  let current = '';
  for (const para of paragraphs) {
    const candidate = current ? current + '\n\n' + para : para;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) blocks.push(current);
    if (para.length <= maxChars) {
      current = para;
    } else {
      // A single huge paragraph: split at sentence boundaries.
      for (const piece of splitSentences(para, maxChars)) blocks.push(piece);
      current = '';
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

/**
 * Split text into pieces of at most maxChars, breaking at sentence
 * boundaries where possible, at word boundaries as a last resort.
 */
export function splitSentences(text: string, maxChars: number): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('maxChars must be a positive integer.');
  if (unicodeLength(text) <= maxChars) return [text];
  const sentences = sentenceSpans(text);
  const pieces: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (unicodeLength(current + sentence) <= maxChars) {
      current += sentence;
      continue;
    }
    if (current) pieces.push(current);
    if (unicodeLength(sentence) <= maxChars) {
      current = sentence;
    } else {
      const chunks = splitLongSpan(sentence, maxChars);
      pieces.push(...chunks.slice(0, -1));
      current = chunks.at(-1) ?? '';
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function sentenceSpans(text: string): string[] {
  const chars = [...text];
  const spans: string[] = [];
  let start = 0;
  for (let i = 0; i < chars.length; i++) {
    if (!'.!?…'.includes(chars[i])) continue;
    while (i + 1 < chars.length && '.!?…'.includes(chars[i + 1])) i++;
    while (i + 1 < chars.length && '"\'”’)]}'.includes(chars[i + 1])) i++;
    while (i + 1 < chars.length && /\s/u.test(chars[i + 1])) i++;
    spans.push(chars.slice(start, i + 1).join(''));
    start = i + 1;
  }
  if (start < chars.length) spans.push(chars.slice(start).join(''));
  return spans.length ? spans : [text];
}

function splitLongSpan(text: string, maxChars: number): string[] {
  const chars = [...text];
  const pieces: string[] = [];
  let start = 0;
  while (start < chars.length) {
    const hardEnd = Math.min(chars.length, start + maxChars);
    if (hardEnd === chars.length) { pieces.push(chars.slice(start).join('')); break; }
    let end = hardEnd;
    for (let i = hardEnd; i > start; i--) {
      if (/\s/u.test(chars[i - 1])) { end = i; break; }
    }
    // A single word can exceed the limit. A code-point boundary is the only
    // safe hard boundary; never emit an oversized request or split a surrogate.
    if (end === start) end = hardEnd;
    pieces.push(chars.slice(start, end).join(''));
    start = end;
  }
  return pieces;
}

function unicodeLength(text: string): number { return [...text].length; }

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Replace non-breaking Unicode space variants with ordinary ASCII spaces. */
export function normalizeNonBreakingSpaces(text: string): string {
  return text.replace(/[\u00a0\u2007\u202f]/g, ' ');
}

/**
 * Whether text contains something a narrator could say. Decorative EPUB
 * section dividers are often represented as runs of asterisks or dashes;
 * they should never become TTS segments.
 */
export function hasNarratableText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}
