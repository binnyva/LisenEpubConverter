import crypto from 'node:crypto';
import fs from 'node:fs';
import type { WorkDir } from '../state.js';

/**
 * Per-block progress inside one chapter. A long chapter is many LLM calls;
 * without this a timeout or one malformed reply near the end discards every
 * block already paid for. A checkpoint is only an accelerator: it is ignored
 * when its key no longer matches the inputs, and removed once the chapter's
 * real output has been saved.
 */
export type CheckpointStage = 'chapters' | 'script';

const CHECKPOINT_DIR = 'checkpoints';

interface CheckpointFile<T> {
  key: string;
  blocks: T[];
}

const checkpointFile = (stage: CheckpointStage, index: number): string =>
  `${CHECKPOINT_DIR}/${stage}-${String(index).padStart(2, '0')}.json`;

/** Hash every input that decides what a block's result would be. */
export function checkpointKey(...parts: Array<string | number>): string {
  return crypto.createHash('sha256').update(parts.join('\x1f')).digest('hex').slice(0, 24);
}

/** Completed blocks, in order, or none when the inputs changed or the file is unreadable. */
export function loadCheckpoint<T>(work: WorkDir, stage: CheckpointStage, index: number, key: string, totalBlocks: number): T[] {
  const file = work.path(checkpointFile(stage, index));
  if (!fs.existsSync(file)) return [];
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as CheckpointFile<T>;
    if (saved.key !== key || !Array.isArray(saved.blocks) || saved.blocks.length > totalBlocks) return [];
    return saved.blocks;
  } catch {
    // A write interrupted mid-file is the same as no checkpoint.
    return [];
  }
}

export function saveCheckpoint<T>(work: WorkDir, stage: CheckpointStage, index: number, key: string, blocks: T[]): void {
  const rel = checkpointFile(stage, index);
  work.dir(CHECKPOINT_DIR);
  // Write-then-rename so a cancelled task never leaves a truncated file.
  const tmp = `${work.path(rel)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ key, blocks } satisfies CheckpointFile<T>));
  fs.renameSync(tmp, work.path(rel));
}

/** Remove one chapter's checkpoint, a stage's, or (with no stage) all of them. */
export function clearCheckpoints(work: WorkDir, stage?: CheckpointStage, indexes?: number[]): void {
  const dir = work.path(CHECKPOINT_DIR);
  if (!fs.existsSync(dir)) return;
  if (!stage) {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  if (indexes) {
    for (const index of indexes) fs.rmSync(work.path(checkpointFile(stage, index)), { force: true });
    return;
  }
  for (const file of fs.readdirSync(dir)) {
    if (file.startsWith(`${stage}-`)) fs.rmSync(work.path(CHECKPOINT_DIR, file), { force: true });
  }
}
