import fs from 'node:fs';
import { z } from 'zod';
import { benchmarkConfig } from '../config.js';

const EFFORTS = ['none', 'default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

const TokensSchema = z.object({ prompt: z.number().nonnegative(), completion: z.number().nonnegative() });

/** benchmarks/models.json: what to run, and the shared settings of every run. */
export const MatrixSchema = z.object({
  /** The benchmark's source text, relative to the benchmarks folder. */
  source: z.string(),
  /** Front matter given to the staged copy of the source, so the chapter is titled properly in prompts. */
  title: z.string(),
  author: z.string(),
  /** The one Metadata call that builds a label's shared base. */
  metadata: z.object({ model: z.string(), effort: z.enum(EFFORTS) }),
  /** Rough Script tokens per run by effort, used only until a configuration has a run of its own. */
  estimates: z.record(z.string(), TokensSchema),
  groups: z.array(z.object({
    name: z.string(),
    efforts: z.array(z.enum(EFFORTS)).min(1),
    models: z.array(z.object({
      id: z.string(),
      /** Efforts for this model instead of the group's. */
      efforts: z.array(z.enum(EFFORTS)).optional(),
      /** Extra efforts on top of the group's. */
      extraEfforts: z.array(z.enum(EFFORTS)).optional(),
      /** US dollars per million tokens when the matrix was written; the live price is used for estimates. */
      listedPrice: TokensSchema.optional(),
      note: z.string().optional(),
    })),
  })),
});
export type Matrix = z.infer<typeof MatrixSchema>;

export function loadMatrix(file: string): Matrix {
  const parsed = MatrixSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!parsed.success) throw new Error(`${file} is not a valid benchmark matrix: ${parsed.error.message}`);
  return parsed.data;
}

/** One model as OpenRouter lists it. Prices are US dollars per million tokens. */
export interface CatalogueModel {
  id: string;
  price: { prompt: number; completion: number };
  supportsReasoning: boolean;
  maxCompletionTokens?: number;
}

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

/** OpenRouter's public model list. It needs no key; nothing about the user is sent. */
export async function fetchCatalogue(fetchImpl: typeof fetch = fetch): Promise<Map<string, CatalogueModel>> {
  const res = await fetchImpl(OPENROUTER_MODELS_URL);
  if (!res.ok) throw new Error(`Could not read OpenRouter's model list (${res.status} ${res.statusText}). Check the network and try again.`);
  const body = await res.json() as { data?: Array<Record<string, unknown>> };
  const models = new Map<string, CatalogueModel>();
  for (const entry of body.data ?? []) {
    if (typeof entry.id !== 'string') continue;
    const pricing = (entry.pricing ?? {}) as Record<string, unknown>;
    const perMillion = (value: unknown): number => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed * 1_000_000 : 0;
    };
    const top = (entry.top_provider ?? {}) as Record<string, unknown>;
    const params = Array.isArray(entry.supported_parameters) ? entry.supported_parameters as unknown[] : [];
    models.set(entry.id, {
      id: entry.id,
      price: { prompt: perMillion(pricing.prompt), completion: perMillion(pricing.completion) },
      supportsReasoning: params.includes('reasoning'),
      maxCompletionTokens: typeof top.max_completion_tokens === 'number' ? top.max_completion_tokens : undefined,
    });
  }
  return models;
}

/** One model and effort to run, `repeats` times. */
export interface PlannedConfig {
  model: string;
  effort: Effort;
  group: string;
  repeats: number;
  price?: CatalogueModel['price'];
  listedPrice?: { prompt: number; completion: number };
  maxCompletionTokens: number;
  /** Estimated Script tokens and cost of one run. */
  estimate: { prompt: number; completion: number; cost?: number; basis: 'previous runs' | 'effort estimate' };
}

export interface Plan {
  configs: PlannedConfig[];
  /** Selected models OpenRouter does not list; a paid run refuses to start while there are any. */
  unknownModels: string[];
  /** Efforts dropped because the model does not accept a reasoning setting. */
  dropped: Array<{ model: string; effort: Effort; reason: string }>;
}

export interface Selection {
  models?: string[];
  efforts?: string[];
  groups?: string[];
  repeats?: number;
}

/**
 * A model is selected by its full id or by a part of it ("haiku", "deepseek/").
 * A pattern that is some model's full id selects only that model, so
 * "z-ai/glm-5.3" does not also pick "z-ai/glm-5.3-flash".
 */
function selected(id: string, patterns: string[] | undefined, allIds: string[]): boolean {
  return !patterns?.length || patterns.some((pattern) => id === pattern || (!allIds.includes(pattern) && id.includes(pattern)));
}

/** Observed mean Script tokens per configuration, from finished runs. */
export type ObservedTokens = Map<string, { prompt: number; completion: number }>;
export const configKey = (model: string, effort: string): string => `${model}\u0000${effort}`;

