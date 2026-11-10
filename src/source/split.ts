import { countWords, hasNarratableText } from '../util/text.js';

/**
 * How good a place the start of a paragraph is to begin a new part:
 * 3 = a heading or section label, 2 = a scene-break divider, 1 = an ordinary
 * paragraph, 0.5 = a line of dialogue (a cut there separates a reply from the
 * exchange that tells a reader who is speaking).
 */
function boundaryRank(paragraph: string): number {
  const text = paragraph.trim();
  if (/^#{1,6}\s/.test(text)) return 3;
  if (!text.includes('\n') && text.length <= 40) {
    // Scene breaks are lines of symbols only: "* * *", "—", "• • •".
    if (!hasNarratableText(text)) return 2;
    const emphasised = text.match(/^(\*{1,3}|_{1,3})(.+)\1$/);
    // Section markers set in bold: a number such as "***2a***" or a capitalised
    // word such as "**NOTE**". An emphasised line of dialogue is not one.
    const marker = emphasised?.[2].trim() ?? '';
    if (/^[\p{L}\p{N}]{1,12}$/u.test(marker) && (/\p{N}/u.test(marker) || marker === marker.toUpperCase())) return 3;
    if (/^(chapter|part|book|section)\s+[\p{L}\p{N}]+\.?$/iu.test((emphasised?.[2] ?? text).trim())) return 3;
  }
  return /^[*_]*["“‘'«]/.test(text) ? 0.5 : 1;
}

/**
 * Split one oversized chapter into parts of roughly `targetWords`. Some
 * sources ship a whole "Part" of a novel, or a whole book, as one document;
 * every later stage then treats 20,000 words as a single unit of work, retry,
 * and review. Cuts are made only between paragraphs, never inside one, and
 * prefer a heading or section label, then a scene break, near each ideal cut.
 * Joining the parts with a blank line gives back the original paragraphs.
 */
export function splitOversizedChapter(markdown: string, maxWords: number, targetWords: number): string[] {
  const paragraphs = markdown.split(/\n\s*\n/).filter((paragraph) => paragraph.trim());
  const words = paragraphs.map(countWords);
  const total = words.reduce((sum, count) => sum + count, 0);
  if (total <= maxWords || paragraphs.length < 2) return [markdown];

  // wordsBefore[i] is the size of everything ahead of a cut placed before paragraph i.
  const wordsBefore: number[] = [0];
  for (const count of words) wordsBefore.push(wordsBefore[wordsBefore.length - 1] + count);
  const ranks = paragraphs.map(boundaryRank);
  // A label followed by its own epigraph or a second label stays with it.
  const rankAt = (i: number): number => (ranks[i - 1] > 1 ? 0 : ranks[i]);

  const partCount = Math.ceil(total / targetWords);
  const ideal = total / partCount;
  // A real break in the text is worth a more uneven split than a plain paragraph is.
  const window = (rank: number): number => ideal * (rank >= 2 ? 0.5 : 0.3);
  const cuts: number[] = [];
  for (let k = 1; k < partCount; k++) {
    const target = k * ideal;
    const from = (cuts.at(-1) ?? 0) + 1;
    let best: number | undefined;
    let nearest: number | undefined;
    for (let i = from; i < paragraphs.length; i++) {
      const distance = Math.abs(wordsBefore[i] - target);
      if (nearest === undefined || distance < Math.abs(wordsBefore[nearest] - target)) nearest = i;
      if (distance > window(rankAt(i))) continue;
      if (best === undefined || rankAt(i) > rankAt(best)
        || (rankAt(i) === rankAt(best) && distance < Math.abs(wordsBefore[best] - target))) best = i;
    }
    // Very long paragraphs can leave nothing inside the window.
    const cut = best ?? nearest;
    if (cut !== undefined) cuts.push(cut);
  }

  const parts: string[] = [];
  let start = 0;
  for (const cut of [...cuts, paragraphs.length]) {
    if (cut > start) parts.push(paragraphs.slice(start, cut).join('\n\n'));
    start = cut;
  }
  return parts.length > 1 ? parts : [markdown];
}
