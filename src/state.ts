import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STAGES, type Stage } from './config.js';
import { isRemoteSource, readSource, sourceFormatForPath, type SourceFormat, type SourceMetadataOverrides } from './source/read.js';

export interface WorkState {
  version: 2;
  source: string;
  sourceHash: string;
  sourceFormat: SourceFormat;
  metadataOverrides?: SourceMetadataOverrides;
  completed: Partial<Record<Stage, string>>; // stage -> ISO timestamp
  /** The currently selected file differs from the source that produced the completed stages. */
  sourceChanged?: boolean;
  /** Completion timestamps for stages that can be run a chapter at a time. */
  chapterCompleted?: Partial<Record<'chapters' | 'script' | 'synth', Record<string, string>>>;
  /** Hash of the cast and concrete bindings used by the last completed synthesis. */
  synthesisInputHash?: string;
}

interface LegacyWorkState extends Omit<WorkState, 'version' | 'source' | 'sourceHash' | 'sourceFormat'> {
  epub?: string;
  epubHash?: string;
}

/**
 * Work directory layout and stage-completion manifest. Everything the pipeline
 * produces lives under the work dir so runs are resumable and inspectable.
 */
export class WorkDir {
  readonly root: string;
  private state: WorkState;
  private readonly currentSourceHash: string;

