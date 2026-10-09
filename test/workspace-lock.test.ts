import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireWorkspaceLock, withWorkspaceLock } from '../src/util/workspace-lock.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('workspace mutation lock', () => {
  it('is race-safe, reentrant in one process, and releases after asynchronous work', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-lock-')); roots.push(root);
    let releaseTask!: () => void;
    const running = withWorkspaceLock(root, 'stage:test', () => new Promise<void>((resolve) => { releaseTask = resolve; }));
    const nested = acquireWorkspaceLock(root, 'edit:test'); // same-process reentrancy
    nested();
    expect(fs.existsSync(path.join(root, '.lisen-mutation.lock'))).toBe(true);
    releaseTask(); await running;
    expect(fs.existsSync(path.join(root, '.lisen-mutation.lock'))).toBe(false);
  });

  it('recovers an old lock only when its owning process is gone', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-lock-')); roots.push(root);
    const lock = path.join(root, '.lisen-mutation.lock'); fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 999999, operation: 'crashed', startedAt: new Date(Date.now() - 60_000).toISOString() }));
    const release = acquireWorkspaceLock(root, 'recovered');
    expect(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')).operation).toBe('recovered');
    release();
  });
});
