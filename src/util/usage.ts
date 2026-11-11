import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import type { Stage } from '../config.js';
import { USAGE_FILE } from '../layout.js';

/** Model spend of one or more requests. Reasoning tokens are part of the completion tokens. */
export interface TokenUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
}

/** What one execution of one stage cost, as saved in the work folder's usage.json. */
export interface StageUsage {
  /** Shared by the stages of one `convert` or one workspace job. */
  runId: string;
  stage: Stage;
  startedAt: string;
  wallMs: number;
  outcome: 'completed' | 'failed' | 'cancelled';
  /** Chapters the run was limited to, when it was. */
  chapters?: number[];
  llm: TokenUsage;
  /** The same spend split by the model that answered. */
  models: Record<string, TokenUsage>;
  tts: { calls: number; characters: number };
}

const emptyTokens = (): TokenUsage => ({ calls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0 });

function addTokens(total: TokenUsage, more: Partial<TokenUsage>): void {
  total.calls += more.calls ?? 0;
  total.promptTokens += more.promptTokens ?? 0;
  total.completionTokens += more.completionTokens ?? 0;
  total.reasoningTokens += more.reasoningTokens ?? 0;
}

interface Collector {
  llm: TokenUsage;
  models: Record<string, TokenUsage>;
  tts: { calls: number; characters: number };
}

const collectors = new AsyncLocalStorage<Collector>();

/** Run stage work with a collector that every model request inside it reports to. */
export function collectUsage<T>(run: (collected: () => Pick<StageUsage, 'llm' | 'models' | 'tts'>) => Promise<T>): Promise<T> {
  const collector: Collector = { llm: emptyTokens(), models: {}, tts: { calls: 0, characters: 0 } };
  return collectors.run(collector, () => run(() => structuredClone(collector)));
}

/**
 * Count one model response, including one that is later rejected as invalid:
 * it was paid for either way. Providers that report no usage count as a call
 * with no tokens.
 */
export function recordLlmUsage(model: string, tokens: { promptTokens?: number; completionTokens?: number; reasoningTokens?: number }): void {
  const collector = collectors.getStore();
  if (!collector) return;
  const usage = { calls: 1, ...tokens };
  addTokens(collector.llm, usage);
  addTokens((collector.models[model] ??= emptyTokens()), usage);
}

/** Count one speech request by the characters it was asked to speak. */
export function recordTtsUsage(characters: number): void {
  const collector = collectors.getStore();
  if (!collector) return;
  collector.tts.calls += 1;
  collector.tts.characters += characters;
}

const number = (value: number): string => value.toLocaleString('en-US');

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** One line a person can compare across books and stages. */
export function usageSummary(usage: Pick<StageUsage, 'llm' | 'tts' | 'wallMs'>): string {
  const parts: string[] = [];
  if (usage.llm.calls) {
    parts.push(`${number(usage.llm.calls)} LLM call${usage.llm.calls === 1 ? '' : 's'}`);
    parts.push(`${number(usage.llm.promptTokens)} prompt + ${number(usage.llm.completionTokens)} completion tokens${usage.llm.reasoningTokens ? ` (${number(usage.llm.reasoningTokens)} reasoning)` : ''}`);
  }
  if (usage.tts.calls) parts.push(`${number(usage.tts.calls)} TTS request${usage.tts.calls === 1 ? '' : 's'} (${number(usage.tts.characters)} characters)`);
  if (!parts.length) parts.push('no model calls');
  parts.push(formatDuration(usage.wallMs));
  return parts.join(' · ');
}

/** Add several stage records together, for a whole run or a stage's history. */
export function totalUsage(records: StageUsage[]): Pick<StageUsage, 'llm' | 'tts' | 'wallMs'> {
  const total = { llm: emptyTokens(), tts: { calls: 0, characters: 0 }, wallMs: 0 };
  for (const record of records) {
    addTokens(total.llm, record.llm);
    total.tts.calls += record.tts.calls;
    total.tts.characters += record.tts.characters;
    total.wallMs += record.wallMs;
  }
  return total;
}

export function readUsage(root: string): StageUsage[] {
  const file = path.join(root, USAGE_FILE);
  if (!fs.existsSync(file)) return [];
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return Array.isArray(saved) ? saved as StageUsage[] : [];
  } catch {
    // A damaged log must never stop a stage; it starts again.
    return [];
  }
}

/** Append one stage's record to the work folder's log. It survives every rebuild. */
export function saveUsage(root: string, record: StageUsage): void {
  fs.writeFileSync(path.join(root, USAGE_FILE), JSON.stringify([...readUsage(root), record], null, 2));
}
