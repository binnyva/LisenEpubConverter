import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyOutcome, countRetries, runBenchmark, summarizeTrace, type RunChild } from '../src/benchmark/runner.js';
import { buildReport } from '../src/benchmark/report.js';
import { loadTarget } from '../src/benchmark/score.js';
import { appVersion } from '../src/benchmark/version.js';
import { removeFixtures, tempRoot } from './helpers.js';

afterEach(removeFixtures);

const root = path.resolve(import.meta.dirname, '..');
const CLEAN = 'Adell and Lupov sat drinking.\n\n"Not forever," he said.\n\n"Oh, hell, just about forever."\n';
const reference = [
  { speaker: 'narrator', text: 'Adell and Lupov sat drinking.', confidence: 'high' },
  { speaker: 'Bertram Lupov', text: '"Not forever,"', confidence: 'high' },
  { speaker: 'narrator', text: 'he said.', confidence: 'high' },
  { speaker: 'Alexander Adell', text: '"Oh, hell, just about forever."', confidence: 'high' },
];

function benchFolder(): string {
  const dir = tempRoot('lisen-bench-');
  fs.mkdirSync(path.join(dir, '0-target', 'script'), { recursive: true });
  fs.mkdirSync(path.join(dir, '0-target', 'chapters-clean'), { recursive: true });
  fs.writeFileSync(path.join(dir, '0-target', 'chapters-clean', '00.md'), CLEAN);
  fs.writeFileSync(path.join(dir, '0-target', 'script', '00.json'), JSON.stringify({ index: 0, segments: reference }));
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({
    source: '0-target/chapters-clean/00.md',
    title: 'The Last Question',
    author: 'Isaac Asimov',
    metadata: { model: 'cheap/meta', effort: 'none' },
    estimates: { none: { prompt: 30000, completion: 6000 }, low: { prompt: 25000, completion: 45000 }, default: { prompt: 25000, completion: 80000 } },
    groups: [{
      name: 'cheap',
      efforts: ['none', 'low'],
      models: [
        { id: 'cheap/good' },
        { id: 'cheap/good-flash' },
        { id: 'cheap/stubborn' },
        { id: 'plain/no-reasoning' },
        { id: 'gone/missing' },
      ],
    }],
  }));
  return dir;
}

/** OpenRouter's public model list, as the stub of fetch returns it. */
const catalogueFetch = (async () => new Response(JSON.stringify({
  data: [
    { id: 'cheap/good', pricing: { prompt: '0.0000001', completion: '0.0000005' }, supported_parameters: ['reasoning', 'response_format'], top_provider: { max_completion_tokens: 32000 } },
    { id: 'cheap/good-flash', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['reasoning'] },
    { id: 'cheap/stubborn', pricing: { prompt: '0.000001', completion: '0.000002' }, supported_parameters: ['reasoning'] },
    { id: 'plain/no-reasoning', pricing: { prompt: '0.000001', completion: '0.000001' }, supported_parameters: ['response_format'] },
    { id: 'cheap/meta', pricing: { prompt: '0.0000001', completion: '0.0000001' }, supported_parameters: ['reasoning'] },
  ],
}))) as typeof fetch;

interface Call { args: string[]; env: NodeJS.ProcessEnv }

/**
 * Stands in for the CLI: Extract and Metadata write a work folder as the real
 * stages would, and Script writes a script (cheap/good), or blocks on an
 * unresolved speaker and leaves its checkpoint (cheap/stubborn).
 */
