import fs from 'node:fs';
import path from 'node:path';
import { STAGES, withLlmRunConfig, type OpenRouterReasoningEffort, type ProviderId, type Stage } from '../config.js';
import { OUTDATED_WORK_FOLDER_MESSAGE, WorkDir, openWorkDir } from '../state.js';
import type { BookMetadata, Stories } from '../types.js';
import { AUDIO_DIR, CHAPTERS_DIR, CHARACTERS_FILE, METADATA_FILE, SCRIPTS_DIR, findChapterFile, listChapterFiles, removeChapterFiles } from '../layout.js';
import { runAssemble } from './assemble.js';
import { runCasting } from './casting.js';
import { runMetadata } from './metadata.js';
import { STORIES_FILE, buildStories, chaptersForStoryNumbers, narratableChapters, readStories, validateStories, writeStories } from './stories.js';
import { runExtract } from './extract.js';
import { runScript } from './script.js';
import { runSynth } from './synth.js';
import { runVoices } from './voices.js';
import type { VoiceTarget } from '../voices/library.js';
import { withWarningReporter } from '../util/warnings.js';
import { withStageProgress, type ChapterProgress, type ActivityProgress } from '../util/progress.js';
import { TaskCancelledError, throwIfTaskCancelled, withTaskCancellation } from '../util/cancellation.js';
import { collectUsage, saveUsage, usageSummary, type StageUsage } from '../util/usage.js';
import { clearCheckpoints } from './checkpoint.js';
import { sourceIsAvailable, type SourceMetadataOverrides } from '../source/read.js';

export type ChapterStage = 'script' | 'synth';

export interface PipelineEvent {
  type: 'started' | 'completed' | 'skipped' | 'warning' | 'progress' | 'usage';
  stage: Stage;
  message: string;
  /** With type 'usage': what the stage cost, as saved to usage.json. */
  usage?: StageUsage;
  progress?: ChapterProgress | ActivityProgress;
  heartbeat?: boolean;
}

export interface RunStageOptions {
  /** Override the text-processing provider for this one run. */
  llmProvider?: ProviderId;
  /** Override the text-processing model for this one run. */
  llmModel?: string;
  /** Override Script's model and reasoning effort for this one run. */
  scriptModel?: string;
  scriptReasoningEffort?: OpenRouterReasoningEffort;
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
  /** Explicit short story collection choice; detection applies when omitted. */
  collection?: boolean;
  chapterIndexes?: number[];
  /** 1-based story numbers, resolved to their chapters. Excludes chapterIndexes. */
  storyIndexes?: number[];
  /** Execute the stage even when its completion record and output already exist. */
  rerun?: boolean;
  rebuild?: boolean;
  /** Abort an in-progress local UI task. */
  signal?: AbortSignal;
  /** Groups the usage records of the stages run together; generated when omitted. */
  runId?: string;
  onEvent?: (event: PipelineEvent) => void;
}

export interface RunStageResult {
  work: WorkDir;
  stage: Stage;
  skipped: boolean;
  output?: string;
  chapterIndexes?: number[];
  /** Calls, tokens and wall time of this stage; absent when it was skipped. */
  usage?: StageUsage;
}

export interface DiscoveredBook {
  root: string;
  sourcePath: string;
  sourceAvailable: boolean;
  completed: Partial<Record<Stage, string>>;
  /** Made by an earlier pipeline; it must be rebuilt from Extract. */
  outdated: boolean;
}

const CHAPTER_STAGES = new Set<Stage>(['script', 'synth']);

