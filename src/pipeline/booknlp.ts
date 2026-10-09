import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { BookAnnotationsSchema, type BookAnnotations, type BookMetadata, type ChapterMap } from '../types.js';
import type { WorkDir } from '../state.js';
import { reportProgress } from '../util/progress.js';
import { taskCancellationSignal, throwIfTaskCancelled } from '../util/cancellation.js';

export const BOOKNLP_ADAPTER_VERSION = '1';
export const BOOKNLP_PIPELINE = 'entity,quote,coref' as const;
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/booknlp.py');

interface TokenRow { id: number; start: number; end: number; text: string }
type Mention = BookAnnotations['mentions'][number];

export async function runBookNlp(work: WorkDir): Promise<BookAnnotations> {
  const metadata = work.readJson<BookMetadata>('metadata.json');
  if (metadata.language.split(/[-_]/, 1)[0].toLowerCase() !== 'en') {
    throw new Error(`BookNLP currently supports English only; this book is marked ${JSON.stringify(metadata.language)}. Correct the language metadata or use an English source.`);
  }
  const { text, map } = prepareBookNlpInput(work, metadata);
  const details = await preflightBookNlp();
  const fingerprint = hashJson({ inputSha256: map.inputSha256, model: config.booknlpModel, pipeline: BOOKNLP_PIPELINE, toolVersion: details.toolVersion, adapterVersion: BOOKNLP_ADAPTER_VERSION });
  const annotationsFile = work.path('booknlp', 'annotations.json');
  if (fs.existsSync(annotationsFile)) {
    const existing = BookAnnotationsSchema.safeParse(JSON.parse(fs.readFileSync(annotationsFile, 'utf8')));
    const rawComplete = ['book.tokens', 'book.quotes', 'book.entities', 'book.book']
      .every((file) => fs.existsSync(work.path('booknlp', 'output', file)));
    if (existing.success && existing.data.provenance.fingerprint === fingerprint && rawComplete) {
      reportProgress({ activity: 'Reusing compatible BookNLP annotations', phase: 'completed' });
      return existing.data;
    }
  }

  const booknlpDir = work.dir('booknlp');
  const pendingRoot = fs.mkdtempSync(path.join(booknlpDir, '.pending-'));
  const pendingOutput = path.join(pendingRoot, 'output');
  reportProgress({ activity: `Running BookNLP ${config.booknlpModel} model over the complete book` });
  try {
    await runProcess([
      'run', '--no-capture-output', '-n', config.booknlpEnvironment, 'python', SCRIPT,
      work.path('booknlp', 'input.txt'), '--output-dir', pendingOutput, '--book-id', 'book', '--model', config.booknlpModel,
    ], config.booknlpTimeoutMs);
    throwIfTaskCancelled();
    for (const file of ['book.tokens', 'book.quotes', 'book.entities', 'book.book']) {
      if (!fs.existsSync(path.join(pendingOutput, file))) throw new Error(`BookNLP completed without required ${file} output.`);
    }
    const annotations = normalizeBookNlpOutput(text, map, pendingOutput, {
      toolVersion: details.toolVersion,
      model: config.booknlpModel,
      fingerprint,
      sourcePath: work.snapshot().source,
      sourceHash: work.snapshot().sourceHash,
    });
    fs.writeFileSync(path.join(pendingRoot, 'annotations.json'), JSON.stringify(annotations, null, 2));
    publishDirectory(pendingOutput, work.path('booknlp', 'output'));
    atomicReplace(path.join(pendingRoot, 'annotations.json'), annotationsFile);
    reportProgress({ activity: `Saved ${annotations.quotations.length} quotations and ${annotations.mentions.length} entity mentions`, phase: 'completed' });
    return annotations;
  } finally {
    fs.rmSync(pendingRoot, { recursive: true, force: true });
  }
}

