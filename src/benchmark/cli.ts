#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { benchmarkConfig } from '../config.js';
import { formatScore, loadTarget, scoreFolder } from './score.js';
import { buildReport, writeReport } from './report.js';
import { cliChild, runBenchmark } from './runner.js';

/** The project root: two levels above this file, in src/ and in dist/ alike. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const list = (value?: string): string[] | undefined => value?.split(',').map((item) => item.trim()).filter(Boolean);

const program = new Command();
program
  .name('bench')
  .description('Benchmark the Script stage across OpenRouter models and reasoning efforts')
  .option('--dir <folder>', 'benchmarks folder', path.join(root, 'benchmarks'));

function matrixOptions(command: Command): Command {
  return command
    .option('--label <label>', 'app-version label the runs go under (default: date and short commit)')
    .option('--models <ids>', 'comma-separated model ids, or parts of ids ("haiku,deepseek/")')
    .option('--efforts <efforts>', 'comma-separated efforts (none, default, minimal, low, medium, high)')
    .option('--groups <names>', 'comma-separated groups from models.json (frontier, mid-range, cheap)')
    .option('--repeat <n>', 'runs of each configuration', String(benchmarkConfig.repeats));
}

const selectionOf = (opts: Record<string, string | undefined>) => ({
  models: list(opts.models),
  efforts: list(opts.efforts),
  groups: list(opts.groups),
  repeats: Number.parseInt(opts.repeat ?? '1', 10),
});

function benchDir(): string {
  return path.resolve(program.opts<{ dir: string }>().dir);
}

matrixOptions(program.command('plan'))
  .description('print the matrix with estimated costs, and exit (no paid calls)')
  .action(async (opts) => {
    await runBenchmark({ root, benchDir: benchDir(), label: opts.label, selection: selectionOf(opts) });
  });

matrixOptions(program.command('run'))
  .description('run the matrix: prints the plan, and spends only with --yes')
  .option('--yes', 'confirm the estimated spend and run')
  .option('--redo', 'run again configurations that already have a finished run under this label')
  .option('--concurrency <n>', 'runs at once', String(benchmarkConfig.concurrency))
  .option('--note <text>', 'what changed in the app, recorded with the runs')
  .option('--allow-version-mismatch', 'add runs to a label whose existing runs came from different source')
  .option('--quiet', 'do not echo the runs\' console output')
  .action(async (opts) => {
    const concurrency = Number.parseInt(opts.concurrency, 10);
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('--concurrency must be a positive integer.');
    const result = await runBenchmark({
      root,
      benchDir: benchDir(),
      label: opts.label,
      note: opts.note,
      selection: selectionOf(opts),
      yes: opts.yes,
      redo: opts.redo,
      concurrency,
      allowVersionMismatch: opts.allowVersionMismatch,
      runChild: cliChild(root, opts.quiet || concurrency > 1 ? undefined : (line) => console.log(`    ${line}`)),
    });
    if (result.started.length) {
      const report = buildReport(benchDir(), loadTarget(path.join(benchDir(), '0-target')), result.label);
      const files = writeReport(benchDir(), report);
      console.log(`\nReport: ${files.markdown}\nPage: ${files.html}\nResults: ${files.json}`);
    }
  });

program
  .command('score')
  .description('score one run folder (or work folder) against the reference; offline')
  .argument('<folder>', 'a run folder, or a work folder with 1-scripts/')
  .option('--json', 'print the full score as JSON')
  .action((folder: string, opts) => {
    const score = scoreFolder(path.resolve(folder), loadTarget(path.join(benchDir(), '0-target')));
    if (!score) throw new Error(`${folder} has no chapter script in 1-scripts/ and no Script checkpoint to score.`);
    console.log(opts.json ? JSON.stringify(score, null, 2) : formatScore(score));
  });

program
  .command('report')
  .description('re-score every saved run and write benchmarks/report.md, report.html and results.json; offline')
  .option('--label <label>', 'label for the main table (default: the most recent)')
  .action((opts) => {
    const report = buildReport(benchDir(), loadTarget(path.join(benchDir(), '0-target')), opts.label);
    const files = writeReport(benchDir(), report);
    console.log(`Report: ${files.markdown}\nPage: ${files.html}\nResults: ${files.json}`);
  });

program.parseAsync().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
