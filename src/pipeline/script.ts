import fs from 'node:fs';
import crypto from 'node:crypto';
import { markdownToSpeakable } from '../epub/markdown.js';
import { hasNarratableText, normalizeNonBreakingSpaces } from '../util/text.js';
import type { WorkDir } from '../state.js';
import { characterRegistryHash, readCharacterRegistry } from './list-characters.js';
import { withChapterProgress, type ProgressReporter } from '../util/progress.js';
import {
  BookAnnotationsSchema,
  ChapterMapSchema,
  ChapterScriptSchema,
  CorrectionsSchema,
  type Analysis,
  type BookAnnotations,
  type BookMetadata,
  type CharacterRegistry,
  type ChapterMap,
  type ChapterScript,
  type Corrections,
  type ScriptSegment,
  type PersonProfile,
} from '../types.js';

export const SCRIPT_CONVERTER_VERSION = '1';

// Legacy-script compatibility helpers use these explicit speech verbs when
// separating already-generated dialogue from surrounding narration.
const dialogueTagVerbs = [
  'said', 'asked', 'answered', 'replied', 'cried', 'called', 'shouted',
  'whispered', 'muttered', 'snapped', 'sighed', 'wailed', 'shrilled',
  'demanded', 'interrupted', 'interjected', 'continued', 'added', 'put\\s+in',
  'cut\\s+in', 'broke\\s+in', 'objected', 'agreed', 'admitted', 'conceded',
  'observed', 'remarked', 'announced', 'exclaimed', 'insisted', 'protested',
  'suggested', 'declared', 'urged', 'warned', 'pleaded', 'begged', 'retorted',
].join('|');
const dialogueTagVerbPhrase = `(?:(?:had|has|have|was|were)\\s+)?(?:${dialogueTagVerbs})`;
const dialogueTagVerbPattern = new RegExp(`\\b${dialogueTagVerbPhrase}\\b`, 'iu');

/**
 * Find character-labelled segments which probably include narration. This is
 * deliberately conservative: character segments with quoted speech plus text
 * outside the quotes are suspicious; narrator segments are included only
 * when the surrounding text has an explicit dialogue-attribution verb.
 */