/** Run exactly one stage. The CLI and local UI both use this instead of duplicating orchestration. */
export async function runStage(options: RunStageOptions): Promise<RunStageResult> {
  return withTaskCancellation(options.signal, () => withLlmRunConfig({ provider: options.llmProvider, model: options.llmModel, scriptModel: options.scriptModel, scriptReasoningEffort: options.scriptReasoningEffort }, () => withWarningReporter((message) => {
    if (options.onEvent) options.onEvent({ type: 'warning', stage: options.stage, message });
    else console.warn(`  ${message}`);
  }, () => withStageProgress((progress, message, heartbeat) => {
    if (options.onEvent) options.onEvent({ type: 'progress', stage: options.stage, progress, message, heartbeat });
    else console.log(`[${options.stage}] ${message}`);
  }, () => measureStage(options)))));
}

/**
 * Run the stage and account for it: calls, tokens and wall time are printed
 * when it finishes, sent as a 'usage' event, and appended to usage.json. A
 * failed or cancelled stage is recorded too, because it was paid for; a
 * skipped stage, or one refused before it started, is not.
 */
async function measureStage(options: RunStageOptions): Promise<RunStageResult> {
  const started = Date.now();
  const tracking: StageTracking = {};
  return collectUsage(async (collected) => {
    const record = (outcome: StageUsage['outcome']): StageUsage | undefined => {
      if (!tracking.work) return undefined;
      const usage: StageUsage = {
        runId: options.runId ?? `${options.stage}-${new Date(started).toISOString()}`,
        stage: options.stage,
        startedAt: new Date(started).toISOString(),
        wallMs: Date.now() - started,
        outcome,
        ...(tracking.chapters ? { chapters: tracking.chapters } : {}),
        ...collected(),
      };
      saveUsage(tracking.work.root, usage);
      const message = `${options.stage} usage: ${usageSummary(usage)}`;
      if (options.onEvent) options.onEvent({ type: 'usage', stage: options.stage, message, usage });
      else console.log(`[${options.stage}] ${message}`);
      return usage;
    };
    try {
      const result = await executeStage(options, tracking);
      return result.skipped ? result : { ...result, usage: record('completed') };
    } catch (err) {
      record(err instanceof TaskCancelledError ? 'cancelled' : 'failed');
      throw err;
    }
  });
}

/** Set by executeStage once the stage has actually begun. */
interface StageTracking {
  work?: WorkDir;
  chapters?: number[];
}

