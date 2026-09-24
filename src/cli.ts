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
import { config, STAGES, type Stage } from './config.js';
import { WorkDir } from './state.js';
import { checkApiKeys, checkFfmpeg } from './checks.js';
import { discoverBooks, runStage } from './pipeline/runner.js';
import { startLocalUi } from './ui/server.js';
import { defaultVoiceTarget, importVoiceLibrary, loadVoiceLibrary, refreshVoiceLibrary, type VoiceTarget } from './voices/library.js';

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
    checkApiKeys();

    const work = new WorkDir(epub, opts.work);
    console.log(`Work directory: ${work.root}`);

    let startAt = 0;
    if (opts.force) startAt = 0;
    if (opts.from) {
      if (!STAGES.includes(opts.from)) {
        console.error(`Error: unknown stage "${opts.from}". Stages: ${STAGES.join(', ')}`);
        process.exit(1);
      }
      startAt = STAGES.indexOf(opts.from as Stage);
    }

    for (const [index, stage] of STAGES.entries()) {
      if (index < startAt) continue;
      if (opts.dryRun && (stage === 'synth' || stage === 'assemble')) {
        console.log(`\nDry run: stopping before "${stage}".`);
        console.log(`Review ${work.path('script')} and ${work.path('casting.json')}, then re-run without --dry-run.`);
        return;
      }
      const result = await runStage({
        epubPath: epub,
        workRoot: opts.work,
        outDir: opts.out,
        stage,
        rebuild: (opts.force || Boolean(opts.from)) && index === startAt,
        onEvent: (event) => console.log(`[${event.stage}] ${event.message}`),
      });
      if (result.output) console.log(`\nDone: ${result.output}`);
    }
  });

program
  .command('status')
  .argument('<epub>', 'path to the .epub file')
  .option('--work <dir>', 'work directory', './work')
  .option('--json', 'print machine-readable JSON')
  .action((epub: string, opts) => {
    if (!fs.existsSync(epub)) {
      console.error(`Error: file not found: ${epub}`);
      process.exit(1);
    }
    const work = new WorkDir(epub, opts.work);
    if (opts.json) {
      console.log(JSON.stringify({ root: work.root, state: work.snapshot(), stages: work.status() }, null, 2));
      return;
    }
    console.log(`Work directory: ${work.root}\n`);
    for (const { stage, done, at } of work.status()) {
      console.log(`  ${done ? '✔' : '·'} ${stage}${at ? `  (${at})` : ''}`);
    }
  });

program
  .command('books')
  .option('--work <dir>', 'work directory', './work')
  .option('--json', 'print machine-readable JSON')
  .action((opts) => {
    const books = discoverBooks(opts.work);
    if (opts.json) {
      console.log(JSON.stringify(books, null, 2));
      return;
    }
    if (!books.length) {
      console.log('No work folders found.');
      return;
    }
    for (const book of books) {
      console.log(`${book.epubAvailable ? '✔' : '!' } ${book.epubPath}`);
    }
  });

program
  .command('run')
  .argument('<epub>', 'path to the .epub file')
  .argument('<stage>', `stage to run (${STAGES.join(', ')})`)
  .option('--chapters <indexes>', 'comma-separated chapter indexes (for chapters, script, synth, or assemble)')
  .option('--rerun', 'execute the stage even if it is already complete')
  .option('--rebuild', 'clear this stage and all derived output before running')
  .option('--out <dir>', 'output directory for assembled M4Bs', '.')
  .option('--work <dir>', 'work directory', './work')
  .option('--json', 'print machine-readable JSON')
  .action(async (epub: string, stage: string, opts) => {
    if (!STAGES.includes(stage as Stage)) throw new Error(`Unknown stage "${stage}". Stages: ${STAGES.join(', ')}`);
    if (!fs.existsSync(epub)) throw new Error(`file not found: ${epub}`);
    if (stage === 'assemble') checkFfmpeg();
    if (['analyze', 'chapters', 'script', 'casting'].includes(stage)) checkApiKeys([config.llmProvider]);
    if (stage === 'synth') checkApiKeys([config.ttsProvider]);
    const chapters = opts.chapters
      ? String(opts.chapters).split(',').map((value) => Number.parseInt(value.trim(), 10))
      : undefined;
    const result = await runStage({
      epubPath: epub,
      workRoot: opts.work,
      outDir: opts.out,
      stage: stage as Stage,
      chapterIndexes: chapters,
      rerun: opts.rerun,
      rebuild: opts.rebuild,
      onEvent: opts.json ? undefined : (event) => console.log(`[${event.stage}] ${event.message}`),
    });
    if (opts.json) {
      console.log(JSON.stringify({ stage: result.stage, skipped: result.skipped, output: result.output, chapters: result.chapterIndexes }, null, 2));
    }
  });

