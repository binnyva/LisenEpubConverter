import OpenAI from 'openai';
import { config } from '../../config.js';
import type { SynthesisRequest, TTSProvider, Voice } from './types.js';

const VOICES: Voice[] = [
  { id: 'alloy', sex: 'neutral', description: 'clear, balanced, androgynous' },
  { id: 'ash', sex: 'male', description: 'warm adult male' },
  { id: 'ballad', sex: 'male', description: 'expressive younger male, British lean' },
  { id: 'coral', sex: 'female', description: 'bright, friendly adult female' },
  { id: 'echo', sex: 'male', description: 'steady, articulate male' },
  { id: 'fable', sex: 'neutral', description: 'animated storyteller, British accent' },
  { id: 'onyx', sex: 'male', description: 'deep, authoritative male' },
  { id: 'nova', sex: 'female', description: 'energetic younger female' },
  { id: 'sage', sex: 'female', description: 'calm, mature female' },
  { id: 'shimmer', sex: 'female', description: 'soft, gentle female' },
  { id: 'verse', sex: 'male', description: 'versatile expressive male' },
];

export class OpenAITTSProvider implements TTSProvider {
  readonly id = 'openai';
  readonly maxChars = config.ttsMaxChars;
  private client = new OpenAI();

  listVoices(): Voice[] {
    return VOICES;
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
    default:
      throw new Error(`Unknown TTS provider: ${config.ttsProvider}`);
  }
}
