import { execFileSync } from 'node:child_process';

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

export function checkApiKey(): void {
  if (!process.env.OPENAI_API_KEY) {
    console.error(
      'Error: OPENAI_API_KEY environment variable is not set.\n' +
        'Get a key at https://platform.openai.com/api-keys and export it:\n' +
        '  export OPENAI_API_KEY=sk-...'
    );
    process.exit(1);
  }
}
