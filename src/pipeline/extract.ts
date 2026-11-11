import fs from 'node:fs';
import { countWords } from '../util/text.js';
import type { WorkDir } from '../state.js';
import type { BookMetadata, ExtractedChapter } from '../types.js';
import { reportProgress } from '../util/progress.js';
import { readSource, type SourceMetadataOverrides } from '../source/read.js';
import { splitOversizedChapter } from '../source/split.js';
import { config } from '../config.js';
import { CHAPTERS_DIR, METADATA_FILE, chapterFileName } from '../layout.js';

/** Stage 1: source document -> one markdown file per chapter + metadata.json + cover. */
export async function runExtract(sourcePath: string, work: WorkDir, overrides?: SourceMetadataOverrides): Promise<BookMetadata> {
  reportProgress({ activity: 'Opening source document and reading its contents' });
  const source = await readSource(sourcePath, overrides);
  fs.rmSync(work.path(CHAPTERS_DIR), { recursive: true, force: true });
  work.dir(CHAPTERS_DIR);

  const chapters: ExtractedChapter[] = [];
  // A source can deliver a whole part of a novel, or a whole book, as one
  // document. Split those so later stages work, retry and report in chapters
  // of a manageable size. Navigation documents are never narrated.
  const items = source.chapters.flatMap((item, sourceIndex) => {
    const baseTitle = item.title || `Section ${sourceIndex + 1}`;
    const parts = item.isNav
      ? [item.markdown]
      : splitOversizedChapter(item.markdown, config.maxChapterWords, config.targetChapterWords);
    return parts.map((markdown, position) => ({
      ...item,
      markdown,
      id: position ? `${item.id}#part${position + 1}` : item.id,
      title: position ? `${baseTitle} (part ${position + 1})` : baseTitle,
      part: parts.length > 1 ? { offset: position, number: position + 1, total: parts.length } : undefined,
    }));
  });
  reportProgress({ activity: 'Extracting chapter text', completedUnits: 0, totalUnits: items.length, unit: 'chapters extracted' });
  items.forEach((item, index) => {
    const title = item.title;

    const file = `${CHAPTERS_DIR}/${chapterFileName(index, title, '.md')}`;
    fs.writeFileSync(work.path(file), item.markdown);

    chapters.push({
      index,
      id: item.id,
      title,
      file,
      words: countWords(item.markdown),
      isNav: item.isNav,
      ...(item.part ? { part: { first: index - item.part.offset, number: item.part.number, total: item.part.total } } : {}),
    });
    reportProgress({ activity: `Extracted ${title}`, completedUnits: index + 1, totalUnits: items.length, unit: 'chapters extracted' });
  });

  let coverFile: string | undefined;
  if (source.cover) {
    coverFile = `cover${source.cover.ext}`;
    fs.writeFileSync(work.path(coverFile), source.cover.data);
  }

  const metadata: BookMetadata = {
    title: source.title,
    author: source.author,
    language: source.language,
    subjects: source.subjects,
    description: source.description,
    coverFile,
    chapters,
  };
  work.writeJson(METADATA_FILE, metadata);
  if (source.contentHash) work.recordDownloadedSourceHash(source.contentHash);
  reportProgress({ activity: 'Chapters, metadata and available cover art saved', phase: 'completed', completedUnits: chapters.length, totalUnits: chapters.length, unit: 'chapters extracted' });
  return metadata;
}
