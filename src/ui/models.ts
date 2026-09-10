import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config, type ProviderId } from '../config.js';

const PreferredModelsSchema = z.object({
  models: z.array(z.object({
    provider: z.enum(['openai', 'openrouter']),
    model: z.string().trim().min(1),
    starred: z.boolean().default(false),
  })).default([]),
});

export type PreferredModel = z.infer<typeof PreferredModelsSchema>['models'][number];

export const preferredModelsFile = path.resolve(process.env.LISEN_PREFERRED_MODELS_FILE ?? './library/preferred-models.json');

/** Read on every request so edits to the JSON file are visible without restarting the UI. */
export function loadPreferredModels(file = preferredModelsFile): PreferredModel[] {
  if (!fs.existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read preferred models at ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = PreferredModelsSchema.safeParse(parsed);
  if (!result.success) throw new Error(`Invalid preferred models file at ${file}: ${result.error.issues[0]?.message ?? 'invalid JSON structure'}`);
  return result.data.models;
}

export function defaultLlmSettings(): { provider: ProviderId; model: string } {
  return { provider: config.llmProvider, model: config.analysisModel };
}
