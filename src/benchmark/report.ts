import fs from 'node:fs';
import path from 'node:path';
import { benchmarkConfig } from '../config.js';
import { formatDuration } from '../util/usage.js';
import { scoreFolder, type ScoreResult, type Target } from './score.js';
import { renderHtml } from './html.js';
import { CONSOLE_LOG, LABEL_RECORD, RUNS_DIR, classifyOutcome, labelRuns, listLabels, type LabelRecord, type RunRecord } from './runner.js';

/**
 * The benchmark report. Every saved run is scored again each time it is
 * built, so a change to the scorer applies to every label alike; the saved
 * script and run record are the record of a run, never the score.
 */

export interface ScoredRun {
  label: string;
  /** Run folder, relative to the benchmarks folder. */
  dir: string;
  record: RunRecord;
  score?: ScoreResult;
}

export interface Stat {
  mean: number;
  min: number;
  max: number;
  n: number;
}

export interface ConfigSummary {
  label: string;
  model: string;
  effort: string;
  runs: ScoredRun[];
  outcomes: Record<string, number>;
  lineAccuracy?: Stat;
  wordAccuracy?: Stat;
  coverage?: Stat;
  narrationToCharacterWords?: Stat;
  speechToNarratorLines?: Stat;
  merges?: Stat;
  splits?: Stat;
  castFound?: Stat;
  cost?: Stat;
  costEstimated: boolean;
  wallMs: Stat;
  calls: Stat;
  promptTokens: Stat;
  completionTokens: Stat;
  reasoningTokens: Stat;
  lowConfidence?: Stat;
  retries: Stat;
  validationFailures: Stat;
}

function stat(values: Array<number | undefined>): Stat | undefined {
  const present = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (!present.length) return undefined;
  return { mean: present.reduce((sum, value) => sum + value, 0) / present.length, min: Math.min(...present), max: Math.max(...present), n: present.length };
}
const must = (s: Stat | undefined): Stat => s ?? { mean: 0, min: 0, max: 0, n: 0 };

/** Every finished run of every label, scored. */
export function collectRuns(benchDir: string, target: Target): ScoredRun[] {
  const runs: ScoredRun[] = [];
  for (const label of listLabels(benchDir)) {
    for (const { dir, record } of labelRuns(path.join(benchDir, RUNS_DIR, label))) {
      if (!record) continue;
      // How a run ended is read again from its log, like the score, so a better reading applies to old runs too.
      const logFile = path.join(dir, CONSOLE_LOG);
      const ended = fs.existsSync(logFile) ? classifyOutcome(record.exitCode, fs.readFileSync(logFile, 'utf8')) : {};
      runs.push({ label, dir: path.relative(benchDir, dir), record: { ...record, ...ended }, score: scoreFolder(dir, target) });
    }
  }
  return runs;
}

