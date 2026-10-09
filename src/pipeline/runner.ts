import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, STAGES, withLlmRunConfig, type ProviderId, type Stage } from '../config.js';
import { WorkDir, openWorkDir } from '../state.js';
import { BookAnnotationsSchema, ChapterMapSchema, ChapterScriptSchema, CorrectionsSchema, type Analysis, type BookMetadata } from '../types.js';
import { runAnalyze } from './analyze.js';
import { runAssemble } from './assemble.js';
import { runCasting } from './casting.js';
import { runChapters } from './chapters.js';
import { CHARACTER_REGISTRY_FILE, characterChapterFile, characterRegistryHash, readCharacterRegistry, runListCharacters } from './list-characters.js';
import { runExtract } from './extract.js';
import { runScript, SCRIPT_CONVERTER_VERSION, validateScriptCoverage } from './script.js';
import { runSynth } from './synth.js';
import { runVoices } from './voices.js';
import { BOOKNLP_ADAPTER_VERSION, BOOKNLP_PIPELINE, runBookNlp } from './booknlp.js';
import type { VoiceTarget } from '../voices/library.js';
import { withWarningReporter } from '../util/warnings.js';
import { withStageProgress, type ChapterProgress, type ActivityProgress } from '../util/progress.js';
import { throwIfTaskCancelled, withTaskCancellation } from '../util/cancellation.js';
import { sourceIsAvailable, type SourceMetadataOverrides } from '../source/read.js';
import { acquireWorkspaceLock } from '../util/workspace-lock.js';

export type ChapterStage = 'chapters' | 'script' | 'synth';

export interface PipelineEvent {
  type: 'started' | 'completed' | 'skipped' | 'warning' | 'progress';
  stage: Stage;
  message: string;
  progress?: ChapterProgress | ActivityProgress;
  heartbeat?: boolean;
}

export interface RunStageOptions {
  /** Override the text-processing provider for this one run. */
  llmProvider?: ProviderId;
  /** Override the text-processing model for this one run. */
  llmModel?: string;
  voiceTarget?: VoiceTarget;
  voiceLibraryFile?: string;
  sourcePath?: string;
  /** @deprecated Use sourcePath. Kept so existing programmatic callers can migrate safely. */
  epubPath?: string;
  workRoot: string;
  /** Optional export directory; defaults to this book's work folder. */
  outDir?: string;
  stage: Stage;
  metadataOverrides?: SourceMetadataOverrides;
  chapterIndexes?: number[];
  /** Execute the stage even when its completion record and output already exist. */
  rerun?: boolean;
  rebuild?: boolean;
  /** Abort an in-progress local UI task. */
  signal?: AbortSignal;
  onEvent?: (event: PipelineEvent) => void;
}

export interface RunStageResult {
  work: WorkDir;
  stage: Stage;
  skipped: boolean;
  output?: string;
  chapterIndexes?: number[];
}

export interface DiscoveredBook {
  root: string;
  sourcePath: string;
  sourceAvailable: boolean;
  completed: Partial<Record<Stage, string>>;
}

const CHAPTER_STAGES = new Set<Stage>(['chapters', 'script', 'synth']);

/** Run exactly one stage. The CLI and local UI both use this instead of duplicating orchestration. */
export async function runStage(options: RunStageOptions): Promise<RunStageResult> {
  return withTaskCancellation(options.signal, () => withLlmRunConfig({ provider: options.llmProvider, model: options.llmModel }, () => withWarningReporter((message) => {
    if (options.onEvent) options.onEvent({ type: 'warning', stage: options.stage, message });
    else console.warn(`  ${message}`);
  }, () => withStageProgress((progress, message, heartbeat) => {
    if (options.onEvent) options.onEvent({ type: 'progress', stage: options.stage, progress, message, heartbeat });
    else console.log(`[${options.stage}] ${message}`);
  }, () => executeStage(options)))));
}

