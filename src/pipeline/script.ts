import fs from 'node:fs';
import { z } from 'zod';
import { jsonCall } from '../providers/llm/openai.js';
import { config } from '../config.js';
import { markdownToSpeakable } from '../epub/markdown.js';
import { hasNarratableText, normalizeNonBreakingSpaces, splitIntoBlocks } from '../util/text.js';
import { reportWarning } from '../util/warnings.js';
import type { WorkDir } from '../state.js';
import { characterRegistryHash, readCharacterRegistry } from './list-characters.js';
import { withChapterProgress, type ChapterProgress, type ProgressReporter } from '../util/progress.js';
import {
  ScriptSegmentSchema,
  type Analysis,
  type BookMetadata,
  type ChapterScript,
  type ChapterSummaries,
  type ScriptSegment,
  type PersonProfile,
} from '../types.js';

const SegmentsSchema = z.object({ segments: z.array(ScriptSegmentSchema) });
const VerifySchema = z.object({
  attributions: z.array(z.object({ id: z.number(), speaker: z.string() })),
});
const NarrationRepairSchema = z.object({
  repairs: z.array(z.object({
    id: z.number().int().nonnegative(),
    segments: z.array(ScriptSegmentSchema).min(1),
  })),
});

// These are verbs that explicitly introduce or follow direct speech. Keeping
// this list local and intentionally broad lets us handle a large class of
// unambiguous EPUB prose before asking a model to interpret it.
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

/** Compare text coverage while allowing whitespace to move across segment boundaries. */
function coverageText(text: string): string {
  return normalizeNonBreakingSpaces(text).replace(/\s+/g, ' ').trim();
}

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

/**
 * Correct only suspicious character segments. The model must return an
 * ordered, verbatim replacement sequence. A malformed replacement is never
 * allowed to replace source text; it is ignored so the chapter can continue.
 */
