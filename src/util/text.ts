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

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