async function executeStage(options: RunStageOptions): Promise<RunStageResult> {
  const { workRoot, outDir, stage, rebuild, rerun, onEvent } = options;
  const sourcePath = options.sourcePath ?? options.epubPath;
  throwIfTaskCancelled();
  if (!STAGES.includes(stage)) throw new Error(`Unknown stage "${stage}".`);
  if (!sourcePath) throw new Error('A source file path is required.');
  if (!sourceIsAvailable(sourcePath)) throw new Error(`Source file not found: ${sourcePath}`);

  const work = await openWorkDir(sourcePath, workRoot, options.metadataOverrides);
  const releaseLock = acquireWorkspaceLock(work.root, `stage:${stage}`);
  try {
  migrateLegacyArtifacts(work);
  if (options.metadataOverrides) work.setMetadataOverrides(options.metadataOverrides);
  const chapterIndexes = normalizeChapterIndexes(options.chapterIndexes);
  if (chapterIndexes && stage === 'list-characters') {
    throw new Error('List Characters uses all narratable chapters; omit --chapters.');
  }
  if (rebuild && rerun) throw new Error('Choose either rerun or rebuild, not both.');
  if (rebuild && chapterIndexes) {
    throw new Error('Chapter-specific rebuild is not supported yet. Rebuild the full stage, or run selected chapters to resume them.');
  }
  if (work.sourceChanged() && !(stage === 'extract' && rebuild)) {
    throw new Error('The selected source differs from the one that produced this work folder. Rebuild Extract before running later stages.');
  }
  // Establish that the requested operation is valid before changing completion
  // state or removing any derived artifact.
  const selected = await validatePrerequisites(work, stage, chapterIndexes);
  if (rebuild) {
    work.invalidateFrom(stage);
    clearArtifactsFrom(work, stage);
  } else if (rerun) {
    // A selected chapter rerun replaces that chapter's output, but must retain
    // completion from earlier selected runs. Only its dependants become stale.
    // Without this distinction, every UI selected run erased the progress made
    // by the previous selection, so a whole-book stage could never complete.
    if (chapterIndexes && CHAPTER_STAGES.has(stage)) work.invalidateAfter(stage);
    else work.invalidateFrom(stage);
    clearStageOutputForRerun(work, stage, chapterIndexes);
  }

  if (stage === 'synth' && work.isDone('synth') && work.synthesisInputsChanged()) {
    work.invalidateFrom('synth');
    clearArtifactsFrom(work, 'synth');
  }
  if (!chapterIndexes && work.isDone(stage) && !rebuild && !rerun) {
    onEvent?.({ type: 'skipped', stage, message: `${stage} is already complete.` });
    return { work, stage, skipped: true };
  }

  onEvent?.({ type: 'started', stage, message: `Running ${stage}…` });
  let output: string | undefined;
  switch (stage) {
    case 'extract':
      await runExtract(sourcePath, work, work.metadataOverrides());
      work.acceptCurrentSource();
      work.markDone(stage);
      break;
    case 'analyze':
      await runAnalyze(work);
      work.markDone(stage);
      break;
    case 'chapters':
      await runChapters(work, selected);
      markChapterStage(work, stage, selected);
      break;
    case 'booknlp':
      await runBookNlp(work);
      work.markDone(stage);
      break;
    case 'list-characters': {
      const previous = fs.existsSync(work.path(CHARACTER_REGISTRY_FILE))
        ? fs.readFileSync(work.path(CHARACTER_REGISTRY_FILE), 'utf8') : undefined;
      runListCharacters(work);
      if (previous !== fs.readFileSync(work.path(CHARACTER_REGISTRY_FILE), 'utf8')) {
        work.invalidateFrom('script');
        // Old encoded chapters must not survive a change of speaker attribution.
        clearArtifactsFrom(work, 'synth');
      }
      work.markDone(stage);
      break;
    }
    case 'script':
      await runScript(work, selected, onEvent
        ? (progress, message, heartbeat) => onEvent({ type: 'progress', stage, progress, message, heartbeat })
        : undefined);
      markChapterStage(work, stage, selected);
      break;
    case 'casting':
      await runCasting(work);
      work.markDone(stage);
      break;
    case 'voices':
      runVoices(work, options.voiceTarget, options.voiceLibraryFile);
      work.markDone(stage);
      break;
    case 'synth':
      await runSynth(work, selected);
      markChapterStage(work, stage, selected);
      if (!selected || work.isDone('synth')) work.recordSynthesisInputs();
      break;
    case 'assemble':
      output = await runAssemble(work, outDir, chapterIndexes);
      if (!chapterIndexes) work.markDone(stage);
      break;
  }
  throwIfTaskCancelled();
  onEvent?.({ type: 'completed', stage, message: output ? `Created ${output}` : `${stage} complete.` });
  return { work, stage, skipped: false, output, chapterIndexes: selected };
  } finally {
    releaseLock();
  }
}

