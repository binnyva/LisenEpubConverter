import { hasNarratableText } from '../util/text.js';

export interface CleanupEdit {
  find: string;
  replace: string;
}

export interface CleanupResult {
  text: string;
  applied: number;
  /** Edits left out, with a reason a person can act on. */
  skipped: Array<{ find: string; reason: string }>;
}

/** An edit is a small correction, not a rewrite: these bound what one can change. */
const MAX_FIND_CHARS = 300;
const MAX_REMOVED_CHARS = 120;
const MAX_ADDED_CHARS = 200;

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Match a model's quotation of the text even when it has "normalised" what it
 * copied: straight for curly quotes, three dots for an ellipsis, one space for
 * a line break. A find that starts or ends with a letter or digit must also
 * start or end a word, so "km" never matches inside another word.
 */
function findPattern(find: string): RegExp {
  let pattern = '';
  for (const part of find.split(/(\s+|\.\.\.|…|['‘’ʼ]|["“”])/u)) {
    if (!part) continue;
    if (/^\s+$/u.test(part)) pattern += '\\s+';
    else if (part === '...' || part === '…') pattern += '(?:…|\\.\\.\\.)';
    else if (/^['‘’ʼ]$/u.test(part)) pattern += "['‘’ʼ]";
    else if (/^["“”]$/u.test(part)) pattern += '["“”]';
    else pattern += escapeRegExp(part);
  }
  const first = [...find][0] ?? '';
  const last = [...find].at(-1) ?? '';
  return new RegExp(
    `${LETTER_OR_DIGIT.test(first) ? '(?<![\\p{L}\\p{N}])' : ''}${pattern}${LETTER_OR_DIGIT.test(last) ? '(?![\\p{L}\\p{N}])' : ''}`,
    'gu',
  );
}

/**
 * Apply a model's cleanup edits to the source text. The text itself is never
 * regenerated, so the model cannot paraphrase, drop, or reorder prose: an edit
 * that does not quote the text, or that would remove or add more than a small
 * correction can, is skipped and reported instead of applied.
 */
export function applyCleanupEdits(source: string, edits: CleanupEdit[]): CleanupResult {
  let text = source;
  let applied = 0;
  const skipped: CleanupResult['skipped'] = [];
  for (const { find, replace } of edits) {
    const skip = (reason: string): void => { skipped.push({ find, reason }); };
    if (!find.trim()) { skip('empty quotation'); continue; }
    if (find === replace) continue;
    if (find.length > MAX_FIND_CHARS) { skip('quotes too much text for one correction'); continue; }
    if (find.length - replace.length > MAX_REMOVED_CHARS) { skip('would remove too much text'); continue; }
    if (replace.length - find.length > MAX_ADDED_CHARS) { skip('would add too much text'); continue; }

    const pattern = findPattern(find);
    const matches = text.match(pattern)?.length ?? 0;
    if (!matches) { skip('not found in the text'); continue; }
    // A bare footnote number also matches every real number that looks the same.
    if (matches > 1 && /\p{N}/u.test(find) && !/\p{L}/u.test(find)) {
      skip('a number that occurs more than once; it needs a neighbouring word');
      continue;
    }
    text = text.replace(pattern, () => replace);
    applied += 1;
  }
  return { text, applied, skipped };
}

/** Drop decorative dividers ("* * *", "———"): they are layout, not narration. */
export function dropLayoutOnlyParagraphs(text: string): string {
  return text
    .split(/\n\s*\n/)
    .filter((paragraph) => hasNarratableText(paragraph))
    .join('\n\n');
}
