import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from '../config.js';

/**
 * Which version of the app produced a benchmark run. The commit alone is not
 * enough: uncommitted work is benchmarked too, so the pipeline's source is
 * hashed by content.
 */
export interface AppVersion {
  commit?: string;
  branch?: string;
  /** Uncommitted changes outside benchmarks/ when the run started. */
  dirty?: boolean;
  packageVersion?: string;
  /** Content hash of src/, without the benchmark tool itself. */
  sourceHash: string;
  /** Content hash of the files Extract and Metadata depend on; decides whether a label's base can be reused. */
  baseStagesHash: string;
}

/** The benchmark tool is not the pipeline: changing it must not look like a new app version. */
const EXCLUDED = ['benchmark/'];

/**
 * Files that decide what Extract and Metadata produce. Kept broad on purpose:
 * a needless rebuild costs one Metadata call, a wrong reuse a whole matrix.
 */
const BASE_STAGE_PATHS = [
  'source/', 'epub/', 'pipeline/extract.ts', 'pipeline/metadata.ts', 'pipeline/stories.ts', 'pipeline/runner.ts',
  'providers/llm/', 'util/text.ts', 'config.ts', 'types.ts', 'layout.ts', 'state.ts', 'cli.ts',
];

function listFiles(dir: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full, base);
    return entry.isFile() ? [path.relative(base, full).split(path.sep).join('/')] : [];
  }).sort();
}

/** Hash file names and contents under `srcDir`, keeping the files `include` accepts. */
export function hashSources(srcDir: string, include: (file: string) => boolean): string {
  const hash = crypto.createHash('sha256');
  for (const file of listFiles(srcDir).filter(include)) {
    hash.update(file).update('\0').update(fs.readFileSync(path.join(srcDir, file))).update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

const inPipeline = (file: string): boolean => !EXCLUDED.some((prefix) => file.startsWith(prefix));
const inBaseStages = (file: string): boolean => BASE_STAGE_PATHS.some((prefix) => (prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix));

function git(root: string, args: string[]): string | undefined {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function appVersion(root: string): AppVersion {
  const srcDir = path.join(root, 'src');
  const status = git(root, ['status', '--porcelain']);
  let packageVersion: string | undefined;
  try {
    packageVersion = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string }).version;
  } catch {
    packageVersion = undefined;
  }
  return {
    commit: git(root, ['rev-parse', 'HEAD']),
    branch: git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty: status === undefined ? undefined : status.split('\n').filter(Boolean).some((line) => !line.slice(3).startsWith('benchmarks/')),
    packageVersion,
    sourceHash: hashSources(srcDir, inPipeline),
    baseStagesHash: hashSources(srcDir, inBaseStages),
  };
}

/** The label used when none is given: the date and short commit, marked when the tree has changes. */
export function defaultLabel(version: AppVersion, now = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  return `${date}-${version.commit?.slice(0, 7) ?? 'nogit'}${version.dirty ? '-dirty' : ''}`;
}

/** The tunables that shape Script, as a run's child process will see them. */
export function scriptTunables(env: Record<string, string | undefined>): Record<string, string | number> {
  return {
    scriptChunkChars: config.scriptChunkChars,
    scriptUnquotedChunkChars: config.scriptUnquotedChunkChars,
    scriptMaxQuotesPerChunk: config.scriptMaxQuotesPerChunk,
    scriptVerificationBatchSize: config.scriptVerificationBatchSize,
    narrationMergeChars: config.narrationMergeChars,
    llmConcurrency: config.llmConcurrency,
    scriptMaxCompletionTokens: env.LISEN_SCRIPT_MAX_COMPLETION_TOKENS ?? 'default',
    llmResponseTimeoutMs: env.LISEN_LLM_RESPONSE_TIMEOUT_MS ?? 120_000,
    llmMaxRetries: env.LISEN_LLM_MAX_RETRIES ?? 5,
  };
}