export function migrateLegacyArtifacts(work: WorkDir): void {
  const scriptDir = work.path('script');
  if (!fs.existsSync(scriptDir)) return;
  const registry = fs.existsSync(work.path('characters.json')) ? readCharacterRegistry(work) : undefined;
  for (const file of fs.readdirSync(scriptDir).filter((name) => /^\d+\.json$/.test(name))) {
    const raw = work.readJson<{ index?: number; version?: number; format?: string; segments?: Array<{ speaker?: string; speakerId?: string; [key: string]: unknown }>; [key: string]: unknown }>(`script/${file}`);
    if (!Number.isInteger(raw.index) || !Array.isArray(raw.segments)) continue;
    const destination = `script/${String(raw.index).padStart(4, '0')}.json`;
    const needsMigration = raw.format === undefined || file !== path.basename(destination);
    if (!needsMigration || (file !== path.basename(destination) && fs.existsSync(work.path(destination)))) continue;
    const segments = raw.segments.map((segment) => {
      if (segment.speakerId || segment.speaker === 'narrator') return { ...segment, speakerId: segment.speaker === 'narrator' ? 'narrator' : segment.speakerId };
      const matches = registry?.characters.filter((character) => character.name === segment.speaker) ?? [];
      return { ...segment, ...(matches.length === 1 ? { speakerId: matches[0].id } : {}) };
    });
    work.writeJson(destination, { ...raw, format: raw.format ?? 'legacy-markdown', segments });
  }
}

export function discoverBooks(workRoot: string): DiscoveredBook[] {
  if (!fs.existsSync(workRoot)) return [];
  return fs
    .readdirSync(workRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const root = path.resolve(workRoot, entry.name);
      const statePath = path.join(root, 'state.json');
      if (!fs.existsSync(statePath)) return [];
      try {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
          source?: string;
          epub?: string;
          completed?: Partial<Record<Stage, string>>;
        };
        const sourcePath = state.source ?? state.epub;
        if (!sourcePath) return [];
        return [{
          root,
          sourcePath,
          sourceAvailable: sourceIsAvailable(sourcePath),
          completed: state.completed ?? {},
        }];
      } catch {
        return [];
      }
    });
}

/**
 * Older work folders can contain complete artifacts but an empty manifest after
 * an interrupted run or the pre-UI source-relink behavior. Recover only when
 * the current source is known to match; a changed source must be rebuilt instead.
 */