export function prepareBookNlpInput(work: WorkDir, metadata = work.readJson<BookMetadata>('metadata.json')): { text: string; map: ChapterMap } {
  const analysis = work.readJson<{ chapters: Array<{ index: number; narrate: boolean }> }>('analysis.json');
  const chapters = metadata.chapters.filter((chapter) => analysis.chapters.some((plan) => plan.index === chapter.index && plan.narrate));
  let text = '';
  const mapped: ChapterMap['chapters'] = [];
  for (const chapter of chapters) {
    const preparedFile = work.path(`chapters-clean/${String(chapter.index).padStart(4, '0')}.txt`);
    if (!fs.existsSync(preparedFile)) throw new Error(`Prepared plain text is missing for chapter ${chapter.index + 1}. Run chapters first.`);
    if (text) text += '\n\n';
    const start = codePointLength(text);
    const chapterText = fs.readFileSync(preparedFile, 'utf8');
    text += chapterText;
    mapped.push({ index: chapter.index, title: chapter.title, start, end: codePointLength(text), titleInText: startsWithTitle(chapterText, chapter.title) });
  }
  const inputSha256 = crypto.createHash('sha256').update(text).digest('hex');
  const map: ChapterMap = { version: 1, offsetConvention: 'unicode-code-points-half-open', inputSha256, chapters: mapped };
  work.dir('booknlp');
  atomicWrite(work.path('booknlp', 'input.txt'), text);
  atomicWrite(work.path('booknlp', 'chapter-map.json'), JSON.stringify(map, null, 2));
  return { text, map };
}

export function normalizeBookNlpOutput(
  input: string,
  chapterMap: ChapterMap,
  outputDir: string,
  provenance: { toolVersion: string; model: 'big' | 'small'; fingerprint: string; sourcePath?: string; sourceHash?: string },
): BookAnnotations {
  validateChapterMap(chapterMap, input);
  const tokens = parseTokens(path.join(outputDir, 'book.tokens'), input);
  const mentions = parseEntities(path.join(outputDir, 'book.entities'), tokens, input);
  const mentionsBySpan = new Map(mentions.map((mention) => [`${mention.startToken}:${mention.endToken}`, mention]));
  const quoteRows = parseTsv(path.join(outputDir, 'book.quotes'));
  const quotations: BookAnnotations['quotations'] = quoteRows.map((row, index) => {
    const startToken = integer(row.quote_start, 'quote_start');
    const endToken = integer(row.quote_end, 'quote_end');
    const span = tokenSpan(tokens, startToken, endToken, input);
    const chapter = chapterForSpan(chapterMap, span.start, span.end);
    const mentionStart = optionalInteger(row.mention_start);
    const mentionEnd = optionalInteger(row.mention_end);
    const mention = mentionStart === null || mentionEnd === null ? null : mentionsBySpan.get(`${mentionStart}:${mentionEnd}`) ?? null;
    if (mentionStart !== null && mentionEnd !== null && !mention) throw new Error(`Malformed BookNLP quotation ${index}: attributed mention ${mentionStart}..${mentionEnd} is absent from entities output.`);
    const rawEntity = nullish(row.char_id);
    const entityId = rawEntity === null ? null : `booknlp:${rawEntity}`;
    if (entityId && entityId !== 'booknlp:0' && !mentions.some((candidate) => candidate.entityId === entityId)) throw new Error(`Malformed BookNLP quotation ${index}: speaker ${entityId} is absent from entities output.`);
    return {
      id: `quote-${crypto.createHash('sha256').update(`${span.start}\x1f${span.end}\x1f${span.text}`).digest('hex').slice(0, 16)}`,
      startToken, endToken, ...span, chapterIndex: chapter?.index ?? null,
      entityId, mention,
      assignment: entityId && chapter ? 'generated' as const : 'unresolved' as const,
    };
  });
  for (let i = 1; i < quotations.length; i++) {
    if (quotations[i].start < quotations[i - 1].end) throw new Error(`Malformed BookNLP output: quotation ${i} overlaps the previous quotation.`);
  }
  return BookAnnotationsSchema.parse({
    version: 1,
    source: { inputSha256: chapterMap.inputSha256, offsetConvention: 'unicode-code-points-half-open', sourcePath: provenance.sourcePath, sourceHash: provenance.sourceHash },
    provenance: { tool: 'booknlp', toolVersion: provenance.toolVersion, model: provenance.model, pipeline: BOOKNLP_PIPELINE, adapterVersion: BOOKNLP_ADAPTER_VERSION, fingerprint: provenance.fingerprint },
    mentions,
    quotations,
  });
}

