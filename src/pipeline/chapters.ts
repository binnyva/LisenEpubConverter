import fs from 'node:fs';
import type { WorkDir } from '../state.js';
import type { Analysis, BookMetadata, ChapterSummaries } from '../types.js';
import { reportProgress, type ChapterProgress } from '../util/progress.js';
import { normalizePlainText } from '../epub/markdown.js';

const SUMMARIES_FILE = 'chapter-summaries.json';


/**
 * Stage 3: deterministically normalize every narratable chapter into the
 * exact plain text frozen for whole-book annotation. Matching prepared files
 * are skipped on resumptions; summaries remain optional compatibility data.
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

  let completedChapters = 0;
  for (const ch of narratable) {
    const source = fs.readFileSync(work.path(ch.file), 'utf8');
    const text = normalizePlainText(source);
    const progress = (activity: string, phase?: ChapterProgress['phase']) => reportProgress({
      activity, phase, chapterIndex: ch.index, chapterTitle: ch.title,
      completedChapters, totalChapters: narratable.length,
      completedUnits: text.length, totalUnits: text.length, unit: 'characters prepared',
    });
    if (!text || !/[\p{L}\p{N}]/u.test(text)) throw new Error(`Narratable chapter ${ch.index + 1} has no speakable text.`);
    const cleanFile = `chapters-clean/${String(ch.index).padStart(4, '0')}.txt`;
    const existing = fs.existsSync(work.path(cleanFile)) ? fs.readFileSync(work.path(cleanFile), 'utf8') : undefined;
    if (existing === text) {
      completedChapters++;
      progress('Reusing frozen plain text', 'skipped');
      continue;
    }
    progress('Freezing normalized plain text', 'saving');
    fs.writeFileSync(work.path(cleanFile), text);
    summaries[ch.index] ??= '';
    completedChapters++;
    progress('Chapter plain text prepared', 'completed');
  }
  work.writeJson(SUMMARIES_FILE, summaries);
}
