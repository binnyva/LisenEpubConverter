import fs from 'node:fs';
import { z } from 'zod';
import { jsonCall } from '../providers/llm/openai.js';
import { config } from '../config.js';
import { condenseSummary, normalizeNonBreakingSpaces, splitIntoBlocks } from '../util/text.js';
import type { WorkDir } from '../state.js';
import type { Analysis, BookMetadata, ChapterSummaries } from '../types.js';
import { CharacterObservationSchema, ChapterCharactersSchema, type ChapterCharacters } from '../types.js';
import { buildCharacterRegistry, characterChapterFile } from './list-characters.js';
import { readStories, storyFor } from './stories.js';
import { reportProgress, type ChapterProgress } from '../util/progress.js';
import { applyCleanupEdits, dropLayoutOnlyParagraphs } from './cleanup.js';
import { reportWarning } from '../util/warnings.js';
import { checkpointKey, clearCheckpoints, loadCheckpoint, saveCheckpoint } from './checkpoint.js';

const DiscoverySchema = z.object({ characters: z.array(CharacterObservationSchema) });
const ChunkResultSchema = DiscoverySchema.extend({
  edits: z.array(z.object({ find: z.string(), replace: z.string() })),
  partialSummary: z.string(),
});

/** One finished block of a chapter, saved so an interrupted chapter resumes instead of restarting. */
interface ChapterBlockCheckpoint {
  cleanedText?: string;
  partialSummary?: string;
  observations: ChapterCharacters['observations'];
}

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

const observationKey = (name: string): string => name.normalize('NFKC').trim().toLowerCase();
const importanceRank = { minor: 0, secondary: 1, main: 2 } as const;

/**
 * A chapter is processed in chunks, so the same speaker can be found more than
 * once. Keep one chapter-level observation for each normalized name while
 * retaining the useful evidence and the strongest supported profile details.
 */
export function mergeChapterObservations(
  observations: ChapterCharacters['observations'],
): ChapterCharacters['observations'] {
  const groups = new Map<string, ChapterCharacters['observations']>();
  for (const observation of observations) {
    const name = observation.name.trim();
    const identity = observationKey(name);
    // Preserve malformed/blank observations as-is; the schema or later review
    // can surface them instead of silently combining unrelated records.
    if (!identity) {
      groups.set(`__blank_${groups.size}`, [{ ...observation, name }]);
      continue;
    }
    const group = groups.get(identity) ?? [];
    group.push({ ...observation, name });
    groups.set(identity, group);
  }

  return [...groups.values()].map((group) => {
    const first = group[0];
    if (group.length === 1) return first;

    const aliases: string[] = [];
    const seenAliases = new Set<string>();
    const evidence: string[] = [];
    const seenEvidence = new Set<string>();
    for (const observation of group) {
      for (const alias of observation.aliases) {
        const trimmed = alias.trim();
        const identity = observationKey(trimmed);
        if (identity && !seenAliases.has(identity)) {
          seenAliases.add(identity);
          aliases.push(trimmed);
        }
      }
      const text = observation.evidence.trim();
      const identity = observationKey(text);
      if (text && !seenEvidence.has(identity)) {
        seenEvidence.add(identity);
        evidence.push(text);
      }
    }

    const supported = (field: 'sex' | 'age' | 'race' | 'class' | 'country'): string => group
      .map((observation) => observation[field])
      .find((value) => observationKey(value) !== 'unknown') ?? 'unknown';
    return {
      ...first,
      aliases,
      evidence: evidence.join(' '),
      named: group.some((observation) => observation.named),
      confidence: group.some((observation) => observation.confidence === 'high') ? 'high' as const : 'low' as const,
      importance: group.reduce((best, observation) =>
        importanceRank[observation.importance] > importanceRank[best] ? observation.importance : best,
      first.importance),
      chunk: Math.min(...group.map((observation) => observation.chunk)),
      sex: supported('sex') as 'male' | 'female' | 'unknown',
      age: supported('age'),
      race: supported('race'),
      class: supported('class'),
      country: supported('country'),
    };
  });
}

/**
 * Stage 3: per narratable chapter — a summary (context for later stages) and a
 * lightly cleaned version of the text for audio. Processes chapters in order so
 * each one gets the previous summaries as rolling context; already-processed
 * chapters are skipped on re-runs.
 */