export function findNarrationAuditCandidates(segments: ScriptSegment[]): number[] {
  return segments.flatMap((segment, id) => {
    const text = segment.text.trim();
    const hasQuote = /["“”]/u.test(text);
    if (hasQuote) {
      // Removing quoted spans leaves dialogue tags and action beats. Pairing
      // straight and curly quotes this way is enough to identify candidates;
      // the repair model handles literary edge cases and malformed source.
      let insideQuote = false;
      const outsideQuotes = [...text].filter((char) => {
        if (char === '"' || char === '“' || char === '”') {
          insideQuote = !insideQuote;
          return false;
        }
        return !insideQuote;
      }).join('');
      if (!hasNarratableText(outsideQuotes)) return [];
      const isNarrator = segment.speaker.toLowerCase() === 'narrator';
      return !isNarrator || dialogueTagVerbPattern.test(outsideQuotes)
        ? [id]
        : [];
    }

    if (segment.speaker.toLowerCase() === 'narrator') return [];

    const names = segment.speaker
      .split(/\s+/)
      .filter((part) => part.length > 1)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(`^(?:${[...names, 'he', 'she', 'they', 'it'].join('|')})\\b`, 'iu').test(text) ? [id] : [];
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function quotedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let opening: number | undefined;
  let style: 'straight' | 'curly' | undefined;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (opening === undefined) {
        opening = i;
        style = 'straight';
      } else if (style === 'straight') {
        ranges.push([opening, i]);
        opening = undefined;
        style = undefined;
      }
    } else if (char === '“' && opening === undefined) {
      opening = i;
      style = 'curly';
    } else if (char === '”' && opening !== undefined && style === 'curly') {
      ranges.push([opening, i]);
      opening = undefined;
      style = undefined;
    }
  }
  return ranges;
}

function splitQuotedDialogueAndNarration(segment: ScriptSegment, dialogueSpeaker: string): ScriptSegment[] {
  const ranges = quotedRanges(segment.text);
  if (!ranges.length) return [segment];

  const narration = (text: string): ScriptSegment | undefined => {
    const trimmed = text.trim();
    return hasNarratableText(trimmed)
      ? { speaker: 'narrator', text: trimmed, confidence: segment.confidence }
      : undefined;
  };
  const result: ScriptSegment[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    const before = narration(segment.text.slice(cursor, start));
    if (before) result.push(before);
    result.push({ ...segment, speaker: dialogueSpeaker, text: segment.text.slice(start, end + 1).trim() });
    cursor = end + 1;
  }
  const after = narration(segment.text.slice(cursor));
  if (after) result.push(after);

  // Quotes with no narratable surrounding prose are already a valid character
  // segment, so preserve it rather than needlessly changing its shape.
  return result.some((part) => part.speaker === 'narrator') ? result : [segment];
}

/** Split unambiguous quoted character speech from adjacent narrative prose. */
export function splitCharacterDialogueAndNarration(segment: ScriptSegment): ScriptSegment[] {
  return segment.speaker.toLowerCase() === 'narrator'
    ? [segment]
    : splitQuotedDialogueAndNarration(segment, segment.speaker);
}

/** Resolve a name in an explicit dialogue tag, including a unique surname. */
function speakerFromDialogueTag(text: string, characters: PersonProfile[]): string | undefined {
  const labels = new Map<string, string | undefined>();
  const add = (label: string, speaker: string) => {
    const key = label.trim().toLocaleLowerCase();
    if (!key) return;
    labels.set(key, labels.has(key) && labels.get(key) !== speaker ? undefined : speaker);
  };
  for (const character of characters) {
    add(character.name, character.name);
    for (const alias of character.aliases) add(alias, character.name);
    const parts = character.name.split(/\s+/);
    if (parts.length > 1) add(parts.at(-1)!, character.name);
  }
  for (const [label, speaker] of labels) {
    if (!speaker) continue;
    const escaped = escapeRegExp(label);
    if (new RegExp(`\\b${dialogueTagVerbPhrase}\\s+(?:the\\s+)?${escaped}\\b|\\b${escaped}\\s+${dialogueTagVerbPhrase}\\b`, 'iu').test(text)) return speaker;
  }
  return undefined;
}

/**
 * Split a named tag followed by a malformed opening quote. Some EPUB sources
 * lose a closing quote; a named tag before the remaining quote is still enough
 * to preserve the text and assign its direct speech without guessing.
 */
function splitUnclosedTaggedDialogue(segment: ScriptSegment, speaker: string): ScriptSegment[] {
  // Prefer a word-opening single quote. EPUBs occasionally mix it with a
  // closing double quote, which would otherwise look like an unclosed pair.
  const singleQuote = /(?:^|[\s,])'(?=\p{L})/u.exec(segment.text);
  const straightQuotes = [...segment.text.matchAll(/"/g)].map((match) => match.index!);
  const opening = singleQuote?.index === undefined
    ? (straightQuotes.length % 2 === 1 ? straightQuotes.at(-1) : undefined)
    : singleQuote.index + singleQuote[0].lastIndexOf("'");
  if (opening === undefined || opening === 0) return [segment];

  const narrationText = segment.text.slice(0, opening).trim();
  const dialogueText = segment.text.slice(opening).trim();
  if (!hasNarratableText(narrationText) || !hasNarratableText(dialogueText)) return [segment];
  return [
    { speaker: 'narrator', text: narrationText, confidence: 'high' },
    { ...segment, speaker, text: dialogueText, confidence: 'high' },
  ];
}

/** Recover direct speech when its individual quote has an explicit dialogue tag. */
export function splitTaggedNarratorDialogue(segment: ScriptSegment, characters: PersonProfile[]): ScriptSegment[] {
  if (segment.speaker.toLowerCase() !== 'narrator') return [segment];
  const ranges = quotedRanges(segment.text);
  if (!ranges.length) {
    const speaker = speakerFromDialogueTag(segment.text, characters);
    // A tag-only narrator segment (for example, "asked Lee Prime") is
    // deterministically narration, even if an earlier audit marked it low.
    return speaker
      ? splitUnclosedTaggedDialogue({ ...segment, confidence: 'high' }, speaker)
      : [segment];
  }

  const result: ScriptSegment[] = [];
  let cursor = 0;
  let foundExplicitSpeaker = false;
  for (const [index, [start, end]] of ranges.entries()) {
    const nextStart = ranges[index + 1]?.[0] ?? segment.text.length;
    const preceding = segment.text.slice(cursor, start);
    const following = segment.text.slice(end + 1, nextStart);
    // A completed tag in the previous paragraph belongs to that paragraph's
    // quote, not to the next quoted passage. This prevents a speaker mention
    // such as "Zee Prime had asked" from leaking into an untagged recollection.
    const precedingSpeaker = /\n\s*\n/u.test(preceding) ? undefined : speakerFromDialogueTag(preceding, characters);
    const speaker = precedingSpeaker ?? speakerFromDialogueTag(following, characters);
    const narrationText = preceding.trim();
    if (hasNarratableText(narrationText)) result.push({ speaker: 'narrator', text: narrationText, confidence: segment.confidence });
    const quote = segment.text.slice(start, end + 1).trim();
    if (speaker) {
      foundExplicitSpeaker = true;
      result.push({ ...segment, speaker, text: quote, confidence: 'high' });
    } else {
      result.push({ ...segment, speaker: 'narrator', text: quote, confidence: segment.confidence });
    }
    cursor = end + 1;
  }
  const tail = segment.text.slice(cursor).trim();
  if (hasNarratableText(tail)) result.push({ speaker: 'narrator', text: tail, confidence: segment.confidence });
  return foundExplicitSpeaker ? result : [segment];
}

/**
 * A very narrow pattern for a narrator cue followed by a continuation of the
 * immediately preceding character's speech. This deliberately excludes broad
 * pronoun and turn-taking guesses: it only accepts a final quote after an
 * "after … pause/silence/moment" cue and an immediately preceding quoted
 * character segment.
 */
function isMarkedDialogueContinuation(segment: ScriptSegment, previous: ScriptSegment | undefined): previous is ScriptSegment {
  if (!previous || previous.speaker.toLowerCase() === 'narrator' || segment.speaker.toLowerCase() !== 'narrator') return false;
  if (!/(?:["”])(?:[.!?…—-]*)$/u.test(previous.text.trim())) return false;

  const match = segment.text.match(/^(.*?)\s*(["“])([\s\S]*)(["”])\s*$/u);
  if (!match) return false;
  const cue = match[1].trim();
  return /^(?:(?:then|and then),?\s+)?after\s+(?:(?:a|an|the)\s+)?(?:[a-z]+\s+){0,3}(?:pause|silence|moment|interval),?$/iu.test(cue);
}

/**
 * Separate boundaries that are fully determined by the surrounding text.
 * This runs before the LLM repair audit, so simple tags and marked speech
 * continuations never incur a repair call.
 */
export function splitDeterministicNarrationBoundaries(
  segments: ScriptSegment[],
  characters: PersonProfile[],
): ScriptSegment[] {
  const result: ScriptSegment[] = [];
  for (const segment of segments) {
    if (segment.speaker.toLowerCase() !== 'narrator') {
      result.push(...splitCharacterDialogueAndNarration(segment));
      continue;
    }

    const tagged = splitTaggedNarratorDialogue(segment, characters);
    if (tagged.length !== 1 || tagged[0] !== segment) {
      result.push(...tagged);
      continue;
    }

    const previous = result.at(-1);
    if (isMarkedDialogueContinuation(segment, previous)) {
      result.push(...splitQuotedDialogueAndNarration(segment, previous.speaker));
      continue;
    }
    result.push(segment);
  }
  return result;
}

/** Remove layout-only segments before they can reach speaker attribution or TTS. */
export function filterNarratableSegments(segments: ScriptSegment[]): ScriptSegment[] {
  return segments
    .map((segment) => {
      const text = normalizeNonBreakingSpaces(segment.text);
      return text === segment.text ? segment : { ...segment, text };
    })
    .filter((segment) => hasNarratableText(segment.text));
}

/**
 * Pull an opening ATX heading out of a cleaned chapter. The heading is handled
 * separately so an attribution model cannot omit it or give it to a character.
 */
export function splitLeadingChapterTitle(markdown: string): { title?: string; content: string } {
  const match = markdown.match(/^(?:\uFEFF)?(?:[ \t]*\r?\n)*[ \t]*#{1,6}[ \t]+(.+?)[ \t]*(?:\r?\n|$)/);
  if (!match) return { content: markdown };

  // ATX headings can have optional closing hashes; markdownToSpeakable also
  // removes emphasis such as the **VIEWFINDER** heading in many EPUBs.
  const title = markdownToSpeakable(match[1].replace(/[ \t]+#+[ \t]*$/, ''));
  const content = markdown.slice(match[0].length).replace(/^(?:[ \t]*\r?\n)+/, '');
  return hasNarratableText(title)
    ? { title, content }
    : { content: markdown };
}

/** Add the heading as a dedicated narrator cue, bounded by natural TTS pauses. */
export function withChapterTitle(segments: ScriptSegment[], title?: string): ScriptSegment[] {
  const narratable = filterNarratableSegments(segments);
  if (!title) return narratable;

  const chapterTitle: ScriptSegment = {
    speaker: 'narrator',
    // Ellipses make the pause part of the spoken request, including at the
    // start/end of a chapter where there is no adjacent segment to imply one.
    text: `… ${title} …`,
    delivery: 'Announce the chapter title clearly, with a brief pause before and after.',
    confidence: 'high',
  };
  const comparable = (text: string) => markdownToSpeakable(text)
    .normalize('NFKC')
    .replace(/^\W+|\W+$/gu, '')
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();

  // Older scripts may already contain the heading because an LLM chose to
  // emit it. Upgrade that segment rather than speaking the title twice.
  return comparable(narratable[0]?.text ?? '') === comparable(title)
    ? [chapterTitle, ...narratable.slice(1)]
    : [chapterTitle, ...narratable];
}

/**
 * Stage 6: deterministically convert exact annotation spans into ordered
 * speaker segments, preserving complete source coverage.
 */
export async function runScript(
  work: WorkDir,
  chapterIndexes?: number[],
  report: ProgressReporter = (_progress, message) => console.log(`  ${message}`),
): Promise<void> {
  const meta = work.readJson<BookMetadata>('metadata.json');
  const analysis = work.readJson<Analysis>('analysis.json');
  const registry = readCharacterRegistry(work);
  const registryHash = characterRegistryHash(registry);
  const annotations = BookAnnotationsSchema.parse(work.readJson('booknlp/annotations.json'));
  const chapterMap = ChapterMapSchema.parse(work.readJson('booknlp/chapter-map.json'));
  const corrections = fs.existsSync(work.path('corrections.json'))
    ? CorrectionsSchema.parse(work.readJson('corrections.json'))
    : CorrectionsSchema.parse({ version: 1 });
  const input = fs.readFileSync(work.path('booknlp/input.txt'), 'utf8');
  work.dir('script');

  const narratable = meta.chapters
    .filter((ch) => analysis.chapters.find((p) => p.index === ch.index)?.narrate)
    .filter((ch) => !chapterIndexes || chapterIndexes.includes(ch.index));

  for (const [chapterPosition, ch] of narratable.entries()) {
    await withChapterProgress({
      chapterIndex: ch.index, chapterTitle: ch.title,
      completedChapters: chapterPosition, totalChapters: narratable.length,
      phase: 'preparing', processedChars: 0, totalChars: 0,
    }, report, async (update) => {
      const mapped = chapterMap.chapters.find((entry) => entry.index === ch.index);
      if (!mapped) throw new Error(`Chapter ${ch.index + 1} is missing from booknlp/chapter-map.json.`);
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
        annotations: annotations.provenance.fingerprint, chapterMap, registry, corrections, chapter: ch.index, converter: SCRIPT_CONVERTER_VERSION,
      })).digest('hex');
      const scriptFile = `script/${String(ch.index).padStart(4, '0')}.json`;
      if (fs.existsSync(work.path(scriptFile))) {
        const existing = ChapterScriptSchema.safeParse(work.readJson(scriptFile));
        if (existing.success && existing.data.fingerprint === fingerprint) {
          validateScriptCoverage(existing.data, input, mapped.start, mapped.end);
          update({ phase: 'skipped', completedChapters: chapterPosition + 1 });
          return;
        }
      }

      const segments = annotationSegmentsForChapter(input, mapped, annotations.quotations, registry, corrections);
      if (!mapped.titleInText && hasNarratableText(ch.title)) {
        segments.unshift({ speaker: 'narrator', speakerId: 'narrator', text: ch.title, delivery: 'Announce the chapter title clearly.', confidence: 'high' });
      }
      const script: ChapterScript = { version: 2, format: 'plain-text', index: ch.index, characterRegistryHash: registryHash, fingerprint, segments };
      validateScriptCoverage(script, input, mapped.start, mapped.end);
      work.writeJson(scriptFile, script);
      saveUnresolvedQuotes(work, annotations.quotations, input, corrections, chapterMap);
      update({ phase: 'saving', totalChars: mapped.end - mapped.start, processedChars: mapped.end - mapped.start });
      update({ phase: 'completed', completedChapters: chapterPosition + 1 });
    });
  }
}

export function annotationSegmentsForChapter(
  input: string,
  chapter: { index: number; start: number; end: number },
  quotations: BookAnnotations['quotations'],
  registry: CharacterRegistry,
  corrections: Corrections,
): ScriptSegment[] {
  const quotes = quotations
    .filter((quote) => quote.chapterIndex === chapter.index || (quote.chapterIndex === null && quote.start < chapter.end && quote.end > chapter.start))
    .map((quote) => ({ ...quote, start: Math.max(quote.start, chapter.start), end: Math.min(quote.end, chapter.end) }))
    .sort((a, b) => a.start - b.start);
  const result: ScriptSegment[] = [];
  let cursor = chapter.start;
  const addNarration = (start: number, end: number) => {
    const text = sliceCodePoints(input, start, end);
    if (hasNarratableText(text)) result.push({ speaker: 'narrator', speakerId: 'narrator', text, confidence: 'high', sourceStart: start, sourceEnd: end });
  };
  for (const quote of quotes) {
    if (quote.start < cursor || quote.end > chapter.end) throw new Error(`Quotation ${quote.id} has invalid chapter boundaries.`);
    addNarration(cursor, quote.start);
    const override = corrections.quotationSpeakers[quote.id];
    const narratorAssignment = override === 'narrator' || (quote.entityId === 'booknlp:0' && !override);
    let character = override ? registry.characters.find((entry) => entry.id === override) : registry.characters.find((entry) => quote.entityId && entry.sourceEntityIds.includes(quote.entityId));
    const mergeInto = character && corrections.characters[character.id]?.mergeInto;
    if (mergeInto) character = registry.characters.find((entry) => entry.id === mergeInto) ?? character;
    const resolved = narratorAssignment || Boolean(character);
    result.push({
      speaker: narratorAssignment ? 'narrator' : (character?.name ?? 'Unresolved speaker'),
      speakerId: narratorAssignment ? 'narrator' : (character?.id ?? 'unresolved'),
      text: sliceCodePoints(input, quote.start, quote.end),
      confidence: resolved ? 'high' : 'low', sourceStart: quote.start, sourceEnd: quote.end, quotationId: quote.id,
    });
    cursor = quote.end;
  }
  addNarration(cursor, chapter.end);
  return filterNarratableSegments(result);
}

export function validateScriptCoverage(script: ChapterScript, input: string, chapterStart: number, chapterEnd: number): void {
  if (chapterEnd > chapterStart && !script.segments.some((segment) => hasNarratableText(segment.text))) {
    throw new Error(`Script for chapter ${script.index + 1} is empty even though the prepared chapter contains narration.`);
  }
  let cursor = chapterStart;
  for (const segment of script.segments.filter((entry) => entry.sourceStart !== undefined)) {
    const start = segment.sourceStart!; const end = segment.sourceEnd!;
    if (start < cursor || end < start || end > chapterEnd) throw new Error(`Script coverage is out of order or overlapping at source offset ${start}.`);
    if (hasNarratableText(sliceCodePoints(input, cursor, start))) throw new Error(`Script coverage omits source text at offsets ${cursor}..${start}.`);
    if (segment.text !== sliceCodePoints(input, start, end)) throw new Error(`Script segment rewrites source text at offsets ${start}..${end}.`);
    cursor = end;
  }
  if (hasNarratableText(sliceCodePoints(input, cursor, chapterEnd))) throw new Error(`Script coverage omits source text at offsets ${cursor}..${chapterEnd}.`);
}

function saveUnresolvedQuotes(work: WorkDir, quotations: BookAnnotations['quotations'], input: string, corrections: Corrections, chapterMap: ChapterMap): void {
  const unresolved = quotations.filter((quote) => quote.assignment === 'unresolved' && !corrections.quotationSpeakers[quote.id]).map((quote) => ({
    id: quote.id, chapterIndex: quote.chapterIndex, text: quote.text,
    chapterIndexes: chapterMap.chapters.filter((chapter) => quote.start < chapter.end && quote.end > chapter.start).map((chapter) => chapter.index),
    context: sliceCodePoints(input, Math.max(0, quote.start - 120), Math.min([...input].length, quote.end + 120)),
  }));
  if (unresolved.length) work.writeJson('unresolved-quotes.json', { version: 1, quotations: unresolved });
  else fs.rmSync(work.path('unresolved-quotes.json'), { force: true });
}

function sliceCodePoints(text: string, start: number, end: number): string { return [...text].slice(start, end).join(''); }
