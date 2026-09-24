import { execFileSync } from 'node:child_process';
import { config, type ProviderId } from './config.js';

export function checkFfmpeg(): void {
  for (const bin of ['ffmpeg', 'ffprobe']) {
    try {
      execFileSync(bin, ['-version'], { stdio: 'ignore' });
    } catch {
      console.error(
        `Error: ${bin} is not installed or not on PATH.\n` +
          `Install it with: brew install ffmpeg (macOS) or apt install ffmpeg (Linux).`
      );
      process.exit(1);
    }
  }
}

export function checkApiKeys(required: ProviderId[] = [config.llmProvider, config.ttsProvider]): void {
  const providers = new Set<ProviderId>(required);
  const missing = [...providers].filter((provider) => {
    const key = provider === 'openai' ? 'OPENAI_API_KEY' : 'OPENROUTER_API_KEY';
    return !process.env[key];
  });

  if (missing.length === 0) return;

  const instructions = missing
    .map((provider) =>
      provider === 'openai'
        ? 'OPENAI_API_KEY is not set. Get a key at https://platform.openai.com/api-keys and export it:\n  export OPENAI_API_KEY=sk-...'
        : 'OPENROUTER_API_KEY is not set. Get a key at https://openrouter.ai/keys and export it:\n  export OPENROUTER_API_KEY=sk-or-...'
    )
    .join('\n\n');
  console.error(`Error: ${instructions}`);
  process.exit(1);
}
