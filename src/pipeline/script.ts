import fs from 'node:fs';
import pLimit from 'p-limit';
import { z } from 'zod';
import { jsonCall } from '../providers/llm/openai.js';
import { config } from '../config.js';
import { markdownToSpeakable } from '../epub/markdown.js';
import { hasNarratableText, isSceneBreak, normalizeNonBreakingSpaces, paragraphsOf, splitIntoBlocks } from '../util/text.js';
import { applySpanEdits, type CleanupEdit, type SpanEditResult } from './cleanup.js';
import { cleanupTriggers } from './cleanup-triggers.js';
import { formatSpans, spansToSegments, splitSpans, type LabelledSpan, type Span } from './spans.js';
import { reportWarning } from '../util/warnings.js';
import type { WorkDir } from '../state.js';
import { SCRIPTS_DIR, chapterFile, findChapterFile } from '../layout.js';
import {
  addCharacters,
  chapterCast,
  consolidateStory,
  labelSharedNames,
  nameKey,
  noteAppearances,
  readCharacterRegistry,
  renameSpeakers,
  setUnresolved,
  writeCharacterRegistry,
  type ChapterCast,
} from './cast.js';
import { chapterTitle, readProfiledMetadata, readStories, storyFor, storyLabels } from './stories.js';
import { withChapterProgress, type ChapterProgress, type ProgressReporter } from '../util/progress.js';
import { TaskCancelledError, throwIfTaskCancelled } from '../util/cancellation.js';
import { checkpointKey, clearCheckpoints, loadCheckpoint, saveCheckpoint } from './checkpoint.js';
import {
  BOOK_STORY_ID,
  CharacterReportSchema,
  ChapterScriptSchema,
  ScriptSegmentSchema,
  type BookMetadata,
  type CharacterRegistry,
  type CharacterReport,
  type ChapterScript,
  type ExtractedChapter,
  type ScriptMode,
  type ScriptSegment,
  type Stories,
  type Story,
  type UnresolvedSpeakerRecord,
} from '../types.js';

const EditsSchema = z.array(z.object({ find: z.string(), replace: z.string() })).default([]);
const CharactersSchema = z.array(CharacterReportSchema).default([]);

/** Quoted mode: who speaks each quoted span. The reply never carries the book's text. */
const LabelsSchema = z.object({
  labels: z.array(z.object({
    id: z.number().int(),
    speaker: z.string(),
    confidence: z.enum(['high', 'low']).default('high'),
    delivery: z.string().optional(),
  })).default([]),
  edits: EditsSchema,
  characters: CharactersSchema,
});

/** Narration with nothing to attribute: cleanup corrections only. */
const EditsOnlySchema = z.object({ edits: EditsSchema });

/** A model only ever returns speech; pauses are inserted deterministically. */
const SpeechSegmentSchema = ScriptSegmentSchema.omit({ kind: true, pauseMs: true });
/** Unquoted mode: the text cannot be split in code, so the model returns it as segments. */
const SegmentsSchema = z.object({
  segments: z.array(SpeechSegmentSchema),
  edits: EditsSchema,
  characters: CharactersSchema,
});

const VerifySchema = z.object({
  attributions: z.array(z.object({ id: z.number(), speaker: z.string() })),
  /** Records for confirmed speakers the cast lacks. */
  characters: CharactersSchema,
});

/** The label a quote gets when nobody can say who speaks it. It never matches a character. */
const UNRESOLVED = 'unresolved speaker';

const EDIT_RULES = `edits: the text is kept exactly as written. List only the small corrections it needs to read well aloud. Most text needs none; return "edits": [] then.
- find: a short exact quotation from the text, copied character for character, with enough neighbouring words to identify the place. replace: what should be read instead. Every occurrence of find in this text is replaced.
- Expand abbreviations and units that a narrator would say in full ("i.e." becomes "that is", "5 km" becomes "5 kilometres"; "Mr." stays).
- Spell out unusual symbols. Remove footnote markers and citation numbers, quoting the word they are attached to ("women.12" becomes "women.").
- Correct an obvious scanning or typesetting error only when the intended word is certain.
- Do not change wording, spelling, contractions, punctuation, quotation marks, or style. Do not remove or rewrite sentences. Do not touch markdown headings.`;

const CHARACTER_RULES = `characters: one record for every speaker you named who is NOT in the cast list. Return "characters": [] when every speaker is already in it.
- name: the fullest name the text gives. aliases: other names the text explicitly uses for the same person.
- sex: "male", "female" or "unknown". age: an approximate age or life stage ("30s", "child", "elderly"), or "unknown".
- named: false for a speaker known only by a role ("the station guard"); use that specific role as the name.
- evidence: a short quotation from this text that identifies the speaker.
- Use "unknown" for anything the text does not support. Do not infer sex or age from a name alone. Do not list people who are mentioned but do not speak.`;

