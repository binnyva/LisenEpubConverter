import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkDir } from '../src/state.js';
import type { Stage } from '../src/config.js';
import { buildStories } from '../src/pipeline/stories.js';
import { CHAPTERS_DIR, METADATA_FILE, SCRIPTS_DIR, chapterFileName, findChapterFile } from '../src/layout.js';
import type { PipelineEvent } from '../src/pipeline/runner.js';
import type { BookMetadata, BookProfile, ChapterScript, ExtractedChapter, ScriptSegment } from '../src/types.js';

const roots: string[] = [];

/** Remove every work folder a test made. Call from afterEach. */
export function removeFixtures(): void {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}

export function tempRoot(prefix = 'lisen-test-'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

export interface FixtureChapter {
  title?: string;
  text: string;
  narrate?: boolean;
  part?: ExtractedChapter['part'];
}

export interface FixtureOptions {
  title?: string;
  chapters: Array<string | FixtureChapter>;
  /** Overrides of the default profile: recognised fiction, a novel, quoted dialogue. */
  profile?: Partial<BookProfile>;
  collection?: boolean;
  /** Stages marked complete. Extract and Metadata by default. */
  done?: Stage[];
}

/** A work folder as it stands after Extract and Metadata, built without either. */
export function bookFixture(options: FixtureOptions) {
  const root = tempRoot();
  const epubPath = path.join(root, 'book.epub');
  fs.writeFileSync(epubPath, crypto.randomBytes(32));
  const work = new WorkDir(epubPath, root);
  const entries = options.chapters.map((chapter) => (typeof chapter === 'string' ? { text: chapter } : chapter));
  work.dir(CHAPTERS_DIR);
  const chapters: ExtractedChapter[] = entries.map((entry, index) => {
    const title = entry.title ?? `Chapter ${index + 1}`;
    const file = `${CHAPTERS_DIR}/${chapterFileName(index, title, '.md')}`;
    fs.writeFileSync(work.path(file), entry.text);
    return { index, id: `c${index}`, title, file, words: entry.text.split(/\s+/).filter(Boolean).length, isNav: false, ...(entry.part ? { part: entry.part } : {}) };
  });
  const collection = options.collection ?? false;
  const profile: BookProfile = {
    recognised: false,
    summary: '',
    summarySource: 'none',
    author: { sex: 'unknown', race: 'unknown', age: 'unknown', country: 'unknown' },
    isFiction: true,
    form: collection ? 'short story collection' : 'novel',
    genres: [],
    narrator: { pointOfView: 'third', sex: 'unknown' },
    dialogueStyle: 'quoted',
    chapters: chapters.map((chapter, index) => ({ index, title: chapter.title, narrate: entries[index].narrate ?? true, reason: '' })),
    stories: [],
    ...options.profile,
  };
  const metadata: BookMetadata = {
    title: options.title ?? 'Book', author: 'Author', language: 'en', subjects: [], description: '', chapters, profile,
  };
  work.writeJson(METADATA_FILE, metadata);
  work.writeJson('stories.json', buildStories(collection, metadata));
  if (options.collection !== undefined) work.setCollection(collection);
  for (const stage of options.done ?? ['extract', 'metadata']) work.markDone(stage);
  const events: PipelineEvent[] = [];
  const run = { epubPath, workRoot: root, outDir: path.join(root, 'out'), onEvent: (event: PipelineEvent) => { events.push(event); } };
  return { root, epubPath, work, metadata, profile, events, run };
}

export function writeScript(work: WorkDir, index: number, segments: Array<Partial<ScriptSegment> & { speaker: string; text: string }>, extra: Partial<ChapterScript> = {}): string {
  const file = `${SCRIPTS_DIR}/${chapterFileName(index, `Chapter ${index + 1}`, '.json')}`;
  work.writeJson(file, { index, segments: segments.map((segment) => ({ confidence: 'high', ...segment })), ...extra });
  return file;
}

export function readScript(work: WorkDir, index: number): ChapterScript {
  const file = findChapterFile(work.root, SCRIPTS_DIR, index, '.json');
  if (!file) throw new Error(`No script saved for chapter ${index}.`);
  return work.readJson<ChapterScript>(file);
}

/** A quoted-mode Script reply: labels for quoted spans, and nothing of the book's text. */
export function labelsReply(
  labels: Array<[id: number, speaker: string, confidence?: 'high' | 'low']>,
  extra: { characters?: Array<Record<string, unknown>>; edits?: Array<{ find: string; replace: string }> } = {},
) {
  return {
    labels: labels.map(([id, speaker, confidence = 'high']) => ({ id, speaker, confidence })),
    edits: extra.edits ?? [],
    characters: (extra.characters ?? []).map((character) => ({ aliases: [], sex: 'unknown', age: 'unknown', named: true, evidence: '', ...character })),
  };
}
