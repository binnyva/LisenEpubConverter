import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STAGES, type Stage } from './config.js';

interface StateFile {
  epub: string;
  epubHash: string;
  completed: Partial<Record<Stage, string>>; // stage -> ISO timestamp
}

/**
 * Work directory layout and stage-completion manifest. Everything the pipeline
 * produces lives under the work dir so runs are resumable and inspectable.
 */
export class WorkDir {
  readonly root: string;
  private state: StateFile;

  constructor(epubPath: string, workRoot: string) {
    const slug = path
      .basename(epubPath)
      .replace(/\.epub$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    this.root = path.resolve(workRoot, slug);
    fs.mkdirSync(this.root, { recursive: true });

    const epubHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(epubPath))
      .digest('hex')
      .slice(0, 16);

    const statePath = this.path('state.json');
    if (fs.existsSync(statePath)) {
      this.state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (this.state.epubHash !== epubHash) {
        console.warn('EPUB file changed since last run — clearing stage state.');
        this.state = { epub: epubPath, epubHash, completed: {} };
        this.save();
      }
    } else {
      this.state = { epub: epubPath, epubHash, completed: {} };
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

  /** Clear completion for `stage` and everything after it. */
  invalidateFrom(stage: Stage): void {
    const start = STAGES.indexOf(stage);
    for (const s of STAGES.slice(start)) delete this.state.completed[s];
    this.save();
  }

  status(): Array<{ stage: Stage; done: boolean; at?: string }> {
    return STAGES.map((stage) => ({
      stage,
      done: this.isDone(stage),
      at: this.state.completed[stage],
    }));
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
}
