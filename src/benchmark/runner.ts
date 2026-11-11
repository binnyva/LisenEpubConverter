import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseEnv } from 'node:util';
import pLimit from 'p-limit';
import { benchmarkConfig } from '../config.js';
import type { StageUsage, TokenUsage } from '../util/usage.js';
import { findWorkDir } from './score.js';
import {
  buildPlan, configKey, fetchCatalogue, formatPlan, loadMatrix, runFolderName, tokenCost,
  type CatalogueModel, type Effort, type Matrix, type ObservedTokens, type Plan, type PlannedConfig, type Selection,
} from './matrix.js';
import { appVersion, defaultLabel, scriptTunables, type AppVersion } from './version.js';

/**
 * The Script benchmark's runner. Each configuration runs the real CLI in a
 * child process of its own (`run <source> script --work <run folder>`): the
 * pipeline reads its configuration from process.env, so configurations
 * sharing one process would leak into each other.
 */

export const RUNS_DIR = 'runs';
export const BASE_DIR = 'base';
export const RUN_RECORD = 'run.json';
export const LABEL_RECORD = 'label.json';
export const CONSOLE_LOG = 'console.log';
export const TRACE_FILE = 'trace.jsonl';
const BASE_RECORD = 'base.json';
const STAGED_SOURCE = 'source/the-last-question.md';

export type Outcome = 'completed' | 'blocked' | 'token-cap' | 'invalid-json' | 'timeout' | 'rejected' | 'failed';

/** What one model call cost, by the kind of Script request it was. */
export interface CallTypeUsage extends TokenUsage {
  /** Cost OpenRouter reported for these calls, when it reported one for each. */
  cost?: number;
}

export interface TraceSummary {
  byType: Record<string, CallTypeUsage>;
  /** Sum of OpenRouter's reported costs; undefined unless every answered call carried one. */
  reportedCost?: number;
  httpErrors: number;
  transportErrors: number;
}

/** run.json: everything about one run except its score, which is always recomputed. */
export interface RunRecord {
  label: string;
  model: string;
  effort: Effort;
  repeat: number;
  note?: string;
  version: AppVersion;
  tunables: Record<string, string | number>;
  startedAt: string;
  finishedAt: string;
  wallMs: number;
  exitCode: number;
  outcome: Outcome;
  reason?: string;
  usage: TokenUsage;
  retries: number;
  validationFailures: number;
  calls: TraceSummary;
  price?: CatalogueModel['price'];
  cost: { value?: number; basis: 'openrouter' | 'estimate' | 'unknown' };
  /** The work folder, relative to the run folder. */
  workDir: string;
}

export interface LabelRecord {
  label: string;
  createdAt: string;
  note?: string;
  version: AppVersion;
}

export interface BaseRecord {
  createdAt: string;
  baseStagesHash: string;
  metadata: Matrix['metadata'];
  /** The label whose base this one was copied from, when it was reused. */
  reusedFrom?: string;
  scriptMode?: string;
}

/** Spawn the CLI with the given arguments and environment, writing its output to logFile. Resolves to the exit code. */
export type RunChild = (args: string[], env: NodeJS.ProcessEnv, logFile: string) => Promise<number>;

export function cliChild(root: string, echo?: (line: string) => void): RunChild {
  return (args, env, logFile) => new Promise((resolve) => {
    const log = fs.createWriteStream(logFile, { flags: 'a' });
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'cli.ts'), ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const forward = (chunk: Buffer): void => {
      log.write(chunk);
      if (echo) for (const line of chunk.toString().split('\n').filter((l) => l.trim())) echo(line);
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', (err) => {
      log.write(`\nError: could not start the CLI: ${err.message}\n`);
      log.end(() => resolve(127));
    });
    child.on('close', (code) => log.end(() => resolve(code ?? 1)));
  });
}

/**
 * The environment of one Script run. Values set here win over .env, which the
 * CLI loads without overriding variables that are already set.
 */