async function repairNarrationBoundaries(
  segments: ScriptSegment[],
  castList: string,
  characters: PersonProfile[],
): Promise<ScriptSegment[]> {
  const deterministicallySplit = splitDeterministicNarrationBoundaries(segments, characters);
  const candidates = findNarrationAuditCandidates(deterministicallySplit);
  if (!candidates.length) return deterministicallySplit;

  const entries = candidates
    .map((id) => `Segment id ${id}, currently labelled ${JSON.stringify(deterministicallySplit[id].speaker)}:\n${JSON.stringify(deterministicallySplit[id].text)}`)
    .join('\n\n');
  const result = await jsonCall({
    model: config.analysisModel,
    schema: NarrationRepairSchema,
    system: `You repair narration boundaries in an audiobook script. Respond with JSON: {"repairs":[{"id":number,"segments":[{"speaker","text","delivery"?,"confidence"}]}]}.

For every supplied id, return a complete ordered replacement sequence for that segment.
- Copy the supplied text verbatim, in the same order. Do not add, remove, rewrite, or summarize words.
- Character segments contain only that character's direct speech. Keep its quotation marks.
- Put dialogue tags, actions, thoughts, descriptions, and all other narration in narrator segments.
- Split interleaved forms such as '"Hello," said Tom. "Goodbye."' into [Tom] "Hello," + [narrator] said Tom. + [Tom] "Goodbye."
- A supplied segment may already be valid unquoted dialogue; preserve it as one character segment when there is no narration to split.
- Use only "narrator" or a name from the character list. Mark clear assignments "high" and uncertain ones "low".`,
    user: `Characters:\n${castList}\n\nRepair these independently:\n${entries}`,
  });

  const repairs = new Map(result.repairs.map((repair) => [repair.id, repair.segments]));
  const unexpected = [...repairs.keys()].filter((id) => !candidates.includes(id));
  const missing = candidates.filter((id) => !repairs.has(id));
  if (unexpected.length || missing.length || repairs.size !== result.repairs.length) {
    const problems = [
      missing.length ? `no repair for segment(s) ${missing.join(', ')}` : '',
      unexpected.length ? `unexpected segment(s) ${unexpected.join(', ')}` : '',
      repairs.size !== result.repairs.length ? 'duplicate repair ids' : '',
    ].filter(Boolean).join('; ');
    throw new Error(`Narration-boundary audit returned ${problems}. Script was not saved; rerun the script stage.`);
  }

  const repaired = deterministicallySplit.flatMap((segment, id) => {
    const replacement = repairs.get(id);
    if (!replacement) return [segment];
    if (coverageText(replacement.map((part) => part.text).join(' ')) !== coverageText(segment.text)) {
      // An audit is advisory. The original attribution has already passed its
      // schema check, and the deterministic pass below can still separate
      // obvious quoted dialogue from narration. Do not make a repair model's
      // spelling/punctuation rewrite lose the entire chapter's progress.
      reportWarning(`Narration-boundary audit changed text in segment ${id}; ignored that repair and retained the source segment.`);
      return [segment];
    }
    return replacement;
  });
  const split = splitDeterministicNarrationBoundaries(repaired, characters);
  const unresolvedNarratorCandidates = findNarrationAuditCandidates(split)
    .filter((id) => split[id].speaker.toLowerCase() === 'narrator');
  if (unresolvedNarratorCandidates.length) {
    // A repair that fails coverage validation has already been discarded. Do
    // not turn that safe preservation of source text into a hard failure: the
    // user can inspect the retained, low-confidence narrator segments while
    // the rest of the chapter remains available for review and correction.
    for (const id of unresolvedNarratorCandidates) split[id].confidence = 'low';
    reportWarning(`Narration-boundary audit could not split dialogue in narrator segment(s) ${unresolvedNarratorCandidates.join(', ')}; retained the original text as low-confidence narration for review.`);
  }
  return split;
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
 * Stage 5: turn each cleaned chapter into an ordered script of
 * {speaker, text, delivery} segments. Fiction goes through LLM dialogue
 * attribution plus a verification pass on low-confidence segments;
 * non-fiction is entirely the narrator.
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
  const summaries = work.readJson<ChapterSummaries>('chapter-summaries.json');
  work.dir('script');

  const narratable = meta.chapters
    .filter((ch) => analysis.chapters.find((p) => p.index === ch.index)?.narrate)
    .filter((ch) => !chapterIndexes || chapterIndexes.includes(ch.index));

  // Canonical-name lookup, including aliases, case-insensitive.
  const canonical = new Map<string, string>();
  for (const c of registry.characters) {
    canonical.set(c.name.toLowerCase(), c.name);
    for (const a of c.aliases) canonical.set(a.toLowerCase(), c.name);
  }

  for (const [chapterPosition, ch] of narratable.entries()) {
    await withChapterProgress({
      chapterIndex: ch.index, chapterTitle: ch.title,
      completedChapters: chapterPosition, totalChapters: narratable.length,
      phase: 'preparing', processedChars: 0, totalChars: 0,
    }, report, async (update) => {
      const scriptFile = `script/${String(ch.index).padStart(2, '0')}.json`;
      if (fs.existsSync(work.path(scriptFile))) {
        // Keep per-chapter resume behavior, while repairing old output produced
        // before the layout-only segment guard was added.
        const existing = work.readJson<ChapterScript>(scriptFile);
        if (existing.characterRegistryHash === registryHash) {
          const text = fs.readFileSync(
            work.path(`chapters-clean/${String(ch.index).padStart(2, '0')}.md`),
            'utf8'
          );
          const { title } = splitLeadingChapterTitle(text);
          const segments = withChapterTitle(existing.segments, title);
          if (segments.length !== existing.segments.length || segments.some((segment, i) => segment !== existing.segments[i])) {
            work.writeJson(scriptFile, { ...existing, segments });
          }
          update({ phase: 'skipped', completedChapters: chapterPosition + 1 });
          return;
        }
      }

      const cleanedText = fs.readFileSync(
        work.path(`chapters-clean/${String(ch.index).padStart(2, '0')}.md`),
        'utf8'
      );
      const { title, content: text } = splitLeadingChapterTitle(cleanedText);

      let segments: ScriptSegment[];
      if (!analysis.isFiction) {
        segments = text
          .split(/\n\s*\n/)
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p) => ({ speaker: 'narrator', text: p, confidence: 'high' as const }));
        update({ phase: 'saving', totalChars: text.length, processedChars: text.length });
      } else {
        segments = await attributeChapter(text, ch.index, ch.title, analysis, summaries, canonical, registry.characters, update);
      }

      const candidates = segments.filter((segment) => segment.speaker !== 'narrator' && !canonical.has(segment.speaker.toLowerCase()));
      const candidatesFile = `character-candidates/${String(ch.index).padStart(2, '0')}.json`;
      if (candidates.length) {
        work.writeJson(candidatesFile, { index: ch.index, candidates });
        throw new Error(`New or unresolved speakers in chapter ${ch.index + 1}: ${[...new Set(candidates.map((s) => s.speaker))].join(', ')}. Review ${candidatesFile}, update chapter-characters/${String(ch.index).padStart(2, '0')}.json with supported identities, then run list-characters --rerun and script.`);
      }
      fs.rmSync(work.path(candidatesFile), { force: true });
      const script: ChapterScript = { index: ch.index, characterRegistryHash: registryHash, segments: withChapterTitle(segments, title) };
      work.writeJson(scriptFile, script);
      update({ phase: 'completed', completedChapters: chapterPosition + 1 });
    });
  }
}

