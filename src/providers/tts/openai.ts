import OpenAI from 'openai';
import { config } from '../../config.js';
import type { SynthesisRequest, TTSProvider, Voice } from './types.js';
import { OpenRouterTTSProvider } from './openrouter.js';
import { OPENAI_VOICES } from './voices.js';

export interface TTSProviderTarget {
  provider: 'openai' | 'openrouter' | 'fish';
  model: string;
}

export class OpenAITTSProvider implements TTSProvider {
  readonly id = 'openai';
  readonly maxChars = config.ttsMaxChars;
  private client = new OpenAI();
  private readonly model: string;

  constructor(target: TTSProviderTarget = { provider: config.ttsProvider, model: config.ttsModel }) {
    this.model = target.model;
  }

  listVoices(): Voice[] {
    return OPENAI_VOICES;
  }

  async synthesize(req: SynthesisRequest): Promise<Buffer> {
    const res = await this.client.audio.speech.create({
      model: this.model,
      voice: req.voiceId,
      input: req.text,
      ...(req.instructions ? { instructions: req.instructions } : {}),
      response_format: 'mp3',
    }, { signal: req.signal });
    return Buffer.from(await res.arrayBuffer());
  }
}

export function getTTSProvider(
  target: TTSProviderTarget = { provider: config.ttsProvider, model: config.ttsModel },
  voiceLibraryFile?: string,
): TTSProvider {
  switch (target.provider) {
    case 'openai':
      return new OpenAITTSProvider(target);
    case 'openrouter':
      return new OpenRouterTTSProvider(target, voiceLibraryFile);
    case 'fish':
      throw new Error('Fish voice bindings are supported, but the Fish synthesis adapter is not implemented yet.');
    default:
      throw new Error(`Unknown TTS provider: ${target.provider}`);
  }
}
