import fs from 'node:fs';
import { z } from 'zod';
import { jsonCall } from '../providers/llm/openai.js';
import { config } from '../config.js';
import { splitIntoBlocks } from '../util/text.js';
import type { WorkDir } from '../state.js';
import {
  ScriptSegmentSchema,
  type Analysis,
  type BookMetadata,
  type ChapterScript,
  type ChapterSummaries,
  type ScriptSegment,
} from '../types.js';

const SegmentsSchema = z.object({ segments: z.array(ScriptSegmentSchema) });
const VerifySchema = z.object({
  attributions: z.array(z.object({ id: z.number(), speaker: z.string() })),
});

/**
 * Stage 4: turn each cleaned chapter into an ordered script of
 * {speaker, text, delivery} segments. Fiction goes through LLM dialogue
 * attribution plus a verification pass on low-confidence segments;
 * non-fiction is entirely the narrator.
 */
export async function runScript(work: WorkDir): Promise<void> {
  const meta = work.readJson<BookMetadata>('metadata.json');
  const analysis = work.readJson<Analysis>('analysis.json');
  const summaries = work.readJson<ChapterSummaries>('chapter-summaries.json');
  work.dir('script');

  const narratable = meta.chapters.filter(
    (ch) => analysis.chapters.find((p) => p.index === ch.index)?.narrate
  );

  // Canonical-name lookup, including aliases, case-insensitive.
  const canonical = new Map<string, string>();
  for (const c of analysis.characters) {
    canonical.set(c.name.toLowerCase(), c.name);
    for (const a of c.aliases) canonical.set(a.toLowerCase(), c.name);
  }

  for (const ch of narratable) {
    const scriptFile = `script/${String(ch.index).padStart(2, '0')}.json`;
    if (fs.existsSync(work.path(scriptFile))) continue;

    const text = fs.readFileSync(
      work.path(`chapters-clean/${String(ch.index).padStart(2, '0')}.md`),
      'utf8'
    );

    let segments: ScriptSegment[];
    if (!analysis.isFiction || analysis.characters.length === 0) {
      segments = text
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => ({ speaker: 'narrator', text: p, confidence: 'high' as const }));
    } else {
      console.log(`  Chapter ${ch.index}: "${ch.title}"`);
      segments = await attributeChapter(text, ch.index, ch.title, analysis, summaries, canonical);
    }

    const script: ChapterScript = { index: ch.index, segments };
    work.writeJson(scriptFile, script);
  }
}

async function attributeChapter(
  text: string,
  index: number,
  title: string,
  analysis: Analysis,
  summaries: ChapterSummaries,
  canonical: Map<string, string>
): Promise<ScriptSegment[]> {
  const castList = analysis.characters
    .map((c) => `- ${c.name}${c.aliases.length ? ` (aka ${c.aliases.join(', ')})` : ''}: ${c.sex}, ${c.age}, ${c.importance}`)
    .join('\n');

  const blocks = splitIntoBlocks(text, config.llmChunkChars);
  const segments: ScriptSegment[] = [];

  for (const [i, block] of blocks.entries()) {
    const tail = segments.slice(-3).map((s) => `[${s.speaker}] ${s.text.slice(0, 120)}`).join('\n');
    const result = await jsonCall({
      model: config.chapterModel,
      schema: SegmentsSchema,
      system: `You convert book text into a multi-voice audiobook script. Respond with JSON: {"segments": [{"speaker", "text", "delivery"?, "confidence"}]}.

Rules:
- Split the text into an ordered list of segments covering ALL of the text, in order. Copy text VERBATIM — never rewrite, drop, or summarize anything.
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
    console.log(`    Verifying ${ambiguous.length} ambiguous attribution(s)`);
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
      system: `You verify speaker attribution in an audiobook script. For each segment id, decide who speaks the ">>" line. Respond with JSON: {"attributions": [{"id": number, "speaker": "name"}]}. Use ONLY names from the character list, or "narrator" if it is narration or genuinely unattributable.`,
      user: `Characters:\n${castList}\n\n${items}`,
    });

    const byId = new Map(verified.attributions.map((a) => [a.id, a.speaker]));
    for (const i of ambiguous) {
      const speaker = byId.get(i);
      const canon = speaker && canonical.get(speaker.toLowerCase());
      segments[i].speaker =
        speaker?.toLowerCase() === 'narrator' ? 'narrator' : (canon ?? 'narrator');
      segments[i].confidence = 'high';
    }
  }

  return segments;
}
