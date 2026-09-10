import fs from 'node:fs';
import { z } from 'zod';
import { jsonCall } from '../providers/llm/openai.js';
import { config } from '../config.js';
import { normalizeNonBreakingSpaces, splitIntoBlocks } from '../util/text.js';
import type { WorkDir } from '../state.js';
import type { Analysis, BookMetadata, ChapterSummaries } from '../types.js';
import { CharacterObservationSchema, ChapterCharactersSchema, type ChapterCharacters } from '../types.js';
import { buildCharacterRegistry, characterChapterFile } from './list-characters.js';

const DiscoverySchema = z.object({ characters: z.array(CharacterObservationSchema) });
const ChunkResultSchema = DiscoverySchema.extend({
  cleanedText: z.string(),
  partialSummary: z.string(),
});

const SUMMARIES_FILE = 'chapter-summaries.json';
const CHARACTER_RULES = `characters: list speaking characters actually present in THIS text, including unnamed speakers identified by a specific role.
- Include name, aliases, sex, age, race, class, country, importance, evidence, named, confidence for each.
- evidence must be a short quotation or concrete textual evidence for identity and traits.
- Set named=false for unnamed roles. Keep distinct unnamed speakers distinct with specific labels.
- Only add aliases explicitly supported as the same person. Use confidence="low" for uncertain identities or traits.
- Use sex="male|female|unknown", importance="main|secondary|minor", confidence="high|low".
- Use "unknown" for unsupported traits. Do not infer race, nationality, or accent from names.
- The initial character candidates are provisional context, not a closed list. Discover late-appearing speakers.
- For non-fiction return characters: [].`;

/**
 * Stage 3: per narratable chapter — a summary (context for later stages) and a
 * lightly cleaned version of the text for audio. Processes chapters in order so
 * each one gets the previous summaries as rolling context; already-processed
 * chapters are skipped on re-runs.
 */
export async function runChapters(work: WorkDir, chapterIndexes?: number[]): Promise<void> {
  const meta = work.readJson<BookMetadata>('metadata.json');
  const analysis = work.readJson<Analysis>('analysis.json');
  work.dir('chapters-clean');

  const summaries: ChapterSummaries = fs.existsSync(work.path(SUMMARIES_FILE))
    ? work.readJson<ChapterSummaries>(SUMMARIES_FILE)
    : {};

  const narratable = meta.chapters
    .filter((ch) => analysis.chapters.find((p) => p.index === ch.index)?.narrate)
    .filter((ch) => !chapterIndexes || chapterIndexes.includes(ch.index));

  for (const ch of narratable) {
    const cleanFile = `chapters-clean/${String(ch.index).padStart(2, '0')}.md`;
    const observationFile = characterChapterFile(ch.index);
    const hasCleanOutput = summaries[ch.index] !== undefined && fs.existsSync(work.path(cleanFile));
    if (hasCleanOutput) {
      // Repair legacy clean files without re-running an LLM call.
      const existing = fs.readFileSync(work.path(cleanFile), 'utf8');
      const normalized = normalizeNonBreakingSpaces(existing);
      if (normalized !== existing) fs.writeFileSync(work.path(cleanFile), normalized);
      if (fs.existsSync(work.path(observationFile))) continue;
      if (!analysis.isFiction) {
        work.writeJson(observationFile, { index: ch.index, observations: [] });
        continue;
      }
    }

    console.log(`  Chapter ${ch.index}: "${ch.title}" (${ch.words} words)`);
    const text = fs.readFileSync(work.path(ch.file), 'utf8');
    const blocks = splitIntoBlocks(text, config.llmChunkChars);

    const recentSummaries = Object.entries(summaries)
      .slice(-5)
      .map(([i, s]) => `Chapter ${i}: ${s}`)
      .join('\n');

    const cleanedParts: string[] = [];
    const partialSummaries: string[] = [];
    const discoveries: ChapterCharacters = { index: ch.index, observations: [] };
    const earlierDiscoveries = meta.chapters
      .filter((earlier) => earlier.index < ch.index && analysis.chapters.some((plan) => plan.index === earlier.index && plan.narrate))
      .filter((earlier) => fs.existsSync(work.path(characterChapterFile(earlier.index))))
      .map((earlier) => ChapterCharactersSchema.parse(work.readJson(characterChapterFile(earlier.index))));
    for (const [i, block] of blocks.entries()) {
      const knownCharacters = buildCharacterRegistry([...earlierDiscoveries, discoveries]).characters
        .map(({ name, aliases, chapters }) => ({ name, aliases, chapters }));
      const context = `Book: "${meta.title}" (${analysis.isFiction ? 'fiction' : 'non-fiction'})
Book summary (provisional): ${analysis.summary}
Initial character candidates: ${JSON.stringify(analysis.characters)}
Characters discovered so far (context only; report observations from THIS text): ${JSON.stringify(knownCharacters)}
${recentSummaries ? `Recent chapter summaries:\n${recentSummaries}\n` : ''}
Chapter ${ch.index}: "${ch.title}" (part ${i + 1} of ${blocks.length})
Text:\n${block}`;
      if (hasCleanOutput) {
        // Backfill old runs without paying to clean the chapter again or altering saved prose.
        const result = await jsonCall({
          model: config.chapterModel,
          schema: DiscoverySchema,
          system: `Identify audiobook speakers. Respond with JSON: {"characters": [...]}\n${CHARACTER_RULES}`,
          user: context,
        });
        discoveries.observations.push(...result.characters.map((character) => ({ ...character, chunk: i })));
        continue;
      }
      const result = await jsonCall({
        model: config.chapterModel,
        schema: ChunkResultSchema,
        system: `You prepare book chapters for audiobook narration. Respond with JSON: {"cleanedText": "...", "partialSummary": "...", "characters": [...]}.

cleanedText rules — change AS LITTLE AS POSSIBLE:
- Keep the text verbatim except for things that read badly aloud.
- Expand abbreviations that a narrator would say in full (e.g. "Mr." stays, but "i.e." becomes "that is").
- Spell out unusual symbols, footnote markers, or citation numbers, or drop them if they add nothing.
- Drop decorative layout-only section dividers (for example, lines made only of repeated asterisks, dashes, or underscores). They are not narration.
- Keep markdown headings as-is (they are handled later).
- Never summarize, shorten, or reorder the actual content.

partialSummary: 2-4 sentences summarizing what happens in THIS text.
${CHARACTER_RULES}`,
        user: context,
      });
      cleanedParts.push(normalizeNonBreakingSpaces(result.cleanedText));
      partialSummaries.push(result.partialSummary);
      if (analysis.isFiction) discoveries.observations.push(...result.characters.map((character) => ({ ...character, chunk: i })));
    }

    if (!hasCleanOutput) {
      fs.writeFileSync(work.path(cleanFile), cleanedParts.join('\n\n'));
      summaries[ch.index] = partialSummaries.join(' ');
      work.writeJson(SUMMARIES_FILE, summaries);
    }
    work.writeJson(observationFile, discoveries);
  }
}
