import fs from 'node:fs';
import { countWords } from '../util/text.js';
import type { WorkDir } from '../state.js';
import type { BookMetadata, ExtractedChapter } from '../types.js';
import { reportProgress } from '../util/progress.js';
import { readSource, type SourceMetadataOverrides } from '../source/read.js';

/** Stage 1: source document -> one canonical plain-text file per chapter. */
export async function runExtract(sourcePath: string, work: WorkDir, overrides?: SourceMetadataOverrides): Promise<BookMetadata> {
  reportProgress({ activity: 'Opening source document and reading its contents' });
  const source = await readSource(sourcePath, overrides);
  const chaptersDir = work.dir('chapters');
  fs.rmSync(chaptersDir, { recursive: true, force: true });
  work.dir('chapters');

  const chapters: ExtractedChapter[] = [];
  reportProgress({ activity: 'Extracting chapter text', completedUnits: 0, totalUnits: source.chapters.length, unit: 'chapters extracted' });
  source.chapters.forEach((item, index) => {
    const title = item.title || `Section ${index + 1}`;

    const slug =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) || 'section';
    const file = `chapters/${String(index).padStart(4, '0')}-${slug}.txt`;
    fs.writeFileSync(work.path(file), item.text);

    chapters.push({
      index,
      id: item.id,
      title,
      file,
      words: countWords(item.text),
      isNav: item.isNav,
    });
    reportProgress({ activity: `Extracted ${title}`, completedUnits: index + 1, totalUnits: source.chapters.length, unit: 'chapters extracted' });
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
    coverFile,
    chapters,
  };
  work.writeJson('metadata.json', metadata);
  if (source.contentHash) work.recordDownloadedSourceHash(source.contentHash);
  reportProgress({ activity: 'Chapters, metadata and available cover art saved', phase: 'completed', completedUnits: chapters.length, totalUnits: chapters.length, unit: 'chapters extracted' });
  return metadata;
}