function fakeCli(calls: Call[]): RunChild {
  return async (args, env, logFile) => {
    calls.push({ args, env });
    const [, source, stage, , workRoot] = args;
    const work = path.join(workRoot, 'the-last-question-markdown');
    if (stage === 'extract') {
      fs.mkdirSync(path.join(work, '0-chapters'), { recursive: true });
      const body = fs.readFileSync(source, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
      fs.writeFileSync(path.join(work, '0-chapters', '00-the-last-question.md'), body);
      fs.writeFileSync(path.join(work, 'state.json'), JSON.stringify({ version: 3, source }));
      fs.writeFileSync(path.join(work, 'metadata.json'), JSON.stringify({ title: 'The Last Question', chapters: [{ index: 0, file: '0-chapters/00-the-last-question.md' }] }));
      fs.appendFileSync(logFile, '[extract] extract complete.\n');
      return 0;
    }
    if (stage === 'metadata') {
      const metadata = JSON.parse(fs.readFileSync(path.join(work, 'metadata.json'), 'utf8'));
      fs.writeFileSync(path.join(work, 'metadata.json'), JSON.stringify({ ...metadata, profile: { isFiction: true, dialogueStyle: 'quoted' } }));
      fs.writeFileSync(path.join(work, 'usage.json'), JSON.stringify([{ stage: 'metadata', llm: { calls: 1, promptTokens: 1, completionTokens: 1, reasoningTokens: 0 } }]));
      return 0;
    }
    // Script.
    const usage = { calls: 2, promptTokens: 2000, completionTokens: 500, reasoningTokens: env.LISEN_SCRIPT_REASONING_EFFORT === 'none' ? 0 : 300 };
    fs.writeFileSync(path.join(work, 'usage.json'), JSON.stringify([...JSON.parse(fs.existsSync(path.join(work, 'usage.json')) ? fs.readFileSync(path.join(work, 'usage.json'), 'utf8') : '[]'), { stage: 'script', outcome: 'completed', llm: usage, models: {}, tts: { calls: 0, characters: 0 }, wallMs: 5 }]));
    const trace = env.LISEN_OPENROUTER_TRACE_FILE!;
    const lines = [
      { type: 'request', requestId: 'a', body: { messages: [{ role: 'system', content: 'You decide who speaks each line' }] } },
      { type: 'response', requestId: 'a', status: 200, body: JSON.stringify({ usage: { prompt_tokens: 1500, completion_tokens: 400, cost: 0.0012 } }) },
      { type: 'request', requestId: 'b', body: { messages: [{ role: 'system', content: 'You independently verify speaker attribution' }] } },
      { type: 'response', requestId: 'b', status: 200, body: JSON.stringify({ usage: { prompt_tokens: 500, completion_tokens: 100, cost: 0.0003 } }) },
    ];
    fs.writeFileSync(trace, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    if (env.LISEN_SCRIPT_MODEL === 'cheap/stubborn') {
      fs.mkdirSync(path.join(work, 'checkpoints'), { recursive: true });
      const result = reference.map((segment) => (segment.speaker === 'Alexander Adell' ? { ...segment, speaker: 'a stranger', confidence: 'low' } : segment));
      fs.writeFileSync(path.join(work, 'checkpoints', 'script-00.json'), JSON.stringify({ key: 'k', blocks: [{ segments: reference, characters: [] }], result }));
      fs.writeFileSync(path.join(work, 'characters.json'), JSON.stringify({ version: 3, characters: [], unresolved: [{ story: 'book', chapter: 0, speaker: 'a stranger', samples: [] }] }));
      fs.appendFileSync(logFile, '[script] LLM returned invalid JSON (bad), retrying (attempt 2 of 5)...\n\nError: New or unresolved speakers in chapter 1: a stranger. They are listed under "unresolved".\n');
      return 1;
    }
    fs.mkdirSync(path.join(work, '1-scripts'), { recursive: true });
    fs.writeFileSync(path.join(work, '1-scripts', '00-the-last-question.json'), JSON.stringify({ index: 0, segments: reference }));
    fs.appendFileSync(logFile, '[script] script complete.\n');
    return 0;
  };
}

describe('runBenchmark', () => {
  it('only prints the plan without --yes, and validates models against OpenRouter', async () => {
    const benchDir = benchFolder();
    const calls: Call[] = [];
    const messages: string[] = [];
    const result = await runBenchmark({ root, benchDir, label: 'test', fetchImpl: catalogueFetch, runChild: fakeCli(calls), log: (m) => messages.push(m) });
    expect(calls).toEqual([]);
    expect(result.spent).toBe(false);
    expect(fs.existsSync(path.join(benchDir, 'runs'))).toBe(false);
    expect(result.plan.unknownModels).toEqual(['gone/missing']);
    // A model that takes no reasoning setting is run once, with the provider's default.
    expect(result.plan.configs.map((c) => `${c.model} ${c.effort}`)).toEqual(['cheap/good none', 'cheap/good low', 'cheap/good-flash none', 'cheap/good-flash low', 'cheap/stubborn none', 'cheap/stubborn low', 'plain/no-reasoning default']);
    expect(result.plan.configs.find((c) => c.model === 'cheap/good' && c.effort === 'low')?.maxCompletionTokens).toBe(32000);
    const text = messages.join('\n');
    expect(text).toContain('estimated total');
    expect(text).toContain('Not on OpenRouter');
    expect(text).toContain('Plan only');
  });

  it('refuses to spend while a selected model is not on OpenRouter', async () => {
    await expect(runBenchmark({ root, benchDir: benchFolder(), label: 'test', yes: true, fetchImpl: catalogueFetch, runChild: fakeCli([]), log: () => {} }))
      .rejects.toThrow(/does not list gone\/missing/);
  });

  it('runs each configuration in its own child, records failures as results, and skips finished runs', async () => {
    const benchDir = benchFolder();
    const calls: Call[] = [];
    const options = {
      root, benchDir, label: 'baseline', yes: true, note: 'first', concurrency: 2,
      selection: { models: ['cheap/good', 'cheap/stubborn'], efforts: ['none'] },
      fetchImpl: catalogueFetch, runChild: fakeCli(calls), log: () => {},
      env: { PATH: process.env.PATH, LISEN_OPENROUTER_MAX_PRICE: '{"prompt":0.1}' },
    };
    const result = await runBenchmark(options);
    expect(calls.map((c) => c.args[2])).toEqual(['extract', 'metadata', 'script', 'script']);
    const scriptCall = calls.find((c) => c.env.LISEN_SCRIPT_MODEL === 'cheap/good')!;
    expect(scriptCall.env).toMatchObject({
      LISEN_LLM_PROVIDER: 'openrouter',
      LISEN_SCRIPT_REASONING_EFFORT: 'none',
      LISEN_OPENROUTER_MAX_PRICE: '',
      LISEN_SCRIPT_MAX_COMPLETION_TOKENS: '16384',
      LISEN_LLM_RESPONSE_TIMEOUT_MS: '600000',
    });
    const runDir = path.join(benchDir, 'runs', 'baseline', 'cheap_good--none');
    expect(scriptCall.env.LISEN_OPENROUTER_TRACE_FILE).toBe(path.join(runDir, 'trace.jsonl'));
    expect(scriptCall.args.slice(2)).toEqual(['script', '--work', runDir]);
    // The base is copied into the run without its usage log.
    expect(fs.existsSync(path.join(runDir, 'the-last-question-markdown', '0-chapters', '00-the-last-question.md'))).toBe(true);

    const good = result.records.find((r) => r.model === 'cheap/good')!;
    expect(good).toMatchObject({ outcome: 'completed', exitCode: 0, label: 'baseline', note: 'first', usage: { calls: 2, promptTokens: 2000 } });
    expect(good.cost).toEqual({ value: expect.closeTo(0.0015, 6), basis: 'openrouter' });
    expect(good.calls.byType.attribution).toMatchObject({ calls: 1, promptTokens: 1500 });
    expect(good.version.sourceHash).toBe(appVersion(root).sourceHash);
    expect(good.tunables).toMatchObject({ scriptChunkChars: 16000, scriptMaxCompletionTokens: '16384' });
    const stubborn = result.records.find((r) => r.model === 'cheap/stubborn')!;
    expect(stubborn).toMatchObject({ outcome: 'blocked', exitCode: 1, validationFailures: 1 });
    expect(stubborn.reason).toMatch(/New or unresolved speakers/);

    // Finished runs are skipped; nothing is spawned again.
    calls.length = 0;
    const again = await runBenchmark(options);
    expect(calls).toEqual([]);
    expect(again.skipped).toHaveLength(2);

    // --redo runs them again; the base is not rebuilt.
    await runBenchmark({ ...options, redo: true, selection: { models: ['cheap/good'], efforts: ['none'] } });
    expect(calls.map((c) => c.args[2])).toEqual(['script']);

    // Repeats get folders of their own.
    calls.length = 0;
    await runBenchmark({ ...options, selection: { models: ['cheap/good'], efforts: ['none'], repeats: 2 } });
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(path.join(benchDir, 'runs', 'baseline', 'cheap_good--none--r2', 'run.json'))).toBe(true);

    // A new label reuses the base, since Extract and Metadata are unchanged.
    calls.length = 0;
    await runBenchmark({ ...options, label: 'two-pass', note: 'second', selection: { models: ['cheap/good'], efforts: ['none'] } });
    expect(calls.map((c) => c.args[2])).toEqual(['script']);
    expect(JSON.parse(fs.readFileSync(path.join(benchDir, 'runs', 'two-pass', 'base', 'base.json'), 'utf8')).reusedFrom).toBe('baseline');

    // The report scores the blocked run from its checkpoint and compares labels.
    const report = buildReport(benchDir, loadTarget(path.join(benchDir, '0-target')), 'baseline');
    expect(report.markdown).toContain('## Results: baseline');
    expect(report.markdown).toContain('| unresolved | Alexander Adell | a stranger |');
    expect(report.markdown).toMatch(/cheap\/good` \| none \| 2 \| completed ×2 \| 100\.0%/);
    expect(report.markdown).toContain('### two-pass → baseline');
    expect(report.markdown).toContain('Only in baseline: `cheap/stubborn` none.');
    expect(report.markdown).toContain('attribution');

    // The HTML page embeds the same results as data, and its script compiles.
    const data = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(report.html)![1];
    const parsed = JSON.parse(data);
    expect(parsed.label).toBe('baseline');
    expect(parsed.configs.map((c: { label: string }) => c.label)).toContain('two-pass');
    expect(parsed.configs.find((c: { model: string }) => c.model === 'cheap/stubborn').runs[0].score.wrong[0]).toMatchObject({ kind: 'unresolved', run: 'a stranger' });
    const script = /<script>([\s\S]*?)<\/script>/.exec(report.html)![1];
    expect(() => new Function(script)).not.toThrow();
  });

  it('refuses to mix two pipelines under one label unless told to', async () => {
    const benchDir = benchFolder();
    fs.mkdirSync(path.join(benchDir, 'runs', 'baseline'), { recursive: true });
    fs.writeFileSync(path.join(benchDir, 'runs', 'baseline', 'label.json'), JSON.stringify({ label: 'baseline', createdAt: '', version: { sourceHash: 'something-else' } }));
    const options = { root, benchDir, label: 'baseline', fetchImpl: catalogueFetch, runChild: fakeCli([]), log: () => {}, selection: { models: ['cheap/good'] } };
    await expect(runBenchmark(options)).rejects.toThrow(/different pipeline/);
    await expect(runBenchmark({ ...options, allowVersionMismatch: true })).resolves.toBeDefined();
  });
});

describe('run facts', () => {
  it('classifies how a run ended', () => {
    expect(classifyOutcome(0, '')).toEqual({ outcome: 'completed' });
    expect(classifyOutcome(1, 'Error: LLM response reached its completion token limit. Increase …').outcome).toBe('token-cap');
    expect(classifyOutcome(1, 'Error: LLM returned invalid JSON after 5 attempts: …').outcome).toBe('invalid-json');
    expect(classifyOutcome(1, 'Error: OpenRouter LLM request failed (404): No endpoints found that support reasoning').outcome).toBe('rejected');
    expect(classifyOutcome(1, 'Error: LLM request timed out after 600 seconds without a model response.').outcome).toBe('timeout');
    expect(classifyOutcome(1, 'Error: something else')).toEqual({ outcome: 'failed', reason: 'something else' });
    expect(classifyOutcome(1, '[script] working\n\nError: OpenRouter LLM request failed (400): Provider returned error ({\n  "error": {\n    "message": "Invalid schema"\n  }\n})').reason)
      .toBe('OpenRouter LLM request failed (400): Provider returned error ({ "error": { "message": "Invalid schema" } })');
  });

  it('counts retries and invalid replies from the log', () => {
    expect(countRetries('LLM call failed (x), retrying\nLLM returned invalid JSON (y)\nLLM returned invalid JSON (z)')).toEqual({ retries: 1, validationFailures: 2 });
  });

  it('leaves the reported cost out when a reply carried none', () => {
    const file = path.join(tempRoot(), 'trace.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'request', requestId: 'a', body: { messages: [{ role: 'system', content: 'You prepare book text' }] } }),
      JSON.stringify({ type: 'response', requestId: 'a', status: 200, body: JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } }) }),
      JSON.stringify({ type: 'response', requestId: 'c', status: 429, body: '{}' }),
    ].join('\n'));
    const summary = summarizeTrace(file);
    expect(summary.reportedCost).toBeUndefined();
    expect(summary.byType.edits).toMatchObject({ calls: 1, promptTokens: 10 });
    expect(summary.httpErrors).toBe(1);
  });
});