  constructor(sourcePath: string, workRoot: string, title?: string, existingRoot?: string) {
    const sourceFormat = sourceFormatForPath(sourcePath);
    if (!sourceFormat) throw new Error('Unsupported source format.');
    const remote = isRemoteSource(sourcePath);
    const sourceName = remote ? urlSlug(sourcePath) : path.basename(sourcePath, path.extname(sourcePath));
    const slug = slugify(title ?? sourceName);
    // A direct WorkDir construction retains the legacy filename fallback for
    // programmatic callers. New user-facing workspaces use openWorkDir(),
    // which supplies the source title.
    this.root = existingRoot ?? path.resolve(workRoot, sourceFormat === 'epub' ? slug : `${slug}-${sourceFormat}`);
    fs.mkdirSync(this.root, { recursive: true });

    this.currentSourceHash = crypto
      .createHash('sha256')
      .update(remote ? sourcePath : fs.readFileSync(sourcePath))
      .digest('hex')
      .slice(0, 16);

    const statePath = this.path('state.json');
    if (fs.existsSync(statePath)) {
      this.state = migrateState(JSON.parse(fs.readFileSync(statePath, 'utf8')) as WorkState | LegacyWorkState, sourcePath, sourceFormat, this.currentSourceHash);
      // URLs are refreshed only by Extract. Avoid a network request whenever a
      // work folder is inspected or a later stage resumes.
      const currentHash = remote && this.state.source === sourcePath ? this.state.sourceHash : this.currentSourceHash;
      if (this.state.sourceHash !== currentHash) {
        console.warn('Source file changed since last run — rebuild Extract before using the existing pipeline output.');
        this.state.source = sourcePath;
        this.state.sourceFormat = sourceFormat;
        this.state.sourceChanged = true;
        this.save();
      } else if (this.state.source !== sourcePath || this.state.sourceChanged) {
        this.state.source = sourcePath;
        this.state.sourceFormat = sourceFormat;
        delete this.state.sourceChanged;
        this.save();
      }
    } else {
      this.state = { version: 2, source: sourcePath, sourceHash: this.currentSourceHash, sourceFormat, completed: {}, chapterCompleted: {} };
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

  /** Accept the currently selected source after an explicit Extract rebuild. */
  acceptCurrentSource(): void {
    if (!isRemoteSource(this.state.source)) this.state.sourceHash = this.currentSourceHash;
    delete this.state.sourceChanged;
    this.save();
  }

  /** Record the exact HTML downloaded during Extract for a URL source. */
  recordDownloadedSourceHash(contentHash: string): void {
    if (!isRemoteSource(this.state.source)) return;
    this.state.sourceHash = contentHash;
    delete this.state.sourceChanged;
    this.save();
  }

  /** @deprecated Use acceptCurrentSource. */
  acceptCurrentEpub(): void {
    this.acceptCurrentSource();
  }

  metadataOverrides(): SourceMetadataOverrides | undefined {
    return this.state.metadataOverrides ? structuredClone(this.state.metadataOverrides) : undefined;
  }

  /** Changing displayed metadata makes every later artifact stale. */
  setMetadataOverrides(overrides: SourceMetadataOverrides): boolean {
    const next = compactOverrides(overrides);
    if (JSON.stringify(next) === JSON.stringify(this.state.metadataOverrides ?? {})) return false;
    if (Object.keys(next).length) this.state.metadataOverrides = next;
    else delete this.state.metadataOverrides;
    this.invalidateFrom('extract');
    return true;
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

/**
 * Open a workspace for a source. Existing folders are found by their saved
 * source path; a new folder is named from the document title, never its path
 * or URL. Reading title metadata for a URL may download the document once.
 */
export async function openWorkDir(
  sourcePath: string,
  workRoot: string,
  metadataOverrides?: SourceMetadataOverrides
): Promise<WorkDir> {
  const existingRoot = findWorkRoot(sourcePath, workRoot);
  if (existingRoot) return new WorkDir(sourcePath, workRoot, undefined, existingRoot);

  const source = await readSource(sourcePath, metadataOverrides);
  return new WorkDir(sourcePath, workRoot, undefined, unusedWorkRoot(workRoot, source.title));
}

function findWorkRoot(sourcePath: string, workRoot: string): string | undefined {
  if (!fs.existsSync(workRoot)) return undefined;
  const currentHash = !isRemoteSource(sourcePath) && fs.existsSync(sourcePath)
    ? sourceHash(sourcePath)
    : undefined;
  for (const entry of fs.readdirSync(workRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = path.resolve(workRoot, entry.name);
    const statePath = path.join(root, 'state.json');
    if (!fs.existsSync(statePath)) continue;
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { source?: unknown; epub?: unknown; sourceHash?: unknown; epubHash?: unknown };
      if (state.source === sourcePath || state.epub === sourcePath ||
        (currentHash !== undefined && (state.sourceHash === currentHash || state.epubHash === currentHash))) return root;
    } catch {
      // Ignore malformed folders; they are not a workspace for this source.
    }
  }
  return undefined;
}

function sourceHash(sourcePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex').slice(0, 16);
}

function unusedWorkRoot(workRoot: string, title: string): string {
  const base = slugify(title);
  let candidate = path.resolve(workRoot, base);
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.resolve(workRoot, `${base}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

function migrateState(
  raw: WorkState | LegacyWorkState,
  sourcePath: string,
  sourceFormat: SourceFormat,
  sourceHash: string
): WorkState {
  if ('source' in raw && typeof raw.source === 'string') {
    return { ...raw, version: 2, sourceFormat: raw.sourceFormat ?? sourceFormat, chapterCompleted: raw.chapterCompleted ?? {} } as WorkState;
  }
  const legacy = raw as LegacyWorkState;
  return {
    version: 2,
    source: legacy.epub ?? sourcePath,
    sourceHash: legacy.epubHash ?? sourceHash,
    sourceFormat: sourceFormatForPath(legacy.epub ?? '') ?? sourceFormat,
    completed: legacy.completed ?? {},
    chapterCompleted: legacy.chapterCompleted ?? {},
    sourceChanged: legacy.sourceChanged,
    synthesisInputHash: legacy.synthesisInputHash,
  };
}

function compactOverrides(overrides: SourceMetadataOverrides): SourceMetadataOverrides {
  return Object.fromEntries(Object.entries(overrides)
    .map(([key, value]) => [key, value?.trim()])
    .filter(([, value]) => Boolean(value))) as SourceMetadataOverrides;
}

function urlSlug(sourceUrl: string): string {
  const url = new URL(sourceUrl);
  const pathPart = url.pathname.replace(/\/$/, '') || 'page';
  const identity = crypto.createHash('sha256').update(sourceUrl).digest('hex').slice(0, 8);
  return `${url.hostname}-${pathPart}-${identity}`;
}

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'untitled';
}
