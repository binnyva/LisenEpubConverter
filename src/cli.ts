#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

// Load .env from the current directory or the project root, if present.
for (const envFile of [
  path.resolve('.env'),
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'),
]) {
  if (fs.existsSync(envFile)) {
    process.loadEnvFile(envFile);
    break;
  }
}
import { STAGES, type Stage } from './config.js';
import { WorkDir } from './state.js';
import { checkApiKey, checkFfmpeg } from './checks.js';
import { runExtract } from './pipeline/extract.js';
import { runAnalyze } from './pipeline/analyze.js';
import { runChapters } from './pipeline/chapters.js';
import { runScript } from './pipeline/script.js';
import { runCasting } from './pipeline/casting.js';
import { runSynth } from './pipeline/synth.js';
import { runAssemble } from './pipeline/assemble.js';

const program = new Command();
program
  .name('lisen')
  .description('Convert an EPUB into a multi-voice M4B audiobook');

program
  .command('convert')
  .argument('<epub>', 'path to the .epub file')
  .option('--out <dir>', 'output directory for the .m4b', '.')
  .option('--work <dir>', 'work directory for intermediate artifacts', './work')
  .option('--from <stage>', `re-run from a stage (${STAGES.join(', ')})`)
  .option('--force', 're-run the whole pipeline from scratch', false)
  .option('--dry-run', 'stop before synthesis (no TTS spend) so script/casting can be reviewed', false)
  .action(async (epub: string, opts) => {
    if (!fs.existsSync(epub)) {
      console.error(`Error: file not found: ${epub}`);
      process.exit(1);
    }
    checkFfmpeg();
    checkApiKey();

    const work = new WorkDir(epub, opts.work);
    console.log(`Work directory: ${work.root}`);

    if (opts.force) work.invalidateFrom('extract');
    if (opts.from) {
      if (!STAGES.includes(opts.from)) {
        console.error(`Error: unknown stage "${opts.from}". Stages: ${STAGES.join(', ')}`);
        process.exit(1);
      }
      work.invalidateFrom(opts.from as Stage);
    }

    const stages: Array<{ name: Stage; run: () => Promise<unknown> | unknown }> = [
      { name: 'extract', run: () => runExtract(epub, work) },
      { name: 'analyze', run: () => runAnalyze(work) },
      { name: 'chapters', run: () => runChapters(work) },
      { name: 'script', run: () => runScript(work) },
      { name: 'casting', run: () => runCasting(work) },
      { name: 'synth', run: () => runSynth(work) },
      { name: 'assemble', run: () => runAssemble(work, opts.out) },
    ];

    for (const stage of stages) {
      if (opts.dryRun && (stage.name === 'synth' || stage.name === 'assemble')) {
        console.log(`\nDry run: stopping before "${stage.name}".`);
        console.log(`Review ${work.path('script')} and ${work.path('casting.json')}, then re-run without --dry-run.`);
        return;
      }
      if (work.isDone(stage.name)) {
        console.log(`[${stage.name}] already done, skipping`);
        continue;
      }
      console.log(`[${stage.name}] running...`);
      const result = await stage.run();
      work.markDone(stage.name);
      if (stage.name === 'assemble') {
        console.log(`\nDone: ${result}`);
      }
    }
  });

program
  .command('status')
  .argument('<epub>', 'path to the .epub file')
  .option('--work <dir>', 'work directory', './work')
  .action((epub: string, opts) => {
    if (!fs.existsSync(epub)) {
      console.error(`Error: file not found: ${epub}`);
      process.exit(1);
    }
    const work = new WorkDir(epub, opts.work);
    console.log(`Work directory: ${work.root}\n`);
    for (const { stage, done, at } of work.status()) {
      console.log(`  ${done ? '✔' : '·'} ${stage}${at ? `  (${at})` : ''}`);
    }
  });

program.parseAsync().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
