import type { ConfigSummary, ScoredRun, Stat } from './report.js';

/**
 * benchmarks/report.html: every benchmark run on one self-contained page, for
 * reading in a browser. It is rebuilt with report.md from the same scores, and
 * its data is embedded, so it opens from disk with no server or network.
 */

export interface HtmlInput {
  generatedAt: string;
  /** The label shown first. */
  label?: string;
  labels: Array<{ label: string; commit?: string; branch?: string; dirty?: boolean; sourceHash?: string; note?: string; createdAt?: string }>;
  configs: ConfigSummary[];
  /** Model id → matrix group (frontier, mid-range, cheap). */
  groups: Record<string, string>;
  reference: { segments: number; lines: number; unattributable: Array<{ speaker: string; text: string }> };
}

const statOf = (s?: Stat) => (s ? { mean: s.mean, min: s.min, max: s.max, n: s.n } : null);

function runData(run: ScoredRun) {
  const r = run.record;
  const s = run.score;
  return {
    dir: run.dir,
    repeat: r.repeat,
    outcome: r.outcome,
    reason: r.reason ?? null,
    startedAt: r.startedAt,
    wallMs: r.wallMs,
    cost: r.cost.value ?? null,
    costBasis: r.cost.basis,
    calls: r.usage.calls,
    prompt: r.usage.promptTokens,
    completion: r.usage.completionTokens,
    reasoning: r.usage.reasoningTokens,
    retries: r.retries,
    invalid: r.validationFailures,
    byType: r.calls.byType,
    score: s ? {
      source: s.source,
      lineAccuracy: s.attribution.lineAccuracy,
      wordAccuracy: s.attribution.wordAccuracy,
      lines: s.attribution.lines,
      correct: s.attribution.correctLines,
      missingLines: s.attribution.missingLines,
      coverage: s.attribution.coverage,
      errors: s.errors,
      wrong: s.wrongLines.map((w) => ({ kind: w.kind, ref: w.refSpeaker, run: w.runSpeaker, text: w.excerpt })),
      merged: s.cast.merged,
      split: s.cast.split,
      missing: s.cast.missing,
      extra: s.cast.extra,
      found: s.cast.found.length,
      castSize: s.cast.reference,
      mapping: s.mapping.filter((m) => m.method !== 'exact').map((m) => ({ run: m.run, ref: m.ref, method: m.method })),
      added: s.fidelity.added,
      removed: s.fidelity.removed,
      narration: s.narratorBoundary.narrationToCharacter.stretches,
      speechToNarrator: s.narratorBoundary.speechToNarrator.lines,
      lowConfidence: s.facts.lowConfidence,
      unresolved: s.facts.unresolvedSpeakers,
    } : null,
  };
}

/** The page's data, as plain JSON. */
export function htmlData(input: HtmlInput) {
  const runs = input.configs.flatMap((c) => c.runs);
  return {
    generatedAt: input.generatedAt,
    label: input.label ?? null,
    labels: input.labels,
    reference: input.reference,
    totalCost: runs.reduce((sum, run) => sum + (run.record.cost.value ?? 0), 0),
    runCount: runs.length,
    configs: input.configs.map((c) => ({
      label: c.label,
      model: c.model,
      effort: c.effort,
      group: input.groups[c.model] ?? 'other',
      outcomes: c.outcomes,
      lineAccuracy: statOf(c.lineAccuracy),
      wordAccuracy: statOf(c.wordAccuracy),
      coverage: statOf(c.coverage),
      narration: statOf(c.narrationToCharacterWords),
      speechToNarrator: statOf(c.speechToNarratorLines),
      merges: statOf(c.merges),
      splits: statOf(c.splits),
      cost: statOf(c.cost),
      costEstimated: c.costEstimated,
      wallMs: statOf(c.wallMs),
      calls: statOf(c.calls),
      prompt: statOf(c.promptTokens),
      completion: statOf(c.completionTokens),
      reasoning: statOf(c.reasoningTokens),
      lowConfidence: statOf(c.lowConfidence),
      retries: statOf(c.retries),
      runs: c.runs.map(runData),
    })),
  };
}

/** Embed JSON in a script element: "<" is escaped so the data can never close the element. */
const embed = (value: unknown): string => JSON.stringify(value)
  .replace(/</g, '\\u003c')
  .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
  .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');

export function renderHtml(input: HtmlInput): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Script Benchmark Results</title>
<style>${STYLE}</style>
</head>
<body>
<header class="page">
  <div>
    <p class="eyebrow">Lisen · Script stage</p>
    <h1>Script benchmark</h1>
    <p class="lede" id="lede"></p>
  </div>
  <dl class="tiles" id="tiles"></dl>
