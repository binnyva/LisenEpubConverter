import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OUTDATED_WORK_FOLDER_MESSAGE, WorkDir } from '../src/state.js';

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

    changed.acceptCurrentSource();
    expect(changed.sourceChanged()).toBe(false);
  });

  it('flags a folder from an earlier pipeline and refuses to change it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-state-'));
    temporaryRoots.push(root);
    const epub = path.join(root, 'book.epub');
    fs.writeFileSync(epub, 'earlier source');
    const work = new WorkDir(epub, root);
    const earlier = JSON.stringify({
      version: 2, source: epub, sourceFormat: 'epub',
      sourceHash: crypto.createHash('sha256').update('earlier source').digest('hex').slice(0, 16),
      completed: { extract: '2026-01-01T00:00:00.000Z', analyze: '2026-01-01T00:00:00.000Z' },
    });
    fs.writeFileSync(work.path('state.json'), earlier);

    const reopened = new WorkDir(epub, root);
    expect(reopened.isOutdated()).toBe(true);
    expect(reopened.isDone('extract')).toBe(false);
    expect(() => reopened.markDone('extract')).toThrow(OUTDATED_WORK_FOLDER_MESSAGE);
    expect(fs.readFileSync(work.path('state.json'), 'utf8')).toBe(earlier);

    reopened.adoptCurrentLayout();
    expect(new WorkDir(epub, root).isOutdated()).toBe(false);
    expect(new WorkDir(epub, root).snapshot()).toMatchObject({ version: 3, source: epub, completed: {} });
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
