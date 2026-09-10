import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, withLlmRunConfig } from '../src/config.js';
import { loadPreferredModels } from '../src/ui/models.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function modelsFile(contents: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-preferred-models-'));
  temporaryDirectories.push(directory);
  const file = path.join(directory, 'models.json');
  fs.writeFileSync(file, contents);
  return file;
}

describe('preferred UI models', () => {
  it('reads editable provider, model, and starred entries', () => {
    const file = modelsFile(JSON.stringify({ models: [
      { provider: 'openrouter', model: 'anthropic/claude-sonnet-4', starred: true },
      { provider: 'openai', model: 'gpt-4.1-mini', starred: false },
    ] }));

    expect(loadPreferredModels(file)).toEqual([
      { provider: 'openrouter', model: 'anthropic/claude-sonnet-4', starred: true },
      { provider: 'openai', model: 'gpt-4.1-mini', starred: false },
    ]);
  });

  it('reports an invalid file instead of silently using malformed model settings', () => {
    const file = modelsFile(JSON.stringify({ models: [{ provider: 'other', model: '', starred: 'yes' }] }));
    expect(() => loadPreferredModels(file)).toThrow('Invalid preferred models file');
  });

  it('keeps a UI model choice scoped to its asynchronous pipeline run', async () => {
    vi.stubEnv('LISEN_LLM_PROVIDER', 'openai');
    vi.stubEnv('LISEN_ANALYSIS_MODEL', 'default-model');
    await withLlmRunConfig({ provider: 'openrouter', model: 'provider/selected-model' }, async () => {
      await Promise.resolve();
      expect(config.llmProvider).toBe('openrouter');
      expect(config.analysisModel).toBe('provider/selected-model');
      expect(config.chapterModel).toBe('provider/selected-model');
    });
    expect(config.llmProvider).toBe('openai');
    expect(config.analysisModel).toBe('default-model');
  });
});
