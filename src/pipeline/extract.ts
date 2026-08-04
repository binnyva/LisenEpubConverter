import fs from 'node:fs';
import * as cheerio from 'cheerio';
import { parseEpub } from '../epub/epub.js';
import { htmlToMarkdown } from '../epub/markdown.js';
import { countWords } from '../util/text.js';
import type { WorkDir } from '../state.js';
import type { BookMetadata, ExtractedChapter } from '../types.js';

/** Stage 1: EPUB -> one markdown file per spine chapter + metadata.json + cover. */
export function runExtract(epubPath: string, work: WorkDir): BookMetadata {
  const epub = parseEpub(epubPath);
  const chaptersDir = work.dir('chapters');
  fs.rmSync(chaptersDir, { recursive: true, force: true });
  work.dir('chapters');

  const chapters: ExtractedChapter[] = [];
  epub.spine.forEach((item, index) => {
    const markdown = htmlToMarkdown(item.html);

    let title = epub.tocTitles.get(item.href) ?? '';
    if (!title) {
      const $ = cheerio.load(item.html);
      title = $('h1, h2, h3').first().text().trim();
    }
    if (!title) title = `Section ${index + 1}`;

    const slug =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) || 'section';
    const file = `chapters/${String(index).padStart(2, '0')}-${slug}.md`;
    fs.writeFileSync(work.path(file), markdown);

    chapters.push({
      index,
      id: item.id,
      title,
      file,
      words: countWords(markdown),
      isNav: item.isNav,
    });
  });

  let coverFile: string | undefined;
  if (epub.cover) {
    coverFile = `cover${epub.cover.ext}`;
    fs.writeFileSync(work.path(coverFile), epub.cover.data);
  }

  const metadata: BookMetadata = {
    title: epub.title,
    author: epub.author,
    language: epub.language,
    coverFile,
    chapters,
  };
  work.writeJson('metadata.json', metadata);
  return metadata;
}
