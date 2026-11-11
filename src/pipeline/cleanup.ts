import { paragraphsOf } from '../util/text.js';

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

/** Why an edit is refused whatever text it is applied to, or undefined when it is acceptable. */
function refusal({ find, replace }: CleanupEdit): string | undefined {
  if (!find.trim()) return 'empty quotation';
  if (find.length > MAX_FIND_CHARS) return 'quotes too much text for one correction';
  if (find.length - replace.length > MAX_REMOVED_CHARS) return 'would remove too much text';
  if (replace.length - find.length > MAX_ADDED_CHARS) return 'would add too much text';
  return undefined;
}

/** A bare footnote number also matches every real number that looks the same. */
const isRepeatedBareNumber = (find: string, matches: number): boolean =>
  matches > 1 && /\p{N}/u.test(find) && !/\p{L}/u.test(find);

const REPEATED_NUMBER = 'a number that occurs more than once; it needs a neighbouring word';

/**
 * Apply a model's cleanup edits to the source text. The text itself is never
 * regenerated, so the model cannot paraphrase, drop, or reorder prose: an edit
 * that does not quote the text, or that would remove or add more than a small
 * correction can, is skipped and reported instead of applied.
 */
export function applyCleanupEdits(source: string, edits: CleanupEdit[]): CleanupResult {
  const result = applySpanEdits([source], edits);
  return { text: result.texts[0], applied: result.applied, skipped: result.skipped };
}

export interface SpanEditResult {
  texts: string[];
  applied: number;
  skipped: CleanupResult['skipped'];
}

/**
 * Apply cleanup edits to a passage held as separate spans. An edit is applied
 * inside each span it quotes, under the same guards as applyCleanupEdits; one
 * whose quotation only exists across two spans is skipped, because narration
 * and speech are different segments and an edit cannot straddle them.
 */
export function applySpanEdits(spans: string[], edits: CleanupEdit[]): SpanEditResult {
  let texts = [...spans];
  let applied = 0;
  const skipped: CleanupResult['skipped'] = [];
  for (const edit of edits) {
    const { find, replace } = edit;
    if (find === replace && find.trim()) continue;
    const reason = refusal(edit);
    if (reason) { skipped.push({ find, reason }); continue; }

    const pattern = findPattern(find);
    const matches = texts.reduce((sum, text) => sum + (text.match(pattern)?.length ?? 0), 0);
    if (!matches) {
      const crosses = texts.length > 1 && pattern.test(texts.join(' '));
      skipped.push({ find, reason: crosses ? 'crosses a span boundary' : 'not found in the text' });
      continue;
    }
    if (isRepeatedBareNumber(find, matches)) { skipped.push({ find, reason: REPEATED_NUMBER }); continue; }
    texts = texts.map((text) => text.replace(pattern, () => replace));
    applied += 1;
  }
  return { texts, applied, skipped };
}

/**
 * Drop paragraphs that hold nothing at all. Decorative dividers ("• • •",
 * "* * *") are deliberately kept: they are layout in print, but in audio they
 * are the only sign of a scene break, and Script turns each one into a pause.
 */
export function dropEmptyParagraphs(text: string): string {
  return paragraphsOf(text).join('\n\n');
}
