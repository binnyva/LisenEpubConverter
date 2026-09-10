import { config } from '../config.js';
import { AsyncLocalStorage } from 'node:async_hooks';

/** Work measured in natural units, or just an activity while a single request is pending. */
export interface ActivityProgress extends Partial<ChapterProgress> {
  activity: string;
  completedUnits?: number;
  totalUnits?: number;
  unit?: string;
  elapsedMs: number;
}

type ActivityReporter = (progress: ActivityProgress, message: string, heartbeat: boolean) => void;
const activities = new AsyncLocalStorage<{ update: (progress: Omit<ActivityProgress, 'elapsedMs'>) => void }>();

function activityMessage(progress: ActivityProgress): string {
  const chapter = progress.chapterIndex === undefined ? '' : `Chapter ${progress.chapterIndex}: "${progress.chapterTitle}" — `;
  const units = progress.totalUnits && progress.completedUnits !== undefined
    ? ` · ${progress.completedUnits}/${progress.totalUnits} ${progress.unit} (${Math.floor(100 * progress.completedUnits / progress.totalUnits)}%)` : '';
  const chapters = progress.totalChapters === undefined ? '' : ` · ${progress.completedChapters}/${progress.totalChapters} chapters complete`;
  return `${chapter}${progress.activity}${units}${chapters} · ${Math.floor(progress.elapsedMs / 1000)}s elapsed`;
}

/** Replace the current activity; omitted counters disappear when moving to an unmeasured phase. */
export function reportProgress(progress: Omit<ActivityProgress, 'elapsedMs'>): void {
  const context = activities.getStore();
  if (context) context.update(progress);
  else console.log(`  ${activityMessage({ ...progress, elapsedMs: 0 })}`);
}

export async function withStageProgress<T>(report: ActivityReporter, run: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  let current: Omit<ActivityProgress, 'elapsedMs'> | undefined;
  let active = true;
  const emit = (heartbeat: boolean) => {
    if (!active || !current) return;
    const progress = { ...current, elapsedMs: Date.now() - startedAt };
    report(progress, activityMessage(progress), heartbeat);
  };
  const timer = setInterval(() => emit(true), config.progressIntervalMs);
  timer.unref();
  try {
    return await activities.run({ update: (progress) => { current = progress; emit(false); } }, run);
  } finally {
    active = false;
    clearInterval(timer);
  }
}

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
