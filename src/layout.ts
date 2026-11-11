import fs from 'node:fs';
import path from 'node:path';

/**
 * Work folder layout. Numbered folders sort in pipeline order, and every
 * per-chapter file is named `<NN>-<slug>` so a folder reads as a table of
 * contents.
 */
export const CHAPTERS_DIR = '0-chapters';
export const SCRIPTS_DIR = '1-scripts';
export const AUDIO_CACHE_DIR = '2-audio-cache';
export const AUDIO_DIR = '3-audio';
export const METADATA_FILE = 'metadata.json';
export const CHARACTERS_FILE = 'characters.json';
export const USAGE_FILE = 'usage.json';

/** Extension of a chapter's synthesis manifest, beside its encoded `.m4a`. */
export const MANIFEST_EXT = '.json';

const SLUG_CHARS = 60;

const pad = (index: number): string => String(index).padStart(2, '0');

/** A chapter title as a file name part, capped so paths stay readable. */
export function chapterSlug(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, SLUG_CHARS)
    .replace(/-$/, '') || 'chapter';
}

export function chapterFileName(index: number, title: string, extension: string): string {
  return `${pad(index)}-${chapterSlug(title)}${extension}`;
}

/** The chapter index a file name starts with, if it is a chapter file. */
export function chapterIndexOf(fileName: string): number | undefined {
  const match = /^(\d+)-/.exec(fileName);
  return match ? Number(match[1]) : undefined;
}

/** Every chapter file of one kind in a folder, in chapter order, relative to the work root. */
export function listChapterFiles(root: string, dir: string, extension: string): Array<{ index: number; file: string }> {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full)
    .filter((name) => name.endsWith(extension))
    .flatMap((name) => {
      const index = chapterIndexOf(name);
      return index === undefined ? [] : [{ index, file: `${dir}/${name}` }];
    })
    .sort((left, right) => left.index - right.index || left.file.localeCompare(right.file));
}

/**
 * A chapter's file, found by its index prefix and never by its title: a
 * retitled chapter keeps the script and audio already made for it.
 */
export function findChapterFile(root: string, dir: string, index: number, extension: string): string | undefined {
  return listChapterFiles(root, dir, extension).find((entry) => entry.index === index)?.file;
}

/** The existing file for a chapter, or the name a new one is given. */
export function chapterFile(root: string, dir: string, index: number, title: string, extension: string): string {
  return findChapterFile(root, dir, index, extension) ?? `${dir}/${chapterFileName(index, title, extension)}`;
}

/** Remove one chapter's files of a kind, whatever titles they were saved under. */
export function removeChapterFiles(root: string, dir: string, index: number, extension: string): void {
  for (const entry of listChapterFiles(root, dir, extension)) {
    if (entry.index === index) fs.rmSync(path.join(root, entry.file), { force: true });
  }
}
