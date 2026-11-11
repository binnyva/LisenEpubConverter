import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { alignTokens, loadRunScript, scoreFolder, scoreScript, speakerKey, words, type ScoredSegment } from '../src/benchmark/score.js';
import { removeFixtures, tempRoot } from './helpers.js';

afterEach(removeFixtures);

const n = (text: string): ScoredSegment => ({ speaker: 'narrator', text, confidence: 'high' });
const say = (speaker: string, text: string, extra: Partial<ScoredSegment> = {}): ScoredSegment => ({ speaker, text, confidence: 'high', ...extra });

/** A small reference in the shape of the real one. */
const reference: ScoredSegment[] = [
  n('The Last Question'),
  n('Adell and Lupov sat drinking in the dark.'),
  say('Bertram Lupov', '"Not forever,"'),
  n('he said.'),
  say('Alexander Adell', '"Oh, hell, just about forever."'),
  { speaker: 'narrator', text: '• • •', confidence: 'high', kind: 'pause', pauseMs: 2000 } as ScoredSegment,
  say('Cosmic AC', '"THERE IS AS YET INSUFFICIENT DATA."'),
  say('Universal AC', '"LET THERE BE LIGHT!"'),
  say('Man', '"Is this the end?"'),
  say('Man', '"Can it be reversed?"'),
  say('One man', '"Most of it is in hyperspace."'),
  n('It said: THERE IS INSUFFICIENT DATA FOR A MEANINGFUL ANSWER.'),
  say('Galactic AC', 'THERE IS INSUFFICIENT DATA FOR A MEANINGFUL ANSWER.'),
];

describe('alignTokens', () => {
  it('finds a longest common subsequence', () => {
    const lcs = (a: string[], b: string[]): number => {
      const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
      for (let i = 1; i <= a.length; i += 1) for (let j = 1; j <= b.length; j += 1) {
        t[i][j] = a[i - 1] === b[j - 1] ? t[i - 1][j - 1] + 1 : Math.max(t[i - 1][j], t[i][j - 1]);
      }
      return t[a.length][b.length];
    };
    let seed = 7;
    const random = (): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let trial = 0; trial < 50; trial += 1) {
      const a = Array.from({ length: Math.floor(random() * 30) }, () => 'abcd'[Math.floor(random() * 4)]);
      const b = Array.from({ length: Math.floor(random() * 30) }, () => 'abcd'[Math.floor(random() * 4)]);
      const pairs = alignTokens(a, b);
      expect(pairs.length).toBe(lcs(a, b));
      for (const [i, j] of pairs) expect(a[i]).toBe(b[j]);
      for (let k = 1; k < pairs.length; k += 1) {
        expect(pairs[k][0]).toBeGreaterThan(pairs[k - 1][0]);
        expect(pairs[k][1]).toBeGreaterThan(pairs[k - 1][1]);
      }
    }
  });

  it('ignores punctuation, case and curly apostrophes in words', () => {
    expect(words('“It’s amazing,” said Adell -- truly.')).toEqual(["it's", 'amazing', 'said', 'adell', 'truly']);
  });
});

