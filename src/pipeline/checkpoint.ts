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
export type CheckpointStage = 'script';

const CHECKPOINT_DIR = 'checkpoints';

interface CheckpointFile<T, R> {
  key: string;
  blocks: T[];
  /** Work done after the last block, such as verified speakers; saved once every block is finished. */
  result?: R;
}

export interface Checkpoint<T, R> {
  blocks: T[];
  result?: R;
}

const checkpointFile = (stage: CheckpointStage, index: number): string =>
  `${CHECKPOINT_DIR}/${stage}-${String(index).padStart(2, '0')}.json`;

/** Hash every input that decides what a block's result would be. */
export function checkpointKey(...parts: Array<string | number>): string {
  return crypto.createHash('sha256').update(parts.join('\x1f')).digest('hex').slice(0, 24);
}

/** Completed blocks, in order, or none when the inputs changed or the file is unreadable. */
export function loadCheckpoint<T, R = never>(work: WorkDir, stage: CheckpointStage, index: number, key: string, totalBlocks: number): Checkpoint<T, R> {
  const file = work.path(checkpointFile(stage, index));
  if (!fs.existsSync(file)) return { blocks: [] };
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as CheckpointFile<T, R>;
    if (saved.key !== key || !Array.isArray(saved.blocks) || saved.blocks.length > totalBlocks) return { blocks: [] };
    return { blocks: saved.blocks, result: saved.blocks.length === totalBlocks ? saved.result : undefined };
  } catch {
    // A write interrupted mid-file is the same as no checkpoint.
    return { blocks: [] };
  }
}

export function saveCheckpoint<T, R = never>(work: WorkDir, stage: CheckpointStage, index: number, key: string, blocks: T[], result?: R): void {
  const rel = checkpointFile(stage, index);
  work.dir(CHECKPOINT_DIR);
  // Write-then-rename so a cancelled task never leaves a truncated file.
  const tmp = `${work.path(rel)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ key, blocks, ...(result === undefined ? {} : { result }) } satisfies CheckpointFile<T, R>));
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