export function recoverStageStateFromArtifacts(work: WorkDir): boolean {
  if (work.sourceChanged() || Object.keys(work.snapshot().completed).length > 0) return false;
  if (!fs.existsSync(work.path('metadata.json'))) return false;

  let changed = false;
  work.markDone('extract');
  changed = true;
  if (!fs.existsSync(work.path('analysis.json'))) return changed;
  work.markDone('analyze');

  const narratable = narratableChapterIndexes(work);
  const summaries = fs.existsSync(work.path('chapter-summaries.json'))
    ? work.readJson<Record<string, string>>('chapter-summaries.json')
    : {};
  const hasCleanOutput = narratable.every((index) =>
    fs.existsSync(work.path(`chapters-clean/${String(index).padStart(4, '0')}.txt`)) && summaries[String(index)] !== undefined
  );
  if (!hasCleanOutput) return changed;
  work.markChaptersDone('chapters', narratable, narratable);

  if (!fs.existsSync(work.path('booknlp/annotations.json')) || !fs.existsSync(work.path('booknlp/chapter-map.json')) || !fs.existsSync(work.path('booknlp/input.txt'))) return changed;
  const recoveredMap = ChapterMapSchema.safeParse(work.readJson('booknlp/chapter-map.json'));
  const recoveredAnnotations = BookAnnotationsSchema.safeParse(work.readJson('booknlp/annotations.json'));
  const recoveredInputHash = crypto.createHash('sha256').update(fs.readFileSync(work.path('booknlp/input.txt'))).digest('hex');
  if (!recoveredMap.success || !recoveredAnnotations.success || recoveredMap.data.inputSha256 !== recoveredInputHash || recoveredAnnotations.data.source.inputSha256 !== recoveredInputHash || recoveredAnnotations.data.provenance.model !== config.booknlpModel || recoveredAnnotations.data.provenance.adapterVersion !== BOOKNLP_ADAPTER_VERSION) return changed;
  const recoveredBookNlpFingerprint = crypto.createHash('sha256').update(JSON.stringify({
    inputSha256: recoveredInputHash,
    model: config.booknlpModel,
    pipeline: BOOKNLP_PIPELINE,
    toolVersion: recoveredAnnotations.data.provenance.toolVersion,
    adapterVersion: BOOKNLP_ADAPTER_VERSION,
  })).digest('hex');
  if (recoveredAnnotations.data.provenance.fingerprint !== recoveredBookNlpFingerprint) return changed;
  if (!['book.tokens', 'book.quotes', 'book.entities', 'book.book'].every((file) => fs.existsSync(work.path('booknlp/output', file)))) return changed;
  work.markDone('booknlp');

  if (!fs.existsSync(work.path(CHARACTER_REGISTRY_FILE))) return changed;
  work.markDone('list-characters');

  const registry = readCharacterRegistry(work);
  const registryHash = characterRegistryHash(registry);
  const corrections = fs.existsSync(work.path('corrections.json'))
    ? CorrectionsSchema.parse(work.readJson('corrections.json'))
    : CorrectionsSchema.parse({ version: 1 });
  const frozenInput = fs.readFileSync(work.path('booknlp/input.txt'), 'utf8');
  const hasScripts = narratable.every((index) => {
    const file = `script/${String(index).padStart(4, '0')}.json`;
    if (!fs.existsSync(work.path(file))) return false;
    const script = ChapterScriptSchema.safeParse(work.readJson(file));
    const mapped = recoveredMap.data.chapters.find((chapter) => chapter.index === index);
    if (!script.success || !mapped || script.data.characterRegistryHash !== registryHash) return false;
    const expectedFingerprint = crypto.createHash('sha256').update(JSON.stringify({
      annotations: recoveredAnnotations.data.provenance.fingerprint,
      chapterMap: recoveredMap.data,
      registry,
      corrections,
      chapter: index,
      converter: SCRIPT_CONVERTER_VERSION,
    })).digest('hex');
    if (script.data.fingerprint !== expectedFingerprint) return false;
    try { validateScriptCoverage(script.data, frozenInput, mapped.start, mapped.end); return true; }
    catch { return false; }
  });
  if (!hasScripts) return changed;
  work.markChaptersDone('script', narratable, narratable);

  if (!fs.existsSync(work.path('casting.json'))) return changed;
  work.markDone('casting');

  if (!fs.existsSync(work.path('voice-bindings.json'))) return changed;
  work.markDone('voices');

  const hasAudio = narratable.every((index) => {
    const file = `audio/${String(index).padStart(4, '0')}-segments.json`;
    if (!fs.existsSync(work.path(file))) return false;
    const manifest = work.readJson<{ version?: number; index?: number; fingerprint?: string; scriptFingerprint?: string }>(file);
    const script = work.readJson<{ fingerprint?: string }>(`script/${String(index).padStart(4, '0')}.json`);
    return manifest.version === 2 && manifest.index === index && Boolean(manifest.fingerprint) && manifest.scriptFingerprint === script.fingerprint;
  });
  if (hasAudio) work.markChaptersDone('synth', narratable, narratable);
  return changed;
}