async function attributeChapter(
  text: string,
  index: number,
  title: string,
  analysis: Analysis,
  summaries: ChapterSummaries,
  canonical: Map<string, string>,
  characters: PersonProfile[],
  update: (change: Partial<ChapterProgress>) => void,
): Promise<ScriptSegment[]> {
  const castList = characters
    .map((c) => `- ${c.name}${c.aliases.length ? ` (aka ${c.aliases.join(', ')})` : ''}: ${c.sex}, ${c.age}, ${c.importance}`)
    .join('\n');

  const blocks = splitIntoBlocks(text, config.llmChunkChars);
  const segments: ScriptSegment[] = [];
  const totalChars = blocks.reduce((sum, block) => sum + block.length, 0);
  let processedChars = 0;

  for (const [i, block] of blocks.entries()) {
    update({ phase: 'attributing', block: i + 1, totalBlocks: blocks.length, processedChars, totalChars });
    const tail = segments.slice(-3).map((s) => `[${s.speaker}] ${s.text.slice(0, 120)}`).join('\n');
    const result = await jsonCall({
      model: config.chapterModel,
      schema: SegmentsSchema,
      system: `You convert book text into a multi-voice audiobook script. Respond with JSON: {"segments": [{"speaker", "text", "delivery"?, "confidence"}]}.

Rules:
- Split all narratable prose into an ordered list of segments, in order. Copy that text VERBATIM — never rewrite, drop, or summarize it.
- Do not emit decorative layout-only section dividers, such as lines made solely of repeated asterisks, dashes, underscores, or whitespace. They are not narratable text and are excluded from the coverage requirement.
- Every segment must contain spoken content (at least one letter or number); never return a punctuation-only segment.
- "speaker" is "narrator" for all narration and dialogue tags ("she said"), or the character's name for quoted dialogue.
- Dialogue tags stay with the narrator: '"Hello," said Tom.' becomes [Tom] "Hello," + [narrator] said Tom.
- Keep quotation marks in the dialogue text.
- "delivery" (optional): a short hint when the text makes it explicit, e.g. "whispering", "shouting", "sobbing".
- "confidence": "high" when the speaker is clear, "low" when you are guessing.
- Only use speaker names from the character list; if the speaker is not in the list or unclear, use the name you believe is right with confidence "low".
- Merge consecutive narrator paragraphs into segments of at most 1500 characters.

Examples:

---

Example 1
Context: Conversation between Bertram Lupov and Alexander Adell.

Lupov cocked his head sideways. He had a trick of doing that when he wanted to be contrary, and he wanted to be contrary now, partly because he had had to carry the ice and glassware. "Not forever," he said.

"Oh, hell, just about forever. Till the sun runs down, Bert. Ten billion, maybe. Are you satisfied?"

Lupov put his fingers through his thinning hair as though to reassure himself that some was still left and sipped gently at his own drink. "Ten billion years isn't forever."

"Well, it will last our time, won't it?"

---

Output JSON:

{
  "speaker": "narrator",
  "text": "Lupov cocked his head sideways. He had a trick of doing that when he wanted to be contrary, and he wanted to be contrary now, partly because he had had to carry the ice and glassware.",
  "confidence": "high"
},
{
  "speaker": "Bertram Lupov",
  "text": "\"Not forever,\"",
  "confidence": "high"
},
{
  "speaker": "narrator",
  "text": "he said.",
  "confidence": "high"
},
{
  "speaker": "Alexander Adell",
  "text": "\"Oh, hell, just about forever. Till the sun runs down, Bert. Ten billion, maybe. Are you satisfied?\"",
  "confidence": "high"
},
{
  "speaker": "narrator",
  "text": "Lupov put his fingers through his thinning hair as though to reassure himself that some was still left and sipped gently at his own drink.",
  "confidence": "high"
},
{
  "speaker": "Bertram Lupov",
  "text": "\"Ten billion years isn't forever.\"",
  "confidence": "high"
},
{
  "speaker": "Alexander Adell",
  "text": "\"Well, it will last our time, won't it?\"",
  "confidence": "high"
},

---

Example 2
Context: Conversation between Jerrodine and Jerrodd...

Jerrodine's eyes were moist as she watched the visiplate. "I can't help it. I feel funny about leaving Earth."

"Why, for Pete's sake?" demanded Jerrodd. "We had nothing there." Then, after a reflective pause, "I tell you, it's a lucky thing the computers worked out interstellar travel the way the race is growing."

"I know, I know," said Jerrodine miserably.

---
Output JSON for Example 2...

{
  "speaker": "narrator",
  "text": "Jerrodine's eyes were moist as she watched the visiplate.",
  "confidence": "high"
},
{
  "speaker": "Jerrodine",
  "text": "\"I can't help it. I feel funny about leaving Earth.\"",
  "confidence": "high"
},
{
  "speaker": "Jerrodd",
  "text": "\"Why, for Pete's sake?\"",
  "confidence": "high"
},
{
  "speaker": "narrator",
  "text": "demanded Jerrodd.",
  "confidence": "high"
},
{
  "speaker": "Jerrodd",
  "text": "\"We had nothing there.\"",
  "confidence": "high"
},
{
  "speaker": "narrator",
  "text": "Then, after a reflective pause,",
  "confidence": "high"
},
{
  "speaker": "Jerrodd",
  "text": "\"I tell you, it's a lucky thing the computers worked out interstellar travel the way the race is growing.\"",
  "confidence": "high"
},
{
  "speaker": "Jerrodine",
  "text": "\"I know, I know,\"",
  "confidence": "high"
},
{
  "speaker": "narrator",
  "text": "said Jerrodine miserably.",
  "confidence": "high"
},
---
`,
      user: `Book: "${analysis.summary.slice(0, 400)}"
Chapter ${index}: "${title}"${blocks.length > 1 ? ` (part ${i + 1} of ${blocks.length})` : ''}
Chapter summary: ${summaries[index] ?? ''}

Characters:
${castList}
${tail ? `\nPrevious segments (context):\n${tail}` : ''}

Text:
${block}`,
    });
    const auditCandidates = findNarrationAuditCandidates(result.segments);
    if (auditCandidates.length) {
      update({ phase: 'repairing', processedChars, auditedSegments: auditCandidates.length });
    }
    segments.push(...await repairNarrationBoundaries(result.segments, castList, characters));
    processedChars += block.length;
  }

  // Normalize speaker names; collect ambiguous segments for verification.
  const ambiguous: number[] = [];
  segments.forEach((seg, i) => {
    if (seg.speaker.toLowerCase() === 'narrator') {
      seg.speaker = 'narrator';
      return;
    }
    const canon = canonical.get(seg.speaker.toLowerCase());
    if (canon) seg.speaker = canon;
    if (!canon || seg.confidence === 'low') ambiguous.push(i);
  });

  // Verification pass: re-attribute ambiguous segments with surrounding context.
  if (ambiguous.length > 0) {
    update({ phase: 'verifying', processedChars, ambiguousSegments: ambiguous.length });
    const items = ambiguous
      .map((i) => {
        const ctx = segments
          .slice(Math.max(0, i - 2), i + 3)
          .map((s, j) => `${Math.max(0, i - 2) + j === i ? '>>' : '  '} [${s.speaker}] ${s.text.slice(0, 200)}`)
          .join('\n');
        return `Segment id ${i} (marked ">>"):\n${ctx}`;
      })
      .join('\n\n');

    const verified = await jsonCall({
      model: config.analysisModel,
      schema: VerifySchema,
      system: `You verify speaker attribution in an audiobook script. For each segment id, decide who speaks the ">>" line. Respond with JSON: {"attributions": [{"id": number, "speaker": "name"}]}. Prefer canonical names from the character list. If a speaking character is missing, return their supported name or a specific role label for review. Use "unresolved speaker" if dialogue cannot be attributed. Use "narrator" only for narration; missing characters are not narration.`,
      user: `Characters:\n${castList}\n\n${items}`,
    });

    const byId = new Map(verified.attributions.map((a) => [a.id, a.speaker]));
    for (const i of ambiguous) {
      const speaker = byId.get(i);
      const canon = speaker && canonical.get(speaker.toLowerCase());
      segments[i].speaker =
        speaker?.toLowerCase() === 'narrator' ? 'narrator' : (canon ?? speaker ?? 'unresolved speaker');
      segments[i].confidence = canon || speaker?.toLowerCase() === 'narrator' ? 'high' : 'low';
    }
  }

  update({ phase: 'saving', processedChars });
  return segments;
}