describe('scoreScript', () => {
  it('aligns on text, so a different cut, an extra preface and an edited word do not count against attribution', () => {
    const run: ScoredSegment[] = [
      n('… The Last Question … A preface about the author that the reference drops.'),
      n('Adell and Lupov sat drinking in the dark.'),
      say('Bertram Lupov', '"Not forever,"'),
      n('he said.'),
      say('Alexander Adell', '"Oh, heck, just about forever."'),
      say('Cosmic AC', '"THERE IS AS YET INSUFFICIENT DATA."'),
      say('Universal AC', '"LET THERE BE LIGHT!"'),
      say('Man', '"Is this the end?"'),
      say('Man', '"Can it be reversed?"'),
      say('One man', '"Most of it is in hyperspace."'),
      n('It said: THERE IS INSUFFICIENT DATA FOR A MEANINGFUL ANSWER. THERE IS INSUFFICIENT DATA FOR A MEANINGFUL ANSWER.'),
    ];
    const score = scoreScript(reference, run);
    expect(score.attribution.lineAccuracy).toBe(1);
    expect(score.attribution.lines).toBe(7);
    expect(score.attribution.coverage).toBe(1);
    expect(score.fidelity.wordsRemoved).toBe(1); // "hell"
    expect(score.fidelity.removed).toContain('hell');
    expect(score.fidelity.added.join(' ')).toContain('preface about the author');
    // The unquoted Galactic AC line cannot be attributed in quoted mode and is left out.
    expect(score.attribution.unattributable.map((u) => u.refSpeaker)).toEqual(['Galactic AC']);
    expect(score.cast.reference).toBe(6);
    expect(score.narratorBoundary.narrationToCharacter.words).toBe(0);
  });

  it('maps speaker names by exact key, alias file and best overlap, and reports which', () => {
    const run = reference.map((segment) => {
      if (segment.speaker === 'Man') return { ...segment, speaker: 'Man (chapter 1)' };
      if (segment.speaker === 'One man') return { ...segment, speaker: 'the one man (chapter 1)' };
      if (segment.speaker === 'Bertram Lupov') return { ...segment, speaker: 'Bert' };
      if (segment.speaker === 'Alexander Adell') return { ...segment, speaker: 'Somebody Else' };
      return segment;
    });
    const score = scoreScript(reference, run, { aliases: { 'Bertram Lupov': ['Bert'] } });
    const method = Object.fromEntries(score.mapping.map((m) => [m.ref, `${m.run}:${m.method}`]));
    expect(method.Man).toBe('Man (chapter 1):exact');
    expect(method['One man']).toBe('the one man (chapter 1):exact');
    expect(method['Bertram Lupov']).toBe('Bert:alias');
    expect(method['Alexander Adell']).toBe('Somebody Else:overlap');
    expect(score.attribution.lineAccuracy).toBe(1);
    expect(speakerKey('The One Man (chapter 12)')).toBe('one man');
  });

  it('reports merged and split characters apart from plain misattributions', () => {
    const run = reference.map((segment) => {
      if (segment.speaker === 'Cosmic AC') return { ...segment, speaker: 'Universal AC' };
      if (segment.speaker === 'Man' && segment.text.includes('reversed')) return { ...segment, speaker: 'Man of Earth' };
      if (segment.speaker === 'Bertram Lupov') return { ...segment, speaker: 'Alexander Adell' };
      return segment;
    });
    const score = scoreScript(reference, run);
    // Lupov's only line went to Adell, so Adell holds both characters: that is a merge too.
    expect(score.cast.merged).toHaveLength(2);
    expect(score.cast.merged).toContainEqual({ run: 'Universal AC', refs: ['Cosmic AC', 'Universal AC'] });
    expect(score.cast.merged).toContainEqual({ run: 'Alexander Adell', refs: ['Alexander Adell', 'Bertram Lupov'] });
    expect(score.cast.split).toEqual([{ ref: 'Man', runs: ['Man', 'Man of Earth'] }]);
    expect(score.errors).toMatchObject({ merge: 2, split: 1, misattribution: 0 });
    expect(score.cast.missing).toContain('Cosmic AC');
    expect(score.cast.mergedAway).toContain('Cosmic AC');
    expect(score.wrongLines.find((w) => w.refSpeaker === 'Cosmic AC')).toMatchObject({ kind: 'merge', runSpeaker: 'Universal AC' });
  });

  it('counts narrator boundary errors both ways', () => {
    const run = reference.map((segment) => {
      if (segment.text === 'he said.') return { ...segment, speaker: 'Bertram Lupov' };
      if (segment.speaker === 'One man') return { ...segment, speaker: 'narrator' };
      return segment;
    });
    const score = scoreScript(reference, run);
    expect(score.narratorBoundary.narrationToCharacter).toMatchObject({ words: 2, stretches: [{ runSpeaker: 'Bertram Lupov', words: 2, excerpt: 'he said' }] });
    expect(score.narratorBoundary.speechToNarrator).toEqual({ lines: 1, words: 6 });
    expect(score.errors['to-narrator']).toBe(1);
    expect(score.cast.missing).toEqual(['One man']);
  });

  it('counts unresolved speakers as wrong', () => {
    const run = reference.map((segment) => (segment.speaker === 'Man' ? { ...segment, speaker: 'Mysterious Voice', confidence: 'low' } : segment));
    const score = scoreScript(reference, run, { unresolved: ['Mysterious Voice'] });
    expect(score.errors.unresolved).toBe(2);
    expect(score.facts.unresolvedSpeakers).toEqual(['Mysterious Voice']);
    expect(score.facts.lowConfidence).toBe(2);
    expect(score.cast.missing).toEqual(['Man']);
  });
});

describe('scoring folders', () => {
  function workFolder(): { runDir: string; work: string } {
    const runDir = tempRoot('lisen-bench-');
    const work = path.join(runDir, 'the-last-question-markdown');
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, 'state.json'), '{}');
    return { runDir, work };
  }
  const target = { segments: reference, aliases: {} };

  it('scores a blocked run from its checkpoint, with the unresolved lines wrong', () => {
    const { runDir, work } = workFolder();
    fs.mkdirSync(path.join(work, 'checkpoints'));
    const result = reference.map((segment) => (segment.speaker === 'One man' ? { ...segment, speaker: 'a voice', confidence: 'low' } : segment));
    fs.writeFileSync(path.join(work, 'checkpoints', 'script-00.json'), JSON.stringify({ key: 'k', blocks: [{ segments: reference, characters: [] }], result }));
    fs.writeFileSync(path.join(work, 'characters.json'), JSON.stringify({ version: 3, characters: [], unresolved: [{ story: 'book', chapter: 0, speaker: 'a voice', samples: [] }] }));
    expect(loadRunScript(runDir)?.source).toBe('checkpoint-result');
    const score = scoreFolder(runDir, target)!;
    expect(score.source).toBe('checkpoint-result');
    expect(score.errors.unresolved).toBe(1);
    expect(score.wrongLines).toEqual([expect.objectContaining({ kind: 'unresolved', refSpeaker: 'One man', runSpeaker: 'a voice' })]);
    expect(score.attribution.correctLines).toBe(6);
  });

  it('scores a run that stopped before verification from its finished blocks, and reports the coverage', () => {
    const { runDir, work } = workFolder();
    fs.mkdirSync(path.join(work, 'checkpoints'));
    fs.writeFileSync(path.join(work, 'checkpoints', 'script-00.json'), JSON.stringify({ key: 'k', blocks: [{ segments: reference.slice(0, 5), characters: [] }] }));
    const score = scoreFolder(runDir, target)!;
    expect(score.source).toBe('checkpoint-blocks');
    expect(score.attribution.lines).toBe(2);
    expect(score.attribution.missingLines).toBe(5);
    expect(score.attribution.coverage).toBeCloseTo(2 / 7);
  });

  it('prefers the saved script, and finds nothing in an empty folder', () => {
    const { runDir, work } = workFolder();
    fs.mkdirSync(path.join(work, '1-scripts'));
    fs.writeFileSync(path.join(work, '1-scripts', '00-the-last-question.json'), JSON.stringify({ index: 0, segments: reference }));
    expect(scoreFolder(runDir, target)?.source).toBe('script');
    expect(scoreFolder(tempRoot(), target)).toBeUndefined();
  });
});