</header>
<main>
  <section>
    <div class="section-head">
      <h2>Accuracy against cost</h2>
      <p>One point per model and effort. Higher is better, further left is cheaper. Hover or tap a point for details.</p>
    </div>
    <div class="chart-wrap"><svg id="chart" role="img" aria-label="Attribution accuracy against cost per run"></svg><div class="tip" id="tip" hidden></div></div>
    <div class="legend" id="legend"></div>
  </section>
  <section>
    <div class="section-head">
      <h2>All configurations</h2>
      <p>Click a column to sort and a row to see each run: the lines it got wrong, merged or split characters, and text it changed. Ranges show the spread over repeats.</p>
    </div>
    <div class="controls">
      <label>Label <select id="label"></select></label>
      <label>Group <select id="group"><option value="">All</option></select></label>
      <label>Show <select id="show"><option value="scored">Scored runs</option><option value="all">Everything</option><option value="failed">Rejected and failed</option></select></label>
      <label class="grow">Search <input id="search" type="search" placeholder="model, effort, outcome"></label>
    </div>
    <div class="table-wrap"><table id="table"><thead></thead><tbody></tbody></table></div>
  </section>
  <section id="compare-section" hidden>
    <div class="section-head">
      <h2>Version comparison</h2>
      <p>The same model and effort under two labels.</p>
    </div>
    <div class="controls">
      <label>From <select id="from"></select></label>
      <label>To <select id="to"></select></label>
    </div>
    <div class="table-wrap"><table id="compare"><thead></thead><tbody></tbody></table></div>
  </section>
  <section>
    <div class="section-head"><h2>About the scores</h2></div>
    <div class="notes" id="notes"></div>
  </section>
</main>
<script id="data" type="application/json">${embed(htmlData(input))}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

const STYLE = `
:root {
  --bg: #f7f7f5; --surface: #ffffff; --surface-2: #f0f0ec; --text: #1c1c1a; --muted: #6b6b66; --border: #e2e2dc;
  --accent: #2f5bd3; --good: #1d7a46; --warn: #a86400; --bad: #b3261e;
  --g-frontier: #7b4fd6; --g-mid: #2f5bd3; --g-cheap: #1d8a7a; --g-other: #8a8a84;
  --bar: #cdd8f6; --shadow: 0 1px 2px rgba(0,0,0,.05), 0 2px 8px rgba(0,0,0,.04);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #141413; --surface: #1d1d1b; --surface-2: #262623; --text: #ecece8; --muted: #9a9a93; --border: #33332f;
    --accent: #8aa8ff; --good: #5fcf8f; --warn: #e6a640; --bad: #ff7b72;
    --g-frontier: #b593ff; --g-mid: #7da0ff; --g-cheap: #4fd1bd; --g-other: #8a8a84;
    --bar: #2c3a66; --shadow: none; color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #141413; --surface: #1d1d1b; --surface-2: #262623; --text: #ecece8; --muted: #9a9a93; --border: #33332f;
  --accent: #8aa8ff; --good: #5fcf8f; --warn: #e6a640; --bad: #ff7b72;
  --g-frontier: #b593ff; --g-mid: #7da0ff; --g-cheap: #4fd1bd; --g-other: #8a8a84;
  --bar: #2c3a66; --shadow: none; color-scheme: dark;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em; }
header.page, main { max-width: 1280px; margin: 0 auto; padding: 0 16px; }
header.page { padding-top: 32px; padding-bottom: 8px; display: grid; gap: 20px; }
@media (min-width: 900px) { header.page { grid-template-columns: 1fr auto; align-items: end; } }
.eyebrow { margin: 0; color: var(--muted); font-size: 13px; letter-spacing: .04em; text-transform: uppercase; }
h1 { margin: 4px 0 6px; font-size: 30px; line-height: 1.15; letter-spacing: -.01em; }
h2 { margin: 0; font-size: 19px; }
.lede { margin: 0; color: var(--muted); max-width: 70ch; }
.tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 0; }
@media (min-width: 600px) { .tiles { grid-template-columns: repeat(4, minmax(120px, 1fr)); } }
.tiles div { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; box-shadow: var(--shadow); }
.tiles dt { color: var(--muted); font-size: 12px; }
.tiles dd { margin: 2px 0 0; font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
section { margin: 28px 0; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 18px; box-shadow: var(--shadow); }
.section-head { margin-bottom: 12px; }
.section-head p { margin: 4px 0 0; color: var(--muted); font-size: 14px; }
.chart-wrap { position: relative; }
#chart { width: 100%; height: auto; display: block; }
#chart text { fill: var(--muted); font-size: 11px; }
#chart .axis { stroke: var(--border); }
#chart .grid { stroke: var(--border); stroke-dasharray: 2 4; }
#chart .pt { cursor: pointer; stroke: var(--surface); stroke-width: 1.5; }
#chart .pt.low { opacity: .45; }
#chart .pt:hover, #chart .pt.on { stroke: var(--text); stroke-width: 2; }
#chart .tag { fill: var(--text); font-size: 10.5px; pointer-events: none; }
.tip { position: absolute; z-index: 2; pointer-events: none; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 13px; box-shadow: 0 4px 16px rgba(0,0,0,.15); max-width: 280px; }
.tip b { display: block; }
.legend { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 8px; color: var(--muted); font-size: 13px; }
.legend button { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.legend button[aria-pressed="false"] { opacity: .4; }
.swatch { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.controls { display: flex; flex-wrap: wrap; gap: 10px 16px; margin-bottom: 12px; font-size: 13px; color: var(--muted); }
.controls label { display: flex; flex-direction: column; gap: 3px; }
.controls .grow { flex: 1 1 200px; }
select, input { font: inherit; color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: 7px; padding: 6px 8px; min-width: 0; }
.table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; border: 1px solid var(--border); border-radius: 10px; }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
th, td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; white-space: nowrap; }
th { position: sticky; top: 0; background: var(--surface-2); font-weight: 600; font-size: 12.5px; color: var(--muted); cursor: pointer; user-select: none; }
th[aria-sort="ascending"]::after { content: " ▲"; }
th[aria-sort="descending"]::after { content: " ▼"; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tbody tr.row { cursor: pointer; }
tbody tr.row:hover { background: var(--surface-2); }
tbody tr.row.open { background: var(--surface-2); }
.acc { position: relative; min-width: 120px; }
.acc .bar { position: absolute; inset: 6px auto 6px 0; background: var(--bar); border-radius: 3px; }
.acc span { position: relative; }
.range { color: var(--muted); font-size: 12px; }
.pill { display: inline-block; padding: 1px 8px; border-radius: 99px; font-size: 12px; border: 1px solid currentColor; }
.o-completed { color: var(--good); } .o-blocked { color: var(--warn); } .o-rejected, .o-failed, .o-token-cap, .o-invalid-json, .o-timeout { color: var(--bad); }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; vertical-align: 1px; }
tr.detail td { white-space: normal; background: var(--bg); padding: 14px; }
.runs { display: grid; gap: 14px; position: sticky; left: 14px; width: min(1180px, calc(100vw - 96px)); }
@media (max-width: 600px) { .runs { left: 0; width: calc(100vw - 92px); } }
.run .facts code { word-break: break-all; }
.run { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
.run h4 { margin: 0 0 4px; font-size: 14px; }
.run .facts { color: var(--muted); font-size: 13px; margin: 0 0 8px; }
.run ul { margin: 6px 0; padding-left: 18px; }
.run table { font-size: 13px; }
.run td { white-space: normal; }
.reason { color: var(--bad); font-size: 13px; word-break: break-word; }
.kind { font-size: 12px; color: var(--muted); }
.notes { color: var(--muted); font-size: 14px; max-width: 90ch; }
.notes p { margin: 0 0 8px; }
.delta-up { color: var(--good); } .delta-down { color: var(--bad); }
`;

