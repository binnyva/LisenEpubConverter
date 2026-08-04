import fs from 'node:fs';
import crypto from 'node:crypto';
import pLimit from 'p-limit';
import { getTTSProvider } from '../providers/tts/openai.js';
import { markdownToSpeakable } from '../epub/markdown.js';
import { splitSentences } from '../util/text.js';
import { config } from '../config.js';
import type { WorkDir } from '../state.js';
import type { Casting, ChapterAudioManifest, ChapterScript } from '../types.js';

/**
 * Stage 6: synthesize every script segment to MP3. Each unique
 * (text, voice, instructions) is cached by content hash, so re-runs and
 * crashes never pay for the same audio twice.
 */
export async function runSynth(work: WorkDir): Promise<void> {
  const casting = work.readJson<Casting>('casting.json');
  const provider = getTTSProvider();
  const cacheDir = work.dir('audio-cache');
  work.dir('audio');

  const limit = pLimit(config.ttsConcurrency);
  const scriptFiles = fs.readdirSync(work.path('script')).sort();

  let total = 0;
  let cached = 0;

  for (const file of scriptFiles) {
    const script = work.readJson<ChapterScript>(`script/${file}`);
    const manifestFile = `audio/${String(script.index).padStart(2, '0')}-segments.json`;

    const pieces: Array<{ hash: string; text: string; voiceId: string; instructions: string }> = [];
    for (const seg of script.segments) {
      const voice =
        seg.speaker === 'narrator'
          ? casting.narrator
          : (casting.characters[seg.speaker] ?? casting.narrator);
      const instructions = [voice.instructions, seg.delivery ? `Delivery: ${seg.delivery}.` : '']
        .filter(Boolean)
        .join(' ');

      const speakable = markdownToSpeakable(seg.text);
      if (!speakable) continue;
      for (const text of splitSentences(speakable, provider.maxChars)) {
        const hash = crypto
          .createHash('sha256')
          .update([provider.id, config.ttsModel, voice.voiceId, instructions, text].join('\x1f'))
          .digest('hex')
          .slice(0, 24);
        pieces.push({ hash, text, voiceId: voice.voiceId, instructions });
      }
    }

    total += pieces.length;
    await Promise.all(
      pieces.map((piece) =>
        limit(async () => {
          const out = `${cacheDir}/${piece.hash}.mp3`;
          if (fs.existsSync(out)) {
            cached++;
            return;
          }
          const audio = await synthesizeWithRetry(provider, piece);
          fs.writeFileSync(out + '.tmp', audio);
          fs.renameSync(out + '.tmp', out);
        })
      )
    );

    const manifest: ChapterAudioManifest = {
      index: script.index,
      segments: pieces.map((p) => p.hash),
    };
    work.writeJson(manifestFile, manifest);
    console.log(`  Chapter ${script.index}: ${pieces.length} audio segment(s) ready`);
  }

  console.log(`  Synthesized ${total - cached} segment(s), ${cached} from cache.`);
}

async function synthesizeWithRetry(
  provider: ReturnType<typeof getTTSProvider>,
  piece: { text: string; voiceId: string; instructions: string }
): Promise<Buffer> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await provider.synthesize({
        text: piece.text,
        voiceId: piece.voiceId,
        instructions: piece.instructions || undefined,
      });
    } catch (err) {
      lastErr = err;
      const backoff = 2000 * 2 ** (attempt - 1);
      console.warn(`  TTS failed (${(err as Error).message}), retrying in ${backoff / 1000}s...`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}
