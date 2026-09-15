import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { STAGES, type ProviderId, type Stage } from '../config.js';
import { CastingSchema, CharacterRegistrySchema, VoiceBindingsSchema, type Analysis, type BookMetadata, type Casting, type VoiceBindings, type CharacterRegistry, type ChapterCharacters, type ScriptSegment } from '../types.js';
import { clearArtifactsFrom, discoverBooks, recoverStageStateFromArtifacts, runStage, type PipelineEvent } from '../pipeline/runner.js';
import { WorkDir, type WorkState } from '../state.js';
import { loadVoiceLibrary } from '../voices/library.js';
import { defaultLlmSettings, loadPreferredModels, preferredModelsFile } from './models.js';

interface UiOptions {
  workRoot: string;
  outDir: string;
  port: number;
}

interface LocalJob {
  id: string;
  status: 'running' | 'cancelling' | 'cancelled' | 'completed' | 'failed';
  stage: Stage;
  epubPath: string;
  events: PipelineEvent[];
  startedAt: number;
  finishedAt?: number;
  progress?: PipelineEvent['progress'];
  progressUpdatedAt?: number;
  output?: string;
  error?: string;
  llm?: { provider: ProviderId; model: string };
}

interface UnresolvedSpeakerCandidate {
  key: string;
  speaker: string;
  chapters: number[];
  samples: Array<Pick<ScriptSegment, 'text' | 'delivery' | 'confidence'> & { chapter: number }>;
}

const JSON_LIMIT = 1_000_000;

/** A deliberately local UI: provider credentials and filesystem access stay in Node, never the browser. */
export async function startLocalUi(options: UiOptions): Promise<string> {
  const jobs = new Map<string, LocalJob>();
  const jobControllers = new Map<string, AbortController>();
  let activeJob: LocalJob | undefined;
  const workRoot = path.resolve(options.workRoot);
  const outDir = path.resolve(options.outDir);
  const withUiPaths = (detail: object): object => ({ ...detail, workRoot, outDir });

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${options.port}`);
      if (request.method === 'GET' && url.pathname === '/') return html(response);
      if (request.method === 'GET' && url.pathname === '/api/books') {
        return json(response, 200, discoverBooks(workRoot));
      }
      if (request.method === 'GET' && url.pathname === '/api/book') {
        const root = url.searchParams.get('root');
        return json(response, 200, withUiPaths(root ? bookDetailFromRoot(root, workRoot) : bookDetail(requiredEpub(url), workRoot)));
      }
      if (request.method === 'GET' && url.pathname === '/api/voices') {
        try {
          return json(response, 200, loadVoiceLibrary().voices);
        } catch {
          return json(response, 200, []);
        }
      }
      if (request.method === 'GET' && url.pathname === '/api/settings') {
        return json(response, 200, { ...defaultLlmSettings(), models: loadPreferredModels(), modelsFile: preferredModelsFile });
      }
      if (request.method === 'GET' && url.pathname === '/api/job') {
        const id = url.searchParams.get('id');
        const job = id ? jobs.get(id) : undefined;
        if (!job) return json(response, 404, { error: 'Job not found.' });
        return json(response, 200, job);
      }
      if (request.method === 'POST' && url.pathname === '/api/job/cancel') {
        const body = await bodyJson<{ id?: string }>(request);
        const job = body.id ? jobs.get(body.id) : undefined;
        const controller = body.id ? jobControllers.get(body.id) : undefined;
        if (!job || !controller) return json(response, 404, { error: 'Job not found.' });
        if (job.status !== 'running') return json(response, 409, { error: 'Task is no longer running.' });
        job.status = 'cancelling';
        job.events.push({ type: 'warning', stage: job.stage, message: 'Cancellation requested…' });
        controller.abort();
        return json(response, 202, job);
      }
      if (request.method === 'POST' && url.pathname === '/api/books/open') {
        const body = await bodyJson<{ epub?: string; root?: string }>(request);
        return json(response, 200, withUiPaths(body.root ? bookDetailFromRoot(body.root, workRoot) : bookDetail(requireEpub(body.epub), workRoot)));
      }
      if (request.method === 'POST' && url.pathname === '/api/run') {
        if (activeJob) return json(response, 409, { error: `A ${activeJob.stage} job is already running.` });
        const body = await bodyJson<{ epub?: string; stage?: Stage; chapters?: number[]; rerun?: boolean; rebuild?: boolean; llm?: { provider?: string; model?: string } }>(request);
        const epubPath = requireEpub(body.epub);
        if (!body.stage || !STAGES.includes(body.stage)) return json(response, 400, { error: 'Invalid stage.' });
        const llm = parseLlmSettings(body.llm);
        const job: LocalJob = {
          id: crypto.randomUUID(), status: 'running', stage: body.stage, epubPath, events: [], startedAt: Date.now(),
          llm,
        };
        activeJob = job;
        jobs.set(job.id, job);
        const controller = new AbortController();
        jobControllers.set(job.id, controller);
        void runStage({
          epubPath,
          workRoot,
          outDir,
          stage: body.stage,
          chapterIndexes: body.chapters,
          rerun: body.rerun,
          rebuild: body.rebuild,
          llmProvider: llm.provider,
          llmModel: llm.model,
          signal: controller.signal,
          onEvent: (event) => {
            if (event.progress) {
              job.progress = event.progress;
              job.progressUpdatedAt = Date.now();
            }
            if (!event.heartbeat) job.events.push(event);
            if (event.type === 'warning') console.warn(`  ${event.message}`);
          },
        }).then((result) => {
          if (controller.signal.aborted) {
            job.status = 'cancelled';
            job.events.push({ type: 'warning', stage: job.stage, message: 'Task cancelled by user.' });
          } else {
            job.status = 'completed';
            job.output = result.output;
          }
        }).catch((error: unknown) => {
          if (controller.signal.aborted) {
            job.status = 'cancelled';
            job.events.push({ type: 'warning', stage: job.stage, message: 'Task cancelled by user.' });
          } else {
            job.status = 'failed';
            job.error = error instanceof Error ? error.message : String(error);
          }
        }).finally(() => {
          job.finishedAt = Date.now();
          jobControllers.delete(job.id);
          activeJob = undefined;
        });
        return json(response, 202, job);
      }
      if (request.method === 'POST' && url.pathname === '/api/casting') {
        const body = await bodyJson<{ epub?: string; casting?: Casting; bindings?: VoiceBindings }>(request);
        const epubPath = requireEpub(body.epub);
        const casting = CastingSchema.parse(body.casting);
        const work = new WorkDir(epubPath, workRoot);
        work.writeJson('casting.json', casting);
        work.markDone('casting');
        if (body.bindings) {
          work.writeJson('voice-bindings.json', VoiceBindingsSchema.parse(body.bindings));
          work.markDone('voices');
          work.invalidateFrom('synth');
          clearArtifactsFrom(work, 'synth');
        } else {
          work.invalidateFrom('voices');
          clearArtifactsFrom(work, 'voices');
        }
        return json(response, 200, withUiPaths(bookDetail(epubPath, workRoot)));
      }
      if (request.method === 'POST' && url.pathname === '/api/characters') {
        const body = await bodyJson<{ epub?: string; registry?: CharacterRegistry; resumeFromChapter?: number }>(request);
        const epubPath = requireEpub(body.epub);
        const registry = CharacterRegistrySchema.parse(body.registry);
        validateCharacterRegistry(registry);
        const work = new WorkDir(epubPath, workRoot);
        work.writeJson('characters.json', registry);
        work.markDone('list-characters');
        const resumeFrom = body.resumeFromChapter;
        const canResume = typeof resumeFrom === 'number' && Number.isInteger(resumeFrom) &&
          unresolvedSpeakerCandidates(work.root).some((candidate) => candidate.chapters.includes(resumeFrom));
        if (canResume) {
          // The new identity was first encountered here; preserve earlier, already-attributed chapters.
          work.invalidateAfter('script');
          clearArtifactsFrom(work, 'casting');
          fs.rmSync(work.path('character-candidates'), { recursive: true, force: true });
        } else {
          // General manual registry edits can affect any chapter's attribution.
          work.invalidateFrom('script');
          clearArtifactsFrom(work, 'script');
        }
        return json(response, 200, withUiPaths(bookDetail(epubPath, workRoot)));
      }
      return json(response, 404, { error: 'Not found.' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected server error.';
      return json(response, 400, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return `http://127.0.0.1:${options.port}`;
}