async function executeStage(options: RunStageOptions, tracking: StageTracking = {}): Promise<RunStageResult> {
  const { workRoot, outDir, stage, rebuild, rerun, onEvent } = options;
  const sourcePath = options.sourcePath ?? options.epubPath;
  throwIfTaskCancelled();
  if (!STAGES.includes(stage)) throw new Error(`Unknown stage "${stage}".`);
  if (!sourcePath) throw new Error('A source file path is required.');
  if (!sourceIsAvailable(sourcePath)) throw new Error(`Source file not found: ${sourcePath}`);

  const work = await openWorkDir(sourcePath, workRoot, options.metadataOverrides);
  if (work.isOutdated()) {
    // Nothing in an earlier pipeline's folder is read, migrated or removed.
    if (!(stage === 'extract' && rebuild)) throw new Error(OUTDATED_WORK_FOLDER_MESSAGE);
    work.adoptCurrentLayout();
  }
  if (options.metadataOverrides) work.setMetadataOverrides(options.metadataOverrides);
  if (options.collection !== undefined) applyCollectionSetting(work, options.collection);
  const chapterIndexes = normalizeChapterIndexes(selectedChapters(work, options));
  if (rebuild && rerun) throw new Error('Choose either rerun or rebuild, not both.');
  if (rebuild && chapterIndexes) {
    throw new Error('Chapter-specific rebuild is not supported yet. Rebuild the full stage, or run selected chapters to resume them.');
  }
  if (work.sourceChanged() && !(stage === 'extract' && rebuild)) {
    throw new Error('The selected source differs from the one that produced this work folder. Rebuild Extract before running later stages.');
  }
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

  const selected = await validatePrerequisites(work, stage, chapterIndexes);
  if (stage === 'synth' && work.isDone('synth') && work.synthesisInputsChanged()) {
    work.invalidateFrom('synth');
    clearArtifactsFrom(work, 'synth');
  }
  if (!chapterIndexes && work.isDone(stage) && !rebuild && !rerun) {
    onEvent?.({ type: 'skipped', stage, message: `${stage} is already complete.` });
    return { work, stage, skipped: true };
  }

  onEvent?.({ type: 'started', stage, message: `Running ${stage}…` });
  tracking.work = work;
  tracking.chapters = chapterIndexes;
  let output: string | undefined;
  switch (stage) {
    case 'extract':
      await runExtract(sourcePath, work, work.metadataOverrides());
      work.acceptCurrentSource();
      work.markDone(stage);
      break;
    case 'metadata': {
      const previousStories = readFileIfPresent(work.path(STORIES_FILE));
      await runMetadata(work);
      // Regrouped stories change every character scope below this stage.
      if (previousStories !== undefined && previousStories !== readFileIfPresent(work.path(STORIES_FILE))) {
        work.invalidateFrom('script');
        clearArtifactsFrom(work, 'script');
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
}

/** Chapter selection, whether it was requested by chapter or by story. */
function selectedChapters(work: WorkDir, options: RunStageOptions): number[] | undefined {
  if (!options.storyIndexes?.length) return options.chapterIndexes;
  if (options.chapterIndexes?.length) throw new Error('Select either chapters or stories, not both.');
  if (!profiledMetadata(work)) throw new Error('Run metadata before selecting stories.');
  return chaptersForStoryNumbers(readStories(work), options.storyIndexes);
}

function readFileIfPresent(file: string): string | undefined {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
}

/** metadata.json, once the Metadata stage has profiled the book. */
function profiledMetadata(work: WorkDir): BookMetadata | undefined {
  if (!fs.existsSync(work.path(METADATA_FILE))) return undefined;
  const metadata = work.readJson<BookMetadata>(METADATA_FILE);
  return metadata.profile ? metadata : undefined;
}

/**
 * Record an explicit collection choice and regroup the stories. The grouping
 * is derived, so Metadata does not have to run again; the artifacts that depend
 * on character scopes are cleared, keeping paid MP3s.
 */
function applyCollectionSetting(work: WorkDir, collection: boolean): void {
  if (!work.setCollection(collection)) return;
  const metadata = profiledMetadata(work);
  if (!metadata) return;
  saveStoryGrouping(work, buildStories(collection, metadata));
}

/**
 * Save a grouping and the collection choice it implies, then clear what
 * depends on character scopes: the cast, scripts, casting, bindings and
 * encoded chapters. The paid MP3 cache is retained. Returns true when the
 * grouping actually changed.
 */
export function saveStoryGrouping(work: WorkDir, next: Stories): boolean {
  const metadata = profiledMetadata(work);
  if (!metadata) throw new Error('Run metadata before grouping stories.');
  validateStories(next, metadata);
  work.setCollection(next.collection);
  const before = readFileIfPresent(work.path(STORIES_FILE));
  writeStories(work, next);
  if (before === readFileIfPresent(work.path(STORIES_FILE))) return false;
  work.invalidateFrom('script');
  clearArtifactsFrom(work, 'script');
  return true;
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
          version?: number;
          completed?: Partial<Record<Stage, string>>;
        };
        const sourcePath = state.source ?? state.epub;
        if (!sourcePath) return [];
        return [{
          root,
          sourcePath,
          sourceAvailable: sourceIsAvailable(sourcePath),
          completed: state.version === 3 ? state.completed ?? {} : {},
          outdated: state.version !== 3,
        }];
      } catch {
        return [];
      }
    });
}

/** Remove Metadata's part of metadata.json, leaving what Extract wrote. */
function clearProfile(work: WorkDir): void {
  if (!fs.existsSync(work.path(METADATA_FILE))) return;
  const metadata = work.readJson<BookMetadata>(METADATA_FILE);
  if (!metadata.profile) return;
  delete metadata.profile;
  work.writeJson(METADATA_FILE, metadata);
}

