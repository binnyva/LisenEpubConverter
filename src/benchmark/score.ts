import fs from 'node:fs';
import path from 'node:path';

/**
 * The Script benchmark's scorer. It is offline and pure: it reads a reference
 * script and a run's script (or, for a run that stopped, the verified
 * segments its checkpoint kept) and measures speaker attribution and cast
 * discovery. Text is aligned word by word, never by segment index, because a
 * run can cut segments differently and a cleanup edit can change a word.
 */

export interface ScoredSegment {
  speaker: string;
  text: string;
  confidence?: string;
  delivery?: string;
  kind?: string;
}

/** Where a run's segments came from. A blocked run is scored from its checkpoint. */
export type ScriptSource = 'script' | 'checkpoint-result' | 'checkpoint-blocks';

export interface RunScript {
  segments: ScoredSegment[];
  source: ScriptSource;
  /** Speakers the run left unresolved; their lines always count as wrong. */
  unresolved: string[];
  /** The work folder the script was read from. */
  workDir: string;
}

/** Reference speaker name → run speaker names known to mean the same character. */
export type AliasFile = Record<string, string[]>;

export type ErrorKind = 'to-narrator' | 'unresolved' | 'merge' | 'split' | 'misattribution';

export interface LineError {
  kind: ErrorKind;
  refSpeaker: string;
  runSpeaker: string;
  words: number;
  /** The first words of the reference line. */
  excerpt: string;
  refSegment: number;
}

export interface SpeakerMapping {
  run: string;
  ref: string;
  method: 'exact' | 'alias' | 'overlap';
  /** Words of the reference speaker's lines the run speaker was given. */
  overlapWords: number;
}

export interface NarrationStretch {
  runSpeaker: string;
  words: number;
  excerpt: string;
}

export interface ScoreResult {
  source: ScriptSource;
  segments: { reference: number; run: number };
  attribution: {
    /** Reference character lines that could be scored: their text is present in the run. */
    lines: number;
    correctLines: number;
    words: number;
    correctWords: number;
    lineAccuracy: number;
    wordAccuracy: number;
    /** Reference character lines whose text the run does not have; not counted either way. */
    missingLines: number;
    /** Share of the reference's scorable character lines that the run's text covers. */
    coverage: number;
    /** Character lines with no double quotation mark: quoted-mode Script cannot attribute them. */
    unattributable: Array<{ refSpeaker: string; excerpt: string; refSegment: number }>;
  };
  errors: Record<ErrorKind, number>;
  wrongLines: LineError[];
  narratorBoundary: {
    /** Narration the run gave to a character. */
    narrationToCharacter: { words: number; stretches: NarrationStretch[] };
    /** Character speech the run gave to the narrator. */
    speechToNarrator: { lines: number; words: number };
  };
  mapping: SpeakerMapping[];
  cast: {
    reference: number;
    found: string[];
    /** Reference characters the run has no speaker for. */
    missing: string[];
    /** The missing characters whose lines went to a merged speaker. */
    mergedAway: string[];
    extra: string[];
    merged: Array<{ run: string; refs: string[] }>;
    split: Array<{ ref: string; runs: string[] }>;
  };
  fidelity: {
    wordsAdded: number;
    wordsRemoved: number;
    added: string[];
    removed: string[];
  };
  facts: {
    lowConfidence: number;
    delivery: number;
    pauses: { reference: number; run: number };
    unresolvedSpeakers: string[];
  };
}

const NARRATOR = 'narrator';
const UNRESOLVED = 'unresolved speaker';
const EXCERPT_WORDS = 8;

/** Lower-cased words: letters and digits, with inner apostrophes. Punctuation and spacing never count. */
export function words(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? [];
}

function excerpt(text: string, count = EXCERPT_WORDS): string {
  const parts = text.replace(/\s+/g, ' ').trim().split(' ');
  return parts.slice(0, count).join(' ') + (parts.length > count ? ' …' : '');
}

/**
 * Pairs of equal tokens [aIndex, bIndex] in a shortest edit script between a
 * and b (Myers' algorithm). Each step keeps only the diagonals it can reach,
 * so memory grows with the square of the number of differences, not of the
 * text length.
 */
