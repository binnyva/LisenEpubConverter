import { config } from '../../config.js';
import type { SynthesisRequest, TTSProvider, Voice } from './types.js';
import { loadVoiceCatalog, OPENAI_VOICES } from './voices.js';
import type { TTSProviderTarget } from './openai.js';
import { libraryVoicesForTarget } from '../../voices/library.js';

/** TTS implementation for OpenRouter's OpenAI-compatible audio/speech endpoint. */
export class OpenRouterTTSProvider implements TTSProvider {
  readonly id = 'openrouter';
  readonly maxChars = config.ttsMaxChars;
  private readonly voices: Voice[];
  private readonly model: string;

  constructor(
    target: TTSProviderTarget = { provider: 'openrouter', model: config.ttsModel },
    voiceLibraryFile?: string,
  ) {
    this.model = target.model;
    if (config.ttsVoicesFile) {
      this.voices = loadVoiceCatalog(config.ttsVoicesFile);
    } else if (this.model.startsWith('openai/')) {
      this.voices = OPENAI_VOICES;
    } else {
      this.voices = libraryVoicesForTarget({ provider: 'openrouter', model: this.model }, voiceLibraryFile);
      if (!this.voices.length) {
        throw new Error(
          `OpenRouter TTS model "${this.model}" has no compatible voices in the shared voice library. Add its catalogue there or set LISEN_TTS_VOICES_FILE to a JSON file describing its supported voices.`
        );
      }
    }
  }

  listVoices(): Voice[] {
    return this.voices;
  }

  async synthesize(req: SynthesisRequest): Promise<Buffer> {
    const usesOpenAIOptions = this.model.startsWith('openai/');
    const res = await fetch(`${config.openRouterBaseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ''}`,
        'Content-Type': 'application/json',
        'X-OpenRouter-Title': 'Lisen EPUB Convertor',
        ...(config.openRouterSiteUrl ? { 'HTTP-Referer': config.openRouterSiteUrl } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        input: req.text,
        voice: req.voiceId,
        response_format: 'mp3',
        ...(usesOpenAIOptions && req.instructions
          ? { provider: { options: { openai: { instructions: req.instructions } } } }
          : {}),
      }),
      signal: req.signal,
    });
    if (!res.ok) {
      throw new Error(`OpenRouter TTS request failed (${res.status}): ${(await res.text()).slice(0, 1000)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}
