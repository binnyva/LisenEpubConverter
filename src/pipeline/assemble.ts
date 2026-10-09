import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { reportProgress } from '../util/progress.js';
import { taskCancellationSignal, throwIfTaskCancelled } from '../util/cancellation.js';
import type { WorkDir } from '../state.js';
import type { Analysis, BookMetadata, ChapterAudioManifest, ChapterScript } from '../types.js';

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

function escapeMeta(s: string): string {
  return s.replace(/([=;#\\\n])/g, '\\$1');
}

/**
 * Stage 10: concatenate cached segments into per-chapter M4A files, then all
 * chapters into a single M4B with chapter markers, tags and cover art.
 */
export async function runAssemble(work: WorkDir, outDir?: string, chapterIndexes?: number[]): Promise<string> {
  throwIfTaskCancelled();
  reportProgress({ activity: 'Reading synthesized chapter manifests' });
  const meta = work.readJson<BookMetadata>('metadata.json');
  const analysis = work.readJson<Analysis>('analysis.json');
  work.dir('audio');
  const expected = meta.chapters.filter((chapter) => analysis.chapters.some((plan) => plan.index === chapter.index && plan.narrate)).map((chapter) => chapter.index);
  const selected = chapterIndexes ?? expected;
  if (!selected.length) throw new Error('The current narration plan has no chapters to assemble.');
  if (selected.some((index) => !expected.includes(index))) throw new Error('One or more selected chapters are not in the current narration plan.');
  const manifests = selected.map((index) => {
    const file = `audio/${String(index).padStart(4, '0')}-segments.json`;
    if (!fs.existsSync(work.path(file))) throw new Error(`Synthesized manifest is missing for requested chapter ${index + 1}. Run synth for the complete selection.`);
    const manifest = work.readJson<ChapterAudioManifest>(file);
    if (manifest.index !== index) throw new Error(`${file} contains chapter index ${manifest.index}; expected ${index}.`);
    if (!manifest.fingerprint || !manifest.encoding || !manifest.scriptFingerprint) throw new Error(`${file} is a legacy manifest without freshness provenance. Rerun synth; cached paid MP3s will be reused.`);
    const currentEncoding = { codec: 'aac', bitrate: config.audioBitrate, sampleRate: 44100, channels: 1 };
    if (JSON.stringify(manifest.encoding) !== JSON.stringify(currentEncoding)) throw new Error(`Chapter ${index + 1} encoding settings changed. Rerun synth to refresh its manifest.`);
    const scriptFile = `script/${String(index).padStart(4, '0')}.json`;
    const script = work.readJson<ChapterScript>(scriptFile);
    const scriptFingerprint = script.fingerprint ?? crypto.createHash('sha256').update(JSON.stringify(script)).digest('hex');
    if (scriptFingerprint !== manifest.scriptFingerprint) throw new Error(`Chapter ${index + 1} synthesis is stale because its script changed. Rerun synth.`);
    for (const hash of manifest.segments) if (!fs.existsSync(work.path('audio-cache', `${hash}.mp3`))) throw new Error(`Cached audio ${hash} required by chapter ${index + 1} is missing. Rerun synth.`);
    return manifest;
  });

  // 1. Per-chapter concat + AAC encode (skipped when the chapter m4a exists).
  const chapterTitle = (index: number): string =>
    meta.chapters.find((c) => c.index === index)?.title ?? `Chapter ${index}`;
  let encoded = 0;
  for (const manifest of manifests) {
    throwIfTaskCancelled();
    const chapterFile = work.path('audio', `${String(manifest.index).padStart(4, '0')}.m4a`);
    const provenanceFile = `${chapterFile}.json`;
    const progress = (activity: string) => reportProgress({ activity,
      chapterIndex: manifest.index, chapterTitle: chapterTitle(manifest.index),
      completedUnits: encoded, totalUnits: manifests.length, unit: 'chapters encoded',
    });
    const encodedProvenance = fs.existsSync(provenanceFile) ? JSON.parse(fs.readFileSync(provenanceFile, 'utf8')) as { manifestFingerprint?: string; encoding?: unknown } : undefined;
    if (fs.existsSync(chapterFile) && encodedProvenance?.manifestFingerprint === manifest.fingerprint && JSON.stringify(encodedProvenance?.encoding) === JSON.stringify(manifest.encoding)) {
      encoded++;
      progress('Reusing encoded chapter');
      continue;
    }
    progress(`Encoding ${manifest.segments.length} audio segments — waiting for ffmpeg`);

    const listFile = work.path('audio', `concat-${manifest.index}.txt`);
    fs.writeFileSync(
      listFile,
      manifest.segments
        .map((h) => `file '${work.path('audio-cache', `${h}.mp3`).replace(/'/g, "'\\''")}'`)
        .join('\n')
    );
    // Publish only successful encodes so a failed request can be resumed safely.
    const pendingFile = chapterFile + '.tmp.m4a';
    try {
      await ffmpeg([
        '-f', 'concat', '-safe', '0', '-i', listFile,
        '-c:a', 'aac', '-b:a', config.audioBitrate, '-ar', '44100', '-ac', '1',
        pendingFile,
      ]);
      fs.renameSync(pendingFile, chapterFile);
      const pendingProvenance = `${provenanceFile}.tmp`;
      fs.writeFileSync(pendingProvenance, JSON.stringify({ version: 1, manifestFingerprint: manifest.fingerprint, encoding: manifest.encoding }, null, 2));
      fs.renameSync(pendingProvenance, provenanceFile);
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
    const file = work.path('audio', `${String(manifest.index).padStart(4, '0')}.m4a`);
    chapterFiles.push(file);
    const durMs = Math.round(await durationOf(file) * 1000);
    ffmeta += `\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=${cursorMs}\nEND=${cursorMs + durMs}\ntitle=${escapeMeta(chapterTitle(manifest.index))}\n`;
    cursorMs += durMs;
    reportProgress({ activity: 'Building chapter markers', completedUnits: chapterFiles.length, totalUnits: manifests.length, unit: 'chapter durations read' });
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

  const pendingOut = path.join(outputDir, `.${safeTitle}.${process.pid}.${Date.now()}.tmp.m4b`);
  const args = ['-i', bookM4a, '-i', ffmetaFile];
  if (meta.coverFile && fs.existsSync(work.path(meta.coverFile))) {
    args.push('-i', work.path(meta.coverFile));
    args.push('-map', '0:a', '-map', '2:v', '-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic');
  } else {
    args.push('-map', '0:a');
  }
  args.push('-map_metadata', '1', '-c:a', 'copy', '-f', 'mp4', pendingOut);
  reportProgress({ activity: 'Writing M4B with metadata and cover art — waiting for ffmpeg' });
  try {
    await ffmpeg(args);
    throwIfTaskCancelled();
    fs.renameSync(pendingOut, outFile);
  } finally {
    fs.rmSync(pendingOut, { force: true });
  }

  fs.rmSync(bookM4a);
  reportProgress({ activity: `Audiobook saved: ${outFile}`, phase: 'completed' });
  return outFile;
}