export function summarize(runs: ScoredRun[]): ConfigSummary[] {
  const groups = new Map<string, ScoredRun[]>();
  for (const run of runs) {
    const key = `${run.label}\u0000${run.record.model}\u0000${run.record.effort}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups.values()].map((group) => {
    const scores = group.map((run) => run.score);
    const records = group.map((run) => run.record);
    const outcomes: Record<string, number> = {};
    for (const record of records) outcomes[record.outcome] = (outcomes[record.outcome] ?? 0) + 1;
    return {
      label: group[0].label,
      model: group[0].record.model,
      effort: group[0].record.effort,
      runs: group.sort((l, r) => l.record.repeat - r.record.repeat),
      outcomes,
      lineAccuracy: stat(scores.map((s) => s?.attribution.lineAccuracy)),
      wordAccuracy: stat(scores.map((s) => s?.attribution.wordAccuracy)),
      coverage: stat(scores.map((s) => s?.attribution.coverage)),
      narrationToCharacterWords: stat(scores.map((s) => s?.narratorBoundary.narrationToCharacter.words)),
      speechToNarratorLines: stat(scores.map((s) => s?.narratorBoundary.speechToNarrator.lines)),
      merges: stat(scores.map((s) => s?.cast.merged.length)),
      splits: stat(scores.map((s) => s?.cast.split.length)),
      castFound: stat(scores.map((s) => s?.cast.found.length)),
      cost: stat(records.map((r) => r.cost.value)),
      costEstimated: records.some((r) => r.cost.basis !== 'openrouter'),
      wallMs: must(stat(records.map((r) => r.wallMs))),
      calls: must(stat(records.map((r) => r.usage.calls))),
      promptTokens: must(stat(records.map((r) => r.usage.promptTokens))),
      completionTokens: must(stat(records.map((r) => r.usage.completionTokens))),
      reasoningTokens: must(stat(records.map((r) => r.usage.reasoningTokens))),
      lowConfidence: stat(scores.map((s) => s?.facts.lowConfidence)),
      retries: must(stat(records.map((r) => r.retries))),
      validationFailures: must(stat(records.map((r) => r.validationFailures))),
    };
  });
}

/** Complete runs first, by attribution accuracy, then by cost. */
export function rank(configs: ConfigSummary[]): ConfigSummary[] {
  const complete = (c: ConfigSummary): boolean => (c.coverage?.min ?? 0) >= benchmarkConfig.minCoverage;
  return [...configs].sort((l, r) => Number(complete(r)) - Number(complete(l))
    || (r.lineAccuracy?.mean ?? -1) - (l.lineAccuracy?.mean ?? -1)
    || (r.wordAccuracy?.mean ?? -1) - (l.wordAccuracy?.mean ?? -1)
    || (l.cost?.mean ?? Infinity) - (r.cost?.mean ?? Infinity));
}

/** The label of the most recently started run. */
export function latestLabel(runs: ScoredRun[]): string | undefined {
  return [...runs].sort((l, r) => r.record.startedAt.localeCompare(l.record.startedAt))[0]?.label;
}

// ---------------------------------------------------------------------------
// Formatting.

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const money = (value: number): string => (value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(3)}`);
const kilo = (value: number): string => (value >= 10_000 ? `${Math.round(value / 1000)}k` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value)));
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** A mean, with the range when a configuration ran more than once. */
function show(s: Stat | undefined, format: (value: number) => string): string {
  if (!s) return '–';
  return s.n > 1 && s.max !== s.min ? `${format(s.mean)} (${format(s.min)}–${format(s.max)})` : format(s.mean);
}

function outcomeText(outcomes: Record<string, number>): string {
  const entries = Object.entries(outcomes);
  return entries.length === 1 && entries[0][1] === 1 ? entries[0][0] : entries.map(([outcome, count]) => `${outcome} ×${count}`).join(', ');
}

function table(header: string[], rows: string[][]): string[] {
  return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`)];
}

function mainTable(configs: ConfigSummary[]): string[] {
  return table(
    ['#', 'Model', 'Effort', 'Runs', 'Outcome', 'Lines right', 'Words right', 'Narration → char (words)', 'Speech → narrator', 'Merges / splits', 'Cost', 'Wall', 'Calls', 'Tokens in / out (reasoning)', 'Low conf.', 'Retries / invalid'],
    configs.map((c, i) => [
      String(i + 1), `\`${c.model}\``, c.effort, String(c.runs.length), outcomeText(c.outcomes),
      show(c.lineAccuracy, pct) + ((c.coverage?.min ?? 1) < benchmarkConfig.minCoverage ? ` ⚠ ${show(c.coverage, pct)} scored` : ''),
      show(c.wordAccuracy, pct),
      show(c.narrationToCharacterWords, (v) => v.toFixed(0)),
      show(c.speechToNarratorLines, (v) => v.toFixed(0)),
      `${show(c.merges, (v) => v.toFixed(0))} / ${show(c.splits, (v) => v.toFixed(0))}`,
      show(c.cost, money) + (c.cost && c.costEstimated ? ' est.' : ''),
      show(c.wallMs, formatDuration),
      show(c.calls, (v) => v.toFixed(0)),
      `${kilo(c.promptTokens.mean)} / ${kilo(c.completionTokens.mean)} (${kilo(c.reasoningTokens.mean)})`,
      show(c.lowConfidence, (v) => v.toFixed(0)),
      `${show(c.retries, (v) => v.toFixed(0))} / ${show(c.validationFailures, (v) => v.toFixed(0))}`,
    ]),
  );
}

