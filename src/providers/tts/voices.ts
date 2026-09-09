import fs from 'node:fs';
import type { Voice } from './types.js';

export const OPENAI_VOICES: Voice[] = [
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

export function parseVoiceCatalog(raw: string, source: string): Voice[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`TTS voice catalogue ${source} is not valid JSON.`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`TTS voice catalogue ${source} must be a non-empty JSON array.`);
  }

  const voices = parsed.map((voice, index) => {
    if (
      !voice ||
      typeof voice !== 'object' ||
      typeof (voice as Voice).id !== 'string' ||
      !['male', 'female', 'neutral'].includes((voice as Voice).sex) ||
      typeof (voice as Voice).description !== 'string'
    ) {
      throw new Error(
        `TTS voice catalogue ${source} entry ${index + 1} must contain string id, sex (male, female, or neutral), and string description.`
      );
    }
    return voice as Voice;
  });
  if (new Set(voices.map((voice) => voice.id)).size !== voices.length) {
    throw new Error(`TTS voice catalogue ${source} contains duplicate voice ids.`);
  }
  return voices;
}

export function loadVoiceCatalog(file: string): Voice[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Could not read TTS voice catalogue ${file}: ${(err as Error).message}`);
  }
  return parseVoiceCatalog(raw, file);
}