export function alignTokens(a: string[], b: string[], maxEdits = 6000): Array<[number, number]> {
  // Common ends are matched directly; only the middle needs the search.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < start; i += 1) pairs.push([i, i]);

  const x0 = a.slice(start, endA);
  const y0 = b.slice(start, endB);
  const n = x0.length;
  const m = y0.length;
  const max = n + m;
  const middle: Array<[number, number]> = [];
  if (n && m) {
    const offset = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace: Array<{ lo: number; values: Int32Array }> = [];
    let finalD = -1;
    for (let d = 0; d <= max && finalD < 0; d += 1) {
      if (d > maxEdits) throw new Error(`The texts differ in more than ${maxEdits} places and cannot be aligned.`);
      trace.push({ lo: -d - 1, values: v.slice(offset - d - 1, offset + d + 2) });
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && x0[x] === y0[y]) {
          x += 1;
          y += 1;
        }
        v[offset + k] = x;
        if (x >= n && y >= m) {
          finalD = d;
          break;
        }
      }
    }
    let x = n;
    let y = m;
    for (let d = finalD; d > 0; d -= 1) {
      const snap = trace[d];
      const at = (k: number): number => snap.values[k - snap.lo];
      const k = x - y;
      const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
      const prevX = at(prevK);
      const prevY = prevX - prevK;
      while (x > prevX && y > prevY) {
        x -= 1;
        y -= 1;
        middle.push([x, y]);
      }
      x = prevX;
      y = prevY;
    }
    while (x > 0 && y > 0) {
      x -= 1;
      y -= 1;
      middle.push([x, y]);
    }
  }
  middle.reverse();
  for (const [x, y] of middle) pairs.push([x + start, y + start]);
  for (let i = 0; i < a.length - endA; i += 1) pairs.push([endA + i, endB + i]);
  return pairs;
}

/** A speaker name reduced for matching: case, a leading "the", and Script's "(chapter N)" scope label are ignored. */
export function speakerKey(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s*\(chapter \d+\)\s*$/, '')
    .replace(/^the\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const isNarrator = (speaker: string): boolean => speaker.trim().toLowerCase() === NARRATOR;
const hasDoubleQuote = (text: string): boolean => /["“”]/.test(text);

interface Token {
  word: string;
  segment: number;
}

function tokenize(segments: ScoredSegment[]): Token[] {
  const tokens: Token[] = [];
  segments.forEach((segment, index) => {
    if (segment.kind === 'pause') return;
    for (const word of words(segment.text)) tokens.push({ word, segment: index });
  });
  return tokens;
}

/** Consecutive unaligned tokens of one side as short phrases. */
function unalignedPhrases(tokens: Token[], aligned: boolean[]): string[] {
  const phrases: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length) phrases.push(current.length > 12 ? `${current.slice(0, 12).join(' ')} … (${current.length} words)` : current.join(' '));
    current = [];
  };
  tokens.forEach((token, i) => {
    if (aligned[i]) flush();
    else current.push(token.word);
  });
  flush();
  return phrases;
}

export interface ScoreOptions {
  aliases?: AliasFile;
  unresolved?: string[];
  source?: ScriptSource;
}

