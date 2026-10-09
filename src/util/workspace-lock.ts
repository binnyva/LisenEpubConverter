import fs from 'node:fs';
import path from 'node:path';

const held = new Map<string, number>();

/** Race-safe cross-process mutation lock with conservative stale-owner recovery. */
export function acquireWorkspaceLock(root: string, operation: string): () => void {
  const lock = path.join(root, '.lisen-mutation.lock');
  const reentrant = held.get(lock) ?? 0;
  if (reentrant) {
    held.set(lock, reentrant + 1);
    return () => releaseHeld(lock, false);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, operation, startedAt: new Date().toISOString() }));
      held.set(lock, 1);
      return () => releaseHeld(lock, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = readOwner(lock);
      if (attempt === 0 && owner && !processAlive(owner.pid) && Date.now() - owner.startedAt > 30_000) {
        const stale = `${lock}.stale-${owner.pid}-${Date.now()}`;
        try { fs.renameSync(lock, stale); fs.rmSync(stale, { recursive: true, force: true }); continue; }
        catch { /* another process recovered it */ }
      }
      throw new Error(`This workspace is locked${owner ? ` by PID ${owner.pid} running ${owner.operation} since ${new Date(owner.startedAt).toISOString()}` : ''}. Wait for it to finish or confirm the owning process has stopped.`);
    }
  }
  throw new Error('Could not acquire the workspace mutation lock.');
}

export function withWorkspaceLock<T>(root: string, operation: string, task: () => T): T {
  const release = acquireWorkspaceLock(root, operation);
  try {
    const value = task();
    if (value && typeof (value as unknown as PromiseLike<unknown>).then === 'function') {
      return Promise.resolve(value).finally(release) as T;
    }
    release();
    return value;
  } catch (error) {
    release();
    throw error;
  }
}

function releaseHeld(lock: string, ownsDirectory: boolean): void {
  const count = held.get(lock) ?? 0;
  if (count > 1) { held.set(lock, count - 1); return; }
  held.delete(lock);
  if (ownsDirectory) fs.rmSync(lock, { recursive: true, force: true });
}

function readOwner(lock: string): { pid: number; operation: string; startedAt: number } | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')) as { pid?: unknown; operation?: unknown; startedAt?: unknown };
    if (!Number.isInteger(raw.pid) || typeof raw.operation !== 'string' || typeof raw.startedAt !== 'string') return undefined;
    const startedAt = Date.parse(raw.startedAt);
    return Number.isFinite(startedAt) ? { pid: raw.pid as number, operation: raw.operation, startedAt } : undefined;
  } catch { return undefined; }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