export function buildPlan(matrix: Matrix, catalogue: Map<string, CatalogueModel>, selection: Selection = {}, observed: ObservedTokens = new Map()): Plan {
  const plan: Plan = { configs: [], unknownModels: [], dropped: [] };
  const repeats = selection.repeats ?? benchmarkConfig.repeats;
  const allIds = matrix.groups.flatMap((group) => group.models.map((model) => model.id));
  for (const group of matrix.groups) {
    if (selection.groups?.length && !selection.groups.includes(group.name)) continue;
    for (const model of group.models) {
      if (!selected(model.id, selection.models, allIds)) continue;
      const listed = catalogue.get(model.id);
      if (!listed) {
        plan.unknownModels.push(model.id);
        continue;
      }
      const efforts = [...new Set([...(model.efforts ?? group.efforts), ...(model.extraEfforts ?? [])])]
        .filter((effort) => !selection.efforts?.length || selection.efforts.includes(effort));
      const kept = new Set<Effort>();
      for (const effort of efforts) {
        if (!listed.supportsReasoning && effort !== 'default') {
          plan.dropped.push({ model: model.id, effort, reason: 'OpenRouter does not list "reasoning" for this model; only "default" is run' });
          // A model that takes no reasoning setting is still run once, as the provider's default.
          if (!selection.efforts?.length || selection.efforts.includes('default')) kept.add('default');
          continue;
        }
        kept.add(effort);
      }
      for (const effort of kept) {
        const cap = effort === 'none' ? benchmarkConfig.maxCompletionTokens : benchmarkConfig.reasoningMaxCompletionTokens;
        const seen = observed.get(configKey(model.id, effort));
        const tokens = seen ?? matrix.estimates[effort] ?? matrix.estimates.default ?? { prompt: 0, completion: 0 };
        plan.configs.push({
          model: model.id,
          effort,
          group: group.name,
          repeats,
          price: listed.price,
          listedPrice: model.listedPrice,
          maxCompletionTokens: listed.maxCompletionTokens ? Math.min(cap, listed.maxCompletionTokens) : cap,
          estimate: { ...tokens, cost: tokenCost(tokens, listed.price), basis: seen ? 'previous runs' : 'effort estimate' },
        });
      }
    }
  }
  return plan;
}

/** Cost in US dollars of the given tokens at per-million prices. Reasoning tokens are part of completion tokens. */
export function tokenCost(tokens: { prompt: number; completion: number }, price?: { prompt: number; completion: number }): number | undefined {
  if (!price) return undefined;
  return (tokens.prompt * price.prompt + tokens.completion * price.completion) / 1_000_000;
}

/** The folder name of one run: `<model-slug>--<effort>`, with `--r<N>` for a repeat after the first. */
export function runFolderName(model: string, effort: string, repeat: number): string {
  const slug = model.replace(/[/:]+/g, '_');
  return `${slug}--${effort}${repeat > 1 ? `--r${repeat}` : ''}`;
}

const dollars = (value?: number): string => (value === undefined ? '?' : value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`);

/** The plan as a table a person reads before agreeing to spend. */
export function formatPlan(plan: Plan, baseCost?: { note: string; cost?: number }): string {
  const rows = plan.configs.map((c) => {
    // Listed prices are rounded; only a real change is worth pointing out.
    const changed = (listed: number, live: number): boolean => Math.abs(listed - live) > 0.05 * Math.max(listed, live);
    const priceNote = c.listedPrice && c.price && (changed(c.listedPrice.prompt, c.price.prompt) || changed(c.listedPrice.completion, c.price.completion))
      ? ` (listed ${c.listedPrice.prompt}/${c.listedPrice.completion})` : '';
    return [
      c.model, c.effort, String(c.repeats),
      c.price ? `${+c.price.prompt.toFixed(4)}/${+c.price.completion.toFixed(4)}${priceNote}` : '?',
      `${Math.round(c.estimate.prompt / 1000)}k/${Math.round(c.estimate.completion / 1000)}k${c.estimate.basis === 'previous runs' ? '*' : ''}`,
      dollars(c.estimate.cost),
      dollars(c.estimate.cost === undefined ? undefined : c.estimate.cost * c.repeats),
    ];
  });
  const header = ['model', 'effort', 'runs', '$/M in/out', 'est. tokens in/out', 'est. per run', 'est. total'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells: string[]): string => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ');
  const total = plan.configs.reduce((sum, c) => sum + (c.estimate.cost ?? 0) * c.repeats, 0) + (baseCost?.cost ?? 0);
  const runs = plan.configs.reduce((sum, c) => sum + c.repeats, 0);
  const out = [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line), ''];
  if (baseCost) out.push(`Base: ${baseCost.note}${baseCost.cost !== undefined ? ` (~${dollars(baseCost.cost)})` : ''}`);
  out.push(`${runs} run(s) of ${plan.configs.length} configuration(s); estimated total ${dollars(total)}.`);
  out.push('Estimates are rough: models differ widely in how much they reason. * = mean of earlier runs of the same configuration.');
  for (const drop of plan.dropped) out.push(`Skipped ${drop.model} --${drop.effort}: ${drop.reason}.`);
  if (plan.unknownModels.length) out.push(`Not on OpenRouter (check the id in benchmarks/models.json): ${plan.unknownModels.join(', ')}.`);
  return out.join('\n');
}