const SCRIPT = String.raw`
(function () {
  var data = JSON.parse(document.getElementById('data').textContent);
  var GROUP_ORDER = ['frontier', 'mid-range', 'cheap', 'other'];
  var GROUP_VAR = { 'frontier': '--g-frontier', 'mid-range': '--g-mid', 'cheap': '--g-cheap', 'other': '--g-other' };
  var state = { label: data.label, group: '', show: 'scored', search: '', sort: 'lineAccuracy', dir: -1, open: {}, hidden: {} };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function pct(v) { return (v * 100).toFixed(1) + '%'; }
  function money(v) { return v == null ? '–' : v < 0.01 ? '$' + v.toFixed(4) : v < 1 ? '$' + v.toFixed(3) : '$' + v.toFixed(2); }
  function kilo(v) { return v >= 10000 ? Math.round(v / 1000) + 'k' : v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(Math.round(v)); }
  function dur(ms) {
    var s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    return m < 60 ? m + 'm ' + String(s % 60).padStart(2, '0') + 's' : Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
  }
  function show(stat, fmt) {
    if (!stat) return '–';
    var main = fmt(stat.mean);
    return stat.n > 1 && stat.max !== stat.min ? main + ' <span class="range">' + fmt(stat.min) + '–' + fmt(stat.max) + '</span>' : main;
  }
  function color(group) { return 'var(' + (GROUP_VAR[group] || '--g-other') + ')'; }
  function scored(c) { return !!c.lineAccuracy; }
  function outcomeText(o) {
    var keys = Object.keys(o);
    if (keys.length === 1 && o[keys[0]] === 1) return keys[0];
    return keys.map(function (k) { return k + ' ×' + o[k]; }).join(', ');
  }
  function mainOutcome(o) { return o.completed ? 'completed' : Object.keys(o)[0]; }
  function id(c) { return c.label + '|' + c.model + '|' + c.effort; }

  // Header.
  var labels = data.labels.map(function (l) { return l.label; });
  var current = data.labels.filter(function (l) { return l.label === data.label; })[0] || {};
  var scoredRuns = data.configs.reduce(function (n, c) { return n + c.runs.filter(function (r) { return r.score; }).length; }, 0);
  document.getElementById('lede').innerHTML = 'Speaker attribution on <em>The Last Question</em>: ' + data.reference.lines +
    ' scorable character lines, scored against a hand-corrected script. Label <code>' + esc(data.label) + '</code>' +
    (current.commit ? ', commit <code>' + esc(current.commit.slice(0, 7)) + '</code>' + (current.dirty ? ' with uncommitted changes' : '') : '') +
    '. Built ' + esc(new Date(data.generatedAt).toLocaleString()) + '.';
  var best = data.configs.filter(function (c) { return c.label === data.label && c.lineAccuracy; })
    .sort(function (a, b) { return b.lineAccuracy.mean - a.lineAccuracy.mean || (a.cost ? a.cost.mean : 1e9) - (b.cost ? b.cost.mean : 1e9); })[0];
  var tiles = [
    ['Runs', String(data.runCount)],
    ['Scored', String(scoredRuns)],
    ['Total spend', money(data.totalCost)],
    ['Best mean', best ? pct(best.lineAccuracy.mean) : '–'],
  ];
  document.getElementById('tiles').innerHTML = tiles.map(function (t) { return '<div><dt>' + t[0] + '</dt><dd>' + t[1] + '</dd></div>'; }).join('');

  // Controls.
  var labelSelect = document.getElementById('label');
  labelSelect.innerHTML = labels.map(function (l) { return '<option' + (l === data.label ? ' selected' : '') + '>' + esc(l) + '</option>'; }).join('');
  var groups = GROUP_ORDER.filter(function (g) { return data.configs.some(function (c) { return c.group === g; }); });
  document.getElementById('group').innerHTML += groups.map(function (g) { return '<option>' + esc(g) + '</option>'; }).join('');
  labelSelect.onchange = function () { state.label = this.value; render(); };
  document.getElementById('group').onchange = function () { state.group = this.value; render(); };
  document.getElementById('show').onchange = function () { state.show = this.value; render(); };
  document.getElementById('search').oninput = function () { state.search = this.value.toLowerCase(); render(); };

  function visible() {
    return data.configs.filter(function (c) {
      if (c.label !== state.label) return false;
      if (state.group && c.group !== state.group) return false;
      if (state.show === 'scored' && !scored(c)) return false;
      if (state.show === 'failed' && c.outcomes.completed === c.runs.length) return false;
      if (state.search && (c.model + ' ' + c.effort + ' ' + outcomeText(c.outcomes) + ' ' + c.group).toLowerCase().indexOf(state.search) < 0) return false;
      return true;
    });
  }

  // Table.
  var COLUMNS = [
    { key: 'model', title: 'Model', value: function (c) { return c.model; }, cell: function (c) { return '<span class="dot" style="background:' + color(c.group) + '"></span><code>' + esc(c.model) + '</code>'; } },
    { key: 'effort', title: 'Effort', value: function (c) { return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'default'].indexOf(c.effort); }, cell: function (c) { return esc(c.effort); } },
    { key: 'runs', title: 'Runs', num: true, value: function (c) { return c.runs.length; }, cell: function (c) { return String(c.runs.length); } },
    { key: 'outcome', title: 'Outcome', value: function (c) { return outcomeText(c.outcomes); }, cell: function (c) { return '<span class="pill o-' + esc(mainOutcome(c.outcomes)) + '">' + esc(outcomeText(c.outcomes)) + '</span>'; } },
    { key: 'lineAccuracy', title: 'Lines right', num: true, value: function (c) { return c.lineAccuracy ? c.lineAccuracy.mean : -1; },
      cell: function (c) { return c.lineAccuracy ? '<div class="acc"><div class="bar" style="width:' + (c.lineAccuracy.mean * 100).toFixed(1) + '%"></div><span>' + show(c.lineAccuracy, pct) + '</span></div>' : '–'; } },
    { key: 'wordAccuracy', title: 'Words right', num: true, value: function (c) { return c.wordAccuracy ? c.wordAccuracy.mean : -1; }, cell: function (c) { return show(c.wordAccuracy, pct); } },
    { key: 'merges', title: 'Merges', num: true, value: function (c) { return c.merges ? c.merges.mean : 1e9; }, cell: function (c) { return show(c.merges, function (v) { return v.toFixed(v % 1 ? 1 : 0); }); } },
    { key: 'boundary', title: 'Narrator errors', num: true, value: function (c) { return c.narration ? c.narration.mean + c.speechToNarrator.mean : 1e9; },
      cell: function (c) { return c.narration ? show(c.narration, function (v) { return v.toFixed(0); }) + ' / ' + show(c.speechToNarrator, function (v) { return v.toFixed(0); }) : '–'; } },
    { key: 'cost', title: 'Cost / run', num: true, value: function (c) { return c.cost ? c.cost.mean : 1e9; }, cell: function (c) { return show(c.cost, money) + (c.cost && c.costEstimated ? ' <span class="range">est.</span>' : ''); } },
    { key: 'wall', title: 'Wall time', num: true, value: function (c) { return c.wallMs ? c.wallMs.mean : 0; }, cell: function (c) { return show(c.wallMs, dur); } },
    { key: 'calls', title: 'Calls', num: true, value: function (c) { return c.calls ? c.calls.mean : 0; }, cell: function (c) { return show(c.calls, function (v) { return v.toFixed(v % 1 ? 1 : 0); }); } },
    { key: 'tokens', title: 'Tokens in / out (reasoning)', num: true, value: function (c) { return c.completion ? c.completion.mean : 0; },
      cell: function (c) { return c.prompt ? kilo(c.prompt.mean) + ' / ' + kilo(c.completion.mean) + ' <span class="range">(' + kilo(c.reasoning.mean) + ')</span>' : '–'; } },
    { key: 'low', title: 'Low conf.', num: true, value: function (c) { return c.lowConfidence ? c.lowConfidence.mean : -1; }, cell: function (c) { return show(c.lowConfidence, function (v) { return v.toFixed(0); }); } },
  ];
  var table = document.getElementById('table');
  table.tHead.innerHTML = '<tr>' + COLUMNS.map(function (col) {
    return '<th data-key="' + col.key + '"' + (col.num ? ' class="num"' : '') + '>' + col.title + '</th>';
  }).join('') + '</tr>';
  Array.prototype.forEach.call(table.tHead.querySelectorAll('th'), function (th) {
    th.onclick = function () {
      var key = th.getAttribute('data-key');
      if (state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = ['model', 'effort', 'outcome', 'cost', 'wall', 'calls', 'tokens', 'merges', 'boundary', 'low'].indexOf(key) >= 0 ? 1 : -1; }
      render();
    };
  });

  function runDetail(run) {
    var s = run.score;
    var out = '<div class="run"><h4>Run ' + run.repeat + ' · <span class="o-' + esc(run.outcome) + '">' + esc(run.outcome) + '</span></h4>';
    out += '<p class="facts">' + run.calls + ' calls · ' + kilo(run.prompt) + ' in / ' + kilo(run.completion) + ' out (' + kilo(run.reasoning) + ' reasoning) · ' + dur(run.wallMs) +
      ' · ' + money(run.cost) + (run.costBasis === 'estimate' ? ' est.' : '') + ' · ' + run.retries + ' retries, ' + run.invalid + ' invalid replies · <code>' + esc(run.dir) + '</code></p>';
    if (run.reason) out += '<p class="reason">' + esc(run.reason) + '</p>';
    var types = Object.keys(run.byType || {});
    if (types.length) out += '<p class="facts">By call type: ' + types.map(function (t) { var u = run.byType[t]; return esc(t) + ' ' + u.calls + ' (' + money(u.cost) + ')'; }).join(' · ') + '</p>';
    if (!s) return out + '<p class="facts">Nothing to score: the run stopped before its first block was saved.</p></div>';
    out += '<p><b>' + s.correct + '/' + s.lines + '</b> lines right (' + pct(s.lineAccuracy) + ')' + (s.source !== 'script' ? ', scored from the ' + (s.source === 'checkpoint-result' ? 'checkpoint (blocked run)' : 'finished blocks (stopped before verification)') : '') +
      '. Cast ' + s.found + '/' + s.castSize + '.</p><ul>';
    s.merged.forEach(function (m) { out += '<li>Merged ' + m.refs.map(esc).join(' + ') + ' → <b>' + esc(m.run) + '</b></li>'; });
    s.split.forEach(function (m) { out += '<li>Split <b>' + esc(m.ref) + '</b> → ' + m.runs.map(esc).join(' + ') + '</li>'; });
    if (s.mapping.length) out += '<li>Names mapped: ' + s.mapping.map(function (m) { return esc(m.run) + ' → ' + esc(m.ref) + ' <span class="kind">(' + m.method + ')</span>'; }).join('; ') + '</li>';
    if (s.unresolved.length) out += '<li>Unresolved: ' + s.unresolved.map(esc).join(', ') + '</li>';
    if (s.added.length || s.removed.length) out += '<li>Text changed: ' + s.removed.map(function (p) { return '−“' + esc(p) + '”'; }).concat(s.added.map(function (p) { return '+“' + esc(p) + '”'; })).slice(0, 10).join(', ') + '</li>';
    if (s.narration.length) out += '<li>Narration given to a character: ' + s.narration.slice(0, 6).map(function (n) { return esc(n.runSpeaker) + ' “' + esc(n.excerpt) + '”'; }).join('; ') + '</li>';
    out += '</ul>';
    if (s.wrong.length) {
      out += '<div class="table-wrap"><table><thead><tr><th>Kind</th><th>Reference</th><th>Run</th><th>Line</th></tr></thead><tbody>' +
        s.wrong.map(function (w) { return '<tr><td class="kind">' + esc(w.kind) + '</td><td>' + esc(w.ref) + '</td><td>' + esc(w.run) + '</td><td>' + esc(w.text) + '</td></tr>'; }).join('') +
        '</tbody></table></div>';
    } else {
      out += '<p class="facts">Every scorable line went to the right speaker.</p>';
    }
    return out + '</div>';
  }

  function renderTable(rows) {
    var col = COLUMNS.filter(function (c) { return c.key === state.sort; })[0];
    rows.sort(function (a, b) {
      var x = col.value(a), y = col.value(b);
      var d = typeof x === 'string' ? x.localeCompare(y) : x - y;
      return d * state.dir || (b.lineAccuracy ? b.lineAccuracy.mean : -1) - (a.lineAccuracy ? a.lineAccuracy.mean : -1);
    });
    Array.prototype.forEach.call(table.tHead.querySelectorAll('th'), function (th) {
      th.setAttribute('aria-sort', th.getAttribute('data-key') === state.sort ? (state.dir > 0 ? 'ascending' : 'descending') : 'none');
    });
    var html = '';
    rows.forEach(function (c) {
      var key = id(c);
      html += '<tr class="row' + (state.open[key] ? ' open' : '') + '" data-id="' + esc(key) + '">' + COLUMNS.map(function (column) {
        return '<td' + (column.num ? ' class="num"' : '') + '>' + column.cell(c) + '</td>';
      }).join('') + '</tr>';
      if (state.open[key]) html += '<tr class="detail"><td colspan="' + COLUMNS.length + '"><div class="runs">' + c.runs.map(runDetail).join('') + '</div></td></tr>';
    });
    if (!rows.length) html = '<tr><td colspan="' + COLUMNS.length + '">No configurations match.</td></tr>';
    table.tBodies[0].innerHTML = html;
    Array.prototype.forEach.call(table.tBodies[0].querySelectorAll('tr.row'), function (tr) {
      tr.onclick = function () { var k = tr.getAttribute('data-id'); state.open[k] = !state.open[k]; render(); };
    });
  }

  // Chart: accuracy against cost per run, cost on a log scale.
  var svg = document.getElementById('chart');
  var tip = document.getElementById('tip');
  function renderChart(rows) {
    var points = rows.filter(function (c) { return c.lineAccuracy && c.cost && c.cost.mean > 0 && !state.hidden[c.group]; });
    var W = 900, H = 380, L = 54, R = 20, T = 16, B = 44;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    if (!points.length) { svg.innerHTML = '<text x="' + W / 2 + '" y="' + H / 2 + '" text-anchor="middle">No scored runs with a cost to plot.</text>'; return; }
    var costs = points.map(function (p) { return p.cost.mean; });
    var lo = Math.pow(10, Math.floor(Math.log10(Math.min.apply(null, costs))));
    var hi = Math.pow(10, Math.ceil(Math.log10(Math.max.apply(null, costs))));
    // The interesting differences are at the top; anything below the floor is pinned to the bottom edge.
    var yMin = 0.8;
    var below = points.filter(function (p) { return p.lineAccuracy.mean < yMin; }).length;
    function x(v) { return L + (Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) * (W - L - R); }
    function y(v) { return T + (1 - (Math.max(v, yMin) - yMin) / (1 - yMin)) * (H - T - B); }
    var out = '';
    for (var d = lo; d <= hi * 1.0001; d *= 10) {
      out += '<line class="grid" x1="' + x(d) + '" x2="' + x(d) + '" y1="' + T + '" y2="' + (H - B) + '"/>' +
        '<text x="' + x(d) + '" y="' + (H - B + 16) + '" text-anchor="middle">' + money(d) + '</text>';
    }
    var step = 0.05;
    for (var a = 1; a >= yMin - 1e-9; a -= step) {
      out += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(a) + '" y2="' + y(a) + '"/>' +
        '<text x="' + (L - 8) + '" y="' + (y(a) + 4) + '" text-anchor="end">' + Math.round(a * 100) + '%</text>';
    }
    out += '<line class="axis" x1="' + L + '" x2="' + (W - R) + '" y1="' + (H - B) + '" y2="' + (H - B) + '"/>';
    out += '<text x="' + ((L + W - R) / 2) + '" y="' + (H - 6) + '" text-anchor="middle">Cost per run (log scale)</text>';
    if (below) out += '<text x="' + (L + 6) + '" y="' + (H - B - 6) + '">' + below + ' below 80%, pinned to this edge</text>';
    out += '<text transform="translate(14 ' + ((T + H - B) / 2) + ') rotate(-90)" text-anchor="middle">Lines right</text>';
    points.sort(function (p, q) { return q.lineAccuracy.mean - p.lineAccuracy.mean; });
    points.forEach(function (p, i) {
      var r = 5 + Math.min(4, Math.log2(1 + (p.wallMs ? p.wallMs.mean : 0) / 60000));
      out += '<circle class="pt' + (p.lineAccuracy.mean < yMin ? ' low' : '') + '" data-i="' + i + '" cx="' + x(p.cost.mean).toFixed(1) + '" cy="' + y(p.lineAccuracy.mean).toFixed(1) + '" r="' + r.toFixed(1) + '" fill="' + color(p.group) + '"><title>' + esc(p.model + ' · ' + p.effort) + '</title></circle>';
    });
    // Name the points on the frontier (nothing else is both cheaper and at least as accurate), skipping a name that would overlap one already placed.
    var placed = [];
    points.slice().sort(function (p, q) { return p.cost.mean - q.cost.mean; }).forEach(function (p) {
      var dominated = points.some(function (q) { return q !== p && q.cost.mean <= p.cost.mean && q.lineAccuracy.mean >= p.lineAccuracy.mean && (q.cost.mean < p.cost.mean || q.lineAccuracy.mean > p.lineAccuracy.mean); });
      if (dominated || p.lineAccuracy.mean < yMin) return;
      var text = p.model.split('/').pop() + ' · ' + p.effort;
      var tx = x(p.cost.mean) + 9, ty = y(p.lineAccuracy.mean) + 16, width = text.length * 6;
      if (tx + width > W - R) tx = x(p.cost.mean) - 9 - width;
      if (placed.some(function (b) { return tx < b.x + b.w && b.x < tx + width && Math.abs(ty - b.y) < 13; })) return;
      placed.push({ x: tx, y: ty, w: width });
      out += '<text class="tag" x="' + tx.toFixed(1) + '" y="' + ty.toFixed(1) + '">' + esc(text) + '</text>';
    });
    svg.innerHTML = out;
    Array.prototype.forEach.call(svg.querySelectorAll('.pt'), function (el) {
      var p = points[+el.getAttribute('data-i')];
      function on() {
        tip.hidden = false;
        tip.innerHTML = '<b><code>' + esc(p.model) + '</code> · ' + esc(p.effort) + '</b>' + show(p.lineAccuracy, pct) + ' lines right<br>' + show(p.cost, money) + ' per run · ' + show(p.wallMs, dur) +
          '<br>' + p.runs.length + ' run' + (p.runs.length === 1 ? '' : 's') + ' · ' + esc(p.group);
        var box = svg.getBoundingClientRect(), wrap = svg.parentNode.getBoundingClientRect(), pt = el.getBoundingClientRect();
        var left = pt.left - wrap.left + 14, top = pt.top - wrap.top - 10;
        tip.style.left = Math.min(left, box.width - 290) + 'px';
        tip.style.top = Math.max(0, top) + 'px';
      }
      el.onmouseenter = on;
      el.onclick = function (e) { e.stopPropagation(); on(); var k = id(p); state.open[k] = true; state.show = 'all'; document.getElementById('show').value = 'all'; render(); document.querySelector('tr[data-id="' + k.replace(/"/g, '\\"') + '"]').scrollIntoView({ block: 'center', behavior: 'smooth' }); };
      el.onmouseleave = function () { tip.hidden = true; };
    });
  }
  var legend = document.getElementById('legend');
  function renderLegend() {
    legend.innerHTML = groups.map(function (g) {
      return '<button type="button" data-g="' + esc(g) + '" aria-pressed="' + (!state.hidden[g]) + '"><span class="swatch" style="background:' + color(g) + '"></span>' + esc(g) + '</button>';
    }).join('') + '<span>Larger points took longer.</span>';
    Array.prototype.forEach.call(legend.querySelectorAll('button'), function (b) {
      b.onclick = function () { var g = b.getAttribute('data-g'); state.hidden[g] = !state.hidden[g]; render(); };
    });
  }

  // Version comparison.
  var compareSection = document.getElementById('compare-section');
  if (labels.length > 1) {
    compareSection.hidden = false;
    var from = document.getElementById('from'), to = document.getElementById('to');
    from.innerHTML = labels.map(function (l, i) { return '<option' + (i === labels.length - 2 ? ' selected' : '') + '>' + esc(l) + '</option>'; }).join('');
    to.innerHTML = labels.map(function (l) { return '<option' + (l === data.label ? ' selected' : '') + '>' + esc(l) + '</option>'; }).join('');
    from.onchange = to.onchange = renderCompare;
  }
  function renderCompare() {
    if (labels.length < 2) return;
    var a = document.getElementById('from').value, b = document.getElementById('to').value;
    var byKey = function (label) { var m = {}; data.configs.forEach(function (c) { if (c.label === label) m[c.model + '|' + c.effort] = c; }); return m; };
    var A = byKey(a), B = byKey(b);
    var keys = Object.keys(B).filter(function (k) { return A[k]; });
    var t = document.getElementById('compare');
    t.tHead.innerHTML = '<tr><th>Model</th><th>Effort</th><th class="num">Lines right</th><th class="num">Δ</th><th class="num">Cost</th><th class="num">Δ</th><th class="num">Calls</th><th class="num">Wall</th></tr>';
    function delta(v, fmt, goodUp) {
      if (v == null || isNaN(v)) return '–';
      var cls = v === 0 ? '' : (v > 0) === goodUp ? 'delta-up' : 'delta-down';
      return '<span class="' + cls + '">' + (v > 0 ? '+' : v < 0 ? '−' : '±') + fmt(Math.abs(v)) + '</span>';
    }
    var rows = keys.map(function (k) {
      var x = A[k], y = B[k];
      var acc = x.lineAccuracy && y.lineAccuracy ? (y.lineAccuracy.mean - x.lineAccuracy.mean) * 100 : null;
      var cost = x.cost && y.cost ? y.cost.mean - x.cost.mean : null;
      return '<tr><td><code>' + esc(y.model) + '</code></td><td>' + esc(y.effort) + '</td>' +
        '<td class="num">' + show(x.lineAccuracy, pct) + ' → ' + show(y.lineAccuracy, pct) + '</td><td class="num">' + delta(acc, function (v) { return v.toFixed(1) + ' pts'; }, true) + '</td>' +
        '<td class="num">' + show(x.cost, money) + ' → ' + show(y.cost, money) + '</td><td class="num">' + delta(cost, money, false) + (x.cost && y.cost && x.cost.mean > 0 ? ' <span class="range">×' + (y.cost.mean / x.cost.mean).toFixed(2) + '</span>' : '') + '</td>' +
        '<td class="num">' + x.calls.mean.toFixed(1) + ' → ' + y.calls.mean.toFixed(1) + '</td><td class="num">' + dur(x.wallMs.mean) + ' → ' + dur(y.wallMs.mean) + '</td></tr>';
    });
    var onlyA = Object.keys(A).filter(function (k) { return !B[k]; }), onlyB = Object.keys(B).filter(function (k) { return !A[k]; });
    var note = (onlyA.length ? '<tr><td colspan="8" class="range">Only in ' + esc(a) + ': ' + onlyA.map(esc).join(', ').replace(/\|/g, ' · ') + '</td></tr>' : '') +
      (onlyB.length ? '<tr><td colspan="8" class="range">Only in ' + esc(b) + ': ' + onlyB.map(esc).join(', ').replace(/\|/g, ' · ') + '</td></tr>' : '');
    t.tBodies[0].innerHTML = (rows.join('') || '<tr><td colspan="8">No configuration ran under both labels.</td></tr>') + note;
  }

  document.getElementById('notes').innerHTML =
    '<p><b>Lines right</b> is the share of the reference’s character lines given to the right speaker; <b>words right</b> weights each line by its length. Text is aligned word by word, so differently cut segments or a corrected word do not count against a run.</p>' +
    '<p><b>Merges</b> count run speakers that hold the lines of two or more reference characters, such as Cosmic AC and AC folded into Universal AC. <b>Narrator errors</b> are narration words given to a character / character lines given to the narrator.</p>' +
    '<p>Run speaker names are matched to the reference by exact name, then the alias file, then best overlap. A blocked run is scored from its checkpoint, with its unresolved lines counted wrong. Cost is what OpenRouter reported per call; “est.” marks one computed from tokens and listed prices.</p>' +
    (data.reference.unattributable.length ? '<p>Left out of every score: ' + data.reference.unattributable.map(function (u) { return esc(u.speaker) + ' “' + esc(u.text) + '”'; }).join('; ') + ' — it has no double quotation marks, so quoted-mode Script cannot attribute it.</p>' : '');

  function render() {
    var rows = visible();
    renderTable(rows.slice());
    renderChart(data.configs.filter(function (c) { return c.label === state.label && (!state.group || c.group === state.group); }));
    renderLegend();
    renderCompare();
  }
  document.addEventListener('click', function () { tip.hidden = true; });
  render();
})();
`;