function bookDetail(epubPath: string, workRoot: string): object {
  const work = new WorkDir(epubPath, workRoot);
  recoverStageStateFromArtifacts(work);
  return bookDetailFromRoot(work.root, workRoot, work.snapshot());
}

function bookDetailFromRoot(root: string, workRoot: string, stateOverride?: WorkState): object {
  const workRootResolved = path.resolve(workRoot);
  const rootResolved = path.resolve(root);
  const relative = path.relative(workRootResolved, rootResolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Work folder is outside the configured work directory.');
  let state = stateOverride ?? readJson<WorkState>(path.join(rootResolved, 'state.json'));
  if (!state || typeof state !== 'object' || !('epub' in state) || typeof state.epub !== 'string') {
    throw new Error('This work folder does not contain a valid state.json file.');
  }
  const epubPath = state.epub;
  if (fs.existsSync(epubPath)) {
    const work = new WorkDir(epubPath, workRootResolved);
    if (work.root === rootResolved) {
      recoverStageStateFromArtifacts(work);
      state = work.snapshot();
    }
  }
  const metadata = readJson<BookMetadata>(path.join(rootResolved, 'metadata.json'));
  const analysis = readJson<Analysis>(path.join(rootResolved, 'analysis.json'));
  const characterRegistry = readJson<CharacterRegistry>(path.join(rootResolved, 'characters.json'));
  const characterCandidates = unresolvedSpeakerCandidates(rootResolved);
  const characterObservations = (metadata?.chapters ?? []).filter((chapter) => analysis?.chapters.some((plan) => plan.index === chapter.index && plan.narrate)).map((chapter) => readJson<ChapterCharacters>(path.join(rootResolved, `chapter-characters/${String(chapter.index).padStart(2, '0')}.json`))).filter(Boolean);
  const casting = readJson<Casting>(path.join(rootResolved, 'casting.json'));
  const bindings = readJson<VoiceBindings>(path.join(rootResolved, 'voice-bindings.json'));
  const chapters = metadata?.chapters.map((chapter) => ({
    ...chapter,
    narrate: analysis?.chapters.find((plan) => plan.index === chapter.index)?.narrate ?? false,
    reason: analysis?.chapters.find((plan) => plan.index === chapter.index)?.reason,
    cleaned: fs.existsSync(path.join(rootResolved, `chapters-clean/${String(chapter.index).padStart(2, '0')}.md`)),
    scripted: fs.existsSync(path.join(rootResolved, `script/${String(chapter.index).padStart(2, '0')}.json`)),
    synthesized: fs.existsSync(path.join(rootResolved, `audio/${String(chapter.index).padStart(2, '0')}-segments.json`)),
  })) ?? [];
  return { epubPath, epubAvailable: fs.existsSync(epubPath), root: rootResolved, state, metadata, analysis, characterRegistry, characterCandidates, characterObservations, casting, bindings, chapters };
}

function unresolvedSpeakerCandidates(root: string): UnresolvedSpeakerCandidate[] {
  const candidatesDir = path.join(root, 'character-candidates');
  if (!fs.existsSync(candidatesDir)) return [];
  const groups = new Map<string, UnresolvedSpeakerCandidate>();
  for (const file of fs.readdirSync(candidatesDir).filter((name) => name.endsWith('.json'))) {
    const data = readJson<{ index?: number; candidates?: ScriptSegment[] }>(path.join(candidatesDir, file));
    const index = data?.index;
    if (!data || typeof index !== 'number' || !Number.isInteger(index) || !Array.isArray(data.candidates)) continue;
    for (const candidate of data.candidates) {
      const speaker = candidate.speaker?.trim();
      if (!speaker) continue;
      const key = speaker.normalize('NFKC').toLocaleLowerCase();
      const group = groups.get(key) ?? { key: `candidate-${key}`, speaker, chapters: [], samples: [] };
      if (!group.chapters.includes(index)) group.chapters.push(index);
      if (group.samples.length < 3) group.samples.push({ chapter: index, text: candidate.text, delivery: candidate.delivery, confidence: candidate.confidence });
      groups.set(key, group);
    }
  }
  return [...groups.values()].sort((a, b) => a.speaker.localeCompare(b.speaker));
}

function requiredEpub(url: URL): string {
  return requireEpub(url.searchParams.get('epub') ?? undefined);
}

function requireEpub(value?: string): string {
  if (!value?.trim()) throw new Error('Enter the path to an EPUB file.');
  const epubPath = path.resolve(value.trim());
  if (!fs.existsSync(epubPath)) throw new Error(`EPUB file not found: ${epubPath}`);
  if (!epubPath.toLowerCase().endsWith('.epub')) throw new Error('The selected file must be an .epub file.');
  return epubPath;
}

function readJson<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function parseLlmSettings(value?: { provider?: string; model?: string }): { provider: ProviderId; model: string } {
  const fallback = defaultLlmSettings();
  const provider = value?.provider ?? fallback.provider;
  if (provider !== 'openai' && provider !== 'openrouter') throw new Error('Text provider must be "openai" or "openrouter".');
  const model = value?.model?.trim() ?? fallback.model;
  if (!model) throw new Error('Enter a text-processing model name.');
  if (model.length > 200) throw new Error('Text-processing model names must be 200 characters or fewer.');
  return { provider, model };
}

function validateCharacterRegistry(registry: CharacterRegistry): void {
  const normalize = (value: string): string => value.normalize('NFKC').trim().toLocaleLowerCase();
  const canonical = new Map<string, string>();
  const identities = new Map<string, string>();
  for (const character of registry.characters) {
    const name = character.name.trim();
    const normalized = normalize(name);
    if (!normalized) throw new Error('Every character needs a name.');
    if (normalized === 'narrator') throw new Error('"narrator" is reserved and cannot be a character name.');
    if (canonical.has(normalized)) throw new Error(`Duplicate character name: "${name}" and "${canonical.get(normalized)}".`);
    canonical.set(normalized, name);
    for (const label of [name, ...character.aliases]) {
      const clean = label.trim();
      const key = normalize(clean);
      if (!key) throw new Error(`"${name}" has an empty alias.`);
      const owner = identities.get(key);
      if (owner && owner !== character.id) throw new Error(`"${clean}" is used by both "${owner}" and "${name}". Resolve the duplicate name or alias before saving.`);
      identities.set(key, character.id);
    }
  }
}

async function bodyJson<T>(request: IncomingMessage): Promise<T> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const part of request) {
    const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += buffer.length;
    if (size > JSON_LIMIT) throw new Error('Request body is too large.');
    parts.push(buffer);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as T;
}

function json(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(data));
}

function html(response: ServerResponse): void {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(PAGE);
}