/** Remove derived output only for an explicit rebuild; the audio cache is intentionally retained. */
export function clearArtifactsFrom(work: WorkDir, stage: Stage): void {
  const fromScript = [CHARACTERS_FILE, SCRIPTS_DIR, 'casting.json', 'voice-bindings.json', AUDIO_DIR];
  const files: Partial<Record<Stage, string[]>> = {
    extract: [CHAPTERS_DIR, METADATA_FILE, STORIES_FILE, ...fromScript],
    metadata: [STORIES_FILE, ...fromScript],
    script: fromScript,
    casting: ['casting.json', 'voice-bindings.json', AUDIO_DIR],
    voices: ['voice-bindings.json', AUDIO_DIR],
    synth: [AUDIO_DIR],
  };
  if (stage === 'metadata') clearProfile(work);
  for (const rel of files[stage] ?? []) fs.rmSync(work.path(rel), { recursive: true, force: true });
  // Partial chapter progress belongs to the output being rebuilt.
  if (STAGES.indexOf(stage) <= STAGES.indexOf('script')) clearCheckpoints(work, 'script');
}

/** Clear only the output that prevents a requested stage from actually executing. */
function clearStageOutputForRerun(work: WorkDir, stage: Stage, indexes?: number[]): void {
  if (stage === 'script') {
    // An explicit rerun asks for fresh model output, not a resumed attempt.
    clearCheckpoints(work, 'script', indexes);
    if (!indexes) {
      // A whole-stage rerun rediscovers the cast along with the scripts.
      fs.rmSync(work.path(SCRIPTS_DIR), { recursive: true, force: true });
      fs.rmSync(work.path(CHARACTERS_FILE), { force: true });
      return;
    }
    for (const index of indexes) removeChapterFiles(work.root, SCRIPTS_DIR, index, '.json');
    return;
  }
  if (stage === 'synth') {
    for (const { index, file } of listChapterFiles(work.root, AUDIO_DIR, '.m4a')) {
      if (!indexes || indexes.includes(index)) fs.rmSync(work.path(file), { force: true });
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
    case 'metadata': requireDone('extract'); break;
    case 'script': requireDone('metadata'); break;
    case 'casting':
      requireDone('metadata');
      if (!listChapterFiles(work.root, SCRIPTS_DIR, '.json').length) throw new Error('Run script for at least one chapter before casting.');
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
      break;
  }
  if (!CHAPTER_STAGES.has(stage)) return requested;

  const available = narratableChapterIndexes(work);
  const selected = requested ?? available;
  if (selected.some((index) => !available.includes(index))) {
    throw new Error(`One or more selected chapters are not narratable chapters.`);
  }
  if (stage === 'synth' && selected.some((index) => !findChapterFile(work.root, SCRIPTS_DIR, index, '.json'))) {
    throw new Error('Run script for the selected chapter first.');
  }
  return selected;
}

function narratableChapterIndexes(work: WorkDir): number[] {
  return narratableChapters(work.readJson<BookMetadata>(METADATA_FILE));
}

function markChapterStage(work: WorkDir, stage: ChapterStage, indexes?: number[]): void {
  const all = narratableChapterIndexes(work);
  if (all.length === 0) {
    work.markDone(stage);
    return;
  }
  if (stage === 'script') {
    // A run can stop at the first unresolved speaker. When that speaker is
    // resolved, earlier script files remain valid and let the next selected
    // run continue from the failed chapter rather than starting over.
    const complete = all.filter((index) => findChapterFile(work.root, SCRIPTS_DIR, index, '.json'));
    work.markChaptersDone(stage, complete, all);
    return;
  }
  work.markChaptersDone(stage, indexes ?? all, all);
}
