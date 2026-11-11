import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { reportProgress } from '../util/progress.js';
import { taskCancellationSignal, throwIfTaskCancelled } from '../util/cancellation.js';
import type { WorkDir } from '../state.js';
import type { BookMetadata, ChapterAudioEntry, ChapterAudioManifest } from '../types.js';
import { AUDIO_CACHE_DIR, AUDIO_DIR, MANIFEST_EXT, METADATA_FILE, chapterFile, listChapterFiles } from '../layout.js';
import { chapterTitle as titleOf } from './stories.js';

const execFileAsync = promisify(execFile);

async function ffmpeg(args: string[]): Promise<void> {
  await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { signal: taskCancellationSignal() });
}

async function durationOf(file: string): Promise<number> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8', signal: taskCancellationSignal() }
  );
  return parseFloat(stdout.trim());
}

/**
 * Sample rate and channel count of a synthesized segment. Scene-break silence
 * has to match it: the concat demuxer joins streams, it does not resample them.
 */
async function audioFormatOf(file: string): Promise<{ rate: string; channels: string }> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,channels', '-of', 'default=noprint_wrappers=1', file],
    { encoding: 'utf8', signal: taskCancellationSignal() }
  );
  const values = new Map(stdout.trim().split(/\r?\n/).map((line) => line.split('=') as [string, string]));
  const rate = values.get('sample_rate');
  const channels = values.get('channels');
  if (!rate || !channels) throw new Error(`ffprobe reported no audio stream in ${file}. Rerun synth for this chapter.`);
  return { rate, channels };
}

/**
 * An MP3 of silence for a scene break, encoded once per length and format and
 * kept in the derived audio folder. Nothing is paid for and nothing is cached
 * alongside synthesized speech.
 */
async function silenceFile(work: WorkDir, pauseMs: number, format: { rate: string; channels: string }): Promise<string> {
  const file = work.path(AUDIO_DIR, `silence-${pauseMs}ms-${format.rate}-${format.channels}.mp3`);
  if (fs.existsSync(file)) return file;
  const layout = format.channels === '1' ? 'mono' : 'stereo';
  const source = ['-f', 'lavfi', '-i', `anullsrc=r=${format.rate}:cl=${layout}`, '-t', String(pauseMs / 1000)];
  const pending = file + '.tmp.mp3';
  try {
    try {
      await ffmpeg([...source, '-c:a', 'libmp3lame', '-b:a', '64k', pending]);
    } catch {
      // Some ffmpeg builds expose the encoder only under its generic name.
      await ffmpeg([...source, '-c:a', 'mp3', '-b:a', '64k', pending]);
    }
    fs.renameSync(pending, file);
  } catch (err) {
    throw new Error(`ffmpeg could not encode the ${pauseMs}ms scene-break silence (${(err as Error).message}). This needs an ffmpeg build with an MP3 encoder, such as "brew install ffmpeg".`);
  } finally {
    fs.rmSync(pending, { force: true });
  }
  return file;
}

