import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkDir } from '../src/state.js';
import { migrateLegacyArtifacts, recoverStageStateFromArtifacts } from '../src/pipeline/runner.js';

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

  it('migrates a legacy EPUB state manifest without losing its completion record', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-state-'));
    temporaryRoots.push(root);
    const epub = path.join(root, 'book.epub');
    fs.writeFileSync(epub, 'legacy source');
    const work = new WorkDir(epub, root);
    fs.writeFileSync(work.path('state.json'), JSON.stringify({
      epub,
      epubHash: crypto.createHash('sha256').update('legacy source').digest('hex').slice(0, 16),
      completed: { extract: '2026-01-01T00:00:00.000Z' },
      chapterCompleted: {},
    }));

    const migrated = new WorkDir(epub, root);
    expect(migrated.snapshot()).toMatchObject({ version: 2, source: epub, sourceFormat: 'epub' });
    expect(migrated.isDone('extract')).toBe(true);
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

  it('migrates legacy name-keyed script files to explicit legacy-Markdown artifacts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-state-')); temporaryRoots.push(root);
    const epub = path.join(root, 'book.epub'); fs.writeFileSync(epub, 'legacy');
    const work = new WorkDir(epub, root);
    work.writeJson('characters.json', { version: 2, chapters: [7], characters: [{ id: 'speaker-alice', name: 'Alice', aliases: [], sex: 'unknown', age: 'unknown', race: 'unknown', class: 'unknown', country: 'unknown', importance: 'minor', chapters: [7], evidence: [], issues: [], sourceEntityIds: [], sourceQuoteIds: [], inferredPronouns: [] }] });
    work.writeJson('script/07.json', { index: 7, segments: [{ speaker: 'Alice', text: '**Hello.**', confidence: 'high' }] });
    migrateLegacyArtifacts(work);
    expect(work.readJson<any>('script/0007.json')).toMatchObject({ format: 'legacy-markdown', segments: [{ speakerId: 'speaker-alice' }] });
  });

  it('does not recover BookNLP completion from normalized JSON when raw output is absent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-state-')); temporaryRoots.push(root);
    const epub = path.join(root, 'book.epub'); fs.writeFileSync(epub, 'source');
    const work = new WorkDir(epub, root);
    work.writeJson('metadata.json', { title: 'Book', author: 'Author', language: 'en', chapters: [{ index: 0, title: 'One', file: 'chapters/0000.txt', words: 1, isNav: false }] });
    work.writeJson('analysis.json', { isFiction: false, summary: '', characters: [], author: { name: 'Author', aliases: [], sex: 'unknown', age: 'unknown', race: 'unknown', class: 'unknown', country: 'unknown', importance: 'minor' }, chapters: [{ index: 0, narrate: true, reason: '' }] });
    fs.writeFileSync(path.join(work.dir('chapters-clean'), '0000.txt'), 'Hello.');
    work.writeJson('chapter-summaries.json', { 0: '' });
    const inputHash = crypto.createHash('sha256').update('Hello.').digest('hex');
    fs.writeFileSync(path.join(work.dir('booknlp'), 'input.txt'), 'Hello.');
    work.writeJson('booknlp/chapter-map.json', { version: 1, offsetConvention: 'unicode-code-points-half-open', inputSha256: inputHash, chapters: [{ index: 0, title: 'One', start: 0, end: 6, titleInText: false }] });
    work.writeJson('booknlp/annotations.json', { version: 1, source: { inputSha256: inputHash, offsetConvention: 'unicode-code-points-half-open' }, provenance: { tool: 'booknlp', toolVersion: '1.0.8', model: 'big', pipeline: 'entity,quote,coref', adapterVersion: '1', fingerprint: 'not-compatible' }, mentions: [], quotations: [] });
    recoverStageStateFromArtifacts(work);
    expect(work.isDone('chapters')).toBe(true);
    expect(work.isDone('booknlp')).toBe(false);
  });
});
