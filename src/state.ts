import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STAGES, type Stage } from './config.js';

export interface WorkState {
  epub: string;
  epubHash: string;
  completed: Partial<Record<Stage, string>>; // stage -> ISO timestamp
  /** The EPUB currently selected differs from the source that produced the completed stages. */
  sourceChanged?: boolean;
  /** Completion timestamps for stages that can be run a chapter at a time. */
  chapterCompleted?: Partial<Record<'chapters' | 'script' | 'synth', Record<string, string>>>;
  /** Hash of the cast and concrete bindings used by the last completed synthesis. */
  synthesisInputHash?: string;
}

/**
 * Work directory layout and stage-completion manifest. Everything the pipeline
 * produces lives under the work dir so runs are resumable and inspectable.
 */
export class WorkDir {
  readonly root: string;
  private state: WorkState;
  private readonly currentEpubHash: string;

  constructor(epubPath: string, workRoot: string) {
    const slug = path
      .basename(epubPath)
      .replace(/\.epub$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    this.root = path.resolve(workRoot, slug);
    fs.mkdirSync(this.root, { recursive: true });

    this.currentEpubHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(epubPath))
      .digest('hex')
      .slice(0, 16);

    const statePath = this.path('state.json');
    if (fs.existsSync(statePath)) {
      this.state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (this.state.epubHash !== this.currentEpubHash) {
        console.warn('EPUB file changed since last run — rebuild Extract before using the existing pipeline output.');
        this.state.epub = epubPath;
        this.state.sourceChanged = true;
        this.save();
      } else if (this.state.epub !== epubPath || this.state.sourceChanged) {
        this.state.epub = epubPath;
        delete this.state.sourceChanged;
        this.save();
      }
    } else {
      this.state = { epub: epubPath, epubHash: this.currentEpubHash, completed: {}, chapterCompleted: {} };
      this.save();
    }
  }

  path(...parts: string[]): string {
    return path.join(this.root, ...parts);
  }

  dir(...parts: string[]): string {
    const p = this.path(...parts);
    fs.mkdirSync(p, { recursive: true });
    return p;
  }

  isDone(stage: Stage): boolean {
    return Boolean(this.state.completed[stage]);
  }

  markDone(stage: Stage): void {
    this.state.completed[stage] = new Date().toISOString();
    this.save();
  }

  sourceChanged(): boolean {
    return this.state.sourceChanged === true;
  }

  /** Accept the currently selected EPUB after an explicit Extract rebuild. */
  acceptCurrentEpub(): void {
    this.state.epubHash = this.currentEpubHash;
    delete this.state.sourceChanged;
    this.save();
  }

  completedChapters(stage: 'chapters' | 'script' | 'synth'): number[] {
    return Object.keys(this.state.chapterCompleted?.[stage] ?? {})
      .map(Number)
      .filter(Number.isInteger)
      .sort((a, b) => a - b);
  }

  markChaptersDone(
    stage: 'chapters' | 'script' | 'synth',
    indexes: number[],
    allIndexes: number[]
  ): void {
    const timestamp = new Date().toISOString();
    const completed = (this.state.chapterCompleted ??= {});
    const byChapter = (completed[stage] ??= {});
    for (const index of indexes) byChapter[String(index)] = timestamp;

    if (allIndexes.length > 0 && allIndexes.every((index) => byChapter[String(index)])) {
      this.state.completed[stage] = timestamp;
    } else {
      delete this.state.completed[stage];
    }
    this.save();
  }

  /** Clear completion for `stage` and everything after it. */
  invalidateFrom(stage: Stage): void {
    const start = STAGES.indexOf(stage);
    for (const s of STAGES.slice(start)) {
      delete this.state.completed[s];
      if (s === 'chapters' || s === 'script' || s === 'synth') {
        delete this.state.chapterCompleted?.[s];
      }
    }
    if (start <= STAGES.indexOf('synth')) delete this.state.synthesisInputHash;
    this.save();
  }

  /**
   * Clear only stages that depend on `stage`, retaining the stage's own
   * per-chapter completion record. This lets selected chapter reruns build up
   * toward a completed whole-book stage.
   */
  invalidateAfter(stage: Stage): void {
    const next = STAGES[STAGES.indexOf(stage) + 1];
    if (next) this.invalidateFrom(next);
  }

  recordSynthesisInputs(): void {
    this.state.synthesisInputHash = this.synthesisInputsHash();
    this.save();
  }

  synthesisInputsChanged(): boolean {
    return Boolean(this.state.synthesisInputHash && this.state.synthesisInputHash !== this.synthesisInputsHash());
  }

  status(): Array<{ stage: Stage; done: boolean; at?: string }> {
    return STAGES.map((stage) => ({
      stage,
      done: this.isDone(stage),
      at: this.state.completed[stage],
    }));
  }

  snapshot(): WorkState {
    return structuredClone(this.state);
  }

  readJson<T>(rel: string): T {
    return JSON.parse(fs.readFileSync(this.path(rel), 'utf8')) as T;
  }

  writeJson(rel: string, data: unknown): void {
    fs.mkdirSync(path.dirname(this.path(rel)), { recursive: true });
    fs.writeFileSync(this.path(rel), JSON.stringify(data, null, 2));
  }

  private save(): void {
    fs.writeFileSync(this.path('state.json'), JSON.stringify(this.state, null, 2));
  }

  private synthesisInputsHash(): string {
    const inputs = ['casting.json', 'voice-bindings.json'].map((file) => {
      const full = this.path(file);
      return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
    });
    return crypto.createHash('sha256').update(inputs.join('\x1f')).digest('hex');
  }
}