function escapeMeta(s: string): string {
  return s.replace(/([=;#\\\n])/g, '\\$1');
}

/**
 * Stage 7: concatenate cached MP3 segments into one AAC-encoded M4A per
 * chapter (the only encode after synthesis), then stream-copy the chapters
 * into a single M4B with chapter markers, tags and cover art.
 */
export async function runAssemble(work: WorkDir, outDir?: string, chapterIndexes?: number[]): Promise<string> {
  throwIfTaskCancelled();
  reportProgress({ activity: 'Reading synthesized chapter manifests' });
  const meta = work.readJson<BookMetadata>(METADATA_FILE);
  work.dir(AUDIO_DIR);

  const manifestFiles = listChapterFiles(work.root, AUDIO_DIR, MANIFEST_EXT)
    .filter(({ index }) => !chapterIndexes || chapterIndexes.includes(index));
  const manifests = manifestFiles.map(({ file }) => work.readJson<ChapterAudioManifest>(file));
  const manifestPath = new Map(manifestFiles.map(({ index, file }) => [index, work.path(file)]));
  const encodedPath = (index: number): string => work.path(chapterFile(work.root, AUDIO_DIR, index, titleOf(meta, index), '.m4a'));
  if (manifests.length === 0) throw new Error('No synthesized chapters found — run synth first.');

  // 1. Per-chapter concat + AAC encode (skipped when the chapter m4a exists).
  const chapterTitle = (index: number): string => titleOf(meta, index);
  let encoded = 0;
  for (const manifest of manifests) {
    throwIfTaskCancelled();
    const encodedFile = encodedPath(manifest.index);
    const progress = (activity: string) => reportProgress({ activity,
      chapterIndex: manifest.index, chapterTitle: chapterTitle(manifest.index),
      completedUnits: encoded, totalUnits: manifests.length, unit: 'chapters encoded',
    });
    const manifestFile = manifestPath.get(manifest.index)!;
    // A manifest rewritten after this encode (new pauses, a changed script)
    // makes the existing file stale, so reuse it only while it is newer.
    if (fs.existsSync(encodedFile) && fs.statSync(encodedFile).mtimeMs >= fs.statSync(manifestFile).mtimeMs) {
      encoded++;
      progress('Reusing encoded chapter');
      continue;
    }
    progress(`Encoding ${manifest.segments.length} audio segments — waiting for ffmpeg`);

    const pauses = manifest.segments.filter((entry): entry is { pauseMs: number } => typeof entry !== 'string');
    const silence = new Map<number, string>();
    if (pauses.length) {
      const firstHash = manifest.segments.find((entry): entry is string => typeof entry === 'string');
      if (!firstHash) throw new Error(`Chapter ${manifest.index + 1} has no synthesized speech — rerun synth for it.`);
      const format = await audioFormatOf(work.path(AUDIO_CACHE_DIR, `${firstHash}.mp3`));
      for (const { pauseMs } of pauses) {
        if (!silence.has(pauseMs)) silence.set(pauseMs, await silenceFile(work, pauseMs, format));
      }
    }
    const sourceOf = (entry: ChapterAudioEntry): string =>
      typeof entry === 'string' ? work.path(AUDIO_CACHE_DIR, `${entry}.mp3`) : silence.get(entry.pauseMs)!;

    const listFile = work.path(AUDIO_DIR, `concat-${manifest.index}.txt`);
    fs.writeFileSync(
      listFile,
      manifest.segments
        .map((entry) => `file '${sourceOf(entry).replace(/'/g, "'\\''")}'`)
        .join('\n')
    );
    // Publish only successful encodes so a failed request can be resumed safely.
    // Named so it is never mistaken for a chapter's finished file.
    const pendingFile = work.path(AUDIO_DIR, `pending-${manifest.index}.m4a`);
    try {
      await ffmpeg([
        '-f', 'concat', '-safe', '0', '-i', listFile,
        '-c:a', 'aac', '-b:a', config.audioBitrate, '-ar', '44100', '-ac', '1',
        pendingFile,
      ]);
      fs.renameSync(pendingFile, encodedFile);
    } finally {
      fs.rmSync(pendingFile, { force: true });
    }
    fs.rmSync(listFile);
    encoded++;
    progress('Chapter encoding complete');
  }

  // 2. Chapter markers from encoded durations.
  reportProgress({ activity: 'Reading encoded durations and building chapter markers', completedUnits: 0, totalUnits: manifests.length, unit: 'chapter durations read' });

  let ffmeta = `;FFMETADATA1\ntitle=${escapeMeta(meta.title)}\nartist=${escapeMeta(meta.author)}\nalbum=${escapeMeta(meta.title)}\ngenre=Audiobook\n`;
  let cursorMs = 0;
  const chapterFiles: string[] = [];
  for (const manifest of manifests) {
    throwIfTaskCancelled();
    const file = encodedPath(manifest.index);
    chapterFiles.push(file);
    const durMs = Math.round(await durationOf(file) * 1000);
    ffmeta += `\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=${cursorMs}\nEND=${cursorMs + durMs}\ntitle=${escapeMeta(chapterTitle(manifest.index))}\n`;
    cursorMs += durMs;
    reportProgress({ activity: 'Building chapter markers', completedUnits: chapterFiles.length, totalUnits: manifests.length, unit: 'chapter durations read' });
  }
  const ffmetaFile = work.path(AUDIO_DIR, 'ffmetadata.txt');
  fs.writeFileSync(ffmetaFile, ffmeta);

  // 3. Concat chapters (stream copy — identical encoding) into one m4a.
  const concatList = work.path(AUDIO_DIR, 'concat-book.txt');
  fs.writeFileSync(
    concatList,
    chapterFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n')
  );
  const bookM4a = work.path(AUDIO_DIR, 'book.m4a');
  reportProgress({ activity: 'Joining encoded chapters — waiting for ffmpeg' });
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', concatList, '-c', 'copy', bookM4a]);
  throwIfTaskCancelled();
  fs.rmSync(concatList);

  // 4. Mux metadata + cover into the final .m4b.
  // Keep the finished audiobook alongside the artifacts that produced it by
  // default. An explicit output directory remains available for exports.
  const outputDir = outDir ? path.resolve(outDir) : work.root;
  fs.mkdirSync(outputDir, { recursive: true });
  const safeTitle = meta.title.replace(/[\\/:*?"<>|]/g, '-').trim() || 'book';
  const selectionLabel = chapterIndexes?.length
    ? ` - chapters ${[...chapterIndexes].sort((a, b) => a - b).join('-')}`
    : '';
  const outFile = path.join(outputDir, `${safeTitle}${selectionLabel}.m4b`);

  const args = ['-i', bookM4a, '-i', ffmetaFile];
  if (meta.coverFile && fs.existsSync(work.path(meta.coverFile))) {
    args.push('-i', work.path(meta.coverFile));
    args.push('-map', '0:a', '-map', '2:v', '-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic');
  } else {
    args.push('-map', '0:a');
  }
  args.push('-map_metadata', '1', '-c:a', 'copy', '-f', 'mp4', outFile);
  reportProgress({ activity: 'Writing M4B with metadata and cover art — waiting for ffmpeg' });
  await ffmpeg(args);
  throwIfTaskCancelled();

  fs.rmSync(bookM4a);
  reportProgress({ activity: `Audiobook saved: ${outFile}`, phase: 'completed' });
  return outFile;
}