/** Remove derived output only for an explicit rebuild; audio cache is intentionally retained. */
export function clearArtifactsFrom(work: WorkDir, stage: Stage): void {
  const files: Partial<Record<Stage, string[]>> = {
    extract: ['chapters', 'metadata.json', 'analysis.json', 'chapters-clean', 'chapter-summaries.json', 'chapter-characters', 'booknlp', 'characters.json', 'character-candidates', 'script', 'casting.json', 'voice-bindings.json', 'audio'],
    analyze: ['analysis.json', 'chapters-clean', 'chapter-summaries.json', 'chapter-characters', 'booknlp', 'characters.json', 'character-candidates', 'script', 'casting.json', 'voice-bindings.json', 'audio'],
    chapters: ['chapters-clean', 'chapter-summaries.json', 'chapter-characters', 'booknlp', 'characters.json', 'character-candidates', 'script', 'casting.json', 'voice-bindings.json', 'audio'],
    booknlp: ['booknlp', 'characters.json', 'character-candidates', 'script', 'casting.json', 'voice-bindings.json', 'audio'],
    'list-characters': ['characters.json', 'character-candidates', 'script', 'casting.json', 'voice-bindings.json', 'audio'],
    script: ['character-candidates', 'script', 'casting.json', 'voice-bindings.json', 'audio'],
    casting: ['casting.json', 'voice-bindings.json', 'audio'],
    voices: ['voice-bindings.json', 'audio'],
    synth: ['audio'],
  };
  for (const rel of files[stage] ?? []) fs.rmSync(work.path(rel), { recursive: true, force: true });
}

/** Clear only the output that prevents a requested stage from actually executing. */
function clearStageOutputForRerun(work: WorkDir, stage: Stage, indexes?: number[]): void {
  if (stage === 'chapters') {
    if (!indexes) {
      fs.rmSync(work.path('chapters-clean'), { recursive: true, force: true });
      fs.rmSync(work.path('chapter-summaries.json'), { force: true });
      fs.rmSync(work.path('chapter-characters'), { recursive: true, force: true });
      return;
    }
    const summaries = fs.existsSync(work.path('chapter-summaries.json'))
      ? work.readJson<Record<string, string>>('chapter-summaries.json')
      : {};
    for (const index of indexes) {
      fs.rmSync(work.path(`chapters-clean/${String(index).padStart(4, '0')}.txt`), { force: true });
      fs.rmSync(work.path(characterChapterFile(index)), { force: true });
      delete summaries[String(index)];
    }
    work.writeJson('chapter-summaries.json', summaries);
    return;
  }
  if (stage === 'script') {
    if (!indexes) {
      fs.rmSync(work.path('script'), { recursive: true, force: true });
      clearEncodedAudio(work);
      return;
    }
    for (const index of indexes) {
      fs.rmSync(work.path(`script/${String(index).padStart(4, '0')}.json`), { force: true });
      fs.rmSync(work.path(`audio/${String(index).padStart(4, '0')}-segments.json`), { force: true });
      fs.rmSync(work.path(`audio/${String(index).padStart(4, '0')}.m4a`), { force: true });
      fs.rmSync(work.path(`audio/${String(index).padStart(4, '0')}.m4a.json`), { force: true });
    }
    return;
  }
  if (stage === 'synth') {
    const audio = work.path('audio');
    if (!fs.existsSync(audio)) return;
    const files = fs.readdirSync(audio).filter((file) => file.endsWith('.m4a'));
    for (const file of files) {
      const index = Number.parseInt(file, 10);
      if (!indexes || indexes.includes(index)) fs.rmSync(path.join(audio, file), { force: true });
    }
  }
}

function normalizeChapterIndexes(indexes?: number[]): number[] | undefined {
  if (!indexes?.length) return undefined;
  const normalized = [...new Set(indexes)].sort((a, b) => a - b);
  if (normalized.some((index) => !Number.isInteger(index) || index < 0)) {
    throw new Error('Chapter indexes must be non-negative integers.');
  }
  return normalized;
}