export function scriptEnv(base: NodeJS.ProcessEnv, config: Pick<PlannedConfig, 'model' | 'effort' | 'maxCompletionTokens'>, runDir: string): NodeJS.ProcessEnv {
  return {
    ...base,
    LISEN_LLM_PROVIDER: 'openrouter',
    // Attribution and verification; the chapter model answers Script's edits-only requests.
    LISEN_SCRIPT_MODEL: config.model,
    LISEN_CHAPTER_MODEL: config.model,
    LISEN_ANALYSIS_MODEL: config.model,
    LISEN_SCRIPT_REASONING_EFFORT: config.effort,
    // Empty lifts any price cap in .env, which would make OpenRouter refuse the expensive models.
    LISEN_OPENROUTER_MAX_PRICE: '',
    LISEN_SCRIPT_MAX_COMPLETION_TOKENS: String(config.maxCompletionTokens),
    LISEN_LLM_RESPONSE_TIMEOUT_MS: String(benchmarkConfig.responseTimeoutMs),
    LISEN_OPENROUTER_TRACE_FILE: path.join(runDir, TRACE_FILE),
  };
}

function baseEnv(base: NodeJS.ProcessEnv, metadata: Matrix['metadata'], baseDir: string): NodeJS.ProcessEnv {
  return {
    ...base,
    LISEN_LLM_PROVIDER: 'openrouter',
    LISEN_ANALYSIS_MODEL: metadata.model,
    LISEN_CHAPTER_MODEL: metadata.model,
    LISEN_OPENROUTER_REASONING_EFFORT: metadata.effort,
    LISEN_OPENROUTER_MAX_PRICE: '',
    LISEN_LLM_RESPONSE_TIMEOUT_MS: String(benchmarkConfig.responseTimeoutMs),
    LISEN_OPENROUTER_TRACE_FILE: path.join(baseDir, TRACE_FILE),
  };
}

/** Why a run ended, from its exit code and console log. */
export function classifyOutcome(exitCode: number, log: string): { outcome: Outcome; reason?: string } {
  if (exitCode === 0) return { outcome: 'completed' };
  // The CLI prints "Error: <message>" last; a provider's message can run over several lines of JSON.
  const at = log.lastIndexOf('\nError: ');
  const tail = at >= 0 ? log.slice(at + '\nError: '.length) : log.startsWith('Error: ') ? log.slice('Error: '.length) : '';
  const reason = (tail.replace(/\s+/g, ' ').trim() || log.trim().split('\n').at(-1) || `exit code ${exitCode}`).slice(0, 600);
  if (/New or unresolved speakers/.test(log)) return { outcome: 'blocked', reason };
  if (/completion token limit/.test(log)) return { outcome: 'token-cap', reason };
  if (/invalid JSON after \d+ attempts/.test(log)) return { outcome: 'invalid-json', reason };
  if (/timed out after/.test(reason)) return { outcome: 'timeout', reason };
  if (/OpenRouter LLM request failed \(4\d\d\)/.test(log)) return { outcome: 'rejected', reason };
  return { outcome: 'failed', reason };
}