const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lisen — audiobook workspace</title><style>
:root{color-scheme:dark;font-family:ui-rounded,"SF Pro Rounded",system-ui,sans-serif;background:#101725;color:#eaf0ff}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 0 0,#243667,transparent 38rem),#101725;min-height:100vh}.shell{max-width:1280px;margin:auto;padding:38px 24px 80px}header{display:flex;justify-content:space-between;align-items:end;margin-bottom:32px}.header-actions{display:flex;align-items:center;gap:12px}.eyebrow{font-size:.72rem;text-transform:uppercase;letter-spacing:.16em;color:#9eb1df;margin:0 0 8px}h1{margin:0;font-size:2.4rem;letter-spacing:-.06em}h2{font-size:1.1rem;margin:0 0 14px}h3{font-size:.9rem;margin:0}.subtle{color:#aebbd9;font-size:.9rem}.panel{background:rgba(20,30,51,.82);border:1px solid #304267;border-radius:18px;padding:20px;box-shadow:0 20px 55px #070b1526}.open{display:grid;grid-template-columns:1fr auto;gap:10px;margin-bottom:20px}input,textarea,select,button{font:inherit}input,textarea,select{border:1px solid #40547d;background:#101a30;color:#edf3ff;border-radius:9px;padding:10px 12px}button{border:0;border-radius:9px;background:#89f0cb;color:#08231e;font-weight:750;padding:10px 14px;cursor:pointer}button:hover{filter:brightness(1.06)}button:disabled{cursor:not-allowed;opacity:.45}.quiet{background:#263754;color:#dfebff}.danger{background:#6d3c53;color:#ffe6ee}.icon{font-size:1.2rem;line-height:1;padding:9px 11px}.books{display:flex;gap:9px;flex-wrap:wrap}.book{background:#192742;color:#dce9ff;border:1px solid #3c5075}.book.missing{border-color:#a65b70;color:#f1b9c7}.book.active{outline:2px solid #89f0cb}.workspace{display:grid;grid-template-columns:minmax(420px,1.35fr) minmax(280px,.65fr);gap:20px;margin-top:20px}.stages{display:grid;gap:9px}.stage{display:grid;grid-template-columns:12px 1fr auto;gap:12px;align-items:center;padding:13px 14px;background:#15213a;border:1px solid #2c3d61;border-radius:12px}.dot{width:10px;height:10px;border-radius:50%;background:#576984}.dot.done{background:#89f0cb}.dot.stale{background:#f3bd63}.dot.running{background:#91b9ff;animation:pulse 1s infinite}.stage-name{text-transform:capitalize;font-weight:700}.stage-meta{font-size:.77rem;color:#a6b7d9;margin-top:2px}.actions{display:flex;gap:6px}.actions button{padding:7px 10px;font-size:.78rem}.chapter-tools{display:flex;gap:8px;align-items:center;margin:18px 0 10px}.chapter-list{max-height:430px;overflow:auto;border-top:1px solid #2d3c5e}.chapter{display:grid;grid-template-columns:auto 34px 1fr auto;gap:9px;align-items:center;padding:9px 2px;border-bottom:1px solid #263653;font-size:.86rem}.chapter.skip{opacity:.48}.badges{display:flex;gap:4px}.badge{font-size:.66rem;border:1px solid #40547d;color:#bcd1f6;border-radius:99px;padding:2px 5px}.badge.ready{border-color:#3c8f77;color:#9ff1d2}.detail{display:grid;gap:20px}.json{margin:0;max-height:210px;overflow:auto;background:#0e172a;color:#c9d9ff;border-radius:10px;padding:13px;font:12px ui-monospace,SFMono-Regular,monospace;white-space:pre-wrap}.cast{display:grid;gap:9px}.voice-row{display:grid;grid-template-columns:110px 1fr 1.5fr;gap:7px;align-items:center}.voice-row label{font-size:.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.voice-row select,.voice-row input{min-width:0;padding:8px}.toast{position:fixed;right:22px;bottom:22px;z-index:10;max-width:min(420px,calc(100vw - 44px));padding:13px 16px;border:1px solid #41577f;border-radius:12px;background:#283a5e;color:#e2ecff;font-size:.9rem;box-shadow:0 16px 42px #0509138c;opacity:0;transform:translateY(14px);pointer-events:none;transition:opacity .18s ease,transform .18s ease}.toast.visible{opacity:1;transform:translateY(0);pointer-events:auto}.toast.success{background:#173d36;border-color:#3d927a;color:#c3f9e3}.toast.error{background:#563145;border-color:#9e5e72;color:#ffe1e9}.toast.progress{background:#263b64;border-color:#6585be;color:#d9e7ff}dialog{width:min(680px,calc(100vw - 32px));border:1px solid #49618e;border-radius:16px;background:#17233c;color:#edf3ff;box-shadow:0 30px 90px #050913b3;padding:22px}dialog::backdrop{background:#050913aa}.dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}.command{margin:0;overflow:auto;border:1px solid #3c5177;border-radius:9px;background:#0d1628;padding:13px;color:#cbdaff;font:13px ui-monospace,SFMono-Regular,monospace;white-space:pre-wrap;word-break:break-word}.settings-grid{display:grid;gap:14px}.settings-grid label{display:grid;gap:6px;font-size:.86rem;font-weight:700}.model-picker{position:relative}.suggestions{position:absolute;z-index:2;left:0;right:0;top:calc(100% + 4px);max-height:180px;overflow:auto;border:1px solid #49618e;border-radius:9px;background:#101a30;box-shadow:0 14px 32px #050913aa}.suggestions:empty{display:none}.suggestion{display:block;width:100%;border-radius:0;text-align:left;background:transparent;color:#dce9ff;padding:9px 12px;font-weight:500}.suggestion:hover{background:#263b5e}.starred-models{display:flex;gap:7px;flex-wrap:wrap}.starred-models button{padding:6px 9px;font-size:.8rem}.settings-file{overflow-wrap:anywhere;font-size:.78rem}@keyframes pulse{50%{opacity:.35}}@media(max-width:850px){.workspace{grid-template-columns:1fr}.shell{padding:22px 14px}header{align-items:start;flex-direction:column;gap:9px}.open{grid-template-columns:1fr}.voice-row{grid-template-columns:1fr}}
.activity{margin-top:20px}.activity-header{display:flex;justify-content:space-between;align-items:start;gap:12px}.activity-header h2{margin-bottom:14px}.activity-header button{padding:7px 10px;font-size:.8rem}.activity-log{max-height:260px;overflow:auto;display:grid;gap:8px}.activity-event{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:.85rem;color:#bcd1f6}.activity-event.warning{color:#f3bd63}.activity-event.error{color:#ffb6c9}
.chapter-progress{margin-bottom:16px;padding:14px;background:#101a30;border-radius:10px}.chapter-progress p{margin:6px 0}.chapter-progress progress{width:100%;height:14px;accent-color:#89f0cb}
</style></head><body><main class="shell"><header><div><p class="eyebrow">Local audiobook production</p><h1>Lisen workspace</h1></div><div class="header-actions"><p class="subtle">Files and API keys stay on this machine.</p><button class="quiet icon" id="open-settings" aria-label="Text model settings" title="Text model settings">&#9881;</button></div></header><section class="panel"><form class="open" id="open-form"><input id="epub" placeholder="/full/path/to/book.epub" aria-label="EPUB path" required><button>Open EPUB</button></form><div id="books" class="books"></div></section><section id="activity" class="panel activity" hidden aria-labelledby="activity-title"><h2 id="activity-title">Stage activity</h2><p id="activity-status" class="subtle" role="status"></p><div id="chapter-progress" class="chapter-progress" hidden><h3 id="progress-title"></h3><p id="progress-phase" class="subtle" role="status"></p><progress id="progress-bar" max="100" value="0" aria-label="Current activity progress"></progress><p id="progress-text" class="subtle"></p><p id="progress-chapters" class="subtle"></p></div><div id="activity-log" class="activity-log" role="log" aria-live="polite" aria-relevant="additions"></div></section><section id="workspace" class="workspace" hidden><div class="panel"><h2 id="book-title">Pipeline</h2><div id="stages" class="stages"></div><div id="chapter-area" hidden><div class="chapter-tools"><button class="quiet" id="select-all">Select narratable</button><button class="quiet" id="clear-selection">Clear</button><span class="subtle" id="selected-count"></span></div><div id="chapters" class="chapter-list"></div></div></div><aside class="detail"><div class="panel"><h2>Book analysis</h2><p class="subtle">Sampled overview; character candidates are provisional.</p><pre class="json" id="analysis"></pre></div><div class="panel"><h2>Characters</h2><p class="subtle" id="character-status"></p><div id="characters"></div></div><div class="panel"><h2>Voice casting</h2><p class="subtle">Saving changes makes synthesis and assembly stale.</p><form class="cast" id="casting"></form><button id="save-casting">Save casting</button></div></aside></section></main><dialog id="settings-dialog" aria-labelledby="settings-title"><h2 id="settings-title">Text model settings</h2><p class="subtle">Used for Analyze, Chapters, List Characters, Script, and Casting. Synthesis continues to use the saved voice binding.</p><div class="settings-grid"><label>Provider<select id="llm-provider" aria-label="Text provider"><option value="openai">OpenAI</option><option value="openrouter">OpenRouter</option></select></label><label>Model<div class="model-picker"><input id="llm-model" autocomplete="off" spellcheck="false" aria-autocomplete="list" aria-controls="model-suggestions" placeholder="Enter a model name"><div id="model-suggestions" class="suggestions" role="listbox"></div></div></label><div><h3>Starred models</h3><div id="starred-models" class="starred-models"></div></div><p class="subtle settings-file">Edit <code id="models-file"></code> to add models or set <code>starred</code> to true.</p></div><div class="dialog-actions"><button class="quiet" id="close-settings">Close</button><button id="apply-settings">Use for new runs</button></div></dialog><dialog id="cmd-dialog" aria-labelledby="cmd-title"><h2 id="cmd-title">Run from the command line</h2><pre id="cmd-text" class="command"></pre><div class="dialog-actions"><button class="quiet" id="close-cmd">Close</button><button id="copy-cmd">Copy command</button></div></dialog><div id="toast" class="toast" role="status" aria-live="polite"></div><script>
if(document.body)document.body.insertAdjacentHTML('beforeend','<style>.text-link{display:inline-block;margin-top:10px;background:none;border:0;padding:0;color:#9ff1d2;font-weight:700;text-decoration:underline;cursor:pointer}.character-dialog{width:min(900px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto}.character-editors{display:grid;gap:14px}.character-editor{padding:15px;border:1px solid #3c5177;border-radius:12px;background:#101a30}.character-editor.needs-review{border-color:#a88448}.character-editor h3{margin:0 0 10px}.character-editor label{display:grid;gap:5px;font-size:.78rem;color:#bcd1f6}.character-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.character-fields .wide{grid-column:span 2}.character-issues{margin:0 0 10px;padding-left:20px;color:#f3bd63;font-size:.85rem}.character-evidence{margin:12px 0 0}.character-evidence summary{cursor:pointer;color:#bcd1f6;font-size:.85rem}.character-evidence p{margin:7px 0;font-size:.82rem;white-space:pre-wrap}@media(max-width:640px){.character-fields{grid-template-columns:1fr}.character-fields .wide{grid-column:span 1}}</style><dialog id="character-dialog" class="character-dialog" aria-labelledby="character-dialog-title"><h2 id="character-dialog-title">Review book characters</h2><p class="subtle">Correct registry details before scripting. Saving makes Script and later stages stale, but keeps the audio cache.</p><p id="character-review-summary" class="subtle"></p><div id="character-editors" class="character-editors"></div><div class="dialog-actions"><button class="quiet" id="close-character-dialog">Cancel</button><button id="save-characters">Save character registry</button></div></dialog>');
if(document.body)document.head.insertAdjacentHTML('beforeend','<style>.character-editor{padding:0;overflow:hidden}.character-editor>summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 15px;cursor:pointer;font-weight:750}.character-editor>summary:hover{background:#182945}.character-editor .character-body{padding:0 15px 15px}.character-editor.blocking{border-color:#b75a73;box-shadow:0 0 0 1px #b75a7338}.character-editor.blocking>summary{background:#402336}.character-status{font-size:.76rem;font-weight:700;color:#aebbd9}.character-status.blocking{color:#ffc0ce}.character-status.review{color:#f3bd63}</style>');
if(document.body)document.head.insertAdjacentHTML('beforeend','<style>.conflict-choices{display:inline-flex;gap:6px;flex-wrap:wrap;margin:3px 0}.conflict-choice{padding:4px 7px;border:1px solid #a88448;border-radius:7px;background:#263754;color:#ffe09a;font-size:.82rem;font-weight:650}.conflict-choice:hover{background:#4b3b23}.conflict-help{display:block;margin-top:4px;color:#aebbd9;font-size:.77rem}</style>');
if(document.body)document.head.insertAdjacentHTML('beforeend','<style>.unresolved-candidate{padding:14px 15px;border:1px solid #b75a73;border-radius:12px;background:#402336}.unresolved-candidate.resolved{border-color:#3c8f77;background:#173d36}.unresolved-candidate h3{margin:0 0 7px}.candidate-resolution{display:grid;grid-template-columns:1fr auto;gap:9px;align-items:end;margin-top:10px}.candidate-resolution label{display:grid;gap:5px;font-size:.8rem;color:#bcd1f6}.candidate-samples{margin:10px 0 0;font-size:.83rem}.candidate-samples p{margin:6px 0;white-space:pre-wrap}@media(max-width:640px){.candidate-resolution{grid-template-columns:1fr}}</style>');
const stages=['extract','analyze','chapters','list-characters','script','casting','voices','synth','assemble'];let book=null,voices=[],selected=new Set(),job=null,toastTimer=null,activityJobId=null,activityEventCount=0,activityError=null,modelSettings=null,activeLlm=null,candidateResolutions={},scriptResumeFrom=null;
const $=s=>document.querySelector(s);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(url,opts){const r=await fetch(url,opts);const data=await r.json();if(!r.ok)throw Error(data.error||'Request failed.');return data}
function fuzzyScore(value,query){const hay=value.toLowerCase(),needle=query.trim().toLowerCase();if(!needle)return 0;let at=0,score=0;for(const char of needle){const found=hay.indexOf(char,at);if(found<0)return -1;score+=found-at;at=found+1}return score+(hay.startsWith(needle)?-100:0)}
function selectedLlm(){return activeLlm||(modelSettings?{provider:modelSettings.provider,model:modelSettings.model}:null)}
function renderModelSettings(){if(!modelSettings)return;const current=selectedLlm();const provider=$('#llm-provider'),input=$('#llm-model');provider.value=current.provider;input.value=current.model;$('#models-file').textContent=modelSettings.modelsFile;renderModelChoices()}
function renderModelChoices(){if(!modelSettings)return;const provider=$('#llm-provider').value,query=$('#llm-model').value;const matches=modelSettings.models.filter(m=>m.provider===provider).map(m=>({...m,score:fuzzyScore(m.model,query)})).filter(m=>m.score>=0).sort((a,b)=>a.score-b.score||a.model.localeCompare(b.model));$('#model-suggestions').innerHTML=matches.slice(0,8).map(m=>'<button class="suggestion" role="option" data-model-choice="'+esc(m.model)+'">'+esc(m.model)+'</button>').join('');document.querySelectorAll('[data-model-choice]').forEach(x=>x.onclick=()=>{ $('#llm-model').value=x.dataset.modelChoice;renderModelChoices();$('#llm-model').focus() });const starred=modelSettings.models.filter(m=>m.provider===provider&&m.starred);$('#starred-models').innerHTML=starred.length?starred.map(m=>'<button class="quiet" data-model-choice="'+esc(m.model)+'">&#9733; '+esc(m.model)+'</button>').join(''):'<p class="subtle">No starred '+esc(provider)+' models yet.</p>';document.querySelectorAll('#starred-models [data-model-choice]').forEach(x=>x.onclick=()=>{ $('#llm-model').value=x.dataset.modelChoice;renderModelChoices() })}
function notice(message,kind=''){const toast=$('#toast');clearTimeout(toastTimer);toast.textContent=message||'';toast.className='toast '+(message?'visible ':'')+kind;if(message&&kind!=='progress')toastTimer=setTimeout(()=>{toast.className='toast';},5500)}
async function refreshBooks(){const books=await api('/api/books');$('#books').innerHTML=books.length?books.map(b=>'<button class="book '+(!b.epubAvailable?'missing ':'')+(book&&b.root===book.root?'active':'')+'" data-root="'+esc(b.root)+'">'+esc(b.epubPath.split('/').pop())+(b.epubAvailable?'':' · source missing')+'</button>').join(''):'<span class="subtle">No existing work folders yet.</span>';document.querySelectorAll('[data-root]').forEach(x=>x.onclick=()=>openExisting(x.dataset.root));}
async function openBook(epub){try{book=await api('/api/books/open',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({epub})});selected=new Set();$('#workspace').hidden=false;$('#epub').value=book.epubPath;notice(book.state.sourceChanged?'This EPUB differs from the source used for the existing artifacts. Rebuild Extract before running later stages.':'',book.state.sourceChanged?'error':'');render();refreshBooks()}catch(e){notice(e.message,'error')}}
async function openExisting(root){try{book=await api('/api/books/open',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({root})});selected=new Set();$('#workspace').hidden=false;$('#epub').value=book.epubPath;notice(!book.epubAvailable?'Source EPUB is missing. You can inspect this work folder; paste the current EPUB path above to relink it.':book.state.sourceChanged?'This EPUB differs from the source used for the existing artifacts. Rebuild Extract before running later stages.':'',(!book.epubAvailable||book.state.sourceChanged)?'error':'');render();refreshBooks()}catch(e){notice(e.message,'error')}}
function stageState(stage){if(job&&job.status==='running'&&job.stage===stage)return 'running';if(book.state.completed[stage])return 'done';const order=stages.indexOf(stage);return stages.slice(0,order).some(s=>book.state.completed[s])?'stale':'ready'}
function render(){if(!book)return;const title=book.metadata?.title||book.epubPath.split('/').pop();$('#book-title').textContent=title+' · pipeline';$('#analysis').textContent=book.analysis?JSON.stringify(book.analysis,null,2):'Run Analyze to inspect the book.';$('#stages').innerHTML=stages.map(stage=>{const state=stageState(stage),disabled=job||!book.epubAvailable,label=stage==='script'&&scriptResumeFrom!==null?'Resume from chapter '+(scriptResumeFrom+1):'Run';return '<div class="stage"><i class="dot '+state+'"></i><div><div class="stage-name">'+stageLabel(stage)+'</div><div class="stage-meta">'+stageHint(stage,state)+'</div></div><div class="actions"><button class="quiet" data-run="'+stage+'" '+(disabled?'disabled':'')+'>'+label+'</button><button class="danger" data-rebuild="'+stage+'" '+(disabled?'disabled':'')+'>Rebuild all</button><button class="quiet" data-cmd="'+stage+'">Cmd</button></div></div>'}).join('');document.querySelectorAll('[data-run]').forEach(x=>x.onclick=()=>run(x.dataset.run,false));document.querySelectorAll('[data-rebuild]').forEach(x=>x.onclick=()=>run(x.dataset.rebuild,true));document.querySelectorAll('[data-cmd]').forEach(x=>x.onclick=()=>showCommand(x.dataset.cmd));renderChapters();renderCharacters();renderCasting()}
function stageLabel(stage){return stage==='list-characters'?'List Characters':stage}
function stageHint(stage,state){const descriptions={extract:'Read the EPUB into chapters, metadata, and cover art.',analyze:'Sample the book for an overview, initial character candidates, and narration choices.',chapters:'Clean chapters, summarize them, and discover speaking characters.', 'list-characters':'Combine all chapter observations into the book character registry; flag uncertain identities. Offline.',script:'Split prose and dialogue into speaker-attributed segments.',casting:'Describe the intended sound and delivery for each speaker.',voices:'Match the cast to voices from the shared library.',synth:'Turn selected script segments into cached speech audio. TTS usage is billable.',assemble:'Combine synthesized chapters into an M4B with chapter markers.'};if(state==='done')return 'Complete · '+descriptions[stage];if(state==='running')return 'Running locally…';return state==='stale'?'Needs a fresh run · '+descriptions[stage]:descriptions[stage]}
function renderChapters(){const has=book.chapters.length>0;$('#chapter-area').hidden=!has;if(!has)return;$('#selected-count').textContent=selected.size?selected.size+' selected':'';$('#chapters').innerHTML=book.chapters.map(c=>'<label class="chapter '+(!c.narrate?'skip':'')+'"><input type="checkbox" data-chapter="'+c.index+'" '+(!c.narrate?'disabled ':'')+(selected.has(c.index)?'checked':'')+'><span>'+String(c.index+1).padStart(2,'0')+'</span><span>'+esc(c.title)+'</span><span class="badges">'+(c.narrate?'<i class="badge">narrate</i>':'<i class="badge">skip</i>')+(c.cleaned?'<i class="badge ready">clean</i>':'')+(c.scripted?'<i class="badge ready">script</i>':'')+(c.synthesized?'<i class="badge ready">audio</i>':'')+'</span></label>').join('');document.querySelectorAll('[data-chapter]').forEach(x=>x.onchange=()=>{x.checked?selected.add(+x.dataset.chapter):selected.delete(+x.dataset.chapter);render()})}
function renderCharacters(){const observations=book.characterObservations||[],ready=book.state.completed['list-characters'];const registry=book.characterRegistry;$('#character-status').textContent=ready?'Book character registry · '+(registry?.characters.length||0)+' characters':observations.length+' chapters scanned · '+(registry?'Registry needs a fresh List Characters run.':'Run List Characters after all narratable chapters are processed.');const entries=ready&&registry?registry.characters:observations.flatMap(ch=>ch.observations.map(c=>({...c,chapters:[ch.index],issues:c.confidence==='low'?['Needs review']:[]})));$('#characters').innerHTML=(registry?'<button class="text-link" id="open-character-review">Review and edit registry</button>':'')+(entries.length?entries.map(c=>'<details><summary>'+esc(c.name)+' <span class="subtle">· chapters '+c.chapters.map(i=>i+1).join(', ')+'</span></summary><p class="subtle">'+esc(c.aliases.length?'Aliases: '+c.aliases.join(', '):'No known aliases')+'</p><p class="subtle">'+esc([c.sex,c.age,c.country].join(' · '))+'</p>'+(c.issues||[]).map(issue=>'<p class="activity-event warning">'+esc(issue)+'</p>').join('')+'<pre class="json">'+esc(typeof c.evidence==='string'?c.evidence:JSON.stringify(c.evidence,null,2))+'</pre></details>').join(''):'<p class="subtle">No speaking characters discovered.</p>');const review=$('#open-character-review');if(review)review.onclick=openCharacterDialog}
function normCharacter(value){return String(value||'').normalize('NFKC').trim().toLocaleLowerCase()}
function conflictField(issue){return issue.match(/^Conflicting (sex|age|race|class|country):\s*(.+)\.$/)?.[1]}
function reviewIssues(entries){const saved=new Map((book?.characterRegistry?.characters||[]).map(character=>[character.id,character.issues||[]]));const result=new Map(entries.map(character=>[character.id,[...(saved.get(character.id)||[]).filter(issue=>{const field=conflictField(issue);return !field||normCharacter(character[field])==='unknown'})]]));const labels=new Map;for(const character of entries){const incomplete=['sex','age','race','class','country'].filter(field=>normCharacter(character[field])==='unknown');if(!normCharacter(character.name))result.get(character.id).push('A character name is required.');if(incomplete.length)result.get(character.id).push('Incomplete details: '+incomplete.join(', ')+'.');const seen=new Set;for(const label of [character.name,...character.aliases]){const key=normCharacter(label);if(!key||seen.has(key))continue;seen.add(key);const owners=labels.get(key)||[];owners.push(character);labels.set(key,owners)}}for(const [label,owners] of labels)if(owners.length>1)owners.forEach(character=>result.get(character.id).push('Duplicate name or alias "'+label+'" also belongs to '+owners.filter(other=>other.id!==character.id).map(other=>other.name||'an unnamed character').join(', ')+'.'));return result}
function editorValue(row,field){return row.querySelector('[data-character-field="'+field+'"]').value}
function dialogCharacters(){return [...document.querySelectorAll('[data-character-editor]')].map(row=>({id:row.dataset.id,name:editorValue(row,'name').trim(),aliases:editorValue(row,'aliases').split(/[\\n,]/).map(value=>value.trim()).filter(Boolean),sex:editorValue(row,'sex'),age:editorValue(row,'age').trim()||'unknown',race:editorValue(row,'race').trim()||'unknown',class:editorValue(row,'class').trim()||'unknown',country:editorValue(row,'country').trim()||'unknown',importance:editorValue(row,'importance')}))}
function isBlockingIssue(issue){return issue.startsWith('A character name is required')||issue.startsWith('Duplicate name or alias')}
function issueMarkup(issue){const match=issue.match(/^Conflicting (sex|age|race|class|country):\s*(.+)\.$/);if(!match)return '<li>'+esc(issue)+'</li>';const options=match[2].split(' / ').map(value=>value.trim()).filter(Boolean);return '<li>Conflicting '+esc(match[1])+': <span class="conflict-choices">'+options.map(value=>'<button type="button" class="conflict-choice" data-conflict-choice data-conflict-field="'+esc(match[1])+'" data-conflict-value="'+esc(value)+'">'+esc(value)+'</button>').join('')+'</span><span class="conflict-help">Choose the supported value to use for this attribute.</span></li>'}
function refreshCharacterReviewIssues(){const issues=reviewIssues(dialogCharacters());let flagged=0,blocking=0;document.querySelectorAll('[data-character-editor]').forEach(row=>{const list=issues.get(row.dataset.id)||[],hasBlocking=list.some(isBlockingIssue);flagged+=list.length?1:0;blocking+=hasBlocking?1:0;row.classList.toggle('needs-review',list.length>0);row.classList.toggle('blocking',hasBlocking);row.querySelector('[data-character-issues]').innerHTML=list.map(issueMarkup).join('')||'<li class="subtle">No review issues found.</li>';row.querySelectorAll('[data-conflict-choice]').forEach(choice=>choice.onclick=()=>{row.querySelector('[data-character-field="'+choice.dataset.conflictField+'"]').value=choice.dataset.conflictValue;refreshCharacterReviewIssues()});const status=row.querySelector('[data-character-status]');status.textContent=hasBlocking?'Fix before saving':list.length?'Needs review':'Ready';status.className='character-status '+(hasBlocking?'blocking':list.length?'review':'')});const unresolved=unresolvedCandidateCount(),totalBlocking=blocking+unresolved;$('#character-review-summary').textContent=totalBlocking?totalBlocking+' blocking '+(totalBlocking===1?'issue remains':'issues remain')+' before Script can run. '+(unresolved?unresolved+' unresolved speaker '+(unresolved===1?'needs':'need')+' a resolution. ':'')+(flagged-blocking?String(flagged-blocking)+' character '+(flagged-blocking===1?'needs':'need')+' review.':''):flagged?flagged+' character '+(flagged===1?'needs':'need')+' review.':'No duplicate, unresolved, or incomplete profiles found.'}
function field(label,field,value,wide=''){return '<label class="'+wide+'">'+label+'<input data-character-field="'+field+'" value="'+esc(value)+'"></label>'}
function selectField(label,field,value,values){return '<label>'+label+'<select data-character-field="'+field+'">'+values.map(option=>'<option value="'+option+'" '+(value===option?'selected':'')+'>'+option+'</option>').join('')+'</select></label>'}
function unresolvedCandidateCount(){return (book.characterCandidates||[]).filter(candidate=>!candidateResolutions[candidate.key]).length}
function resumeFromCandidateChapter(){const chapters=(book.characterCandidates||[]).flatMap(candidate=>candidate.chapters);return chapters.length?Math.min(...chapters):undefined}
function candidateMarkup(candidate,registry){const resolution=candidateResolutions[candidate.key]||'',selected=resolution==='new'?'new':resolution;return '<section class="unresolved-candidate" data-candidate-editor data-key="'+esc(candidate.key)+'"><h3>Unresolved speaker: '+esc(candidate.speaker)+' <span class="subtle">· chapters '+candidate.chapters.map(index=>index+1).join(', ')+'</span></h3><p class="subtle" data-candidate-status>This speaker blocks Script until it is matched or added.</p><div class="candidate-resolution"><label>Resolve as<select data-candidate-resolution><option value="">Choose a resolution…</option><option value="new" '+(selected==='new'?'selected':'')+'>Add '+esc(candidate.speaker)+' as a new character</option>'+registry.characters.map(character=>'<option value="'+esc(character.id)+'" '+(selected===character.id?'selected':'')+'>Use existing character: '+esc(character.name)+'</option>').join('')+'</select></label></div><details class="candidate-samples"><summary>Script evidence · '+candidate.samples.length+' sample'+(candidate.samples.length===1?'':'s')+'</summary>'+candidate.samples.map(sample=>'<p><strong>Chapter '+(sample.chapter+1)+':</strong> '+esc(sample.text)+(sample.delivery?' <span class="subtle">· '+esc(sample.delivery)+'</span>':'')+'</p>').join('')+'</details></section>'}
function refreshCandidateResolutions(){document.querySelectorAll('[data-candidate-editor]').forEach(row=>{const choice=row.querySelector('[data-candidate-resolution]'),resolved=Boolean(choice.value);candidateResolutions[row.dataset.key]=choice.value;row.classList.toggle('resolved',resolved);row.querySelector('[data-candidate-status]').textContent=resolved?'Will be resolved when you save the registry.':'This speaker blocks Script until it is matched or added.'});refreshCharacterReviewIssues()}
function renderCharacterDialog(){const registry=book.characterRegistry;if(!registry)return;const candidates=(book.characterCandidates||[]).map(candidate=>candidateMarkup(candidate,registry)).join('');$('#character-editors').innerHTML=candidates+registry.characters.map(character=>'<details class="character-editor" data-character-editor data-id="'+esc(character.id)+'"><summary><span>'+esc(character.name||'Unnamed character')+' <span class="subtle">· chapters '+character.chapters.map(index=>index+1).join(', ')+'</span></span><span class="character-status" data-character-status></span></summary><div class="character-body"><ul class="character-issues" data-character-issues></ul><div class="character-fields">'+field('Name','name',character.name)+field('Aliases (comma-separated)','aliases',character.aliases.join(', '),'wide')+selectField('Sex','sex',character.sex,['unknown','female','male'])+field('Age','age',character.age)+field('Race','race',character.race)+field('Role / class','class',character.class)+field('Country / accent','country',character.country)+selectField('Importance','importance',character.importance,['main','secondary','minor'])+'</div><details class="character-evidence"><summary>Evidence · '+character.evidence.length+' item'+(character.evidence.length===1?'':'s')+'</summary>'+character.evidence.map(item=>'<p><strong>Chapter '+(item.chapter+1)+', passage '+(item.chunk+1)+':</strong> '+esc(item.text)+'</p>').join('')+'</details></div></details>').join('');document.querySelectorAll('[data-character-editor] input,[data-character-editor] select').forEach(input=>{input.oninput=refreshCharacterReviewIssues;input.onchange=refreshCharacterReviewIssues});document.querySelectorAll('[data-character-editor]').forEach(row=>row.ontoggle=()=>{if(row.open)document.querySelectorAll('[data-character-editor]').forEach(other=>{if(other!==row)other.open=false})});document.querySelectorAll('[data-candidate-resolution]').forEach(choice=>choice.onchange=refreshCandidateResolutions);refreshCandidateResolutions()}
function openCharacterDialog(event){if(event)event.preventDefault();if(!book.characterRegistry)return;candidateResolutions={};renderCharacterDialog();$('#character-dialog').showModal()}
function applyCandidateResolutions(registry){for(const candidate of book.characterCandidates||[]){const resolution=candidateResolutions[candidate.key];if(!resolution)continue;if(resolution==='new'){registry.characters.push({id:'manual-'+Date.now()+'-'+Math.random().toString(36).slice(2),name:candidate.speaker,aliases:[],sex:'unknown',age:'unknown',race:'unknown',class:'unknown',country:'unknown',importance:'minor',chapters:[...candidate.chapters],evidence:candidate.samples.map(sample=>({chapter:sample.chapter,chunk:0,text:sample.text})),issues:['Added manually from an unresolved script speaker; review the evidence.']});continue}const target=registry.characters.find(character=>character.id===resolution);if(target&&normCharacter(target.name)!==normCharacter(candidate.speaker)&&!target.aliases.some(alias=>normCharacter(alias)===normCharacter(candidate.speaker)))target.aliases.push(candidate.speaker)}return registry}
const characterDialog=$('#character-dialog');if(characterDialog){$('#close-character-dialog').onclick=()=>characterDialog.close();$('#save-characters').onclick=async()=>{if(!book?.characterRegistry)return;if(unresolvedCandidateCount())return notice('Resolve every unresolved speaker before saving.','error');const resumeFromChapter=resumeFromCandidateChapter(),edits=dialogCharacters(),issues=reviewIssues(edits);if([...issues.values()].some(list=>list.some(issue=>issue.startsWith('A character name is required')||issue.startsWith('Duplicate name or alias'))))return notice('Resolve the duplicate or missing character names before saving.','error');const editById=new Map(edits.map(character=>[character.id,character]));const registry=structuredClone(book.characterRegistry);registry.characters=registry.characters.map(character=>{const edit=editById.get(character.id),next={...character,...edit};return {...next,issues:next.issues.filter(issue=>{const field=conflictField(issue);return !field||normCharacter(next[field])==='unknown'})}});applyCandidateResolutions(registry);try{book=await api('/api/characters',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({epub:book.epubPath,registry,resumeFromChapter})});characterDialog.close();if(resumeFromChapter!==undefined){scriptResumeFrom=resumeFromChapter;selected=new Set(book.chapters.filter(chapter=>chapter.narrate&&chapter.index>=resumeFromChapter).map(chapter=>chapter.index))}notice(resumeFromChapter===undefined?'Character registry saved. Script and later stages need a fresh run.':'Character registry saved. Script is ready to resume from chapter '+(resumeFromChapter+1)+'.','success');render();refreshBooks()}catch(e){notice(e.message,'error')}}}
function renderCasting(){const form=$('#casting');if(!book.casting){form.innerHTML='<p class="subtle">Run Casting after at least one scripted chapter.</p>';return}const assignments=[['narrator',book.casting.narrator],...Object.entries(book.casting.characters)];form.innerHTML=assignments.map(([name,a])=>{const binding=name==='narrator'?book.bindings?.narrator:book.bindings?.characters?.[name];const label=a.voiceProfile.presentation+' · '+a.voiceProfile.age+(a.voiceProfile.tone.length?' · '+a.voiceProfile.tone.join(', '):'');return '<div class="voice-row"><label title="'+esc(name)+'">'+esc(name)+'<br><small>'+esc(label)+'</small></label><select data-voice="'+esc(name)+'" '+(!book.bindings?'disabled':'')+'><option value="">'+(book.bindings?'Choose voice':'Run Voices first')+'</option>'+voices.filter(v=>!book.bindings||v.models.includes(book.bindings.target.provider+':'+book.bindings.target.model)).map(v=>'<option value="'+esc(v.id)+'" '+(v.id===binding?.libraryVoiceId?'selected':'')+'>'+esc(v.id)+'</option>').join('')+'</select><input data-instructions="'+esc(name)+'" value="'+esc(a.instructions)+'" aria-label="Instructions for '+esc(name)+'"></div>'}).join('')}
async function run(stage,rebuild){if(stage==='synth'&&!confirm('Synthesis sends the selected text to your configured TTS provider and may incur charges. Continue?'))return;try{const chapters=!rebuild&&['chapters','script','synth','assemble'].includes(stage)&&selected.size?[...selected]:undefined;if(stage==='script')scriptResumeFrom=null;job=await api('/api/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({epub:book.epubPath,stage,chapters,rerun:!rebuild,rebuild,llm:selectedLlm()})});notice('Running '+stageLabel(stage)+(chapters?' for '+chapters.length+' selected chapter'+(chapters.length===1?'':'s'):'')+'…','progress');renderJob(job);render();poll()}catch(e){notice(e.message,'error')}}
function closeTaskButton(){let button=$('#close-task');if(button)return button;button=document.createElement('button');button.id='close-task';button.className='danger';button.textContent='Close task';button.hidden=true;$('#activity').insertBefore(button,$('#activity-status'));return button}
async function closeTask(){if(!job||job.status!=='running')return;const button=closeTaskButton();button.disabled=true;try{job=await api('/api/job/cancel',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:job.id})});renderJob(job)}catch(e){button.disabled=false;notice(e.message,'error')}}
function renderJob(current){
  const close=closeTaskButton();
  close.hidden=current.status!=='running'&&current.status!=='cancelling';
  close.disabled=current.status==='cancelling';
  close.textContent=current.status==='cancelling'?'Cancelling…':'Close task';
  close.onclick=closeTask;
  const log=$('#activity-log');
  if(activityJobId!==current.id){log.replaceChildren();activityJobId=current.id;activityEventCount=0;activityError=null}
  $('#activity').hidden=false;
  const now=current.finishedAt??Date.now();
  const elapsed=current.startedAt===undefined?'':' · '+Math.floor(Math.max(0,now-current.startedAt)/1000)+'s elapsed';
  $('#activity-status').textContent=current.epubPath.split('/').pop()+' · '+current.stage+' · '+current.status+elapsed;
  const progress=current.progress;
  $('#chapter-progress').hidden=!progress;
  if(progress&&'activity' in progress){
    const measured=progress.totalUnits>0&&progress.completedUnits!==undefined;
    const percent=measured?Math.floor(100*progress.completedUnits/progress.totalUnits):0;
    const settled=['completed','skipped'].includes(progress.phase);
    const seconds=Math.floor((progress.elapsedMs+(!settled?Math.max(0,now-(current.progressUpdatedAt??now)):0))/1000);
    $('#progress-title').textContent=progress.chapterIndex===undefined?stageLabel(current.stage).replace(/^./,c=>c.toUpperCase()):'Chapter '+(progress.chapterIndex+1)+': '+progress.chapterTitle;
    $('#progress-phase').textContent=progress.activity+' · '+seconds+'s elapsed';
    $('#progress-bar').hidden=!measured&&(settled||current.status!=='running');
    if(measured)$('#progress-bar').value=percent;else $('#progress-bar').removeAttribute('value');
    $('#progress-text').textContent=measured?progress.completedUnits+'/'+progress.totalUnits+' '+progress.unit+' · '+percent+'%':'';
    $('#progress-chapters').textContent=progress.totalChapters===undefined?'':progress.completedChapters+'/'+progress.totalChapters+' chapters complete';
  }else if(progress){
    const percent=progress.totalChars?Math.floor(100*progress.processedChars/progress.totalChars):0;
    const settled=['completed','skipped'].includes(progress.phase);
    const seconds=Math.floor((progress.elapsedMs+(!settled?Math.max(0,now-(current.progressUpdatedAt??now)):0))/1000);
    const activity={preparing:'Preparing script',attributing:'Attributing block '+progress.block+'/'+progress.totalBlocks,verifying:'Verifying '+progress.ambiguousSegments+' uncertain speaker assignment(s)',saving:'Saving script',completed:'Chapter complete',skipped:'Reusing existing script'}[progress.phase];
    $('#progress-title').textContent='Chapter '+(progress.chapterIndex+1)+': '+progress.chapterTitle;
    $('#progress-phase').textContent=activity+' · '+seconds+'s elapsed';
    $('#progress-bar').hidden=!progress.totalChars;
    $('#progress-bar').value=percent;
    $('#progress-text').textContent=progress.totalChars?percent+'% of text processed':'';
    $('#progress-chapters').textContent=progress.completedChapters+'/'+progress.totalChapters+' chapters complete';
  }
  const atBottom=log.scrollHeight-log.scrollTop-log.clientHeight<24;
  const append=(message,kind)=>{const row=document.createElement('p');row.className='activity-event '+kind;row.textContent=message;log.append(row)};
  for(const event of current.events.slice(activityEventCount))append(event.message,event.type);
  activityEventCount=current.events.length;
  if(current.error&&current.error!==activityError){append(current.error,'error');activityError=current.error}
  if(atBottom)log.scrollTop=log.scrollHeight;
}
function shellQuote(value){return JSON.stringify(String(value))}function showCommand(stage){const chapters=['chapters','script','synth','assemble'].includes(stage)&&selected.size?[...selected]:undefined;const parts=['npm run dev -- run',shellQuote(book.epubPath),stage];if(chapters)parts.push('--chapters',chapters.join(','));parts.push('--rerun','--work',shellQuote(book.workRoot));if(stage==='assemble')parts.push('--out',shellQuote(book.outDir));$('#cmd-title').textContent='Run '+stageLabel(stage)+' from the command line';$('#cmd-text').textContent=parts.join(' ');$('#cmd-dialog').showModal()}async function copyCommand(){const command=$('#cmd-text').textContent;try{await navigator.clipboard.writeText(command);$('#cmd-dialog').close();notice('Command copied.','success')}catch(e){notice('Could not copy the command. Select and copy it manually.','error')}}
async function poll(){if(!job)return;try{const current=await api('/api/job?id='+encodeURIComponent(job.id));job=current;renderJob(current);if(current.status==='running'||current.status==='cancelling'){setTimeout(poll,700);return}if(current.status==='failed')notice(current.error,'error');else if(current.status==='cancelled')notice('Task cancelled.','progress');else notice(current.output?'Created '+current.output:current.events.at(-1)?.message||'Stage complete.','success');job=null;book=await api('/api/book?epub='+encodeURIComponent(book.epubPath));render();refreshBooks()}catch(e){notice(e.message,'error');job=null;render()}}
$('#open-form').onsubmit=e=>{e.preventDefault();openBook($('#epub').value)};$('#select-all').onclick=()=>{book.chapters.filter(c=>c.narrate).forEach(c=>selected.add(c.index));render()};$('#clear-selection').onclick=()=>{selected.clear();render()};$('#open-settings').onclick=async()=>{try{modelSettings=await api('/api/settings');renderModelSettings();$('#settings-dialog').showModal()}catch(e){notice(e.message,'error')}};$('#close-settings').onclick=()=>$('#settings-dialog').close();$('#llm-provider').onchange=renderModelChoices;$('#llm-model').oninput=renderModelChoices;$('#apply-settings').onclick=()=>{const provider=$('#llm-provider').value,model=$('#llm-model').value.trim();if(!model)return notice('Enter a text-processing model name.','error');activeLlm={provider,model};$('#settings-dialog').close();notice('New text-processing runs will use '+provider+' / '+model+'.','success')};$('#close-cmd').onclick=()=>$('#cmd-dialog').close();$('#copy-cmd').onclick=copyCommand;$('#save-casting').onclick=async()=>{if(!book.casting)return;const next={version:2,narrator:{...book.casting.narrator},characters:{}};const bindings=book.bindings?structuredClone(book.bindings):undefined;document.querySelectorAll('[data-voice]').forEach(x=>{const name=x.dataset.voice;const instructions=document.querySelector('[data-instructions="'+CSS.escape(name)+'"]').value;const current=name==='narrator'?book.casting.narrator:book.casting.characters[name];const item={...current,instructions};if(name==='narrator')next.narrator=item;else next.characters[name]=item;if(bindings&&x.value){const voice=voices.find(v=>v.id===x.value);if(voice){const existing=name==='narrator'?bindings.narrator:bindings.characters[name];const assignment={...existing,libraryVoiceId:voice.id,voiceId:voice.nativeVoiceId,selection:'manual',match:{reasons:['Selected manually in the workspace.'],limitations:[]}};if(name==='narrator')bindings.narrator=assignment;else bindings.characters[name]=assignment}}});try{book=await api('/api/casting',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({epub:book.epubPath,casting:next,bindings})});notice('Cast and bindings saved. Existing audio is now stale.','success');render();refreshBooks()}catch(e){notice(e.message,'error')}};Promise.all([refreshBooks(),api('/api/voices'),api('/api/settings')]).then(([,v,settings])=>{voices=v;modelSettings=settings}).catch(e=>notice(e.message,'error'));
</script></body></html>`;