async function validatePrerequisites(
  work: WorkDir,
  stage: Stage,
  requested?: number[]
): Promise<number[] | undefined> {
  const requireDone = (prerequisite: Stage): void => {
    if (!work.isDone(prerequisite)) throw new Error(`Run ${prerequisite} before ${stage}.`);
  };
  switch (stage) {
    case 'analyze': requireDone('extract'); break;
    case 'chapters': requireDone('analyze'); break;
    case 'booknlp': requireDone('chapters'); break;
    case 'list-characters': requireDone('booknlp'); break;
    case 'script':
      requireDone('booknlp');
      requireDone('list-characters');
      if (!requested) requireDone('chapters');
      break;
    case 'casting':
      requireDone('analyze');
      requireDone('list-characters');
      if (!fs.existsSync(work.path('script'))) throw new Error('Run script for at least one chapter before casting.');
      break;
    case 'voices':
      if (!fs.existsSync(work.path('casting.json'))) throw new Error('Run casting before voices.');
      return;
    case 'synth':
      requireDone('voices');
      if (!requested) requireDone('script');
      break;
    case 'assemble':
      if (!requested) requireDone('synth');
      else if (requested.some((index) => !narratableChapterIndexes(work).includes(index))) {
        throw new Error('One or more selected chapters are not in the current narration plan.');
      }
      break;
  }
  if (!CHAPTER_STAGES.has(stage)) return requested;

  const available = narratableChapterIndexes(work);
  const selected = requested ?? available;
  if (selected.some((index) => !available.includes(index))) {
    throw new Error(`One or more selected chapters are not narratable chapters.`);
  }
  if (stage === 'script') requireFiles(work, selected, 'chapters-clean', '.txt', 'Run chapters for the selected chapter first.', 4);
  if (stage === 'synth') requireFiles(work, selected, 'script', '.json', 'Run script for the selected chapter first.');
  return selected;
}

function requireFiles(work: WorkDir, indexes: number[], dir: string, extension: string, message: string, width = 4): void {
  for (const index of indexes) {
    const file = `${dir}/${String(index).padStart(width, '0')}${extension}`;
    if (!fs.existsSync(work.path(file))) throw new Error(message);
  }
}

function clearEncodedAudio(work: WorkDir): void {
  const audio = work.path('audio');
  if (!fs.existsSync(audio)) return;
  for (const file of fs.readdirSync(audio)) {
    if (/^\d+(?:-segments\.json|\.m4a(?:\.json)?)$/.test(file)) fs.rmSync(path.join(audio, file), { force: true });
  }
}

function narratableChapterIndexes(work: WorkDir): number[] {
  const metadata = work.readJson<BookMetadata>('metadata.json');
  const analysis = work.readJson<Analysis>('analysis.json');
  return metadata.chapters
    .filter((chapter) => analysis.chapters.find((plan) => plan.index === chapter.index)?.narrate)
    .map((chapter) => chapter.index);
}

function markChapterStage(work: WorkDir, stage: ChapterStage, indexes?: number[]): void {
  const all = narratableChapterIndexes(work);
  if (all.length === 0) {
    work.markDone(stage);
    return;
  }
  if (stage === 'chapters') {
    // A selected rerun replaces only that chapter's observations. Retained
    // complete chapters still count toward the whole-book registry prerequisite.
    const summaries = work.readJson<Record<string, string>>('chapter-summaries.json');
    const complete = all.filter((index) => summaries[String(index)] !== undefined &&
      fs.existsSync(work.path(`chapters-clean/${String(index).padStart(4, '0')}.txt`)));
    work.markChaptersDone(stage, complete, all);
    return;
  }
  if (stage === 'script') {
    // A run can stop at the first unresolved speaker. When that speaker is
    // resolved, earlier script files remain valid and let the next selected
    // run continue from the failed chapter rather than starting over.
    const complete = all.filter((index) => fs.existsSync(work.path(`script/${String(index).padStart(4, '0')}.json`)));
    work.markChaptersDone(stage, complete, all);
    return;
  }
  work.markChaptersDone(stage, indexes ?? all, all);
}
