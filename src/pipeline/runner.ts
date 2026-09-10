import fs from 'node:fs';
import path from 'node:path';
import { STAGES, withLlmRunConfig, type ProviderId, type Stage } from '../config.js';
import { WorkDir } from '../state.js';
import type { Analysis, BookMetadata } from '../types.js';
import { runAnalyze } from './analyze.js';
import { runAssemble } from './assemble.js';
import { runCasting } from './casting.js';
import { runChapters } from './chapters.js';
import { CHARACTER_REGISTRY_FILE, characterChapterFile, characterRegistryHash, readCharacterRegistry, runListCharacters } from './list-characters.js';
import { runExtract } from './extract.js';
import { runScript } from './script.js';
import { runSynth } from './synth.js';
import { runVoices } from './voices.js';
import type { VoiceTarget } from '../voices/library.js';
import { withWarningReporter } from '../util/warnings.js';
import { withStageProgress, type ChapterProgress, type ActivityProgress } from '../util/progress.js';
import { throwIfTaskCancelled, withTaskCancellation } from '../util/cancellation.js';

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
  epubPath: string;
  workRoot: string;
  outDir: string;
  stage: Stage;
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
  epubPath: string;
  epubAvailable: boolean;
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
  const { epubPath, workRoot, outDir, stage, rebuild, rerun, onEvent } = options;
  throwIfTaskCancelled();
  if (!STAGES.includes(stage)) throw new Error(`Unknown stage "${stage}".`);
  if (!fs.existsSync(epubPath)) throw new Error(`EPUB file not found: ${epubPath}`);

  const work = new WorkDir(epubPath, workRoot);
  const chapterIndexes = normalizeChapterIndexes(options.chapterIndexes);
  if (chapterIndexes && stage === 'list-characters') {
    throw new Error('List Characters uses all narratable chapters; omit --chapters.');
  }
  if (rebuild && rerun) throw new Error('Choose either rerun or rebuild, not both.');
  if (rebuild && chapterIndexes) {
    throw new Error('Chapter-specific rebuild is not supported yet. Rebuild the full stage, or run selected chapters to resume them.');
  }
  if (work.sourceChanged() && !(stage === 'extract' && rebuild)) {
    throw new Error('The selected EPUB differs from the one that produced this work folder. Rebuild Extract before running later stages.');
  }
  if (rebuild) {
    work.invalidateFrom(stage);
    clearArtifactsFrom(work, stage);
  } else if (rerun) {
    work.invalidateFrom(stage);
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
      runExtract(epubPath, work);
      work.acceptCurrentEpub();
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
          epub?: string;
          completed?: Partial<Record<Stage, string>>;
        };
        if (!state.epub) return [];
        return [{
          root,
          epubPath: state.epub,
          epubAvailable: fs.existsSync(state.epub),
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
 * the current EPUB is known to match; a changed source must be rebuilt instead.
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

  const registryHash = characterRegistryHash(readCharacterRegistry(work));
  const hasScripts = narratable.every((index) => {
    const file = `script/${String(index).padStart(2, '0')}.json`;
    return fs.existsSync(work.path(file)) && work.readJson<{ characterRegistryHash?: string }>(file).characterRegistryHash === registryHash;
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
    extract: ['chapters', 'metadata.json', 'analysis.json', 'chapters-clean', 'chapter-summaries.json', 'chapter-characters', 'characters.json', 'character-candidates', 'script', 'casting.json', 'voice-bindings.json', 'audio'],
    analyze: ['analysis.json', 'chapters-clean', 'chapter-summaries.json', 'chapter-characters', 'characters.json', 'character-candidates', 'script', 'casting.json', 'voice-bindings.json', 'audio'],
    chapters: ['chapters-clean', 'chapter-summaries.json', 'chapter-characters', 'characters.json', 'character-candidates', 'script', 'casting.json', 'voice-bindings.json', 'audio'],
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
  work.markChaptersDone(stage, indexes ?? all, all);
}
