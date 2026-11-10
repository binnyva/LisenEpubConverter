import fs from 'node:fs';
import path from 'node:path';
import { STAGES, withLlmRunConfig, type OpenRouterReasoningEffort, type ProviderId, type Stage } from '../config.js';
import { WorkDir, openWorkDir } from '../state.js';
import type { Analysis, BookMetadata, ChapterScript, Stories } from '../types.js';
import { runAnalyze } from './analyze.js';
import { runAssemble } from './assemble.js';
import { runCasting } from './casting.js';
import { runChapters } from './chapters.js';
import { CHARACTER_REGISTRY_FILE, characterChapterFile, characterScopeHash, characterScopeHashes, legacyCharacterRegistryHash, readCharacterRegistry, runListCharacters } from './list-characters.js';
import { STORIES_FILE, buildStories, chaptersForStoryNumbers, readStories, storyIdFor, validateStories, writeStories } from './stories.js';
import { runExtract } from './extract.js';
import { runScript } from './script.js';
import { runSynth } from './synth.js';
import { runVoices } from './voices.js';
import type { VoiceTarget } from '../voices/library.js';
import { withWarningReporter } from '../util/warnings.js';
import { withStageProgress, type ChapterProgress, type ActivityProgress } from '../util/progress.js';
import { throwIfTaskCancelled, withTaskCancellation } from '../util/cancellation.js';
import { clearCheckpoints } from './checkpoint.js';
import { sourceIsAvailable, type SourceMetadataOverrides } from '../source/read.js';

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
  return withTaskCancellation(options.signal, () => withLlmRunConfig({ provider: options.llmProvider, model: options.llmModel, scriptModel: options.scriptModel, scriptReasoningEffort: options.scriptReasoningEffort }, () => withWarningReporter((message) => {
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
  if (options.metadataOverrides) work.setMetadataOverrides(options.metadataOverrides);
  if (options.collection !== undefined) applyCollectionSetting(work, options.collection);
  const chapterIndexes = normalizeChapterIndexes(selectedChapters(work, options));
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
  if (stage === 'chapters' && selected?.some((index) => !fs.existsSync(work.path(characterChapterFile(index))))) {
    // Legacy chapter output needs discovery only; keep existing cleaned text and audio cache.
    work.invalidateFrom(work.isDone('chapters') ? 'chapters' : 'list-characters');
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
    case 'analyze': {
      const previousStories = readFileIfPresent(work.path(STORIES_FILE));
      await runAnalyze(work);
      // Regrouped stories change every character scope below this stage.
      if (previousStories !== undefined && previousStories !== readFileIfPresent(work.path(STORIES_FILE))) {
        work.invalidateFrom('list-characters');
        clearArtifactsFrom(work, 'list-characters');
      }
      work.markDone(stage);
      break;
    }
    case 'chapters':
      await runChapters(work, selected);
      markChapterStage(work, stage, selected);
      break;
    case 'list-characters': {
      const stories = readStories(work);
      let before: Map<string, string> | undefined;
      if (fs.existsSync(work.path(CHARACTER_REGISTRY_FILE))) {
        try {
          before = characterScopeHashes(readCharacterRegistry(work), stories);
        } catch {
          // An unreadable registry cannot be compared, and this stage is the
          // one that rebuilds it. Treat every story as changed instead of
          // refusing to run.
          before = new Map();
        }
      }
      const registry = runListCharacters(work);
      invalidateChangedStories(work, before, characterScopeHashes(registry, stories), stories);
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
  if (!fs.existsSync(work.path('metadata.json')) || !fs.existsSync(work.path('analysis.json'))) {
    throw new Error('Run analyze before selecting stories.');
  }
  return chaptersForStoryNumbers(readStories(work), options.storyIndexes);
}

function readFileIfPresent(file: string): string | undefined {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
}

/**
 * Record an explicit collection choice and regroup the stories. The grouping
 * is derived, so Analyze does not have to run again; the artifacts that depend
 * on character scopes are cleared, keeping cleaned text and paid MP3s.
 */
function applyCollectionSetting(work: WorkDir, collection: boolean): void {
  if (!work.setCollection(collection)) return;
  if (!fs.existsSync(work.path('metadata.json')) || !fs.existsSync(work.path('analysis.json'))) return;
  saveStoryGrouping(work, buildStories(collection, work.readJson<BookMetadata>('metadata.json'), work.readJson<Analysis>('analysis.json')));
}

/**
 * Save a grouping and the collection choice it implies, then clear what
 * depends on character scopes. Cleaned text, chapter observations and the paid
 * MP3 cache are retained. Returns true when the grouping actually changed.
 */
export function saveStoryGrouping(work: WorkDir, next: Stories): boolean {
  validateStories(next, work.readJson<BookMetadata>('metadata.json'), work.readJson<Analysis>('analysis.json'));
  work.setCollection(next.collection);
  const before = readFileIfPresent(work.path(STORIES_FILE));
  writeStories(work, next);
  if (before === readFileIfPresent(work.path(STORIES_FILE))) return false;
  work.invalidateFrom('list-characters');
  clearArtifactsFrom(work, 'list-characters');
  return true;
}

/**
 * Invalidate only the stories whose cast actually changed. One corrected
 * character in a 25-story collection must not re-attribute, and then
 * re-synthesize, every other story.
 */
function invalidateChangedStories(
  work: WorkDir,
  before: Map<string, string> | undefined,
  after: Map<string, string>,
  stories: Stories
): void {
  if (!before) return;
  const sameScopes = before.size === after.size && [...after.keys()].every((id) => before.has(id));
  const changed = [...after].filter(([id, hash]) => before.get(id) !== hash).map(([id]) => id);
  if (sameScopes && !changed.length) return;
  if (!sameScopes) {
    // The grouping moved, so no script can be trusted to use the right scope.
    work.invalidateFrom('script');
    clearArtifactsFrom(work, 'synth');
    return;
  }
  const affected = new Set(stories.stories.filter((story) => changed.includes(story.id)).flatMap((story) => story.chapters));
  const all = narratableChapterIndexes(work);
  for (const index of affected) {
    const name = String(index).padStart(2, '0');
    // Old encoded chapters must not survive a change of speaker attribution.
    // Scripts are left in place; their scope hash no longer matches, so Script
    // rewrites them, and the paid MP3 cache is untouched either way.
    fs.rmSync(work.path(`audio/${name}.m4a`), { force: true });
    fs.rmSync(work.path(`audio/${name}-segments.json`), { force: true });
  }
  const unaffected = all.filter((index) => !affected.has(index));
  work.retainChaptersDone('script', unaffected, all);
  work.retainChaptersDone('synth', unaffected, all);
  for (const stage of ['casting', 'voices', 'assemble'] as const) work.invalidateStage(stage);
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
    fs.existsSync(work.path(`chapters-clean/${String(index).padStart(2, '0')}.md`)) && summaries[String(index)] !== undefined &&
    fs.existsSync(work.path(characterChapterFile(index)))
  );
  if (!hasCleanOutput) return changed;
  work.markChaptersDone('chapters', narratable, narratable);

  if (!fs.existsSync(work.path(CHARACTER_REGISTRY_FILE))) return changed;
  work.markDone('list-characters');

  const registry = readCharacterRegistry(work);
  const stories = readStories(work);
  const legacyHash = legacyCharacterRegistryHash(registry);
  const hasScripts = narratable.every((index) => {
    const file = `script/${String(index).padStart(2, '0')}.json`;
    if (!fs.existsSync(work.path(file))) return false;
    const script = work.readJson<ChapterScript>(file);
    return script.characterScopeHash !== undefined
      ? script.characterScopeHash === characterScopeHash(registry, storyIdFor(stories, index))
      : script.characterRegistryHash === legacyHash;
  });
  if (!hasScripts) return changed;
  work.markChaptersDone('script', narratable, narratable);

  if (!fs.existsSync(work.path('casting.json'))) return changed;
  work.markDone('casting');

  if (!fs.existsSync(work.path('voice-bindings.json'))) return changed;
  work.markDone('voices');

  const hasAudio = narratable.every((index) => fs.existsSync(work.path(`audio/${String(index).padStart(2, '0')}-segments.json`)));
  if (hasAudio) work.markChaptersDone('synth', narratable, narratable);
  return changed;
}

/** Remove derived output only for an explicit rebuild; audio cache is intentionally retained. */
export function clearArtifactsFrom(work: WorkDir, stage: Stage): void {
  const files: Partial<Record<Stage, string[]>> = {
    extract: ['chapters', 'metadata.json', 'analysis.json', 'stories.json', 'chapters-clean', 'chapter-summaries.json', 'chapter-characters', 'characters.json', 'character-candidates', 'script', 'casting.json', 'voice-bindings.json', 'audio'],
    analyze: ['analysis.json', 'stories.json', 'chapters-clean', 'chapter-summaries.json', 'chapter-characters', 'characters.json', 'character-candidates', 'script', 'casting.json', 'voice-bindings.json', 'audio'],
    chapters: ['chapters-clean', 'chapter-summaries.json', 'chapter-characters', 'characters.json', 'character-candidates', 'script', 'casting.json', 'voice-bindings.json', 'audio'],
    'list-characters': ['characters.json', 'character-candidates', 'script', 'casting.json', 'voice-bindings.json', 'audio'],
    script: ['character-candidates', 'script', 'casting.json', 'voice-bindings.json', 'audio'],
    casting: ['casting.json', 'voice-bindings.json', 'audio'],
    voices: ['voice-bindings.json', 'audio'],
    synth: ['audio'],
  };
  for (const rel of files[stage] ?? []) fs.rmSync(work.path(rel), { recursive: true, force: true });
  // Partial chapter progress belongs to the output being rebuilt.
  const order = STAGES.indexOf(stage);
  if (order <= STAGES.indexOf('chapters')) clearCheckpoints(work, 'chapters');
  if (order <= STAGES.indexOf('script')) clearCheckpoints(work, 'script');
}

/** Clear only the output that prevents a requested stage from actually executing. */
function clearStageOutputForRerun(work: WorkDir, stage: Stage, indexes?: number[]): void {
  // An explicit rerun asks for fresh model output, not a resumed attempt.
  if (stage === 'chapters' || stage === 'script') clearCheckpoints(work, stage, indexes);
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
      fs.rmSync(work.path(`chapters-clean/${String(index).padStart(2, '0')}.md`), { force: true });
      fs.rmSync(work.path(characterChapterFile(index)), { force: true });
      delete summaries[String(index)];
    }
    work.writeJson('chapter-summaries.json', summaries);
    return;
  }
  if (stage === 'script') {
    if (!indexes) {
      fs.rmSync(work.path('script'), { recursive: true, force: true });
      return;
    }
    for (const index of indexes) fs.rmSync(work.path(`script/${String(index).padStart(2, '0')}.json`), { force: true });
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
    case 'list-characters': requireDone('chapters'); break;
    case 'script':
      requireDone('analyze');
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
      break;
  }
  if (!CHAPTER_STAGES.has(stage)) return requested;

  const available = narratableChapterIndexes(work);
  const selected = requested ?? available;
  if (selected.some((index) => !available.includes(index))) {
    throw new Error(`One or more selected chapters are not narratable chapters.`);
  }
  if (stage === 'script') requireFiles(work, selected, 'chapters-clean', '.md', 'Run chapters for the selected chapter first.');
  if (stage === 'synth') requireFiles(work, selected, 'script', '.json', 'Run script for the selected chapter first.');
  return selected;
}

function requireFiles(work: WorkDir, indexes: number[], dir: string, extension: string, message: string): void {
  for (const index of indexes) {
    const file = `${dir}/${String(index).padStart(2, '0')}${extension}`;
    if (!fs.existsSync(work.path(file))) throw new Error(message);
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
      fs.existsSync(work.path(`chapters-clean/${String(index).padStart(2, '0')}.md`)) &&
      fs.existsSync(work.path(characterChapterFile(index))));
    work.markChaptersDone(stage, complete, all);
    return;
  }
  if (stage === 'script') {
    // A run can stop at the first unresolved speaker. When that speaker is
    // resolved, earlier script files remain valid and let the next selected
    // run continue from the failed chapter rather than starting over.
    const complete = all.filter((index) => fs.existsSync(work.path(`script/${String(index).padStart(2, '0')}.json`)));
    work.markChaptersDone(stage, complete, all);
    return;
  }
  work.markChaptersDone(stage, indexes ?? all, all);
}