const LABELS_SYSTEM = `You decide who speaks each line of dialogue in a passage from a book, for a multi-voice audiobook. The passage is already split into numbered spans. A span marked QUOTE is text inside quotation marks; every other span is narration and will be read by the narrator. Never return the passage's text.

Respond with JSON: {"labels": [{"id", "speaker", "confidence", "delivery"?}], "edits": [{"find", "replace"}], "characters": [{"name", "aliases", "sex", "age", "named", "evidence"}]}.

labels: exactly one for every QUOTE span, and none for any other span.
- speaker: the character who says it. Use the name exactly as the cast list gives it when the speaker is in the list. For a speaker who is not, use the name the text gives, or a specific role for an unnamed speaker, and add them to "characters".
- Use "narrator" for a QUOTE span that is not speech: a title, a quoted word or phrase, a sign, a scare quote.
- One speaker per label. When several characters say a line together, label it with the one the text names first; never join names with "and".
- Work it out from the dialogue tags ("he said"), turn-taking, forms of address and the scene. "[scene break]" in the context marks a change of scene.
- confidence: "high" when the text settles who speaks, "low" when you are inferring or guessing.
- delivery (optional): a short hint only when the text makes it explicit, such as "whispering", "shouting", "sobbing".

${CHARACTER_RULES}

${EDIT_RULES}
- A find must lie inside one numbered span. Never quote across two spans, and never include the span numbers.

Example

Cast list:
- Bertram Lupov (aka Lupov, Bert): male, unknown

Passage:
[1] Lupov cocked his head sideways. He had a trick of doing that when he wanted to be contrary, and he wanted to be contrary now, partly because he had had to carry the ice and glassware.
[2 QUOTE] "Not forever,"
[3] he said.

[4 QUOTE] "Oh, hell, just about forever. Till the sun runs down, Bert. Ten billion, maybe. Are you satisfied?"

[5] Lupov put his fingers through his thinning hair as though to reassure himself that some was still left and sipped gently at his own drink.
[6 QUOTE] "Ten billion years isn't forever."

[7 QUOTE] "Well, it will last our time, won't it?"

Response:
{"labels": [{"id": 2, "speaker": "Bertram Lupov", "confidence": "high"}, {"id": 4, "speaker": "Alexander Adell", "confidence": "high"}, {"id": 6, "speaker": "Bertram Lupov", "confidence": "high"}, {"id": 7, "speaker": "Alexander Adell", "confidence": "high"}], "edits": [], "characters": [{"name": "Alexander Adell", "aliases": ["Adell"], "sex": "male", "age": "unknown", "named": true, "evidence": "Till the sun runs down, Bert."}]}

Example

Cast list:
- Jerrodd: male, unknown
- Jerrodine: female, unknown

Passage:
[1] Jerrodine's eyes were moist as she watched the visiplate.
[2 QUOTE] "I can't help it. I feel funny about leaving Earth."

[3 QUOTE] "Why, for Pete's sake?"
[4] demanded Jerrodd.
[5 QUOTE] "We had nothing there."
[6] Then, after a reflective pause,
[7 QUOTE] "I tell you, it's a lucky thing the computers worked out interstellar travel the way the race is growing."

[8 QUOTE] "I know, I know,"
[9] said Jerrodine miserably.

Response:
{"labels": [{"id": 2, "speaker": "Jerrodine", "confidence": "high"}, {"id": 3, "speaker": "Jerrodd", "confidence": "high"}, {"id": 5, "speaker": "Jerrodd", "confidence": "high"}, {"id": 7, "speaker": "Jerrodd", "confidence": "high"}, {"id": 8, "speaker": "Jerrodine", "confidence": "high", "delivery": "miserably"}], "edits": [], "characters": []}`;

const EDITS_SYSTEM = `You prepare book text for audiobook narration. Respond with JSON: {"edits": [{"find": "...", "replace": "..."}]}.

${EDIT_RULES}`;

const SEGMENTS_SYSTEM = `You convert book text into a multi-voice audiobook script. This book does not mark dialogue with quotation marks, so you return the text itself, split by speaker. Respond with JSON: {"segments": [{"speaker", "text", "delivery"?, "confidence"}], "edits": [{"find", "replace"}], "characters": [{"name", "aliases", "sex", "age", "named", "evidence"}]}.

segments:
- Split all narratable prose into an ordered list of segments, in order. Copy that text VERBATIM — never rewrite, drop, or summarize it. Corrections belong in "edits", not in the segment text.
- Do not emit decorative layout-only section dividers, such as lines made solely of repeated asterisks, dashes, underscores, or whitespace. They are not narratable text and are excluded from the coverage requirement.
- Every segment must contain spoken content (at least one letter or number); never return a punctuation-only segment.
- "speaker" is "narrator" for all narration and dialogue tags ("she said"), or the character's name for what a character says aloud.
- Dialogue tags stay with the narrator: '— Hello, said Tom.' becomes [Tom] — Hello, + [narrator] said Tom.
- Keep the text's own dialogue punctuation (dashes, commas) in the segment text.
- "delivery" (optional): a short hint when the text makes it explicit, e.g. "whispering", "shouting", "sobbing".
- "confidence": "high" when the speaker is clear, "low" when you are guessing.
- Use speaker names exactly as the cast list gives them. For a speaker who is not in the list, use the name the text gives, or a specific role for an unnamed speaker, and add them to "characters".
- One speaker per segment. When several characters say a line together, give it to the one the text names first; never join names with "and".
- Merge consecutive narrator paragraphs into segments of at most 1500 characters.

${CHARACTER_RULES}

${EDIT_RULES}`;

