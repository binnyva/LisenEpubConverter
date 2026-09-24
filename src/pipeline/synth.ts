import fs from 'node:fs';
import { reportWarning } from '../util/warnings.js';
import crypto from 'node:crypto';
import pLimit from 'p-limit';
import { getTTSProvider } from '../providers/tts/openai.js';
import { markdownToSpeakable } from '../epub/markdown.js';
import { splitSentences } from '../util/text.js';
import { config } from '../config.js';
import { reportProgress } from '../util/progress.js';
import { throwIfTaskCancelled, taskCancellationSignal, waitForRetry } from '../util/cancellation.js';
import { validateVoiceBindings } from './voices.js';
import type { WorkDir } from '../state.js';
import type { BookMetadata, Casting, ChapterAudioManifest, ChapterScript } from '../types.js';

/**
 * Stage 8: synthesize every script segment to MP3. Each unique
 * (text, voice, instructions) is cached by content hash, so re-runs and
 * crashes never pay for the same audio twice.
 */
export async function runSynth(work: WorkDir, chapterIndexes?: number[]): Promise<void> {
  throwIfTaskCancelled();
  reportProgress({ activity: 'Validating saved voice bindings and preparing speech requests' });
  const casting = work.readJson<Casting>('casting.json');
  const bindings = validateVoiceBindings(work);
  const meta = work.readJson<BookMetadata>('metadata.json');
  const provider = getTTSProvider(bindings.target, bindings.libraryFile);

  // Casting instructions that mention a nationality or accent ("Portuguese-
  // accented narration") can make the TTS model switch into that language and
  // translate the segment outright, especially when the text opens with foreign
  // proper nouns. Pin the spoken language explicitly on every request. The
  // guard is applied at request time but excluded from the cache hash, so
  // adding or rewording it never invalidates already-synthesized audio.
  const languageName =
    new Intl.DisplayNames(['en'], { type: 'language' }).of(meta.language) ?? meta.language;
  const languageGuard = `Speak in ${languageName}, reading the text verbatim; never translate it into another language. Any accent described below affects pronunciation only.`;
  const cacheDir = work.dir('audio-cache');
  work.dir('audio');

  const limit = pLimit(config.ttsConcurrency);
  const scriptFiles = fs
    .readdirSync(work.path('script'))
    .filter((file) => !chapterIndexes || chapterIndexes.includes(Number.parseInt(file, 10)))
    .sort();

  let total = 0;
  let cached = 0;
  let completedChapters = 0;

  for (const file of scriptFiles) {
    throwIfTaskCancelled();
    const script = work.readJson<ChapterScript>(`script/${file}`);
    const chapterTitle = meta.chapters.find((chapter) => chapter.index === script.index)?.title ?? `Chapter ${script.index}`;
    reportProgress({ activity: 'Preparing audio segments', chapterIndex: script.index, chapterTitle, completedChapters, totalChapters: scriptFiles.length });
    const manifestFile = `audio/${String(script.index).padStart(2, '0')}-segments.json`;

    const pieces: Array<{ hash: string; text: string; voiceId: string; instructions: string }> = [];
    for (const seg of script.segments) {
      const speaker =
        seg.speaker === 'narrator'
          ? casting.narrator
          : (casting.characters[seg.speaker] ?? casting.narrator);
      const binding =
        seg.speaker === 'narrator'
          ? bindings.narrator
          : (bindings.characters[seg.speaker] ?? bindings.narrator);
      const instructions = [speaker.instructions, seg.delivery ? `Delivery: ${seg.delivery}.` : '']
        .filter(Boolean)
        .join(' ');

      const speakable = markdownToSpeakable(seg.text);
      if (!speakable) continue;
      for (const text of splitSentences(speakable, provider.maxChars)) {
        const hash = crypto
          .createHash('sha256')
          .update([binding.provider, binding.model, binding.voiceId, instructions, text].join('\x1f'))
          .digest('hex')
          .slice(0, 24);
        pieces.push({ hash, text, voiceId: binding.voiceId, instructions });
      }
    }

    total += pieces.length;
    let ready = 0;
    let chapterCached = 0;
    const progress = (activity: string, phase?: 'saving' | 'completed') => reportProgress({
      activity, phase, chapterIndex: script.index, chapterTitle,
      completedChapters, totalChapters: scriptFiles.length,
      completedUnits: ready, totalUnits: pieces.length, unit: 'audio segments ready',
    });
    progress('Synthesizing speech and checking cached audio');
    await Promise.all(
      pieces.map((piece) =>
        limit(async () => {
          throwIfTaskCancelled();
          const out = `${cacheDir}/${piece.hash}.mp3`;
          if (fs.existsSync(out)) {
            cached++;
            chapterCached++;
            ready++;
            progress(`Preparing audio; ${chapterCached} segment(s) reused from cache`);
            return;
          }
          const audio = await synthesizeWithRetry(provider, piece, languageGuard);
          throwIfTaskCancelled();
          fs.writeFileSync(out + '.tmp', audio);
          fs.renameSync(out + '.tmp', out);
          ready++;
          progress(`Synthesizing speech; ${chapterCached} segment(s) reused from cache`);
        })
      )
    );

    const manifest: ChapterAudioManifest = {
      index: script.index,
      segments: pieces.map((p) => p.hash),
    };
    progress('Saving chapter audio manifest', 'saving');
    work.writeJson(manifestFile, manifest);
    completedChapters++;
    progress(`Chapter audio ready; ${chapterCached} segment(s) reused from cache`, 'completed');
  }

  reportProgress({ activity: `Synthesized ${total - cached} segment(s), ${cached} from cache`, phase: 'completed', completedUnits: total, totalUnits: total, unit: 'audio segments ready', completedChapters, totalChapters: scriptFiles.length });
}

async function synthesizeWithRetry(
  provider: ReturnType<typeof getTTSProvider>,
  piece: { text: string; voiceId: string; instructions: string },
  languageGuard: string
): Promise<Buffer> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await provider.synthesize({
        text: piece.text,
        voiceId: piece.voiceId,
        instructions: [languageGuard, piece.instructions].filter(Boolean).join(' '),
        signal: taskCancellationSignal(),
      });
    } catch (err) {
      throwIfTaskCancelled();
      lastErr = err;
      if (attempt === 4) break;
      const backoff = 2000 * 2 ** (attempt - 1);
      reportWarning(`TTS failed (${(err as Error).message}), retrying in ${backoff / 1000}s...`);
      await waitForRetry(backoff);
    }
  }
  throw lastErr;
}
