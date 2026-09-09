import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkDir } from '../src/state.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('WorkDir chapter completion', () => {
  it('only completes a chapter-scoped stage when every narratable chapter is complete', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-state-'));
    temporaryRoots.push(root);
    const epub = path.join(root, 'book.epub');
    fs.writeFileSync(epub, crypto.randomBytes(32));
    const work = new WorkDir(epub, root);

    work.markChaptersDone('script', [1], [1, 4]);
    expect(work.isDone('script')).toBe(false);
    expect(work.completedChapters('script')).toEqual([1]);

    work.markChaptersDone('script', [4], [1, 4]);
    expect(work.isDone('script')).toBe(true);
    expect(work.completedChapters('script')).toEqual([1, 4]);

    work.invalidateFrom('script');
    expect(work.isDone('script')).toBe(false);
    expect(work.completedChapters('script')).toEqual([]);
  });

  it('preserves completed-stage history when the selected EPUB changes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-state-'));
    temporaryRoots.push(root);
    const epub = path.join(root, 'book.epub');
    fs.writeFileSync(epub, 'first edition');
    const original = new WorkDir(epub, root);
    original.markDone('extract');

    fs.writeFileSync(epub, 'revised edition');
    const changed = new WorkDir(epub, root);
    expect(changed.sourceChanged()).toBe(true);
    expect(changed.isDone('extract')).toBe(true);

    changed.acceptCurrentEpub();
    expect(changed.sourceChanged()).toBe(false);
  });

  it('detects hand edits to the cast or bindings after synthesis', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-state-'));
    temporaryRoots.push(root);
    const epub = path.join(root, 'book.epub');
    fs.writeFileSync(epub, crypto.randomBytes(32));
    const work = new WorkDir(epub, root);
    work.writeJson('casting.json', { narrator: { instructions: 'Steady.' } });
    work.writeJson('voice-bindings.json', { narrator: { voiceId: 'voice-a' } });
    work.recordSynthesisInputs();
    expect(work.synthesisInputsChanged()).toBe(false);

    work.writeJson('voice-bindings.json', { narrator: { voiceId: 'voice-b' } });
    expect(work.synthesisInputsChanged()).toBe(true);
  });
});