/** Letters and digits only: what must survive when a model copies text into segments. */
function coverageText(text: string): string {
  return normalizeNonBreakingSpaces(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();
}

/** Why a model's segments do not reproduce a passage, or undefined when they do. */
export function coverageProblem(source: string, segments: Array<{ text: string }>): string | undefined {
  const expected = coverageText(paragraphsOf(source).filter((paragraph) => !isSceneBreak(paragraph)).join(' '));
  const actual = coverageText(segments.map((segment) => segment.text).join(' '));
  if (expected === actual) return undefined;
  let at = 0;
  while (at < expected.length && expected[at] === actual[at]) at += 1;
  return `The segments do not reproduce the text. Every word must appear once, in order, unchanged; the copy first differs near "${expected.slice(Math.max(0, at - 30), at + 30)}".`;
}

/**
 * Remove layout-only segments before they can reach speaker attribution or
 * TTS. A scene-break pause has no narratable text by definition and is the one
 * segment kind that is kept: it is silence, not something to be spoken.
 */
export function filterNarratableSegments(segments: ScriptSegment[]): ScriptSegment[] {
  return segments
    .map((segment) => {
      const text = normalizeNonBreakingSpaces(segment.text);
      return text === segment.text ? segment : { ...segment, text };
    })
    .filter((segment) => segment.kind === 'pause' || hasNarratableText(segment.text));
}

/**
 * The silence a scene break becomes. The divider is kept as the segment text
 * so the script still shows where the break is and what marked it, and the
 * length is recorded so a hand edit can lengthen one break on its own.
 */
export function pauseSegment(divider: string): ScriptSegment {
  return {
    speaker: 'narrator',
    text: divider.trim(),
    confidence: 'high',
    kind: 'pause',
    pauseMs: config.sceneBreakPauseMs,
  };
}

/**
 * One segment as prompt context. A pause is shown as a marker rather than its
 * divider, so the model reads it as a change of scene and never as text to
 * copy into a segment of its own.
 */
function contextLine(segment: ScriptSegment, chars = 120): string {
  return segment.kind === 'pause' ? '[scene break]' : `[${segment.speaker}] ${segment.text.slice(0, chars)}`;
}

/** One Script request's text, and the scene break that follows it. */
export interface AttributionBlock {
  text: string;
  sceneBreak?: string;
}

/**
 * Chapter text as attribution blocks, cut at scene breaks before size, so a
 * divider never lands in the middle of a block and the model never sees one.
 * Each block records the divider that follows it, which becomes a pause.
 */
export function attributionBlocks(text: string, maxChars: number): AttributionBlock[] {
  const blocks: AttributionBlock[] = [];
  let section: string[] = [];
  const flush = (sceneBreak?: string): void => {
    const body = section.join('\n\n');
    section = [];
    const pieces = body.trim() ? splitIntoBlocks(body, maxChars) : [];
    for (const [i, piece] of pieces.entries()) {
      blocks.push(i === pieces.length - 1 && sceneBreak ? { text: piece, sceneBreak } : { text: piece });
    }
    // A divider with nothing before it still marks a break.
    if (sceneBreak && !pieces.length) blocks.push({ text: '', sceneBreak });
  };
  for (const paragraph of paragraphsOf(text)) {
    if (isSceneBreak(paragraph)) flush(paragraph);
    else section.push(paragraph);
  }
  flush();
  return blocks;
}

/**
 * Cut a block between paragraphs so no piece holds more than `maxQuotes`
 * quoted spans. A reply carries one label per quote, and a page of rapid
 * dialogue would otherwise outgrow the completion budget.
 */
export function limitQuotesPerBlock(block: AttributionBlock, maxQuotes: number): AttributionBlock[] {
  const quotesIn = (paragraph: string): number => splitSpans(paragraph).filter((span) => span.kind === 'quote').length;
  const pieces: string[][] = [[]];
  let count = 0;
  for (const paragraph of paragraphsOf(block.text)) {
    const quotes = quotesIn(paragraph);
    if (pieces.at(-1)!.length && count + quotes > maxQuotes) {
      pieces.push([]);
      count = 0;
    }
    pieces.at(-1)!.push(paragraph);
    count += quotes;
  }
  if (pieces.length === 1) return [block];
  return pieces.map((paragraphs, position) => position === pieces.length - 1 && block.sceneBreak
    ? { text: paragraphs.join('\n\n'), sceneBreak: block.sceneBreak }
    : { text: paragraphs.join('\n\n') });
}

/** How a book is scripted, decided once by Metadata. */
export function scriptModeOf(metadata: BookMetadata): ScriptMode {
  const profile = metadata.profile;
  if (!profile?.isFiction) return 'narration';
  return profile.dialogueStyle === 'quoted' ? 'quoted' : 'unquoted';
}

const chunkCharsFor = (mode: ScriptMode): number => (mode === 'unquoted' ? config.scriptUnquotedChunkChars : config.scriptChunkChars);

/** A chapter's Script requests, in order. */
export function scriptBlocks(text: string, mode: ScriptMode): AttributionBlock[] {
  const blocks = attributionBlocks(text, chunkCharsFor(mode));
  return mode === 'quoted' ? blocks.flatMap((block) => limitQuotesPerBlock(block, config.scriptMaxQuotesPerChunk)) : blocks;
}

/**
 * What decides a chapter's script: its own text, how it is chunked, and the
 * mode. The cast is deliberately left out, so a character discovered in
 * chapter 20 does not invalidate the nineteen chapters before it.
 */
export function scriptSourceHash(text: string, mode: ScriptMode): string {
  return checkpointKey(mode, chunkCharsFor(mode), mode === 'quoted' ? config.scriptMaxQuotesPerChunk : 0, text);
}

/**
 * Whether a chunk needs a model at all, and for what. Prose with no quotation
 * marks has nobody to attribute, and prose with no cleanup trigger has nothing
 * to correct: it goes to the narrator as it stands, at no cost.
 */
export function chunkRequest(text: string, mode: ScriptMode): 'none' | 'edits' | 'labels' | 'segments' {
  if (mode === 'unquoted') return 'segments';
  if (mode === 'quoted' && splitSpans(text).some((span) => span.kind === 'quote')) return 'labels';
  return cleanupTriggers(text).length ? 'edits' : 'none';
}

/**
 * Pull an opening ATX heading out of a chapter. The heading is handled
 * separately so an attribution model cannot omit it or give it to a character.
 */
export function splitLeadingChapterTitle(markdown: string): { title?: string; content: string } {
  const match = markdown.match(/^(?:﻿)?(?:[ \t]*\r?\n)*[ \t]*#{1,6}[ \t]+(.+?)[ \t]*(?:\r?\n|$)/);
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
  return [{
    speaker: 'narrator',
    // Ellipses make the pause part of the spoken request, including at the
    // start/end of a chapter where there is no adjacent segment to imply one.
    text: `… ${title} …`,
    delivery: 'Announce the chapter title clearly, with a brief pause before and after.',
    confidence: 'high',
  }, ...narratable];
}

/** One finished block of a chapter, as a checkpoint keeps it. */
interface BlockResult {
  /** Speakers as the model named them; they are matched to the cast when the chapter is assembled. */
  segments: ScriptSegment[];
  /** Speakers this block added to the running cast, so a resumed chapter has the cast as of this block. */
  characters: CharacterReport[];
}

function reportSkippedEdits(chapter: number, block: number, result: SpanEditResult): void {
  if (!result.skipped.length) return;
  reportWarning(`Chapter ${chapter + 1}, block ${block + 1}: skipped ${result.skipped.length} cleanup edit(s) and kept the source text there (${result.skipped.slice(0, 3)
    .map(({ find, reason }) => `${JSON.stringify(find.slice(0, 40))}: ${reason}`).join('; ')}${result.skipped.length > 3 ? '; …' : ''}).`);
}

function castList(cast: ChapterCast): string {
  if (!cast.characters.length) return '(nobody yet — every speaker in this text is new)';
  return cast.characters
    .map((c) => `- ${c.name}${c.aliases.length ? ` (aka ${c.aliases.join(', ')})` : ''}: ${c.sex}, ${c.age}`)
    .join('\n');
}

/** Keep only reports of people the model actually gave lines to. */
function spokenReports(reports: CharacterReport[], speakers: Iterable<string>): CharacterReport[] {
  const spoke = new Set([...speakers].map(nameKey));
  return reports.filter((report) => [report.name, ...report.aliases].some((name) => spoke.has(nameKey(name))));
}

const speakerName = (speaker: string): string => (nameKey(speaker) === 'narrator' ? 'narrator' : speaker.trim() || UNRESOLVED);

interface ChapterContext {
  work: WorkDir;
  metadata: BookMetadata;
  mode: ScriptMode;
  chapter: ExtractedChapter;
  title: string;
  /** Present for a collection: the story this chapter belongs to. */
  storyTitle?: string;
}

function passageHeader(context: ChapterContext, block: number, totalBlocks: number): string {
  return `Book: "${context.metadata.title}"${context.storyTitle ? `\nShort story: "${context.storyTitle}" — one story in a collection. Its characters are its own.` : ''}
Chapter: "${context.title}"${totalBlocks > 1 ? ` (part ${block + 1} of ${totalBlocks})` : ''}`;
}

/** Cleanup only: the request carries the book title, chapter title and text, and nothing about characters. */
async function editsFor(context: ChapterContext, text: string, block: number, totalBlocks: number): Promise<CleanupEdit[]> {
  const result = await jsonCall({
    model: config.chapterModel,
    disableReasoning: true,
    schema: EditsOnlySchema,
    system: EDITS_SYSTEM,
    user: `${passageHeader(context, block, totalBlocks)}

Text:
${text}`,
  });
  return result.edits;
}

function narrationSegments(context: ChapterContext, spans: Span[], edits: CleanupEdit[], block: number): ScriptSegment[] {
  const edited = applySpanEdits(spans.map((span) => span.text), edits);
  reportSkippedEdits(context.chapter.index, block, edited);
  return spansToSegments(spans.map((span, position): LabelledSpan => ({
    span, text: edited.texts[position], speaker: 'narrator', confidence: 'high',
  })), config.narrationMergeChars);
}

/** Script one block: at most one model call, which returns labels and corrections but never the text. */
async function scriptBlock(
  context: ChapterContext,
  blockText: string,
  block: number,
  totalBlocks: number,
  cast: ChapterCast,
  tail: string,
): Promise<BlockResult> {
  const request = chunkRequest(blockText, context.mode);
  if (request === 'none' || request === 'edits') {
    const spans = splitSpans(blockText, context.mode === 'quoted');
    const edits = request === 'edits' ? await editsFor(context, blockText, block, totalBlocks) : [];
    return { segments: narrationSegments(context, spans, edits, block), characters: [] };
  }

  const header = `${passageHeader(context, block, totalBlocks)}

Cast list:
${castList(cast)}
${tail ? `\nPrevious segments (context):\n${tail}\n` : ''}`;

  if (request === 'segments') {
    const result = await jsonCall({
      model: config.scriptModel,
      reasoningEffort: config.scriptReasoningEffort,
      maxCompletionTokens: config.scriptMaxCompletionTokens,
      schema: SegmentsSchema,
      validate: (value) => coverageProblem(blockText, value.segments),
      system: SEGMENTS_SYSTEM,
      user: `${header}
Text:
${blockText}`,
    });
    const problem = coverageProblem(blockText, result.segments);
    if (problem) throw new Error(`Chapter ${context.chapter.index + 1}, block ${block + 1}: ${problem} Run Script again; finished blocks are kept.`);
    const copied = filterNarratableSegments(result.segments);
    const edited = applySpanEdits(copied.map((segment) => segment.text), result.edits);
    reportSkippedEdits(context.chapter.index, block, edited);
    const segments = filterNarratableSegments(copied.map((segment, position) => ({
      ...segment, speaker: speakerName(segment.speaker), text: edited.texts[position],
    })));
    return { segments, characters: spokenReports(result.characters, segments.map((segment) => segment.speaker)) };
  }

  const spans = splitSpans(blockText);
  const quotes = new Set(spans.filter((span) => span.kind === 'quote').map((span) => span.id));
  const result = await jsonCall({
    model: config.scriptModel,
    reasoningEffort: config.scriptReasoningEffort,
    maxCompletionTokens: config.scriptMaxCompletionTokens,
    schema: LabelsSchema,
    system: LABELS_SYSTEM,
    user: `${header}
Passage:
${formatSpans(spans)}`,
  });

  const labels = new Map<number, (typeof result.labels)[number]>();
  let ignored = 0;
  for (const label of result.labels) {
    if (quotes.has(label.id) && !labels.has(label.id)) labels.set(label.id, label);
    else ignored += 1;
  }
  const unlabelled = [...quotes].filter((id) => !labels.has(id));
  if (ignored || unlabelled.length) {
    reportWarning(`Chapter ${context.chapter.index + 1}, block ${block + 1}: ${[
      unlabelled.length ? `${unlabelled.length} quoted span(s) came back without a speaker and go to verification` : '',
      ignored ? `${ignored} label(s) for narration, unknown or repeated spans were ignored` : '',
    ].filter(Boolean).join('; ')}.`);
  }

  const edited = applySpanEdits(spans.map((span) => span.text), result.edits);
  reportSkippedEdits(context.chapter.index, block, edited);
  const labelled = spans.map((span, position): LabelledSpan => {
    const text = edited.texts[position];
    if (span.kind !== 'quote') return { span, text, speaker: 'narrator', confidence: 'high' };
    const label = labels.get(span.id);
    // A quote nobody labelled is never quietly handed to the narrator.
    if (!label) return { span, text, speaker: UNRESOLVED, confidence: 'low' };
    return { span, text, speaker: speakerName(label.speaker), confidence: label.confidence, delivery: label.delivery?.trim() || undefined };
  });
  return {
    segments: spansToSegments(labelled, config.narrationMergeChars),
    characters: spokenReports(result.characters, [...labels.values()].map((label) => label.speaker)),
  };
}

/** Match speakers to the cast, in place. Returns the positions that match nobody. */
function resolveSpeakers(segments: ScriptSegment[], cast: ChapterCast, resolutions: Map<string, string>): number[] {
  const unknown: number[] = [];
  segments.forEach((segment, position) => {
    if (segment.kind === 'pause' || segment.speaker === 'narrator') return;
    const decided = resolutions.get(nameKey(segment.speaker));
    const canonical = decided === undefined
      ? cast.canonical.get(nameKey(segment.speaker))
      : nameKey(decided) === 'narrator' ? 'narrator' : cast.canonical.get(nameKey(decided));
    if (canonical === undefined) {
      unknown.push(position);
      return;
    }
    segment.speaker = canonical;
    if (decided !== undefined) segment.confidence = 'high';
  });
  return unknown;
}

/**
 * One pass over the uncertain labels: the existing verification prompt, in
 * bounded batches. Returns the records it gave for speakers the cast lacks.
 */
async function verifySpeakers(segments: ScriptSegment[], toVerify: number[], cast: ChapterCast): Promise<CharacterReport[]> {
  const reports: CharacterReport[] = [];
  for (let offset = 0; offset < toVerify.length; offset += config.scriptVerificationBatchSize) {
    const batch = toVerify.slice(offset, offset + config.scriptVerificationBatchSize);
    const items = batch
      .map((i) => {
        const ctx = segments
          .slice(Math.max(0, i - 3), i + 4)
          .map((s, j) => `${Math.max(0, i - 3) + j === i ? '>>' : '  '} ${contextLine(s, 240)}`)
          .join('\n');
        return `Segment id ${i} (marked ">>"):\n${ctx}`;
      })
      .join('\n\n');

    const verified = await jsonCall({
      model: config.scriptReviewModel,
      reasoningEffort: config.scriptReasoningEffort,
      maxCompletionTokens: config.scriptMaxCompletionTokens,
      schema: VerifySchema,
      system: `You independently verify speaker attribution in an audiobook script. For every supplied segment id, decide who speaks the ">>" line. Respond with JSON: {"attributions": [{"id": number, "speaker": "name"}], "characters": [{"name", "aliases", "sex", "age", "named", "evidence"}]}. Current labels are tentative; check dialogue tags, turn-taking, pronouns, and scene context. Keep the current label if evidence does not support a change. Prefer canonical names from the character list. If a speaking character is missing, return their supported name or a specific role label for review. Use "${UNRESOLVED}" if dialogue cannot be attributed. Use "narrator" only for narration; missing characters are not narration. characters: one record for every speaker you return who is not in the character list — the fullest name the text gives, other names the text uses for them, sex ("male", "female" or "unknown"), an approximate age or "unknown", named=false for a speaker known only by a role, and a short quotation as evidence; [] when every speaker is in the list.`,
      user: `Characters:\n${castList(cast)}\n\n${items}`,
    });

    const byId = new Map(verified.attributions.map((a) => [a.id, a.speaker]));
    if (byId.size !== verified.attributions.length || byId.size !== batch.length
      || batch.some((id) => !byId.has(id)) || [...byId.keys()].some((id) => !batch.includes(id))) {
      throw new Error('Speaker verification returned missing, duplicate, or unexpected segment ids. Script was not saved; run the script stage again, and finished blocks are kept.');
    }
    for (const i of batch) {
      const speaker = speakerName(byId.get(i)!);
      const canonical = speaker === 'narrator' ? 'narrator' : cast.canonical.get(nameKey(speaker));
      segments[i].speaker = canonical ?? speaker;
      segments[i].confidence = canonical ? 'high' : 'low';
    }
    reports.push(...(verified.characters ?? []));
  }
  return reports;
}

const NOTED_WITHOUT_RECORD = 'Added from Script labels without a character record; traits are unknown. Review the name and details.';

/**
 * Add the speakers verification settled on to the cast. A weaker model often
 * names a new speaker in its labels and forgets the character record; when
 * verification then gives a record, or independently returns the very name the
 * label used, that is a known speaker rather than an unresolved one. A name
 * added without a record is flagged for review. "unresolved speaker", and a
 * name verification did not confirm, still stop the stage.
 */
function addVerifiedSpeakers(
  registry: CharacterRegistry,
  segments: ScriptSegment[],
  labelled: string[],
  verified: number[],
  reports: CharacterReport[],
  where: { story: string; chapter: number; storyLabel?: string },
): void {
  const names = new Set(verified.map((position) => segments[position].speaker)
    .filter((speaker) => speaker !== 'narrator' && nameKey(speaker) !== nameKey(UNRESOLVED)));
  addCharacters(registry, spokenReports(reports, names), { ...where, chunk: 0 });
  const agreed = new Set(verified
    .filter((position) => nameKey(labelled[position]) === nameKey(segments[position].speaker))
    .map((position) => segments[position].speaker));
  for (const name of names) {
    if (!agreed.has(name) || chapterCast(registry, where.story, where.chapter, where.storyLabel).canonical.has(nameKey(name))) continue;
    const [added] = addCharacters(registry, [CharacterReportSchema.parse({ name, named: !/^(?:the|a|an|some|one of)\s/i.test(name) })], { ...where, chunk: 0 });
    const character = registry.characters.find((entry) => entry.name === added && (entry.story || BOOK_STORY_ID) === where.story);
    if (character && !character.issues.includes(NOTED_WITHOUT_RECORD)) character.issues.push(NOTED_WITHOUT_RECORD);
  }
}

function unresolvedRecords(segments: ScriptSegment[], positions: number[], story: string, chapter: number): UnresolvedSpeakerRecord[] {
  const records = new Map<string, UnresolvedSpeakerRecord>();
  for (const position of positions) {
    const segment = segments[position];
    const record = records.get(nameKey(segment.speaker)) ?? { story, chapter, speaker: segment.speaker, samples: [] };
    if (record.samples.length < 3) {
      record.samples.push({
        text: segment.text,
        context: segments.slice(Math.max(0, position - 2), position + 3)
          .map((near, j) => `${Math.max(0, position - 2) + j === position ? '>>' : '  '} ${contextLine(near, 200)}`).join('\n'),
      });
    }
    records.set(nameKey(segment.speaker), record);
  }
  return [...records.values()];
}

/**
 * Stage 3: turn each chapter into an ordered script of {speaker, text,
 * delivery} segments, with one model call per chunk doing cleanup, speaker
 * attribution and character discovery together.
 *
 * The text is split in code. For quoted dialogue the model is shown numbered
 * spans and returns labels for the quoted ones, small corrections, and any
 * speaker the cast lacks; it never returns the text. A book that does not mark
 * dialogue with double quotation marks falls back to the model returning
 * segments, and non-fiction is narration needing corrections at most. A chunk
 * with no quotation marks and no cleanup trigger makes no call.
 *
 * The cast is discovered as the book is read, so the chapters of a story run
 * in order; separate stories run in parallel.
 */
export async function runScript(
  work: WorkDir,
  chapterIndexes?: number[],
  report: ProgressReporter = (_progress, message) => console.log(`  ${message}`),
): Promise<void> {
  const metadata = readProfiledMetadata(work);
  const stories = readStories(work);
  const registry = readCharacterRegistry(work, stories);
  const mode = scriptModeOf(metadata);
  work.dir(SCRIPTS_DIR);

  const narrated = new Set(metadata.profile.chapters.filter((plan) => plan.narrate).map((plan) => plan.index));
  const narratable = metadata.chapters
    .filter((ch) => narrated.has(ch.index))
    .filter((ch) => !chapterIndexes || chapterIndexes.includes(ch.index));

  // Chapters of one story share a running cast and must run in order.
  const groups = new Map<string, { story?: Story; chapters: ExtractedChapter[] }>();
  for (const ch of narratable) {
    const story = storyFor(stories, ch.index);
    if (stories.collection && !story) {
      throw new Error(`Chapter ${ch.index + 1} belongs to no story in stories.json. Rerun metadata, or add the chapter to a story, then rerun Script.`);
    }
    const id = story?.id ?? BOOK_STORY_ID;
    const group = groups.get(id) ?? { story, chapters: [] };
    group.chapters.push(ch);
    groups.set(id, group);
  }

  const run: ScriptRun = { work, metadata, stories, registry, mode, report, completed: 0, total: narratable.length };
  const limit = pLimit(config.llmConcurrency);
  const failures: Error[] = [];
  let cancelled: unknown;
  await Promise.all([...groups.entries()].map(([storyId, group]) => limit(async () => {
    try {
      for (const ch of group.chapters) {
        if (cancelled) return;
        throwIfTaskCancelled();
        await scriptChapter(run, ch, storyId, group.story);
      }
    } catch (err) {
      if (err instanceof TaskCancelledError) cancelled = err;
      // One story stopping for review must not waste the others' paid work.
      else failures.push(err as Error);
    }
  })));

  // Two stories can use one name for two people; label them once every story
  // in this run has settled, and rename the scripts already saved.
  for (const [storyId, renames] of labelSharedNames(registry, stories)) {
    renameSpeakers(work, stories.stories.find((story) => story.id === storyId)?.chapters ?? [], renames);
  }
  writeCharacterRegistry(work, registry);

  if (cancelled) throw cancelled;
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new Error(failures.map((failure) => failure.message).join('\n'));

  const review = registry.characters.filter((character) => character.issues.length);
  if (review.length) reportWarning(`${review.length} character(s) have notes for review in characters.json: ${review.map((c) => c.name).join(', ')}.`);
}

interface ScriptRun {
  work: WorkDir;
  metadata: BookMetadata;
  stories: Stories;
  registry: CharacterRegistry;
  mode: ScriptMode;
  report: ProgressReporter;
  completed: number;
  total: number;
}

async function scriptChapter(run: ScriptRun, ch: ExtractedChapter, storyId: string, story: Story | undefined): Promise<void> {
  const { work, metadata, stories, registry, mode } = run;
  const title = chapterTitle(metadata, ch.index);
  const storyLabel = storyLabels(stories).get(storyId);
  const storyChapters = story?.chapters ?? stories.stories.find((entry) => entry.id === storyId)?.chapters ?? [];
  const cast = (): ChapterCast => chapterCast(registry, storyId, ch.index, storyLabel);

  await withChapterProgress({
    chapterIndex: ch.index, chapterTitle: title,
    completedChapters: run.completed, totalChapters: run.total,
    phase: 'preparing', processedChars: 0, totalChars: 0,
  }, run.report, async (update) => {
    const done = (phase: ChapterProgress['phase']): void => {
      run.completed += 1;
      update({ phase, completedChapters: run.completed });
    };
    const source = normalizeNonBreakingSpaces(fs.readFileSync(work.path(ch.file), 'utf8'));
    const sourceHash = scriptSourceHash(source, mode);
    const existingFile = findChapterFile(work.root, SCRIPTS_DIR, ch.index, '.json');
    if (existingFile) {
      const existing = ChapterScriptSchema.safeParse(work.readJson(existingFile));
      if (existing.success && existing.data.sourceHash === sourceHash) return done('skipped');
    }

    const { title: heading, content: text } = splitLeadingChapterTitle(source);
    const context: ChapterContext = {
      work, metadata, mode, chapter: ch, title,
      storyTitle: stories.collection ? (story?.title || title) : undefined,
    };
    const blocks = scriptBlocks(text, mode);
    const totalChars = blocks.reduce((sum, block) => sum + block.text.length, 0);
    let processedChars = 0;

    // Blocks finished by an interrupted run are reused while the text is
    // unchanged, and replaying what each one added restores the cast as of
    // that block. The cast is not part of the key: a chapter that stopped on
    // an unresolved speaker resumes after the cast is corrected, and the
    // saved names are matched against it again below.
    const checkpoint = loadCheckpoint<BlockResult, ScriptSegment[]>(work, 'script', ch.index, sourceHash, blocks.length);
    const finished = checkpoint.blocks;
    for (const [i, saved] of finished.entries()) {
      addCharacters(registry, saved.characters, { story: storyId, chapter: ch.index, chunk: i, storyLabel });
      processedChars += blocks[i].text.length;
    }
    const attributed = (): ScriptSegment[] => finished.flatMap((block) => block.segments);

    for (const [i, block] of blocks.entries()) {
      if (i < finished.length) continue;
      throwIfTaskCancelled();
      let result: BlockResult = { segments: [], characters: [] };
      // A block that is only a scene break needs no request at all.
      if (block.text.trim()) {
        const request = chunkRequest(block.text, mode);
        update({ phase: request === 'none' ? 'preparing' : 'attributing', block: i + 1, totalBlocks: blocks.length, processedChars, totalChars });
        const tail = attributed().slice(-3).map((segment) => contextLine(segment)).join('\n');
        result = await scriptBlock(context, block.text, i, blocks.length, cast(), tail);
        addCharacters(registry, result.characters, { story: storyId, chapter: ch.index, chunk: i, storyLabel });
        writeCharacterRegistry(work, registry);
      }
      // The scene break that closed this block becomes silence, not speech.
      if (block.sceneBreak) result.segments.push(pauseSegment(block.sceneBreak));
      finished.push(result);
      saveCheckpoint(work, 'script', ch.index, sourceHash, finished);
      processedChars += block.text.length;
    }

    // Offline consolidation: a short name met early is folded into the full
    // name a later block gave, in this chapter and in the story's saved scripts.
    const renames = consolidateStory(registry, storyId);
    renameSpeakers(work, storyChapters, renames);

    // A person's answer for a blocked speaker applies to this chapter only.
    const resolutions = new Map(registry.unresolved
      .filter((record) => record.chapter === ch.index && record.resolveAs?.trim())
      .map((record) => [nameKey(record.speaker), record.resolveAs!.trim()]));

    let segments = checkpoint.result?.map((segment) => ({ ...segment }));
    if (!segments) {
      segments = attributed().map((segment) => ({ ...segment, speaker: renames.get(segment.speaker) ?? segment.speaker }));
      const unknown = new Set(resolveSpeakers(segments, cast(), resolutions));
      const toVerify = segments.flatMap((segment, position) =>
        segment.kind !== 'pause' && (unknown.has(position) || segment.confidence === 'low') ? [position] : []);
      if (toVerify.length) {
        update({ phase: 'verifying', processedChars, ambiguousSegments: toVerify.length });
        const labelled = segments.map((segment) => segment.speaker);
        const reports = await verifySpeakers(segments, toVerify, cast());
        addVerifiedSpeakers(registry, segments, labelled, toVerify, reports, { story: storyId, chapter: ch.index, storyLabel });
      }
      // Verification is paid for once: a chapter that stops below resumes from here.
      saveCheckpoint(work, 'script', ch.index, sourceHash, finished, segments);
    }

    const unresolved = resolveSpeakers(segments, cast(), resolutions);
    if (unresolved.length) {
      const records = unresolvedRecords(segments, unresolved, storyId, ch.index);
      // Answers already given stay on record: the checkpoint holds the names as the model wrote them.
      const answered = registry.unresolved.filter((record) => record.chapter === ch.index && record.resolveAs?.trim());
      setUnresolved(registry, ch.index, [...answered, ...records]);
      writeCharacterRegistry(work, registry);
      throw new Error(`New or unresolved speakers in chapter ${ch.index + 1}${stories.collection ? ` (story "${story?.title || title}")` : ''}: ${records.map((record) => record.speaker).join(', ')}. They are listed under "unresolved" in characters.json and in the workspace's Cast panel. For each, add the character, or set "resolveAs" to an existing character's name or to "narrator", then run Script again: the attributed text is kept and is not paid for twice.`);
    }

    update({ phase: 'saving', processedChars });
    setUnresolved(registry, ch.index, []);
    noteAppearances(registry, storyId, ch.index, segments.map((segment) => segment.speaker));
    const script: ChapterScript = { index: ch.index, story: storyId, mode, sourceHash, segments: withChapterTitle(segments, heading) };
    work.writeJson(existingFile ?? chapterFile(work.root, SCRIPTS_DIR, ch.index, title, '.json'), script);
    writeCharacterRegistry(work, registry);
    clearCheckpoints(work, 'script', [ch.index]);
    done('completed');
  });
}
