export interface Voice {
  id: string;
  /** Rough voice character, used for casting. */
  sex: 'male' | 'female' | 'neutral';
  description: string;
}

export interface SynthesisRequest {
  text: string;
  voiceId: string;
  /** Delivery/persona instructions, for providers that support them. */
  instructions?: string;
  /** Signal used by the local workspace to stop a running task. */
  signal?: AbortSignal;
}

/**
 * Abstraction over TTS services so OpenAI can later be swapped for
 * Azure/Google/ElevenLabs by adding a new implementation.
 */
export interface TTSProvider {
  readonly id: string;
  /** Max characters accepted per synthesize() call. */
  readonly maxChars: number;
  listVoices(): Voice[];
  /** Returns MP3 audio. */
  synthesize(req: SynthesisRequest): Promise<Buffer>;
}