/** Retries after transport errors and replies rejected as invalid, counted from the warnings in a run's log. */
export function countRetries(log: string): { retries: number; validationFailures: number } {
  return {
    retries: (log.match(/LLM call failed \(/g) ?? []).length,
    validationFailures: (log.match(/LLM returned invalid JSON/g) ?? []).length,
  };
}

/** The kind of Script request, from the first words of its system prompt. */
export function callType(system: string): string {
  if (system.startsWith('You decide who speaks')) return 'attribution';
  if (system.startsWith('You independently verify')) return 'verification';
  if (system.startsWith('You prepare book text')) return 'edits';
  if (system.startsWith('You convert book text')) return 'segments';
  return 'other';
}

const emptyUsage = (): CallTypeUsage => ({ calls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0 });

/**
 * Spend by call type and OpenRouter's own cost, from the run's request trace.
 * usage.json cannot split spend this way; the trace can, because every
 * request carries its system prompt and every reply its usage.
 */
export function summarizeTrace(file: string): TraceSummary {
  const summary: TraceSummary = { byType: {}, httpErrors: 0, transportErrors: 0 };
  // Without a trace nothing is known: the cost is then estimated from usage.json.
  if (!fs.existsSync(file)) return summary;
  const types = new Map<string, string>();
  let costed = 0;
  let answered = 0;
  let cost = 0;
  const typeCosts = new Map<string, { costed: number; cost: number }>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const id = String(entry.requestId ?? '');
    if (entry.type === 'request') {
      const messages = (entry.body as { messages?: Array<{ role?: string; content?: string }> } | undefined)?.messages ?? [];
      types.set(id, callType(messages.find((message) => message.role === 'system')?.content ?? ''));
    } else if (entry.type === 'transport-error') {
      summary.transportErrors += 1;
    } else if (entry.type === 'response') {
      if (entry.status !== 200) summary.httpErrors += 1;
      let body: { usage?: Record<string, unknown> } = {};
      try {
        body = JSON.parse(String(entry.body ?? '{}')) as typeof body;
      } catch {
        continue;
      }
      const usage = body.usage;
      if (!usage) continue;
      const type = types.get(id) ?? 'other';
      const bucket = (summary.byType[type] ??= emptyUsage());
      const num = (value: unknown): number => (typeof value === 'number' ? value : 0);
      bucket.calls += 1;
      bucket.promptTokens += num(usage.prompt_tokens);
      bucket.completionTokens += num(usage.completion_tokens);
      bucket.reasoningTokens += num((usage.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens);
      answered += 1;
      const typeCost = typeCosts.get(type) ?? { costed: 0, cost: 0 };
      if (typeof usage.cost === 'number') {
        costed += 1;
        cost += usage.cost;
        typeCost.costed += 1;
        typeCost.cost += usage.cost;
      }
      typeCosts.set(type, typeCost);
    }
  }
  for (const [type, bucket] of Object.entries(summary.byType)) {
    const typeCost = typeCosts.get(type);
    if (typeCost && typeCost.costed === bucket.calls) bucket.cost = typeCost.cost;
  }
  // No answered call means nothing was billed, which is a known cost of zero.
  if (costed === answered) summary.reportedCost = cost;
  return summary;
}

function scriptUsage(workDir: string): TokenUsage {
  const total = emptyUsage();
  const file = path.join(workDir, 'usage.json');
  if (!fs.existsSync(file)) return total;
  try {
    for (const record of JSON.parse(fs.readFileSync(file, 'utf8')) as StageUsage[]) {
      if (record.stage !== 'script') continue;
      total.calls += record.llm.calls;
      total.promptTokens += record.llm.promptTokens;
      total.completionTokens += record.llm.completionTokens;
      total.reasoningTokens += record.llm.reasoningTokens;
    }
  } catch {
    // An unreadable usage log leaves the counts at zero; the trace still has them.
  }
  return total;
}

const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
};

export function readRunRecord(runDir: string): RunRecord | undefined {
  return readJson<RunRecord>(path.join(runDir, RUN_RECORD));
}

/** Every run folder of a label with its record, finished or not. */
export function labelRuns(labelDir: string): Array<{ dir: string; record?: RunRecord }> {
  if (!fs.existsSync(labelDir)) return [];
  return fs.readdirSync(labelDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== BASE_DIR)
    .map((entry) => ({ dir: path.join(labelDir, entry.name), record: readRunRecord(path.join(labelDir, entry.name)) }));
}