/** Score one run's segments against the reference segments. */
export function scoreScript(reference: ScoredSegment[], run: ScoredSegment[], options: ScoreOptions = {}): ScoreResult {
  const unresolvedKeys = new Set([UNRESOLVED, ...(options.unresolved ?? [])].map(speakerKey));
  const isUnresolved = (speaker: string): boolean => unresolvedKeys.has(speakerKey(speaker)) || !speaker.trim();

  const refTokens = tokenize(reference);
  const runTokens = tokenize(run);
  const pairs = alignTokens(refTokens.map((t) => t.word), runTokens.map((t) => t.word));
  const refToRun = new Int32Array(refTokens.length).fill(-1);
  const runAligned = new Array<boolean>(runTokens.length).fill(false);
  for (const [i, j] of pairs) {
    refToRun[i] = j;
    runAligned[j] = true;
  }
  const runSpeakerAt = (refToken: number): string | undefined => {
    const j = refToRun[refToken];
    return j < 0 ? undefined : run[runTokens[j].segment].speaker;
  };

  // Reference tokens grouped by segment.
  const tokensOf = new Map<number, number[]>();
  refTokens.forEach((token, i) => {
    const list = tokensOf.get(token.segment) ?? [];
    list.push(i);
    tokensOf.set(token.segment, list);
  });

  interface Line {
    refSegment: number;
    refSpeaker: string;
    words: number;
    runSpeaker?: string;
  }
  const lines: Line[] = [];
  const unattributable: ScoreResult['attribution']['unattributable'] = [];
  let missingLines = 0;
  // Word overlap between each reference character and each run speaker.
  const overlap = new Map<string, Map<string, number>>();
  const refLineCount = new Map<string, number>();

  reference.forEach((segment, index) => {
    if (segment.kind === 'pause' || isNarrator(segment.speaker)) return;
    if (!hasDoubleQuote(segment.text)) {
      unattributable.push({ refSpeaker: segment.speaker, excerpt: excerpt(segment.text), refSegment: index });
      return;
    }
    const tokenIds = tokensOf.get(index) ?? [];
    const counts = new Map<string, number>();
    for (const t of tokenIds) {
      const speaker = runSpeakerAt(t);
      if (speaker !== undefined) counts.set(speaker, (counts.get(speaker) ?? 0) + 1);
    }
    if (!counts.size) {
      missingLines += 1;
      return;
    }
    const runSpeaker = [...counts.entries()].sort((l, r) => r[1] - l[1])[0][0];
    lines.push({ refSegment: index, refSpeaker: segment.speaker, words: tokenIds.length, runSpeaker });
    refLineCount.set(segment.speaker, (refLineCount.get(segment.speaker) ?? 0) + 1);
    const row = overlap.get(segment.speaker) ?? new Map<string, number>();
    for (const [speaker, count] of counts) row.set(speaker, (row.get(speaker) ?? 0) + count);
    overlap.set(segment.speaker, row);
  });

  // --- Speaker mapping: exact names and the alias file first, then best overlap, one to one.
  // A speaker whose every line is unattributable could never be found, so it is not part of the cast to find.
  const refSpeakers = [...new Set(reference.filter((s) => s.kind !== 'pause' && !isNarrator(s.speaker) && hasDoubleQuote(s.text)).map((s) => s.speaker))];
  const runSpeakers = [...new Set(run.filter((s) => s.kind !== 'pause' && !isNarrator(s.speaker) && !isUnresolved(s.speaker)).map((s) => s.speaker))];
  const overlapOf = (ref: string, runName: string): number => overlap.get(ref)?.get(runName) ?? 0;
  const aliasKeys = new Map<string, string>();
  for (const [ref, names] of Object.entries(options.aliases ?? {})) {
    for (const name of names) aliasKeys.set(speakerKey(name), ref);
  }
  const mapping: SpeakerMapping[] = [];
  const mappedRun = new Map<string, string>();
  const mappedRef = new Set<string>();
  const byName: Array<{ run: string; ref: string; method: 'exact' | 'alias' }> = [];
  for (const runName of runSpeakers) {
    const exact = refSpeakers.find((ref) => speakerKey(ref) === speakerKey(runName));
    if (exact) byName.push({ run: runName, ref: exact, method: 'exact' });
    else {
      const alias = aliasKeys.get(speakerKey(runName));
      if (alias && refSpeakers.includes(alias)) byName.push({ run: runName, ref: alias, method: 'alias' });
    }
  }
  byName.sort((l, r) => overlapOf(r.ref, r.run) - overlapOf(l.ref, l.run) || (l.method === 'exact' ? -1 : 1));
  for (const candidate of byName) {
    if (mappedRun.has(candidate.run) || mappedRef.has(candidate.ref)) continue;
    mappedRun.set(candidate.run, candidate.ref);
    mappedRef.add(candidate.ref);
    mapping.push({ ...candidate, overlapWords: overlapOf(candidate.ref, candidate.run) });
  }
  const pairsByOverlap = refSpeakers.flatMap((ref) => runSpeakers.map((runName) => ({ ref, run: runName, words: overlapOf(ref, runName) })))
    .filter((pair) => pair.words > 0)
    .sort((l, r) => r.words - l.words || l.ref.localeCompare(r.ref) || l.run.localeCompare(r.run));
  for (const pair of pairsByOverlap) {
    if (mappedRun.has(pair.run) || mappedRef.has(pair.ref)) continue;
    mappedRun.set(pair.run, pair.ref);
    mappedRef.add(pair.ref);
    mapping.push({ run: pair.run, ref: pair.ref, method: 'overlap', overlapWords: pair.words });
  }

  // --- Merges and splits, from who holds each reference speaker's lines.
  const held = new Map<string, Map<string, number>>(); // run speaker -> ref speaker -> lines
  for (const line of lines) {
    if (!line.runSpeaker || isNarrator(line.runSpeaker) || isUnresolved(line.runSpeaker)) continue;
    const row = held.get(line.runSpeaker) ?? new Map<string, number>();
    row.set(line.refSpeaker, (row.get(line.refSpeaker) ?? 0) + 1);
    held.set(line.runSpeaker, row);
  }
  const merged: ScoreResult['cast']['merged'] = [];
  for (const [runName, row] of held) {
    const refs = [...row.entries()]
      .filter(([ref, count]) => count >= Math.max(1, Math.ceil((refLineCount.get(ref) ?? 0) / 2)))
      .map(([ref]) => ref);
    if (refs.length >= 2) merged.push({ run: runName, refs: refs.sort() });
  }
  const split: ScoreResult['cast']['split'] = [];
  for (const ref of refSpeakers) {
    const total = refLineCount.get(ref) ?? 0;
    const runs = [...held.entries()]
      .filter(([, row]) => (row.get(ref) ?? 0) >= Math.max(1, Math.ceil(total / 4)))
      .map(([runName]) => runName);
    if (runs.length >= 2) split.push({ ref, runs: runs.sort() });
  }
  const inMerge = (runName: string, ref: string): boolean => merged.some((m) => m.run === runName && m.refs.includes(ref));
  const inSplit = (runName: string, ref: string): boolean => split.some((s) => s.ref === ref && s.runs.includes(runName));

  // --- Lines.
  const errors: Record<ErrorKind, number> = { 'to-narrator': 0, unresolved: 0, merge: 0, split: 0, misattribution: 0 };
  const wrongLines: LineError[] = [];
  let correctLines = 0;
  let correctWords = 0;
  let totalWords = 0;
  let toNarratorWords = 0;
  for (const line of lines) {
    totalWords += line.words;
    const runSpeaker = line.runSpeaker!;
    if (!isNarrator(runSpeaker) && !isUnresolved(runSpeaker) && mappedRun.get(runSpeaker) === line.refSpeaker) {
      correctLines += 1;
      correctWords += line.words;
      continue;
    }
    const kind: ErrorKind = isNarrator(runSpeaker) ? 'to-narrator'
      : isUnresolved(runSpeaker) ? 'unresolved'
        : inMerge(runSpeaker, line.refSpeaker) ? 'merge'
          : inSplit(runSpeaker, line.refSpeaker) ? 'split'
            : 'misattribution';
    errors[kind] += 1;
    if (kind === 'to-narrator') toNarratorWords += line.words;
    wrongLines.push({
      kind, refSpeaker: line.refSpeaker, runSpeaker, words: line.words,
      excerpt: excerpt(reference[line.refSegment].text), refSegment: line.refSegment,
    });
  }

  // --- Narration the run gave to a character, as contiguous stretches.
  const stretches: NarrationStretch[] = [];
  let narrationWords = 0;
  let open: { runSegment: number; tokens: number[] } | undefined;
  const closeStretch = (): void => {
    if (!open) return;
    const words = open.tokens.map((t) => refTokens[t].word);
    stretches.push({ runSpeaker: run[open.runSegment].speaker, words: words.length, excerpt: excerpt(words.join(' ')) });
    open = undefined;
  };
  refTokens.forEach((token, i) => {
    const narration = isNarrator(reference[token.segment].speaker) && reference[token.segment].kind !== 'pause';
    const j = refToRun[i];
    const speaker = j < 0 ? undefined : run[runTokens[j].segment].speaker;
    if (narration && speaker !== undefined && !isNarrator(speaker)) {
      narrationWords += 1;
      const segment = runTokens[j].segment;
      if (!open || open.runSegment !== segment) {
        closeStretch();
        open = { runSegment: segment, tokens: [] };
      }
      open.tokens.push(i);
    } else if (j >= 0 || !narration) {
      closeStretch();
    }
  });
  closeStretch();

  // --- Cast.
  const mergedRefs = new Set(merged.flatMap((m) => m.refs));
  const splitRuns = new Set(split.flatMap((s) => s.runs));
  const found = refSpeakers.filter((ref) => mappedRef.has(ref));
  const extra = runSpeakers.filter((runName) => !mappedRun.has(runName) && !splitRuns.has(runName) && !merged.some((m) => m.run === runName));

  const refAligned = new Array<boolean>(refTokens.length).fill(false);
  for (const [i] of pairs) refAligned[i] = true;
  const removed = unalignedPhrases(refTokens, refAligned);
  const added = unalignedPhrases(runTokens, runAligned);

  const scorable = lines.length + missingLines;
  return {
    source: options.source ?? 'script',
    segments: { reference: reference.length, run: run.length },
    attribution: {
      lines: lines.length,
      correctLines,
      words: totalWords,
      correctWords,
      lineAccuracy: lines.length ? correctLines / lines.length : 0,
      wordAccuracy: totalWords ? correctWords / totalWords : 0,
      missingLines,
      coverage: scorable ? lines.length / scorable : 0,
      unattributable,
    },
    errors,
    wrongLines,
    narratorBoundary: {
      narrationToCharacter: { words: narrationWords, stretches },
      speechToNarrator: { lines: errors['to-narrator'], words: toNarratorWords },
    },
    mapping: mapping.sort((l, r) => l.ref.localeCompare(r.ref)),
    cast: {
      reference: refSpeakers.length,
      found,
      missing: refSpeakers.filter((ref) => !mappedRef.has(ref)),
      mergedAway: refSpeakers.filter((ref) => !mappedRef.has(ref) && mergedRefs.has(ref)),
      extra,
      merged,
      split,
    },
    fidelity: {
      wordsAdded: runAligned.filter((x) => !x).length,
      wordsRemoved: refAligned.filter((x) => !x).length,
      added,
      removed,
    },
    facts: {
      lowConfidence: run.filter((s) => s.kind !== 'pause' && s.confidence === 'low').length,
      delivery: run.filter((s) => s.delivery?.trim()).length,
      pauses: { reference: reference.filter((s) => s.kind === 'pause').length, run: run.filter((s) => s.kind === 'pause').length },
      unresolvedSpeakers: [...new Set(run.map((s) => s.speaker).filter((speaker) => !isNarrator(speaker) && isUnresolved(speaker)))],
    },
  };
}