function callTypeSection(configs: ConfigSummary[]): string[] {
  const types = [...new Set(configs.flatMap((c) => c.runs.flatMap((run) => Object.keys(run.record.calls.byType))))].sort();
  if (!types.length) return ['No request traces were found, so spend cannot be split by call type. usage.json records only totals per stage.'];
  const rows = configs.map((c) => [`\`${c.model}\``, c.effort, ...types.map((type) => {
    const calls = c.runs.map((run) => run.record.calls.byType[type]).filter(Boolean);
    if (!calls.length) return '–';
    const mean = (pick: (u: (typeof calls)[number]) => number | undefined): number => calls.reduce((sum, u) => sum + (pick(u) ?? 0), 0) / c.runs.length;
    const costs = calls.every((u) => u.cost !== undefined) ? ` · ${money(mean((u) => u.cost))}` : '';
    return `${mean((u) => u.calls).toFixed(1)} calls · ${kilo(mean((u) => u.promptTokens))}/${kilo(mean((u) => u.completionTokens))}${costs}`;
  })]);
  return [
    'From the request traces; usage.json records only totals per stage. Per run, mean over repeats: calls · tokens in/out · cost.',
    '',
    ...table(['Model', 'Effort', ...types], rows),
  ];
}

function comparisonSection(main: string, configs: ConfigSummary[]): string[] {
  const others = [...new Set(configs.map((c) => c.label))].filter((label) => label !== main).sort();
  if (!others.length) return ['Only one label has runs, so there is nothing to compare yet.'];
  const out: string[] = [];
  const key = (c: ConfigSummary): string => `${c.model}\u0000${c.effort}`;
  const mainConfigs = new Map(configs.filter((c) => c.label === main).map((c) => [key(c), c]));
  const signed = (value: number, format: (v: number) => string): string => `${value > 0 ? '+' : value < 0 ? '−' : '±'}${format(Math.abs(value))}`;
  for (const other of others) {
    const otherConfigs = new Map(configs.filter((c) => c.label === other).map((c) => [key(c), c]));
    const shared = [...otherConfigs.keys()].filter((k) => mainConfigs.has(k));
    out.push(`### ${other} → ${main}`, '');
    if (shared.length) {
      out.push(...table(
        ['Model', 'Effort', 'Lines right', 'Δ lines right', 'Cost', 'Δ cost', 'Calls', 'Δ calls', 'Wall', 'Δ wall'],
        shared.map((k) => {
          const before = otherConfigs.get(k)!;
          const after = mainConfigs.get(k)!;
          const accuracy = (c: ConfigSummary): number | undefined => c.lineAccuracy?.mean;
          const dAcc = accuracy(after) !== undefined && accuracy(before) !== undefined ? signed((accuracy(after)! - accuracy(before)!) * 100, (v) => `${v.toFixed(1)} pts`) : '–';
          const costRatio = after.cost && before.cost && before.cost.mean > 0 ? ` (×${(after.cost.mean / before.cost.mean).toFixed(2)})` : '';
          const dCost = after.cost && before.cost ? signed(after.cost.mean - before.cost.mean, money) + costRatio : '–';
          return [
            `\`${after.model}\``, after.effort,
            `${show(before.lineAccuracy, pct)} → ${show(after.lineAccuracy, pct)}`, dAcc,
            `${show(before.cost, money)} → ${show(after.cost, money)}`, dCost,
            `${before.calls.mean.toFixed(1)} → ${after.calls.mean.toFixed(1)}`, signed(after.calls.mean - before.calls.mean, (v) => v.toFixed(1)),
            `${formatDuration(before.wallMs.mean)} → ${formatDuration(after.wallMs.mean)}`, signed(after.wallMs.mean - before.wallMs.mean, formatDuration),
          ];
        }),
      ), '');
    }
    const onlyOther = [...otherConfigs.keys()].filter((k) => !mainConfigs.has(k)).map((k) => otherConfigs.get(k)!);
    const onlyMain = [...mainConfigs.keys()].filter((k) => !otherConfigs.has(k)).map((k) => mainConfigs.get(k)!);
    if (onlyOther.length) out.push(`Only in ${other}: ${onlyOther.map((c) => `\`${c.model}\` ${c.effort}`).join(', ')}.`, '');
    if (onlyMain.length) out.push(`Only in ${main}: ${onlyMain.map((c) => `\`${c.model}\` ${c.effort}`).join(', ')}.`, '');
  }
  return out;
}

function runSection(run: ScoredRun): string[] {
  const r = run.record;
  const s = run.score;
  const out = [`### \`${r.model}\` · ${r.effort}${r.repeat > 1 ? ` · repeat ${r.repeat}` : ''}`, ''];
  out.push(`Folder \`${run.dir}\` · ${r.outcome}${r.reason ? `: ${r.reason}` : ''}`);
  out.push(`${r.usage.calls} calls · ${r.usage.promptTokens.toLocaleString('en-US')} prompt + ${r.usage.completionTokens.toLocaleString('en-US')} completion tokens (${r.usage.reasoningTokens.toLocaleString('en-US')} reasoning) · ${formatDuration(r.wallMs)} · ${r.cost.value === undefined ? 'cost unknown' : `${money(r.cost.value)}${r.cost.basis === 'estimate' ? ' (estimated from tokens and listed prices)' : ''}`} · ${r.retries} retries, ${r.validationFailures} invalid replies`);
  if (!s) {
    out.push('', 'No script or checkpoint to score: the run stopped before its first block was saved.', '');
    return out;
  }
  const a = s.attribution;
  out.push(`Scored from ${s.source === 'script' ? 'the saved script' : s.source === 'checkpoint-result' ? 'the checkpoint\'s verified segments (blocked run)' : 'the checkpoint\'s finished blocks (stopped before verification)'}: ${a.correctLines}/${a.lines} lines right (${pct(a.lineAccuracy)}), ${pct(a.wordAccuracy)} of words${a.missingLines ? `; ${a.missingLines} reference line(s) not in the run's text` : ''}.`);
  out.push(`Cast ${s.cast.found.length}/${s.cast.reference}${s.cast.missing.length ? `; missing ${s.cast.missing.join(', ')}` : ''}${s.cast.extra.length ? `; extra ${s.cast.extra.join(', ')}` : ''}.`);
  for (const merge of s.cast.merged) out.push(`- Merged: ${merge.refs.join(' + ')} → **${merge.run}**`);
  for (const split of s.cast.split) out.push(`- Split: **${split.ref}** → ${split.runs.join(' + ')}`);
  const mapped = s.mapping.filter((m) => m.method !== 'exact');
  if (mapped.length) out.push(`- Mapping: ${mapped.map((m) => `${m.run} → ${m.ref} (${m.method})`).join('; ')}`);
  if (s.facts.unresolvedSpeakers.length) out.push(`- Unresolved: ${s.facts.unresolvedSpeakers.join(', ')}`);
  if (s.fidelity.wordsAdded || s.fidelity.wordsRemoved) {
    out.push(`- Text fidelity: +${s.fidelity.wordsAdded} / −${s.fidelity.wordsRemoved} words${[...s.fidelity.removed.map((p) => ` −"${p}"`), ...s.fidelity.added.map((p) => ` +"${p}"`)].slice(0, 8).join(';')}`);
  }
  const stretches = s.narratorBoundary.narrationToCharacter.stretches;
  if (stretches.length) out.push(`- Narration given to a character: ${stretches.slice(0, 6).map((st) => `${st.runSpeaker} "${st.excerpt}" (${st.words} words)`).join('; ')}${stretches.length > 6 ? '; …' : ''}`);
  if (s.wrongLines.length) {
    out.push('', ...table(['Kind', 'Reference', 'Run', 'Line'], s.wrongLines.map((w) => [w.kind, w.refSpeaker, w.runSpeaker, w.excerpt])));
  }
  out.push('');
  return out;
}

export interface Report {
  label?: string;
  results: unknown;
  markdown: string;
  html: string;
}

/** Model id → its group in models.json, for colouring; empty when the matrix cannot be read. */
function matrixGroups(benchDir: string): Record<string, string> {
  try {
    const matrix = JSON.parse(fs.readFileSync(path.join(benchDir, 'models.json'), 'utf8')) as { groups?: Array<{ name: string; models: Array<{ id: string }> }> };
    return Object.fromEntries((matrix.groups ?? []).flatMap((group) => group.models.map((model) => [model.id, group.name])));
  } catch {
    return {};
  }
}

export function buildReport(benchDir: string, target: Target, requestedLabel?: string, now = new Date()): Report {
  const runs = collectRuns(benchDir, target);
  const label = requestedLabel ?? latestLabel(runs);
  if (requestedLabel && !runs.some((run) => run.label === requestedLabel)) {
    throw new Error(`Label "${requestedLabel}" has no finished runs. Labels with runs: ${[...new Set(runs.map((run) => run.label))].join(', ') || 'none'}.`);
  }
  const configs = summarize(runs);
  const mainConfigs = rank(configs.filter((c) => c.label === label));
  const labelInfo = (name: string): LabelRecord | undefined => {
    try {
      return JSON.parse(fs.readFileSync(path.join(benchDir, RUNS_DIR, name, LABEL_RECORD), 'utf8')) as LabelRecord;
    } catch {
      return undefined;
    }
  };
  const info = label ? labelInfo(label) : undefined;
  const referenceLines = target.segments.filter((s) => s.kind !== 'pause' && s.speaker !== 'narrator');
  const unattributable = referenceLines.filter((s) => !/["“”]/.test(s.text));

  const md: string[] = ['# Script benchmark', ''];
  md.push(`Generated ${now.toISOString()}. Scores are recomputed from the saved scripts every time this report is built.`, '');
  md.push(`Reference: "The Last Question", ${target.segments.length} segments, ${referenceLines.length - unattributable.length} scorable character lines${unattributable.length ? ` (${unattributable.length} more have no double quotation marks, so quoted-mode Script cannot attribute them; they are left out: ${unattributable.map((s) => `${s.speaker} "${s.text.slice(0, 40)}…"`).join('; ')})` : ''}.`, '');
  const html = renderHtml({
    generatedAt: now.toISOString(),
    label,
    labels: [...new Set(runs.map((run) => run.label))].sort().map((name) => {
      const record = labelInfo(name);
      const version = record?.version ?? runs.find((run) => run.label === name)?.record.version;
      return { label: name, commit: version?.commit, branch: version?.branch, dirty: version?.dirty, sourceHash: version?.sourceHash, note: record?.note, createdAt: record?.createdAt };
    }),
    configs: [...mainConfigs, ...rank(configs.filter((c) => c.label !== label))],
    groups: matrixGroups(benchDir),
    reference: {
      segments: target.segments.length,
      lines: referenceLines.length - unattributable.length,
      unattributable: unattributable.map((s) => ({ speaker: s.speaker, text: s.text.slice(0, 80) })),
    },
  });
  if (!label) {
    md.push('No runs yet. Run `npm run bench -- run --yes` (see README.md).');
    return { label, results: { generatedAt: now.toISOString(), runs: [] }, markdown: md.join('\n') + '\n', html };
  }
  const v = info?.version ?? runs.find((run) => run.label === label)?.record.version;
  md.push(`## Results: ${label}`, '');
  if (v) md.push(`Commit \`${v.commit?.slice(0, 10) ?? '?'}\` on \`${v.branch ?? '?'}\`${v.dirty ? ' with uncommitted changes' : ''} · source hash \`${v.sourceHash}\` · package ${v.packageVersion ?? '?'}${info?.note ? ` · ${info.note}` : ''}`, '');
  md.push('Sorted by the share of character lines given to the right speaker. Runs whose text covers less than ' + pct(benchmarkConfig.minCoverage) + ' of the reference lines (⚠) are ranked below the rest. With repeats, values are means with the range in brackets. "est." marks a cost computed from tokens and listed prices rather than reported by OpenRouter.', '');
  md.push(...mainTable(mainConfigs), '');
  md.push('## Spend by call type', '', ...callTypeSection(mainConfigs), '');
  md.push('## Version comparison', '', ...comparisonSection(label, configs), '');
  md.push(`## Runs: ${label}`, '');
  for (const config of mainConfigs) for (const run of config.runs) md.push(...runSection(run));

  const results = {
    generatedAt: now.toISOString(),
    label,
    labels: [...new Set(runs.map((run) => run.label))].map((name) => ({ label: name, ...labelInfo(name) })),
    configs: configs.map(({ runs: group, ...rest }) => ({ ...rest, runs: group.map((run) => run.dir) })),
    runs,
  };
  return { label, results, markdown: md.join('\n') + '\n', html };
}

export function writeReport(benchDir: string, report: Report): { json: string; markdown: string; html: string } {
  const json = path.join(benchDir, 'results.json');
  const markdown = path.join(benchDir, 'report.md');
  const html = path.join(benchDir, 'report.html');
  fs.writeFileSync(json, JSON.stringify(report.results, null, 2));
  fs.writeFileSync(markdown, report.markdown);
  fs.writeFileSync(html, report.html);
  return { json, markdown, html };
}
