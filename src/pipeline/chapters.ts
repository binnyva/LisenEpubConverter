import fs from 'node:fs';
import { z } from 'zod';
import { jsonCall } from '../providers/llm/openai.js';
import { config } from '../config.js';
import { splitIntoBlocks } from '../util/text.js';
import type { WorkDir } from '../state.js';
import type { Analysis, BookMetadata, ChapterSummaries } from '../types.js';

const ChunkResultSchema = z.object({
  cleanedText: z.string(),
  partialSummary: z.string(),
});

const SUMMARIES_FILE = 'chapter-summaries.json';

/**
 * Stage 3: per narratable chapter — a summary (context for later stages) and a
 * lightly cleaned version of the text for audio. Processes chapters in order so
 * each one gets the previous summaries as rolling context; already-processed
 * chapters are skipped on re-runs.
 */
export async function runChapters(work: WorkDir): Promise<void> {
  const meta = work.readJson<BookMetadata>('metadata.json');
  const analysis = work.readJson<Analysis>('analysis.json');
  work.dir('chapters-clean');

  const summaries: ChapterSummaries = fs.existsSync(work.path(SUMMARIES_FILE))
    ? work.readJson<ChapterSummaries>(SUMMARIES_FILE)
    : {};

  const narratable = meta.chapters.filter(
    (ch) => analysis.chapters.find((p) => p.index === ch.index)?.narrate
  );

  for (const ch of narratable) {
    const cleanFile = `chapters-clean/${String(ch.index).padStart(2, '0')}.md`;
    if (summaries[ch.index] !== undefined && fs.existsSync(work.path(cleanFile))) continue;

    console.log(`  Chapter ${ch.index}: "${ch.title}" (${ch.words} words)`);
    const text = fs.readFileSync(work.path(ch.file), 'utf8');
    const blocks = splitIntoBlocks(text, config.llmChunkChars);

    const recentSummaries = Object.entries(summaries)
      .slice(-5)
      .map(([i, s]) => `Chapter ${i}: ${s}`)
      .join('\n');

    const cleanedParts: string[] = [];
    const partialSummaries: string[] = [];
    for (const [i, block] of blocks.entries()) {
      const result = await jsonCall({
        model: config.chapterModel,
        schema: ChunkResultSchema,
        system: `You prepare book chapters for audiobook narration. Respond with JSON: {"cleanedText": "...", "partialSummary": "..."}.

cleanedText rules — change AS LITTLE AS POSSIBLE:
- Keep the text verbatim except for things that read badly aloud.
- Expand abbreviations that a narrator would say in full (e.g. "Mr." stays, but "i.e." becomes "that is").
- Spell out unusual symbols, footnote markers, or citation numbers, or drop them if they add nothing.
- Keep markdown headings as-is (they are handled later).
- Never summarize, shorten, or reorder the actual content.

partialSummary: 2-4 sentences summarizing what happens in THIS text.`,
        user: `Book: "${meta.title}" (${analysis.isFiction ? 'fiction' : 'non-fiction'})
Book summary: ${analysis.summary}
${recentSummaries ? `Recent chapter summaries:\n${recentSummaries}\n` : ''}
Chapter ${ch.index}: "${ch.title}"${blocks.length > 1 ? ` (part ${i + 1} of ${blocks.length})` : ''}

Text:
${block}`,
      });
      cleanedParts.push(result.cleanedText);
      partialSummaries.push(result.partialSummary);
    }

    fs.writeFileSync(work.path(cleanFile), cleanedParts.join('\n\n'));
    summaries[ch.index] = partialSummaries.join(' ');
    work.writeJson(SUMMARIES_FILE, summaries);
  }
}