function validateChapterMap(map: ChapterMap, input: string): void {
  const actualHash = crypto.createHash('sha256').update(input).digest('hex');
  if (map.inputSha256 !== actualHash) throw new Error('chapter-map.json does not match the frozen BookNLP input. Rebuild BookNLP preparation.');
  const length = codePointLength(input);
  let previousEnd = 0;
  const indexes = new Set<number>();
  for (const chapter of map.chapters) {
    if (indexes.has(chapter.index)) throw new Error(`chapter-map.json repeats chapter index ${chapter.index}.`);
    if (chapter.start < previousEnd || chapter.end < chapter.start || chapter.end > length) throw new Error(`chapter-map.json has invalid or unordered boundaries for chapter ${chapter.index}.`);
    indexes.add(chapter.index); previousEnd = chapter.end;
  }
}

export function codePointOffsetToUtf16(text: string, offset: number): number {
  if (!Number.isInteger(offset) || offset < 0) throw new Error(`Invalid Unicode code-point offset ${offset}.`);
  let codePoints = 0;
  let utf16 = 0;
  while (utf16 < text.length && codePoints < offset) {
    const value = text.codePointAt(utf16)!;
    utf16 += value > 0xffff ? 2 : 1;
    codePoints++;
  }
  if (codePoints !== offset) throw new Error(`Unicode code-point offset ${offset} exceeds input length ${codePoints}.`);
  return utf16;
}

function parseTokens(file: string, input: string): TokenRow[] {
  const rows = parseTsv(file);
  return rows.map((row, expected) => {
    const id = integer(row.token_ID_within_document, 'token id');
    if (id !== expected) throw new Error(`Malformed BookNLP tokens: expected token ${expected}, found ${id}.`);
    const start = integer(row.byte_onset, 'byte_onset');
    const end = integer(row.byte_offset, 'byte_offset');
    if (end < start || end > codePointLength(input)) throw new Error(`Malformed BookNLP token ${id}: invalid source range ${start}..${end}.`);
    if (expected > 0 && start < Number(rows[expected - 1].byte_offset)) throw new Error(`Malformed BookNLP token ${id}: source spans overlap or are out of order.`);
    const text = sliceCodePoints(input, start, end);
    return { id, start, end, text };
  });
}

function parseEntities(file: string, tokens: TokenRow[], input: string): Mention[] {
  return parseTsv(file).map((row) => {
    const startToken = integer(row.start_token, 'entity start_token');
    const endToken = integer(row.end_token, 'entity end_token');
    const span = tokenSpan(tokens, startToken, endToken, input);
    const prop = row.prop?.toUpperCase();
    return {
      entityId: `booknlp:${row.COREF}`,
      startToken, endToken, ...span,
      kind: prop === 'PROP' ? 'proper' : prop === 'PRON' ? 'pronoun' : 'common',
      category: row.cat ?? 'unknown',
    };
  });
}

function tokenSpan(tokens: TokenRow[], startToken: number, endToken: number, input: string): { start: number; end: number; text: string } {
  const first = tokens[startToken]; const last = tokens[endToken];
  if (!first || !last || endToken < startToken) throw new Error(`Malformed BookNLP token range ${startToken}..${endToken}.`);
  return { start: first.start, end: last.end, text: sliceCodePoints(input, first.start, last.end) };
}

function parseTsv(file: string): Array<Record<string, string>> {
  if (!fs.existsSync(file)) throw new Error(`BookNLP output is incomplete: missing ${path.basename(file)}.`);
  const lines = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').split('\n').filter(Boolean);
  if (!lines.length) throw new Error(`BookNLP output is malformed: ${path.basename(file)} is empty.`);
  const header = lines[0].split('\t');
  return lines.slice(1).map((line, lineNumber) => {
    const values = line.split('\t');
    if (values.length < header.length) throw new Error(`Malformed ${path.basename(file)} line ${lineNumber + 2}.`);
    return Object.fromEntries(header.map((name, index) => [name, index === header.length - 1 ? values.slice(index).join('\t') : values[index]]));
  });
}