export async function runChapters(work: WorkDir, chapterIndexes?: number[]): Promise<void> {
  const meta = work.readJson<BookMetadata>('metadata.json');
  const analysis = work.readJson<Analysis>('analysis.json');
  const stories = readStories(work);
  work.dir('chapters-clean');

  const summaries: ChapterSummaries = fs.existsSync(work.path(SUMMARIES_FILE))
    ? work.readJson<ChapterSummaries>(SUMMARIES_FILE)
    : {};

  const narratable = meta.chapters
    .filter((ch) => analysis.chapters.find((p) => p.index === ch.index)?.narrate)
    .filter((ch) => !chapterIndexes || chapterIndexes.includes(ch.index));

  let completedChapters = 0;
  for (const ch of narratable) {
    let processedChars = 0;
    let totalChars = 0;
    const progress = (activity: string, phase?: ChapterProgress['phase']) => reportProgress({
      activity, phase, chapterIndex: ch.index, chapterTitle: ch.title,
      completedChapters, totalChapters: narratable.length,
      completedUnits: processedChars, totalUnits: totalChars, unit: 'characters processed',
    });
    progress('Checking existing chapter output');
    const cleanFile = `chapters-clean/${String(ch.index).padStart(2, '0')}.md`;
    const observationFile = characterChapterFile(ch.index);
    const hasCleanOutput = summaries[ch.index] !== undefined && fs.existsSync(work.path(cleanFile));
    if (hasCleanOutput) {
      // Repair legacy clean files without re-running an LLM call.
      const existing = fs.readFileSync(work.path(cleanFile), 'utf8');
      const normalized = normalizeNonBreakingSpaces(existing);
      if (normalized !== existing) fs.writeFileSync(work.path(cleanFile), normalized);
      if (fs.existsSync(work.path(observationFile))) {
        const existingObservations = ChapterCharactersSchema.parse(work.readJson(observationFile));
        const mergedObservations = mergeChapterObservations(existingObservations.observations);
        if (mergedObservations.length !== existingObservations.observations.length) {
          work.writeJson(observationFile, { ...existingObservations, observations: mergedObservations });
        }
        completedChapters++;
        progress('Reusing cleaned text, summary and character observations', 'skipped');
        continue;
      }
      if (!analysis.isFiction) {
        work.writeJson(observationFile, { index: ch.index, observations: [] });
        completedChapters++;
        progress('Reused cleaned text and saved empty character observations', 'completed');
        continue;
      }
    }

    const text = fs.readFileSync(work.path(ch.file), 'utf8');
    const blocks = splitIntoBlocks(text, config.llmChunkChars);
    totalChars = blocks.reduce((sum, block) => sum + block.length, 0);

    // In a collection, another story's summaries and cast are noise that
    // invites the model to reuse a name across unrelated stories.
    const storyChapters = storyFor(stories, ch.index)?.chapters ?? [];
    const inScope = (index: number): boolean => !stories.collection || storyChapters.includes(index);
    const recentSummaries = Object.entries(summaries)
      .filter(([index]) => inScope(Number(index)))
      .slice(-5)
      // A long chapter's summary is one summary per block; sent whole it
      // outweighs the text being processed.
      .map(([i, s]) => `Chapter ${i}: ${condenseSummary(s, config.promptSummaryChars)}`)
      .join('\n');

    const cleanedParts: string[] = [];
    const partialSummaries: string[] = [];
    const discoveries: ChapterCharacters = { index: ch.index, observations: [] };
    const earlierDiscoveries = meta.chapters
      .filter((earlier) => earlier.index < ch.index && analysis.chapters.some((plan) => plan.index === earlier.index && plan.narrate))
      .filter((earlier) => inScope(earlier.index))
      .filter((earlier) => fs.existsSync(work.path(characterChapterFile(earlier.index))))
      .map((earlier) => ChapterCharactersSchema.parse(work.readJson(characterChapterFile(earlier.index))));
    // Blocks finished by an interrupted run of this same text are reused.
    const checkpoint = checkpointKey(hasCleanOutput ? 'discover' : 'clean', config.llmChunkChars, text);
    const finished = loadCheckpoint<ChapterBlockCheckpoint>(work, 'chapters', ch.index, checkpoint, blocks.length);
    for (const [i, saved] of finished.entries()) {
      if (!hasCleanOutput) {
        cleanedParts.push(saved.cleanedText ?? '');
        partialSummaries.push(saved.partialSummary ?? '');
      }
      discoveries.observations.push(...saved.observations);
      processedChars += blocks[i].length;
    }
    if (finished.length) progress(`Resuming after ${finished.length} of ${blocks.length} block(s) saved by an interrupted run`);
    const saveBlock = (saved: ChapterBlockCheckpoint): void => {
      finished.push(saved);
      saveCheckpoint(work, 'chapters', ch.index, checkpoint, finished);
    };
    for (const [i, block] of blocks.entries()) {
      if (i < finished.length) continue;
      progress(`${hasCleanOutput ? 'Discovering speakers in' : 'Cleaning and summarizing'} block ${i + 1}/${blocks.length} — waiting for model response`);
      const knownCharacters = buildCharacterRegistry([...earlierDiscoveries, discoveries]).characters
        .map(({ name, aliases, chapters }) => ({ name, aliases, chapters }));
      const context = `Book: "${meta.title}" (${analysis.isFiction ? 'fiction' : 'non-fiction'}${stories.collection ? ', a collection of separate short stories' : ''})
Book summary (provisional): ${analysis.summary}
${stories.collection
  ? `This chapter belongs to the story "${storyFor(stories, ch.index)?.title ?? ch.title}". Characters from other stories in this book are different people, even when they share a name.`
  : `Initial character candidates: ${JSON.stringify(analysis.characters)}`}
Characters discovered so far in this story (context only; report observations from THIS text): ${JSON.stringify(knownCharacters)}
${recentSummaries ? `Recent chapter summaries:\n${recentSummaries}\n` : ''}
Chapter ${ch.index}: "${ch.title}" (part ${i + 1} of ${blocks.length})
Text:\n${block}`;
      if (hasCleanOutput) {
        // Backfill old runs without paying to clean the chapter again or altering saved prose.
        const result = await jsonCall({
          model: config.chapterModel,
          disableReasoning: !analysis.isFiction,
          schema: DiscoverySchema,
          system: `Identify audiobook speakers. Respond with JSON: {"characters": [...]}\n${CHARACTER_RULES}`,
          user: context,
        });
        const observations = result.characters.map((character) => ({ ...character, chunk: i }));
        discoveries.observations.push(...observations);
        saveBlock({ observations });
        processedChars += block.length;
        continue;
      }
      const result = await jsonCall({
        model: config.chapterModel,
        disableReasoning: !analysis.isFiction,
        schema: ChunkResultSchema,
        system: `You prepare book chapters for audiobook narration. Respond with JSON: {"edits": [{"find": "...", "replace": "..."}], "partialSummary": "...", "characters": [...]}.

edits: the text is kept exactly as written. List only the small corrections it needs to read well aloud. Most text needs none; return "edits": [] then.
- find: a short exact quotation from the text, copied character for character, with enough neighbouring words to identify the place. replace: what should be read instead. Every occurrence of find in this text is replaced.
- Expand abbreviations and units that a narrator would say in full ("i.e." becomes "that is", "5 km" becomes "5 kilometres"; "Mr." stays).
- Spell out unusual symbols. Remove footnote markers and citation numbers, quoting the word they are attached to ("women.12" becomes "women.").
- Correct an obvious scanning or typesetting error only when the intended word is certain.
- Do not change wording, spelling, contractions, punctuation, quotation marks, or style. Do not remove or rewrite sentences. Do not touch markdown headings.

partialSummary: 2-4 sentences summarizing what happens in THIS text.
${CHARACTER_RULES}`,
        user: context,
      });
      // The model lists corrections; the prose itself is the source text.
      const cleanup = applyCleanupEdits(block, result.edits ?? []);
      if (cleanup.skipped.length) {
        reportWarning(`Chapter ${ch.index + 1}, block ${i + 1}: skipped ${cleanup.skipped.length} cleanup edit(s) and kept the source text there (${cleanup.skipped.slice(0, 3)
          .map(({ find, reason }) => `${JSON.stringify(find.slice(0, 40))}: ${reason}`).join('; ')}${cleanup.skipped.length > 3 ? '; …' : ''}).`);
      }
      const cleanedText = normalizeNonBreakingSpaces(dropLayoutOnlyParagraphs(cleanup.text));
      const observations = analysis.isFiction ? result.characters.map((character) => ({ ...character, chunk: i })) : [];
      cleanedParts.push(cleanedText);
      partialSummaries.push(result.partialSummary);
      discoveries.observations.push(...observations);
      saveBlock({ cleanedText, partialSummary: result.partialSummary, observations });
      processedChars += block.length;
    }

    progress('Saving chapter output', 'saving');
    if (!hasCleanOutput) {
      fs.writeFileSync(work.path(cleanFile), cleanedParts.join('\n\n'));
      summaries[ch.index] = partialSummaries.join(' ');
      work.writeJson(SUMMARIES_FILE, summaries);
    }
    work.writeJson(observationFile, {
      ...discoveries,
      observations: mergeChapterObservations(discoveries.observations),
    });
    clearCheckpoints(work, 'chapters', [ch.index]);
    completedChapters++;
    progress('Chapter complete', 'completed');
  }
}
