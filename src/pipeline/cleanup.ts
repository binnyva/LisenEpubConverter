import { isSceneBreak, paragraphsOf } from '../util/text.js';

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

/**
 * Drop paragraphs that hold nothing at all. Decorative dividers ("• • •",
 * "* * *") are deliberately kept: they are layout in print, but in audio they
 * are the only sign of a scene break, and Script turns each one into a pause.
 */
export function dropEmptyParagraphs(text: string): string {
  return paragraphsOf(text).join('\n\n');
}

/** Letters and digits only, so a small cleanup edit does not move an anchor. */
function signature(text: string): string {
  return text.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();
}

const ANCHOR_CHARS = 60;

/** The one cleaned paragraph that matches an anchor, or -1 when it is ambiguous. */
function soleMatch(signatures: string[], anchor: string, at: 'start' | 'end'): number {
  const matches = signatures
    .map((candidate, position) => ({ candidate, position }))
    .filter(({ candidate }) => (at === 'start' ? candidate.startsWith(anchor) : candidate.endsWith(anchor)));
  return matches.length === 1 ? matches[0].position : -1;
}

/**
 * Put scene breaks back into a chapter that was cleaned before they were kept,
 * without paying to clean it again. Each divider is anchored on the paragraph
 * before it, or on the one after it when the divider opens the chapter; an
 * anchor that no longer matches exactly one cleaned paragraph is reported
 * instead of guessed at, since a misplaced pause is worse than a missing one.
 */
export function restoreSceneBreaks(raw: string, cleaned: string): { text: string; restored: number; missed: number } {
  const rawParagraphs = paragraphsOf(raw);
  const cleanedParagraphs = paragraphsOf(cleaned);
  // A chapter cleaned after this change already carries every divider.
  if (!rawParagraphs.some(isSceneBreak) || cleanedParagraphs.some(isSceneBreak)) {
    return { text: cleaned, restored: 0, missed: 0 };
  }

  const signatures = cleanedParagraphs.map(signature);
  // Dividers to insert before the cleaned paragraph at each position.
  const before = new Map<number, string[]>();
  let missed = 0;
  for (const [index, paragraph] of rawParagraphs.entries()) {
    if (!isSceneBreak(paragraph)) continue;

    const previous = rawParagraphs.slice(0, index).reverse().find((candidate) => !isSceneBreak(candidate));
    const next = rawParagraphs.slice(index + 1).find((candidate) => !isSceneBreak(candidate));
    let position = -1;
    if (previous) {
      const anchor = signature(previous);
      const found = soleMatch(signatures, anchor.slice(0, ANCHOR_CHARS), 'start');
      position = found === -1 ? soleMatch(signatures, anchor.slice(-ANCHOR_CHARS), 'end') : found;
      if (position !== -1) position += 1;
    }
    if (position === -1 && next) {
      position = soleMatch(signatures, signature(next).slice(0, ANCHOR_CHARS), 'start');
    }
    if (position === -1) {
      missed += 1;
      continue;
    }
    before.set(position, [...(before.get(position) ?? []), paragraph]);
  }

  const restored: string[] = [];
  for (const [position, paragraph] of cleanedParagraphs.entries()) {
    restored.push(...(before.get(position) ?? []));
    restored.push(paragraph);
  }
  restored.push(...(before.get(cleanedParagraphs.length) ?? []));
  return {
    text: restored.join('\n\n'),
    restored: [...before.values()].reduce((sum, dividers) => sum + dividers.length, 0),
    missed,
  };
}
