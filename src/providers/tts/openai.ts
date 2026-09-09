import OpenAI from 'openai';
import { config } from '../../config.js';
import type { SynthesisRequest, TTSProvider, Voice } from './types.js';
import { OpenRouterTTSProvider } from './openrouter.js';
import { OPENAI_VOICES } from './voices.js';

export class OpenAITTSProvider implements TTSProvider {
  readonly id = 'openai';
  readonly maxChars = config.ttsMaxChars;
  private client = new OpenAI();

  listVoices(): Voice[] {
    return OPENAI_VOICES;
  }

  async synthesize(req: SynthesisRequest): Promise<Buffer> {
    const res = await this.client.audio.speech.create({
      model: config.ttsModel,
      voice: req.voiceId,
      input: req.text,
      ...(req.instructions ? { instructions: req.instructions } : {}),
      response_format: 'mp3',
    });
    return Buffer.from(await res.arrayBuffer());
  }
}

export function getTTSProvider(): TTSProvider {
  switch (config.ttsProvider) {
    case 'openai':
      return new OpenAITTSProvider();
    case 'openrouter':
      return new OpenRouterTTSProvider();
    default:
      throw new Error(`Unknown TTS provider: ${config.ttsProvider}`);
  }
}