// ---------------------------------------------------------------------------
// Reading folders.

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));

function isWorkDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'state.json')) || fs.existsSync(path.join(dir, '1-scripts')) || fs.existsSync(path.join(dir, 'checkpoints'));
}

/** The work folder at or below `folder`: a run folder holds one work folder. */
export function findWorkDir(folder: string): string | undefined {
  if (isWorkDir(folder)) return folder;
  if (!fs.existsSync(folder)) return undefined;
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (entry.isDirectory() && isWorkDir(path.join(folder, entry.name))) return path.join(folder, entry.name);
  }
  return undefined;
}

function chapterFileIn(dir: string, index: number): string | undefined {
  if (!fs.existsSync(dir)) return undefined;
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json') && Number(/^(\d+)-/.exec(name)?.[1]) === index).sort()[0];
}

/**
 * A run's script for one chapter. A finished chapter is read from 1-scripts.
 * A chapter blocked on an unresolved speaker has no script, but its checkpoint
 * keeps the verified segments as `result`; those are scored and the speakers
 * listed under "unresolved" in characters.json count as wrong. A run that
 * failed before verification has only the finished blocks.
 */
export function loadRunScript(folder: string, chapter = 0): RunScript | undefined {
  const workDir = findWorkDir(folder);
  if (!workDir) return undefined;
  const scriptFile = chapterFileIn(path.join(workDir, '1-scripts'), chapter);
  const registryFile = path.join(workDir, 'characters.json');
  const registry = fs.existsSync(registryFile) ? readJson(registryFile) as { unresolved?: Array<{ chapter?: number; speaker?: string }> } : {};
  const unresolved = (registry.unresolved ?? [])
    .filter((record) => record.chapter === undefined || record.chapter === chapter)
    .flatMap((record) => (typeof record.speaker === 'string' ? [record.speaker] : []));
  if (scriptFile) {
    const script = readJson(path.join(workDir, '1-scripts', scriptFile)) as { segments: ScoredSegment[] };
    return { segments: script.segments, source: 'script', unresolved: [], workDir };
  }
  const checkpoint = path.join(workDir, 'checkpoints', `script-${String(chapter).padStart(2, '0')}.json`);
  if (!fs.existsSync(checkpoint)) return undefined;
  const saved = readJson(checkpoint) as { blocks?: Array<{ segments?: ScoredSegment[] }>; result?: ScoredSegment[] };
  if (Array.isArray(saved.result)) return { segments: saved.result, source: 'checkpoint-result', unresolved, workDir };
  return { segments: (saved.blocks ?? []).flatMap((block) => block.segments ?? []), source: 'checkpoint-blocks', unresolved, workDir };
}

