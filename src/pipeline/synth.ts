import fs from 'node:fs';
import { reportWarning } from '../util/warnings.js';
import crypto from 'node:crypto';
import { getTTSProvider } from '../providers/tts/openai.js';
import { markdownToSpeakable } from '../epub/markdown.js';
import { splitSentences } from '../util/text.js';
import { config } from '../config.js';
import { reportProgress } from '../util/progress.js';
import { throwIfTaskCancelled, taskCancellationSignal, waitForRetry } from '../util/cancellation.js';
import { validateVoiceBindings } from './voices.js';
import type { WorkDir } from '../state.js';
import type { BookMetadata, Casting, ChapterAudioManifest, ChapterScript } from '../types.js';
import type { Analysis } from '../types.js';

/**
 * Stage 9: synthesize every script segment to MP3. Each unique
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

  const analysis = work.readJson<Analysis>('analysis.json');
  const expected = meta.chapters.filter((chapter) => analysis.chapters.some((plan) => plan.index === chapter.index && plan.narrate)).map((chapter) => chapter.index);
  const selected = chapterIndexes ?? expected;
  if (fs.existsSync(work.path('unresolved-quotes.json'))) {
    const unresolved = work.readJson<{ quotations: Array<{ id: string; chapterIndex: number | null; chapterIndexes?: number[] }> }>('unresolved-quotes.json').quotations
      .filter((quote) => quote.chapterIndexes?.length
        ? quote.chapterIndexes.some((index) => selected.includes(index))
        : quote.chapterIndex === null || selected.includes(quote.chapterIndex));
    if (unresolved.length) throw new Error(`${unresolved.length} unresolved quotation(s) affect the requested synthesis. Assign speakers in the workspace before making paid TTS requests.`);
  }
  const scriptFiles = selected.map((index) => `${String(index).padStart(4, '0')}.json`);
  for (const [position, file] of scriptFiles.entries()) {
    if (!fs.existsSync(work.path('script', file))) throw new Error(`Script is missing for requested chapter ${selected[position] + 1}.`);
    const parsed = work.readJson<ChapterScript>(`script/${file}`);
    if (parsed.index !== selected[position]) throw new Error(`Script filename ${file} contains chapter index ${parsed.index}; expected ${selected[position]}.`);
  }

  let total = 0;
  let cached = 0;
  let completedChapters = 0;

  for (const file of scriptFiles) {
    throwIfTaskCancelled();
    const script = work.readJson<ChapterScript>(`script/${file}`);
    const chapterTitle = meta.chapters.find((chapter) => chapter.index === script.index)?.title ?? `Chapter ${script.index}`;
    reportProgress({ activity: 'Preparing audio segments', chapterIndex: script.index, chapterTitle, completedChapters, totalChapters: scriptFiles.length });
    const manifestFile = `audio/${String(script.index).padStart(4, '0')}-segments.json`;

    const pieces: Array<{ hash: string; text: string; voiceId: string; instructions: string }> = [];
    for (const seg of script.segments) {
      if (seg.speakerId === 'unresolved' || seg.speaker.toLowerCase() === 'unresolved speaker') {
        throw new Error(`Chapter ${script.index + 1} contains unresolved quotation ${seg.quotationId ?? ''}. Assign a speaker in corrections.json or the workspace before synthesis.`);
      }
      const speakerKey = seg.speakerId && seg.speakerId !== 'narrator' ? seg.speakerId : seg.speaker;
      const speaker =
        seg.speaker === 'narrator'
          ? casting.narrator
          : (casting.characters[speakerKey] ?? casting.characters[seg.speaker]);
      const binding =
        seg.speaker === 'narrator'
          ? bindings.narrator
          : (bindings.characters[speakerKey] ?? bindings.characters[seg.speaker]);
      if (!speaker || !binding) throw new Error(`Casting or voice binding is missing for ${seg.speaker} (${speakerKey}). Run casting and voices again.`);
      const instructions = [speaker.instructions, seg.delivery ? `Delivery: ${seg.delivery}.` : '']
        .filter(Boolean)
        .join(' ');

      const speakable = script.format === 'plain-text' ? seg.text.trim() : markdownToSpeakable(seg.text);
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
    const uniquePieces = [...new Map(pieces.map((piece) => [piece.hash, piece])).values()];
    const failureController = new AbortController();
    const outerSignal = taskCancellationSignal();
    const requestSignal = outerSignal ? AbortSignal.any([outerSignal, failureController.signal]) : failureController.signal;
    let cursor = 0;
    let firstError: unknown;
    const worker = async () => {
      while (cursor < uniquePieces.length && !firstError) {
        const piece = uniquePieces[cursor++];
        try {
          throwIfTaskCancelled();
          const out = `${cacheDir}/${piece.hash}.mp3`;
          if (fs.existsSync(out)) {
            cached++;
            chapterCached++;
            ready++;
            progress(`Preparing audio; ${chapterCached} segment(s) reused from cache`);
            continue;
          }
          const audio = await synthesizeWithRetry(provider, piece, languageGuard, requestSignal);
          throwIfTaskCancelled();
          fs.writeFileSync(out + '.tmp', audio);
          fs.renameSync(out + '.tmp', out);
          ready++;
          progress(`Synthesizing speech; ${chapterCached} segment(s) reused from cache`);
        } catch (error) {
          firstError ??= error;
          failureController.abort();
        }
      }
    };
    await Promise.allSettled(Array.from({ length: Math.min(config.ttsConcurrency, uniquePieces.length) }, worker));
    if (firstError) throw firstError;
    // Repeated occurrences share one paid request but remain repeated in the
    // ordered manifest and progress/cache accounting.
    ready = pieces.length;

    const manifest: ChapterAudioManifest = {
      version: 2,
      index: script.index,
      segments: pieces.map((p) => p.hash),
      scriptFingerprint: script.fingerprint ?? crypto.createHash('sha256').update(JSON.stringify(script)).digest('hex'),
      fingerprint: crypto.createHash('sha256').update(JSON.stringify({ segments: pieces.map((p) => p.hash), scriptFingerprint: script.fingerprint, ttsMaxChars: provider.maxChars, splitterVersion: config.ttsSplitterVersion })).digest('hex'),
      encoding: { codec: 'aac', bitrate: config.audioBitrate, sampleRate: 44100, channels: 1 },
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
  languageGuard: string,
  signal: AbortSignal,
): Promise<Buffer> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await provider.synthesize({
        text: piece.text,
        voiceId: piece.voiceId,
        instructions: [languageGuard, piece.instructions].filter(Boolean).join(' '),
        signal,
      });
    } catch (err) {
      if (signal.aborted) throw err;
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
