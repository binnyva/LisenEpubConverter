import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from '../config.js';
import type { WorkDir } from '../state.js';
import type { BookMetadata, ChapterAudioManifest } from '../types.js';

function ffmpeg(args: string[]): void {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

function durationOf(file: string): number {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8' }
  );
  return parseFloat(out.trim());
}

function escapeMeta(s: string): string {
  return s.replace(/([=;#\\\n])/g, '\\$1');
}

/**
 * Stage 7: concatenate cached segments into per-chapter M4A files, then all
 * chapters into a single M4B with chapter markers, tags and cover art.
 */
export function runAssemble(work: WorkDir, outDir: string, chapterIndexes?: number[]): string {
  const meta = work.readJson<BookMetadata>('metadata.json');
  work.dir('audio');

  const manifests = fs
    .readdirSync(work.path('audio'))
    .filter((f) => f.endsWith('-segments.json'))
    .filter((f) => !chapterIndexes || chapterIndexes.includes(Number.parseInt(f, 10)))
    .sort()
    .map((f) => work.readJson<ChapterAudioManifest>(`audio/${f}`));
  if (manifests.length === 0) throw new Error('No synthesized chapters found — run synth first.');

  // 1. Per-chapter concat + AAC encode (skipped when the chapter m4a exists).
  for (const manifest of manifests) {
    const chapterFile = work.path('audio', `${String(manifest.index).padStart(2, '0')}.m4a`);
    if (fs.existsSync(chapterFile)) continue;
    console.log(`  Encoding chapter ${manifest.index} (${manifest.segments.length} segments)`);

    const listFile = work.path('audio', `concat-${manifest.index}.txt`);
    fs.writeFileSync(
      listFile,
      manifest.segments
        .map((h) => `file '${work.path('audio-cache', `${h}.mp3`).replace(/'/g, "'\\''")}'`)
        .join('\n')
    );
    ffmpeg([
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c:a', 'aac', '-b:a', config.audioBitrate, '-ar', '44100', '-ac', '1',
      chapterFile,
    ]);
    fs.rmSync(listFile);
  }

  // 2. Chapter markers from encoded durations.
  const chapterTitle = (index: number): string =>
    meta.chapters.find((c) => c.index === index)?.title ?? `Chapter ${index}`;

  let ffmeta = `;FFMETADATA1\ntitle=${escapeMeta(meta.title)}\nartist=${escapeMeta(meta.author)}\nalbum=${escapeMeta(meta.title)}\ngenre=Audiobook\n`;
  let cursorMs = 0;
  const chapterFiles: string[] = [];
  for (const manifest of manifests) {
    const file = work.path('audio', `${String(manifest.index).padStart(2, '0')}.m4a`);
    chapterFiles.push(file);
    const durMs = Math.round(durationOf(file) * 1000);
    ffmeta += `\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=${cursorMs}\nEND=${cursorMs + durMs}\ntitle=${escapeMeta(chapterTitle(manifest.index))}\n`;
    cursorMs += durMs;
  }
  const ffmetaFile = work.path('audio', 'ffmetadata.txt');
  fs.writeFileSync(ffmetaFile, ffmeta);

  // 3. Concat chapters (stream copy — identical encoding) into one m4a.
  const concatList = work.path('audio', 'concat-book.txt');
  fs.writeFileSync(
    concatList,
    chapterFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n')
  );
  const bookM4a = work.path('audio', 'book.m4a');
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', concatList, '-c', 'copy', bookM4a]);
  fs.rmSync(concatList);

  // 4. Mux metadata + cover into the final .m4b.
  fs.mkdirSync(outDir, { recursive: true });
  const safeTitle = meta.title.replace(/[\\/:*?"<>|]/g, '-').trim() || 'book';
  const selectionLabel = chapterIndexes?.length
    ? ` - chapters ${[...chapterIndexes].sort((a, b) => a - b).join('-')}`
    : '';
  const outFile = path.resolve(outDir, `${safeTitle}${selectionLabel}.m4b`);

  const args = ['-i', bookM4a, '-i', ffmetaFile];
  if (meta.coverFile && fs.existsSync(work.path(meta.coverFile))) {
    args.push('-i', work.path(meta.coverFile));
    args.push('-map', '0:a', '-map', '2:v', '-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic');
  } else {
    args.push('-map', '0:a');
  }
  args.push('-map_metadata', '1', '-c:a', 'copy', '-f', 'mp4', outFile);
  ffmpeg(args);

  fs.rmSync(bookM4a);
  return outFile;
}