export interface Target {
  segments: ScoredSegment[];
  aliases: AliasFile;
}

/** The reference script and its alias file, from benchmarks/0-target. */
export function loadTarget(targetDir: string): Target {
  const script = readJson(path.join(targetDir, 'script', '00.json')) as { segments: ScoredSegment[] };
  const aliasFile = path.join(targetDir, 'aliases.json');
  const aliases = fs.existsSync(aliasFile) ? readJson(aliasFile) as AliasFile : {};
  return { segments: script.segments, aliases };
}

/** Score the run in `folder`, or undefined when it has neither a script nor a checkpoint. */
export function scoreFolder(folder: string, target: Target): ScoreResult | undefined {
  const run = loadRunScript(folder);
  if (!run) return undefined;
  return scoreScript(target.segments, run.segments, { aliases: target.aliases, unresolved: run.unresolved, source: run.source });
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

/** A short plain-text summary of one score, for the `score` command. */
export function formatScore(score: ScoreResult): string {
  const a = score.attribution;
  const lines = [
    `Source: ${score.source} (${score.segments.run} segments; reference ${score.segments.reference})`,
    `Dialogue attribution: ${pct(a.lineAccuracy)} of lines (${a.correctLines}/${a.lines}), ${pct(a.wordAccuracy)} of words (${a.correctWords}/${a.words})`,
    `Coverage: ${pct(a.coverage)}${a.missingLines ? ` (${a.missingLines} reference line(s) not in the run's text)` : ''}; not attributable in quoted mode: ${a.unattributable.length}`,
    `Errors: ${Object.entries(score.errors).map(([kind, count]) => `${kind} ${count}`).join(', ')}`,
    `Narrator boundary: ${score.narratorBoundary.narrationToCharacter.words} narration word(s) given to a character in ${score.narratorBoundary.narrationToCharacter.stretches.length} stretch(es); ${score.narratorBoundary.speechToNarrator.lines} speech line(s) given to the narrator`,
    `Cast: ${score.cast.found.length}/${score.cast.reference} found; missing ${score.cast.missing.join(', ') || 'none'}${score.cast.mergedAway.length ? ` (merged away: ${score.cast.mergedAway.join(', ')})` : ''}; extra ${score.cast.extra.join(', ') || 'none'}`,
    ...score.cast.merged.map((m) => `  merged: ${m.refs.join(' + ')} → ${m.run}`),
    ...score.cast.split.map((s) => `  split: ${s.ref} → ${s.runs.join(' + ')}`),
    'Mapping:',
    ...score.mapping.map((m) => `  ${m.ref} ← ${m.run} (${m.method}${m.method === 'overlap' ? `, ${m.overlapWords} words` : ''})`),
    `Text fidelity: +${score.fidelity.wordsAdded} / −${score.fidelity.wordsRemoved} words`,
    ...score.fidelity.added.slice(0, 5).map((p) => `  added: ${p}`),
    ...score.fidelity.removed.slice(0, 5).map((p) => `  removed: ${p}`),
    `Low confidence: ${score.facts.lowConfidence}; delivery hints: ${score.facts.delivery}; pauses: ${score.facts.pauses.run} (reference ${score.facts.pauses.reference})${score.facts.unresolvedSpeakers.length ? `; unresolved: ${score.facts.unresolvedSpeakers.join(', ')}` : ''}`,
  ];
  if (score.wrongLines.length) {
    lines.push('Wrong lines:');
    for (const wrong of score.wrongLines) lines.push(`  [${wrong.kind}] ${wrong.refSpeaker} → ${wrong.runSpeaker}: ${wrong.excerpt}`);
  }
  return lines.join('\n');
}