async function preflightBookNlp(): Promise<{ toolVersion: string }> {
  reportProgress({ activity: 'Checking the configured BookNLP environment and model files' });
  const output = await runProcess(['run', '--no-capture-output', '-n', config.booknlpEnvironment, 'python', SCRIPT, '--check-only', '--model', config.booknlpModel], 60_000, true);
  try { return JSON.parse(output.trim().split('\n').at(-1)!) as { toolVersion: string }; }
  catch { throw new Error('BookNLP dependency check returned malformed output. Run the configured Conda command manually for details.'); }
}

async function runProcess(args: string[], timeoutMs: number, capture = false): Promise<string> {
  const signal = taskCancellationSignal();
  return new Promise((resolve, reject) => {
    let output = '';
    let finished = false;
    const child = spawn(config.condaExecutable, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; terminate(child.pid); }, timeoutMs);
    const abort = () => terminate(child.pid);
    signal?.addEventListener('abort', abort, { once: true });
    const onData = (chunk: Buffer) => {
      const message = chunk.toString(); output += message;
      if (!capture) for (const line of message.split(/\r?\n/).filter(Boolean)) reportProgress({ activity: `BookNLP: ${line.slice(0, 300)}` });
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.once('error', (error) => finish(() => reject(new Error(`Could not start BookNLP with ${config.condaExecutable}: ${error.message}`))));
    child.once('exit', (code, sig) => finish(() => {
      if (signal?.aborted) reject(new Error('BookNLP was cancelled.'));
      else if (timedOut) reject(new Error(`BookNLP exceeded the ${Math.round(timeoutMs / 60000)} minute timeout and was terminated.`));
      else if (code !== 0) reject(new Error(`BookNLP failed${sig ? ` with signal ${sig}` : ` with exit code ${code}`}: ${output.trim().slice(-2000)}`));
      else resolve(output);
    }));
    function finish(done: () => void) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      done();
    }
  });
}

function terminate(pid: number | undefined): void {
  if (!pid) return;
  try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGTERM'); } catch { /* already exited */ }
  setTimeout(() => { try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL'); } catch { /* exited */ } }, 3_000).unref();
}

function publishDirectory(pending: string, destination: string): void {
  const backup = `${destination}.previous-${process.pid}`;
  fs.rmSync(backup, { recursive: true, force: true });
  if (fs.existsSync(destination)) fs.renameSync(destination, backup);
  try { fs.renameSync(pending, destination); fs.rmSync(backup, { recursive: true, force: true }); }
  catch (error) { if (!fs.existsSync(destination) && fs.existsSync(backup)) fs.renameSync(backup, destination); throw error; }
}

function atomicWrite(file: string, data: string): void { const pending = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`; fs.writeFileSync(pending, data); fs.renameSync(pending, file); }
function atomicReplace(source: string, destination: string): void { const pending = `${destination}.tmp-${crypto.randomUUID()}`; fs.copyFileSync(source, pending); fs.renameSync(pending, destination); }
function codePointLength(text: string): number { return [...text].length; }
function sliceCodePoints(text: string, start: number, end: number): string { return text.slice(codePointOffsetToUtf16(text, start), codePointOffsetToUtf16(text, end)); }
function integer(value: string | undefined, label: string): number { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Malformed BookNLP ${label}: ${JSON.stringify(value)}.`); return parsed; }
function optionalInteger(value: string | undefined): number | null { const clean = nullish(value); return clean === null ? null : integer(clean, 'optional integer'); }
function nullish(value: string | undefined): string | null { return !value || value === 'None' || value === 'null' ? null : value; }
function chapterForSpan(map: ChapterMap, start: number, end: number) { return map.chapters.find((chapter) => start >= chapter.start && end <= chapter.end); }
function startsWithTitle(text: string, title: string): boolean { const normalize = (value: string) => value.normalize('NFKC').replace(/^\W+|\W+$/gu, '').replace(/\s+/g, ' ').toLowerCase(); return normalize(text.split(/\n\n|\n/, 1)[0]) === normalize(title); }
function hashJson(value: unknown): string { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
