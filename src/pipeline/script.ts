import fs from 'node:fs';
import { z } from 'zod';
import { jsonCall } from '../providers/llm/openai.js';
import { config } from '../config.js';
import { markdownToSpeakable } from '../epub/markdown.js';
import { hasNarratableText, normalizeNonBreakingSpaces, splitIntoBlocks } from '../util/text.js';
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
- Merge consecutive narrator paragraphs into segments of at most 1500 characters.`,
      user: `Book: "${analysis.summary.slice(0, 400)}"
Chapter ${index}: "${title}"${blocks.length > 1 ? ` (part ${i + 1} of ${blocks.length})` : ''}
Chapter summary: ${summaries[index] ?? ''}

Characters:
${castList}
${tail ? `\nPrevious segments (context):\n${tail}` : ''}

Text:
${block}`,
    });
    segments.push(...result.segments);
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