export function listLabels(benchDir: string): string[] {
  const runs = path.join(benchDir, RUNS_DIR);
  if (!fs.existsSync(runs)) return [];
  return fs.readdirSync(runs, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

/** Mean Script tokens of finished runs per model and effort, across labels, to estimate the next run. */
export function observedTokens(benchDir: string): ObservedTokens {
  const sums = new Map<string, { prompt: number; completion: number; n: number }>();
  for (const label of listLabels(benchDir)) {
    for (const { record } of labelRuns(path.join(benchDir, RUNS_DIR, label))) {
      if (!record || record.outcome !== 'completed') continue;
      const key = configKey(record.model, record.effort);
      const sum = sums.get(key) ?? { prompt: 0, completion: 0, n: 0 };
      sum.prompt += record.usage.promptTokens;
      sum.completion += record.usage.completionTokens;
      sum.n += 1;
      sums.set(key, sum);
    }
  }
  return new Map([...sums].map(([key, sum]) => [key, { prompt: sum.prompt / sum.n, completion: sum.completion / sum.n }]));
}

export interface BenchmarkOptions {
  /** Project root: where src/cli.ts and package.json are. */
  root: string;
  /** The benchmarks folder. */
  benchDir: string;
  label?: string;
  note?: string;
  selection?: Selection;
  /** Spend: without it the plan is printed and nothing runs. */
  yes?: boolean;
  /** Run configurations again that already have a finished run under this label. */
  redo?: boolean;
  concurrency?: number;
  /** Allow a label whose existing runs were made from different source. */
  allowVersionMismatch?: boolean;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  runChild?: RunChild;
  log?: (message: string) => void;
  now?: () => Date;
}

export interface BenchmarkResult {
  label: string;
  plan: Plan;
  /** Run folders started by this invocation. */
  started: string[];
  skipped: string[];
  records: RunRecord[];
  spent: boolean;
}

interface BaseStatus {
  state: 'ready' | 'reuse' | 'build';
  from?: string;
}

function baseStatus(benchDir: string, label: string, version: AppVersion, matrix: Matrix): BaseStatus {
  const matches = (record?: BaseRecord): boolean => Boolean(record && record.baseStagesHash === version.baseStagesHash
    && record.metadata.model === matrix.metadata.model && record.metadata.effort === matrix.metadata.effort);
  const own = path.join(benchDir, RUNS_DIR, label, BASE_DIR);
  const ownRecord = readJson<BaseRecord>(path.join(own, BASE_RECORD));
  if (ownRecord) return { state: 'ready' };
  for (const other of listLabels(benchDir).reverse()) {
    if (other === label) continue;
    if (matches(readJson<BaseRecord>(path.join(benchDir, RUNS_DIR, other, BASE_DIR, BASE_RECORD)))) return { state: 'reuse', from: other };
  }
  return { state: 'build' };
}

/** Print the plan, and with `yes`, run it. */
export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkResult> {
  const log = options.log ?? ((message: string) => console.log(message));
  const now = options.now ?? (() => new Date());
  const env = options.env ?? process.env;
  const version = appVersion(options.root);
  const label = options.label ?? defaultLabel(version, now());
  if (!/^[\w.-]+$/.test(label)) throw new Error(`Label "${label}" can only contain letters, digits, ".", "_" and "-".`);
  const matrix = loadMatrix(path.join(options.benchDir, 'models.json'));
  const catalogue = await fetchCatalogue(options.fetchImpl);
  const plan = buildPlan(matrix, catalogue, options.selection, observedTokens(options.benchDir));
  const labelDir = path.join(options.benchDir, RUNS_DIR, label);

  // One label is one pipeline.
  const labelRecord = readJson<LabelRecord>(path.join(labelDir, LABEL_RECORD));
  const mismatch = labelRecord && labelRecord.version.sourceHash !== version.sourceHash;
  if (mismatch && !options.allowVersionMismatch) {
    throw new Error(`Label "${label}" holds runs of a different pipeline (source hash ${labelRecord.version.sourceHash}, now ${version.sourceHash}). Choose a new --label, or pass --allow-version-mismatch to add these runs to it anyway.`);
  }

  // Which runs are needed.
  const wanted: Array<{ config: PlannedConfig; repeat: number; dir: string }> = [];
  const skipped: string[] = [];
  for (const config of plan.configs) {
    for (let repeat = 1; repeat <= config.repeats; repeat += 1) {
      const dir = path.join(labelDir, runFolderName(config.model, config.effort, repeat));
      if (!options.redo && readRunRecord(dir)) skipped.push(dir);
      else wanted.push({ config, repeat, dir });
    }
  }
  const pending: Plan = { ...plan, configs: plan.configs.map((config) => ({ ...config, repeats: wanted.filter((w) => w.config === config).length })).filter((config) => config.repeats > 0) };

  const base = baseStatus(options.benchDir, label, version, matrix);
  const metadataModel = catalogue.get(matrix.metadata.model);
  const baseCost = base.state === 'build'
    ? { note: `Extract and one Metadata call on ${matrix.metadata.model} (${matrix.metadata.effort}) build this label's shared base`, cost: tokenCost({ prompt: 5000, completion: matrix.metadata.effort === 'none' ? 1000 : 4000 }, metadataModel?.price) }
    : { note: base.state === 'reuse' ? `reused from label "${base.from}" (Extract and Metadata sources unchanged); no cost` : 'already built; no cost' };

  log(`Label: ${label}${labelRecord ? '' : ' (new)'}  ·  commit ${version.commit?.slice(0, 7) ?? '?'}${version.dirty ? ' + uncommitted changes' : ''}  ·  source ${version.sourceHash}`);
  log('');
  log(formatPlan(pending, wanted.length ? baseCost : undefined));
  if (skipped.length) log(`${skipped.length} run(s) already finished under this label are skipped (--redo runs them again).`);

  const result: BenchmarkResult = { label, plan, started: [], skipped, records: [], spent: false };
  if (!wanted.length) {
    log('Nothing to run.');
    return result;
  }
  if (!options.yes) {
    log('\nPlan only: nothing was run and nothing was spent. Add --yes to run it.');
    return result;
  }
  if (plan.unknownModels.length) throw new Error(`OpenRouter does not list ${plan.unknownModels.join(', ')}. Fix the ids in benchmarks/models.json or leave them out with --models.`);
  if (base.state === 'build' && !metadataModel) throw new Error(`OpenRouter does not list the Metadata model ${matrix.metadata.model}. Fix "metadata" in benchmarks/models.json.`);

  fs.mkdirSync(labelDir, { recursive: true });
  if (!labelRecord) {
    fs.writeFileSync(path.join(labelDir, LABEL_RECORD), JSON.stringify({ label, createdAt: now().toISOString(), note: options.note, version } satisfies LabelRecord, null, 2));
  }
  const runChild = options.runChild ?? cliChild(options.root);
  result.spent = true;
  const baseDir = await ensureBase({ benchDir: options.benchDir, labelDir, label, matrix, version, status: base, env, runChild, log, now });
  const source = path.join(baseDir, STAGED_SOURCE);
  const baseWork = findWorkDir(path.join(baseDir, 'work'));
  if (!baseWork) throw new Error(`The base in ${baseDir} has no work folder. Remove ${baseDir} and run again to rebuild it.`);

  const limit = pLimit(options.concurrency ?? benchmarkConfig.concurrency);
  log(`\nRunning ${wanted.length} run(s), ${options.concurrency ?? benchmarkConfig.concurrency} at a time.`);
  await Promise.all(wanted.map((item) => limit(async () => {
    const name = path.basename(item.dir);
    fs.rmSync(item.dir, { recursive: true, force: true });
    fs.mkdirSync(item.dir, { recursive: true });
    const workDir = path.join(item.dir, path.basename(baseWork));
    fs.cpSync(baseWork, workDir, { recursive: true, filter: (from) => path.basename(from) !== 'usage.json' });
    const childEnv = scriptEnv(env, item.config, item.dir);
    const startedAt = now();
    const started = Date.now();
    result.started.push(item.dir);
    log(`  ${name}: started`);
    const exitCode = await runChild(['run', source, 'script', '--work', item.dir], childEnv, path.join(item.dir, CONSOLE_LOG));
    const wallMs = Date.now() - started;
    const consoleLog = fs.existsSync(path.join(item.dir, CONSOLE_LOG)) ? fs.readFileSync(path.join(item.dir, CONSOLE_LOG), 'utf8') : '';
    const usage = scriptUsage(workDir);
    const calls = summarizeTrace(path.join(item.dir, TRACE_FILE));
    const estimated = tokenCost({ prompt: usage.promptTokens, completion: usage.completionTokens }, item.config.price);
    const record: RunRecord = {
      label,
      model: item.config.model,
      effort: item.config.effort,
      repeat: item.repeat,
      note: options.note,
      version,
      tunables: scriptTunables({ ...readEnvFile(options.root), ...childEnv }),
      startedAt: startedAt.toISOString(),
      finishedAt: now().toISOString(),
      wallMs,
      exitCode,
      ...classifyOutcome(exitCode, consoleLog),
      usage,
      ...countRetries(consoleLog),
      calls,
      price: item.config.price,
      cost: calls.reportedCost !== undefined ? { value: calls.reportedCost, basis: 'openrouter' }
        : estimated !== undefined ? { value: estimated, basis: 'estimate' } : { basis: 'unknown' },
      workDir: path.basename(workDir),
    };
    fs.writeFileSync(path.join(item.dir, RUN_RECORD), JSON.stringify(record, null, 2));
    result.records.push(record);
    log(`  ${name}: ${record.outcome}${record.reason ? ` (${record.reason.slice(0, 160)})` : ''} · ${usage.calls} calls · ${Math.round(wallMs / 1000)}s · ${record.cost.value === undefined ? 'cost unknown' : `$${record.cost.value.toFixed(4)}${record.cost.basis === 'estimate' ? ' (estimate)' : ''}`}`);
  })));
  return result;
}

/** The project's .env as the child will see it, for recording effective tunables. Values are never printed. */
function readEnvFile(root: string): Record<string, string> {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return {};
  try {
    return parseEnv(fs.readFileSync(file, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

async function ensureBase(args: {
  benchDir: string; labelDir: string; label: string; matrix: Matrix; version: AppVersion; status: BaseStatus;
  env: NodeJS.ProcessEnv; runChild: RunChild; log: (message: string) => void; now: () => Date;
}): Promise<string> {
  const baseDir = path.join(args.labelDir, BASE_DIR);
  if (args.status.state === 'ready') return baseDir;
  fs.rmSync(baseDir, { recursive: true, force: true });
  if (args.status.state === 'reuse') {
    const from = path.join(args.benchDir, RUNS_DIR, args.status.from!, BASE_DIR);
    fs.cpSync(from, baseDir, { recursive: true });
    const record = readJson<BaseRecord>(path.join(baseDir, BASE_RECORD))!;
    fs.writeFileSync(path.join(baseDir, BASE_RECORD), JSON.stringify({ ...record, reusedFrom: args.status.from } satisfies BaseRecord, null, 2));
    args.log(`Base reused from label "${args.status.from}".`);
    return baseDir;
  }

  args.log('Building the base: Extract (offline) and one Metadata call.');
  fs.mkdirSync(path.join(baseDir, 'source'), { recursive: true });
  const clean = fs.readFileSync(path.join(args.benchDir, args.matrix.source), 'utf8');
  // Front matter names the chapter, which would otherwise be titled after the file ("00"); the reader strips it.
  fs.writeFileSync(path.join(baseDir, STAGED_SOURCE), `---\ntitle: ${args.matrix.title}\nauthor: ${args.matrix.author}\n---\n${clean}`);
  const source = path.join(baseDir, STAGED_SOURCE);
  const work = path.join(baseDir, 'work');
  const env = baseEnv(args.env, args.matrix.metadata, baseDir);
  for (const stage of ['extract', 'metadata']) {
    const code = await args.runChild(['run', source, stage, '--work', work], env, path.join(baseDir, CONSOLE_LOG));
    if (code !== 0) throw new Error(`Building the base failed at ${stage}; see ${path.join(baseDir, CONSOLE_LOG)}. Fix the cause and run again; the base is rebuilt.`);
  }
  const workDir = findWorkDir(work);
  const metadata = workDir ? readJson<{ chapters?: Array<{ file: string }>; profile?: { isFiction?: boolean; dialogueStyle?: string } }>(path.join(workDir, 'metadata.json')) : undefined;
  const mode = !metadata?.profile ? undefined : !metadata.profile.isFiction ? 'narration' : metadata.profile.dialogueStyle;
  if (workDir && metadata?.chapters?.[0]) {
    const chapter = fs.readFileSync(path.join(workDir, metadata.chapters[0].file), 'utf8');
    if (chapter.trim() !== clean.trim()) throw new Error(`The base chapter text differs from ${args.matrix.source}. Remove ${baseDir} and check the source before running.`);
  }
  if (mode !== 'quoted') {
    throw new Error(`Metadata chose "${mode ?? 'no'}" script mode for the base; the benchmark needs "quoted" so every configuration gets the same task. See ${workDir}/metadata.json, then remove ${baseDir} and run again.`);
  }
  fs.writeFileSync(path.join(baseDir, BASE_RECORD), JSON.stringify({
    createdAt: args.now().toISOString(), baseStagesHash: args.version.baseStagesHash, metadata: args.matrix.metadata, scriptMode: mode,
  } satisfies BaseRecord, null, 2));
  return baseDir;
}
