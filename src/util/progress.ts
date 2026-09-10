import { config } from '../config.js';

export interface ChapterProgress {
  /** Artifact/CLI chapter index (zero-based). */
  chapterIndex: number;
  chapterTitle: string;
  completedChapters: number;
  totalChapters: number;
  phase: 'preparing' | 'attributing' | 'verifying' | 'saving' | 'completed' | 'skipped';
  processedChars: number;
  totalChars: number;
  block?: number;
  totalBlocks?: number;
  ambiguousSegments?: number;
  elapsedMs: number;
}

export type ProgressReporter = (progress: ChapterProgress, message: string, heartbeat: boolean) => void;

export function progressMessage(progress: ChapterProgress): string {
  const percent = progress.totalChars ? Math.floor(100 * progress.processedChars / progress.totalChars) : 0;
  const activity = {
    preparing: 'Preparing script',
    attributing: `Attributing block ${progress.block}/${progress.totalBlocks} (${percent}% of text processed)`,
    verifying: `Attribution complete. Verifying ${progress.ambiguousSegments} uncertain speaker assignment(s)`,
    saving: 'Text processed. Saving script',
    completed: 'Chapter complete',
    skipped: 'Reusing existing script',
  }[progress.phase];
  return `Chapter ${progress.chapterIndex}: "${progress.chapterTitle}" — ${activity} · ${progress.completedChapters}/${progress.totalChapters} chapters complete · ${Math.floor(progress.elapsedMs / 1000)}s elapsed`;
}

/** Report real milestones and keep long requests visibly active without inventing progress. */
export async function withChapterProgress<T>(
  initial: Omit<ChapterProgress, 'elapsedMs'>,
  report: ProgressReporter,
  run: (update: (change: Partial<ChapterProgress>) => void) => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  let current: ChapterProgress = { ...initial, elapsedMs: 0 };
  const emit = (heartbeat: boolean) => {
    current = { ...current, elapsedMs: Date.now() - startedAt };
    report(current, progressMessage(current), heartbeat);
  };
  const timer = setInterval(() => emit(true), config.progressIntervalMs);
  timer.unref();
  try {
    emit(false);
    return await run((change) => {
      current = { ...current, ...change };
      emit(false);
    });
  } finally {
    clearInterval(timer);
  }
}