program
  .command('ui')
  .option('--work <dir>', 'work directory', './work')
  .option('--out <dir>', 'output directory for assembled M4Bs', '.')
  .option('--port <number>', 'local port', '3188')
  .action(async (opts) => {
    const port = Number.parseInt(opts.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
    const url = await startLocalUi({ workRoot: opts.work, outDir: opts.out, port });
    console.log(`Lisen UI is running at ${url}`);
  });

const voices = program.command('voices').description('Manage the shared TTS model and voice library');
voices
  .command('refresh')
  .option('--provider <provider>', 'TTS provider (openai or openrouter)')
  .option('--model <model>', 'TTS model')
  .option('--library <file>', 'voice library JSON file')
  .action((opts) => {
    const target = voiceTargetFromOptions(opts);
    const library = refreshVoiceLibrary(target, opts.library);
    console.log(`Saved ${library.voices.filter((voice) => voice.models.includes(`${target.provider}:${target.model}`)).length} voice(s) for ${target.provider}/${target.model}.`);
  });
voices
  .command('import')
  .argument('<catalogue>', 'legacy JSON voice catalogue')
  .requiredOption('--provider <provider>', 'TTS provider (openai or openrouter)')
  .requiredOption('--model <model>', 'TTS model')
  .option('--library <file>', 'voice library JSON file')
  .action((catalogue, opts) => {
    const target = voiceTargetFromOptions(opts);
    const library = importVoiceLibrary(catalogue, target, opts.library);
    console.log(`Imported ${library.voices.filter((voice) => voice.models.includes(`${target.provider}:${target.model}`)).length} voice(s) for ${target.provider}/${target.model}.`);
  });
voices
  .command('list')
  .option('--provider <provider>', 'filter by provider')
  .option('--model <model>', 'filter by model')
  .option('--library <file>', 'voice library JSON file')
  .action((opts) => {
    const library = loadVoiceLibrary(opts.library);
    const target = opts.provider || opts.model ? voiceTargetFromOptions(opts) : undefined;
    const targetId = target && `${target.provider}:${target.model}`;
    for (const voice of library.voices.filter((entry) => !targetId || entry.models.includes(targetId))) {
      console.log(`${voice.id}\t${voice.description || voice.traits.tone.join(', ')}`);
    }
  });
voices
  .command('apply')
  .argument('<epub>', 'path to the .epub file')
  .option('--provider <provider>', 'voice provider (openai, openrouter, or fish)')
  .option('--model <model>', 'TTS model')
  .option('--library <file>', 'voice library JSON file')
  .option('--work <dir>', 'work directory', './work')
  .option('--out <dir>', 'output directory', '.')
  .action(async (epub, opts) => {
    if (!fs.existsSync(epub)) throw new Error(`file not found: ${epub}`);
    await runStage({ epubPath: epub, workRoot: opts.work, outDir: opts.out, stage: 'voices', voiceTarget: voiceTargetFromOptions(opts), voiceLibraryFile: opts.library, rerun: true, onEvent: (event) => console.log(`[${event.stage}] ${event.message}`) });
  });

function voiceTargetFromOptions(opts: { provider?: string; model?: string }): VoiceTarget {
  const fallback = defaultVoiceTarget();
  const provider = opts.provider ?? fallback.provider;
  if (provider !== 'openai' && provider !== 'openrouter' && provider !== 'fish') throw new Error('Voice provider must be "openai", "openrouter", or "fish".');
  if (provider !== fallback.provider && !opts.model) throw new Error('Specify --model when selecting a different voice provider.');
  return { provider, model: opts.model ?? fallback.model };
}

program.parseAsync().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
