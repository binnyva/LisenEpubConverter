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
  if (text.length <= maxChars) return [text];
  const sentences = text.match(/[^.!?…]+[.!?…]+["'”’]?\s*|[^.!?…]+$/g) ?? [text];
  const pieces: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if ((current + sentence).length <= maxChars) {
      current += sentence;
      continue;
    }
    if (current) pieces.push(current.trim());
    if (sentence.length <= maxChars) {
      current = sentence;
    } else {
      // Sentence longer than the limit: hard-split at word boundaries.
      const words = sentence.split(/\s+/);
      let chunk = '';
      for (const word of words) {
        if ((chunk + ' ' + word).length > maxChars && chunk) {
          pieces.push(chunk.trim());
          chunk = word;
        } else {
          chunk = chunk ? chunk + ' ' + word : word;
        }
      }
      current = chunk;
    }
  }
  if (current.trim()) pieces.push(current.trim());
  return pieces;
}

/**
 * Shorten a long summary for use as prompt context. A chapter summary is the
 * concatenation of one summary per block, so a long chapter's summary can be
 * larger than the text it is sent alongside. Keep whole sentences from the
 * start and the end: the opening sets the scene, the ending is what the next
 * text follows on from.
 */
export function condenseSummary(summary: string, maxChars: number): string {
  const text = summary.replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  const sentences = text.match(/[^.!?…]+[.!?…]+["'”’]?\s*|[^.!?…]+$/g) ?? [text];
  const half = Math.floor(maxChars / 2);
  let head = '';
  let used = 0;
  while (used < sentences.length && (head + sentences[used]).length <= half) head += sentences[used++];
  let tail = '';
  let last = sentences.length - 1;
  while (last >= used && (sentences[last] + tail).length <= half) tail = sentences[last--] + tail;
  // One sentence longer than the budget: fall back to a plain cut.
  if (!head && !tail) return `${text.slice(0, maxChars).trimEnd()} …`;
  return [head.trim(), tail.trim()].filter(Boolean).join(' … ');
}

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

/**
 * Whether a paragraph is a scene-break divider: not empty, but with nothing a
 * narrator could say ("• • •", "* * *", "———"). EPUBs mark a change of scene
 * this way, and in audio the divider is the only thing that marks it, so it is
 * kept through cleanup and turned into a pause before synthesis.
 */
export function isSceneBreak(paragraph: string): boolean {
  const trimmed = paragraph.trim();
  return trimmed !== '' && !hasNarratableText(trimmed);
}

/** Split markdown into paragraphs, dropping empty ones and keeping scene breaks. */
export function paragraphsOf(text: string): string[] {
  return text.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
}
