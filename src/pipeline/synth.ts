import fs from 'node:fs';
import { reportWarning } from '../util/warnings.js';
import crypto from 'node:crypto';
import pLimit from 'p-limit';
import { getTTSProvider } from '../providers/tts/openai.js';
import { markdownToSpeakable } from '../epub/markdown.js';
import { splitSentences } from '../util/text.js';
import { config } from '../config.js';
import { reportProgress } from '../util/progress.js';
import { recordTtsUsage } from '../util/usage.js';
import { throwIfTaskCancelled, taskCancellationSignal, waitForRetry } from '../util/cancellation.js';
import { validateVoiceBindings } from './voices.js';
import type { WorkDir } from '../state.js';
import type { BookMetadata, Casting, ChapterAudioEntry, ChapterAudioManifest, ChapterScript } from '../types.js';
import { AUDIO_CACHE_DIR, AUDIO_DIR, MANIFEST_EXT, METADATA_FILE, SCRIPTS_DIR, chapterFile, listChapterFiles } from '../layout.js';
import { chapterTitle as titleOf } from './stories.js';

/**
 * Stage 6: synthesize every script segment to MP3. Each unique
 * (text, voice, instructions) is cached by content hash, so re-runs and
 * crashes never pay for the same audio twice.
 */
export async function runSynth(work: WorkDir, chapterIndexes?: number[]): Promise<void> {
  throwIfTaskCancelled();
  reportProgress({ activity: 'Validating saved voice bindings and preparing speech requests' });
  const casting = work.readJson<Casting>('casting.json');
  const bindings = validateVoiceBindings(work);
  const meta = work.readJson<BookMetadata>(METADATA_FILE);
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
  const cacheDir = work.dir(AUDIO_CACHE_DIR);
  work.dir(AUDIO_DIR);

  const limit = pLimit(config.ttsConcurrency);
  const scriptFiles = listChapterFiles(work.root, SCRIPTS_DIR, '.json')
    .filter(({ index }) => !chapterIndexes || chapterIndexes.includes(index))
    .map(({ file }) => file);

  let total = 0;
  let cached = 0;
  let completedChapters = 0;

  for (const file of scriptFiles) {
    throwIfTaskCancelled();
    const script = work.readJson<ChapterScript>(file);
    const chapterTitle = titleOf(meta, script.index);
    reportProgress({ activity: 'Preparing audio segments', chapterIndex: script.index, chapterTitle, completedChapters, totalChapters: scriptFiles.length });
    const manifestFile = chapterFile(work.root, AUDIO_DIR, script.index, chapterTitle, MANIFEST_EXT);

    type SpeechPiece = { hash: string; text: string; voiceId: string; instructions: string };
    const pieces: Array<SpeechPiece | { pauseMs: number }> = [];
    for (const seg of script.segments) {
      // A scene break is silence: no request, no cost, assembled by ffmpeg.
      if (seg.kind === 'pause') {
        pieces.push({ pauseMs: seg.pauseMs ?? config.sceneBreakPauseMs });
        continue;
      }
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

    const speech = pieces.filter((piece): piece is SpeechPiece => 'hash' in piece);
    total += speech.length;
    let ready = 0;
    let chapterCached = 0;
    const progress = (activity: string, phase?: 'saving' | 'completed') => reportProgress({
      activity, phase, chapterIndex: script.index, chapterTitle,
      completedChapters, totalChapters: scriptFiles.length,
      completedUnits: ready, totalUnits: speech.length, unit: 'audio segments ready',
    });
    progress('Synthesizing speech and checking cached audio');
    await Promise.all(
      speech.map((piece) =>
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
      segments: pieces.map((p): ChapterAudioEntry => ('hash' in p ? p.hash : { pauseMs: p.pauseMs })),
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
      const audio = await provider.synthesize({
        text: piece.text,
        voiceId: piece.voiceId,
        instructions: [languageGuard, piece.instructions].filter(Boolean).join(' '),
        signal: taskCancellationSignal(),
      });
      recordTtsUsage(piece.text.length);
      return audio;
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
