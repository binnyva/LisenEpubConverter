import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkDir } from '../src/state.js';
import { applyCleanupEdits, dropEmptyParagraphs, restoreSceneBreaks } from '../src/pipeline/cleanup.js';
import { runStage, type PipelineEvent } from '../src/pipeline/runner.js';
import { jsonCall } from '../src/providers/llm/openai.js';

vi.mock('../src/providers/llm/openai.js', () => ({ jsonCall: vi.fn() }));
const llm = vi.mocked(jsonCall);
const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('applyCleanupEdits', () => {
  it('replaces every occurrence and leaves the rest of the text untouched', () => {
    const source = 'It rained, i.e. it poured. We stayed in, i.e. we read.';
    const result = applyCleanupEdits(source, [{ find: 'i.e.', replace: 'that is' }]);

    expect(result).toEqual({ text: 'It rained, that is it poured. We stayed in, that is we read.', applied: 1, skipped: [] });
  });

  it('matches a quotation whose quotes, ellipsis or spacing the model normalised', () => {
    const source = '“Don’t go…” she said.12\nHe left.';
    const result = applyCleanupEdits(source, [{ find: `"Don't go..." she said.12 He left.`, replace: '“Don’t go…” she said.\nHe left.' }]);

    expect(result.text).toBe('“Don’t go…” she said.\nHe left.');
    expect(result.skipped).toEqual([]);
  });

  it('only matches whole words', () => {
    const result = applyCleanupEdits('Akmal ran 5 km to the km marker.', [{ find: 'km', replace: 'kilometres' }]);

    expect(result.text).toBe('Akmal ran 5 kilometres to the kilometres marker.');
  });

  it('skips an edit that does not quote the text', () => {
    const result = applyCleanupEdits('The cat sat.', [{ find: 'The dog sat.', replace: 'The dog stood.' }]);

    expect(result.text).toBe('The cat sat.');
    expect(result.skipped).toEqual([{ find: 'The dog sat.', reason: 'not found in the text' }]);
  });

  it('skips a bare number that would also delete real numbers', () => {
    const source = 'In 12 countries, women earn less.12';

    expect(applyCleanupEdits(source, [{ find: '12', replace: '' }]).text).toBe(source);
    expect(applyCleanupEdits(source, [{ find: 'less.12', replace: 'less.' }]).text).toBe('In 12 countries, women earn less.');
  });

  it('refuses to delete or rewrite a passage', () => {
    const passage = `${'A long sentence that the model would rather not read aloud. '.repeat(4)}End.`;
    const source = `Before. ${passage} After.`;

    expect(applyCleanupEdits(source, [{ find: passage, replace: '' }])).toMatchObject({ text: source, applied: 0 });
    expect(applyCleanupEdits(source, [{ find: 'Before.', replace: 'x'.repeat(400) }])).toMatchObject({ text: source, applied: 0 });
    expect(applyCleanupEdits(source, [{ find: `${passage} ${passage}`, replace: passage }]).skipped[0].reason).toContain('too much');
  });

  it('treats a replacement literally', () => {
    expect(applyCleanupEdits('Cost: 5 USD.', [{ find: '5 USD', replace: '$5 & $&' }]).text).toBe('Cost: $5 & $&.');
  });
});

describe('dropEmptyParagraphs', () => {
  it('keeps scene-break dividers alongside prose and headings', () => {
    expect(dropEmptyParagraphs('# One\n\nFirst.\n\n• • •\n\n   \n\nSecond.'))
      .toBe('# One\n\nFirst.\n\n• • •\n\nSecond.');
  });
});

describe('restoreSceneBreaks', () => {
  const raw = '# One\n\nFirst paragraph here.\n\n• • •\n\nSecond paragraph here.\n\nThird paragraph here.\n\n* * *\n\nFourth paragraph here.';

  it('puts dividers back where the extracted chapter has them', () => {
    const cleaned = '# One\n\nFirst paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.\n\nFourth paragraph here.';

    expect(restoreSceneBreaks(raw, cleaned)).toEqual({ text: raw, restored: 2, missed: 0 });
  });

  it('anchors a divider on prose a cleanup edit has changed', () => {
    const cleaned = '# One\n\nFirst paragraph here, that is here.\n\nSecond paragraph here.\n\nThird paragraph here.\n\nFourth paragraph here.';
    const result = restoreSceneBreaks(raw, cleaned);

    expect(result.restored).toBe(2);
    expect(result.text).toContain('that is here.\n\n• • •\n\nSecond');
  });

  it('reports a divider whose surrounding paragraphs are gone instead of guessing', () => {
    const result = restoreSceneBreaks('Alpha.\n\n• • •\n\nBeta.', 'Something else entirely.');

    expect(result).toEqual({ text: 'Something else entirely.', restored: 0, missed: 1 });
  });

  it('leaves text that already carries its dividers untouched', () => {
    expect(restoreSceneBreaks(raw, raw)).toEqual({ text: raw, restored: 0, missed: 0 });
  });

  it('keeps a divider that opens the chapter', () => {
    const result = restoreSceneBreaks('• • •\n\nFirst paragraph here.', 'First paragraph here.');

    expect(result.text).toBe('• • •\n\nFirst paragraph here.');
  });
});

describe('Chapters cleanup', () => {
  it('writes the source text with only the listed edits applied, and reports rejected ones', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-cleanup-'));
    roots.push(root);
    const sourcePath = path.join(root, 'book.epub');
    fs.writeFileSync(sourcePath, 'offline fixture');
    const work = new WorkDir(sourcePath, root);
    work.writeJson('metadata.json', { title: 'Essay', author: 'Author', chapters: [{ index: 0, title: 'One', file: 'chapters/0.md', words: 20 }] });
    work.writeJson('analysis.json', {
      isFiction: false, summary: 'Overview.', characters: [],
      author: { name: 'Author', sex: 'unknown', age: 'unknown', country: 'unknown' },
      chapters: [{ index: 0, narrate: true }],
    });
    work.dir('chapters');
    fs.writeFileSync(work.path('chapters/0.md'), '# One\n\nShe didn’t walk 5 km, e.g. to work.3\n\n* * *\n\nThe end.');
    work.markDone('extract');
    work.markDone('analyze');
    llm.mockResolvedValueOnce({
      edits: [
        { find: '5 km', replace: '5 kilometres' },
        { find: 'e.g.', replace: 'for example' },
        { find: 'work.3', replace: 'work.' },
        { find: 'She did not walk', replace: 'She never walked' },
      ],
      partialSummary: 'A walk.',
      characters: [],
    });
    const events: PipelineEvent[] = [];

    await runStage({ sourcePath, workRoot: root, stage: 'chapters', onEvent: (event) => events.push(event) });

    expect(fs.readFileSync(work.path('chapters-clean/00.md'), 'utf8'))
      .toBe('# One\n\nShe didn’t walk 5 kilometres, for example to work.\n\n* * *\n\nThe end.');
    const warning = events.find((event) => event.type === 'warning')?.message ?? '';
    expect(warning).toContain('Chapter 1, block 1: skipped 1 cleanup edit(s)');
    expect(warning).toContain('She did not walk');
    const request = llm.mock.calls[0][0] as { system: string };
    expect(request.system).toContain('"edits"');
    expect(request.system).not.toContain('cleanedText');
  });
});
