import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { STAGES, withLlmRunConfig, type OpenRouterReasoningEffort, type ProviderId, type Stage } from '../config.js';
import { CastingSchema, CharacterRegistrySchema, ChapterScriptSchema, StoriesSchema, VoiceBindingsSchema, type BookMetadata, type Casting, type VoiceBindings, type CharacterRegistry } from '../types.js';
import { clearArtifactsFrom, discoverBooks, runStage, saveStoryGrouping, type PipelineEvent } from '../pipeline/runner.js';
import { OUTDATED_WORK_FOLDER_MESSAGE, openWorkDir, type WorkDir, type WorkState } from '../state.js';
import { AUDIO_DIR, CHARACTERS_FILE, MANIFEST_EXT, METADATA_FILE, SCRIPTS_DIR, USAGE_FILE, listChapterFiles } from '../layout.js';
import { loadVoiceLibrary } from '../voices/library.js';
import { defaultAudioSettings, defaultLlmSettings, loadPreferredAudioModels, loadPreferredModels, preferredAudioModelsFile, preferredModelsFile } from './models.js';
import { reconcileUnresolvedSpeakers } from '../pipeline/reconcile-speakers.js';
import { buildStories, readStories, readStoriesFile } from '../pipeline/stories.js';
import { nameKey, readCharacterRegistry, renameSpeakers, validateCharacterRegistry, writeCharacterRegistry } from '../pipeline/cast.js';
import { sourceFormatForPath, sourceIsAvailable, supportedSourceDescription, type SourceMetadataOverrides } from '../source/read.js';

interface UiOptions {
  workRoot: string;
  /** Optional M4B export directory; defaults to each book's work folder. */
  outDir?: string;
  port: number;
}

interface LocalJob {
  id: string;
  status: 'running' | 'cancelling' | 'cancelled' | 'completed' | 'failed';
  stage: Stage;
  sourcePath: string;
  events: PipelineEvent[];
  startedAt: number;
  finishedAt?: number;
  progress?: PipelineEvent['progress'];
  progressUpdatedAt?: number;
  output?: string;
  error?: string;
  llm?: { provider: ProviderId; model: string; scriptModel?: string; scriptReasoningEffort: OpenRouterReasoningEffort };
}

const JSON_LIMIT = 1_000_000;

/** A deliberately local UI: provider credentials and filesystem access stay in Node, never the browser. */
export async function startLocalUi(options: UiOptions): Promise<string> {
  const jobs = new Map<string, LocalJob>();
  const jobControllers = new Map<string, AbortController>();
  let activeJob: LocalJob | undefined;
  const workRoot = path.resolve(options.workRoot);
  const outDir = options.outDir ? path.resolve(options.outDir) : undefined;
  const withUiPaths = (detail: object): object => ({ ...detail, workRoot, ...(outDir ? { outDir } : {}) });

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${options.port}`);
      if (request.method === 'GET' && url.pathname === '/') return html(response);
      if (request.method === 'GET' && url.pathname === '/api/books') {
        return json(response, 200, discoverBooks(workRoot));
      }
      if (request.method === 'GET' && url.pathname === '/api/book') {
        const root = url.searchParams.get('root');
        return json(response, 200, withUiPaths(root ? await bookDetailFromRoot(root, workRoot) : await bookDetail(requiredSource(url), workRoot)));
      }
      if (request.method === 'GET' && url.pathname === '/api/voices') {
        try {
          return json(response, 200, loadVoiceLibrary().voices);
        } catch {
          return json(response, 200, []);
        }
      }
      if (request.method === 'GET' && url.pathname === '/api/settings') {
        return json(response, 200, {
          ...defaultLlmSettings(),
          models: loadPreferredModels(),
          modelsFile: preferredModelsFile,
          audio: {
            ...defaultAudioSettings(),
            models: loadPreferredAudioModels(),
            modelsFile: preferredAudioModelsFile,
          },
        });
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
        const body = await bodyJson<{ source?: string; root?: string; metadata?: SourceMetadataOverrides }>(request);
        const sourcePath = body.root ? undefined : requireSource(body.source);
        if (sourcePath && body.metadata) (await openWorkDir(sourcePath, workRoot, body.metadata)).setMetadataOverrides(body.metadata);
        return json(response, 200, withUiPaths(body.root ? await bookDetailFromRoot(body.root, workRoot) : await bookDetail(sourcePath!, workRoot)));
      }
      if (request.method === 'POST' && url.pathname === '/api/run') {
        if (activeJob) return json(response, 409, { error: `A ${activeJob.stage} job is already running.` });
        const body = await bodyJson<{ source?: string; stage?: Stage; chapters?: number[]; rerun?: boolean; rebuild?: boolean; llm?: { provider?: string; model?: string; scriptModel?: string; scriptReasoningEffort?: string }; audio?: { provider?: string; model?: string } }>(request);
        const sourcePath = requireSource(body.source);
        if (!body.stage || !STAGES.includes(body.stage)) return json(response, 400, { error: 'Invalid stage.' });
        const llm = parseLlmSettings(body.llm);
        if (body.stage === 'script') {
          const work = await openWorkDir(sourcePath, workRoot);
          const metadata = readJson<BookMetadata>(work.path(METADATA_FILE));
          if (metadata?.profile?.isFiction === false) llm.scriptReasoningEffort = 'none';
        }
        const audio = parseAudioSettings(body.audio);
        const job: LocalJob = {
          id: crypto.randomUUID(), status: 'running', stage: body.stage, sourcePath, events: [], startedAt: Date.now(),
          llm,
        };
        activeJob = job;
        jobs.set(job.id, job);
        const controller = new AbortController();
        jobControllers.set(job.id, controller);
        void runStage({
          sourcePath,
          workRoot,
          outDir,
          stage: body.stage,
          chapterIndexes: body.chapters,
          rerun: body.rerun,
          rebuild: body.rebuild,
          llmProvider: llm.provider,
          llmModel: llm.model,
          scriptModel: llm.scriptModel,
          scriptReasoningEffort: llm.scriptReasoningEffort,
          voiceTarget: audio,
          signal: controller.signal,
          runId: job.id,
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
        const body = await bodyJson<{ source?: string; casting?: Casting; bindings?: VoiceBindings }>(request);
        const sourcePath = requireSource(body.source);
        const casting = CastingSchema.parse(body.casting);
        const work = await openWorkDir(sourcePath, workRoot);
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
        return json(response, 200, withUiPaths(await bookDetail(sourcePath, workRoot)));
      }
      if (request.method === 'POST' && url.pathname === '/api/characters') {
        if (activeJob) return json(response, 409, { error: `A ${activeJob.stage} job is already running.` });
        const body = await bodyJson<{ source?: string; registry?: CharacterRegistry }>(request);
        const sourcePath = requireSource(body.source);
        const work = await openWorkDir(sourcePath, workRoot);
        saveCharacterRegistry(work, CharacterRegistrySchema.parse(body.registry));
        return json(response, 200, withUiPaths(await bookDetail(sourcePath, workRoot)));
      }
      if (request.method === 'POST' && url.pathname === '/api/stories') {
        const body = await bodyJson<{ source?: string; collection?: boolean; stories?: unknown }>(request);
        const sourcePath = requireSource(body.source);
        const work = await openWorkDir(sourcePath, workRoot);
        const metadata = readJson<BookMetadata>(work.path(METADATA_FILE));
        if (!metadata?.profile) throw new Error('Run Metadata before grouping stories.');
        const collection = body.collection === true;
        // Without an explicit grouping, fall back to the derived default:
        // one story per chapter for a collection, one for a continuous work.
        const grouping = body.stories === undefined
          ? buildStories(collection, metadata)
          : StoriesSchema.parse({ version: 1, collection, stories: body.stories });
        saveStoryGrouping(work, grouping);
        return json(response, 200, withUiPaths(await bookDetail(sourcePath, workRoot)));
      }
      if (request.method === 'POST' && url.pathname === '/api/speaker-reconciliation') {
        if (activeJob) return json(response, 409, { error: `A ${activeJob.stage} job is already running.` });
        const body = await bodyJson<{ source?: string; llm?: { provider?: string; model?: string } }>(request);
        const sourcePath = requireSource(body.source);
        const work = await openWorkDir(sourcePath, workRoot);
        if (work.sourceChanged()) throw new Error('The selected source differs from the source used for this work folder. Rebuild Extract before reconciling speakers.');
        const llm = parseLlmSettings(body.llm);
        const suggestions = await withLlmRunConfig(llm, () => reconcileUnresolvedSpeakers(work));
        return json(response, 200, { suggestions });
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

/**
 * Save a cast edited in review. A renamed character, or one folded into
 * another by listing its name as an alias, is renamed in the saved scripts
 * offline. The cast feeds Casting, so that stage and everything after it
 * becomes stale; scripts and the paid MP3 cache are kept.
 */
export function saveCharacterRegistry(work: WorkDir, edited: CharacterRegistry): void {
  validateCharacterRegistry(edited);
  const stories = readStories(work);
  const previous = readCharacterRegistry(work, stories);
  const storyOf = (character: { story?: string }): string => character.story || stories.stories[0]?.id || 'book';
  const renames = new Map<string, Map<string, string>>();
  for (const before of previous.characters) {
    const after = edited.characters.find((character) => character.id === before.id)
      ?? edited.characters.find((character) => storyOf(character) === storyOf(before)
        && character.aliases.some((alias) => nameKey(alias) === nameKey(before.name)));
    if (!after || after.name === before.name) continue;
    const story = renames.get(storyOf(before)) ?? new Map<string, string>();
    story.set(before.name, after.name);
    renames.set(storyOf(before), story);
  }
  // A character with lines in a saved script cannot simply disappear.
  const names = new Set(edited.characters.map((character) => character.name));
  const orphaned = new Set<string>();
  for (const { index, file } of listChapterFiles(work.root, SCRIPTS_DIR, '.json')) {
    const story = stories.stories.find((entry) => entry.chapters.includes(index))?.id ?? 'book';
    for (const segment of ChapterScriptSchema.parse(work.readJson(file)).segments) {
      if (segment.speaker === 'narrator') continue;
      const speaker = renames.get(story)?.get(segment.speaker) ?? segment.speaker;
      if (!names.has(speaker)) orphaned.add(segment.speaker);
    }
  }
  if (orphaned.size) {
    throw new Error(`${[...orphaned].join(', ')} still ${orphaned.size === 1 ? 'has' : 'have'} lines in the script. To merge a character into another, add its name to the other's aliases instead of only deleting it.`);
  }
  for (const [storyId, storyRenames] of renames) {
    renameSpeakers(work, stories.stories.find((story) => story.id === storyId)?.chapters ?? [], storyRenames);
  }
  writeCharacterRegistry(work, { ...edited, stories: stories.stories.map(({ id, title }) => ({ id, title })) });
  work.invalidateFrom('casting');
  clearArtifactsFrom(work, 'casting');
}

async function bookDetail(sourcePath: string, workRoot: string): Promise<object> {
  const work = await openWorkDir(sourcePath, workRoot);
  return bookDetailFromRoot(work.root, workRoot, work.isOutdated() ? undefined : work.snapshot());
}

async function bookDetailFromRoot(root: string, workRoot: string, stateOverride?: WorkState): Promise<object> {
  const workRootResolved = path.resolve(workRoot);
  const rootResolved = path.resolve(root);
  const relative = path.relative(workRootResolved, rootResolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Work folder is outside the configured work directory.');
  let state: (WorkState & { epub?: string }) | undefined = stateOverride ?? readJson<WorkState & { epub?: string }>(path.join(rootResolved, 'state.json'));
  if (!state || typeof state !== 'object' ||
    !(('source' in state && typeof state.source === 'string') || ('epub' in state && typeof state.epub === 'string'))) {
    throw new Error('This work folder does not contain a valid state.json file.');
  }
  const sourcePath = state.source ?? state.epub!;
  // A folder from an earlier pipeline is shown as needing a rebuild, and none of its files are read.
  if ((state.version as number) !== 3) {
    return {
      sourcePath, sourceAvailable: sourceIsAvailable(sourcePath), root: rootResolved, outdated: OUTDATED_WORK_FOLDER_MESSAGE,
      state: { source: sourcePath, completed: {}, chapterCompleted: {} }, chapters: [], usage: [],
    };
  }
  if (!stateOverride && sourceIsAvailable(sourcePath)) {
    const work = await openWorkDir(sourcePath, workRootResolved);
    if (work.root === rootResolved) state = work.snapshot();
  }
  const metadata = readJson<BookMetadata>(path.join(rootResolved, METADATA_FILE));
  const characterRegistry = readJson<CharacterRegistry>(path.join(rootResolved, CHARACTERS_FILE));
  const casting = readJson<Casting>(path.join(rootResolved, 'casting.json'));
  const bindings = readJson<VoiceBindings>(path.join(rootResolved, 'voice-bindings.json'));
  const scripted = new Set(listChapterFiles(rootResolved, SCRIPTS_DIR, '.json').map((entry) => entry.index));
  const synthesized = new Set(listChapterFiles(rootResolved, AUDIO_DIR, MANIFEST_EXT).map((entry) => entry.index));
  const plans = new Map((metadata?.profile?.chapters ?? []).map((plan) => [plan.index, plan]));
  const chapters = metadata?.chapters.map((chapter) => ({
    ...chapter,
    title: plans.get(chapter.index)?.title || chapter.title,
    narrate: plans.get(chapter.index)?.narrate ?? false,
    reason: plans.get(chapter.index)?.reason,
    scripted: scripted.has(chapter.index),
    synthesized: synthesized.has(chapter.index),
  })) ?? [];
  const stories = readStoriesFile(rootResolved);
  const usage = readJson<unknown>(path.join(rootResolved, USAGE_FILE)) ?? [];
  return { sourcePath, sourceAvailable: sourceIsAvailable(sourcePath), root: rootResolved, state, metadata, stories, characterRegistry, casting, bindings, chapters, usage };
}

function requiredSource(url: URL): string {
  return requireSource(url.searchParams.get('source') ?? undefined);
}

function requireSource(value?: string): string {
  if (!value?.trim()) throw new Error(`Enter the path to a source file (${supportedSourceDescription()}).`);
  const input = value.trim();
  const sourcePath = sourceFormatForPath(input) === 'html' && /^https?:/i.test(input) ? input : path.resolve(input);
  if (!sourceIsAvailable(sourcePath)) throw new Error(`Source file not found: ${sourcePath}`);
  if (!sourceFormatForPath(sourcePath)) throw new Error(`Unsupported source format. Choose ${supportedSourceDescription()}.`);
  return sourcePath;
}

function readJson<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function parseLlmSettings(value?: { provider?: string; model?: string; scriptModel?: string; scriptReasoningEffort?: string }): { provider: ProviderId; model: string; scriptModel?: string; scriptReasoningEffort: OpenRouterReasoningEffort } {
  const fallback = defaultLlmSettings();
  const provider = value?.provider ?? fallback.provider;
  if (provider !== 'openai' && provider !== 'openrouter') throw new Error('Text provider must be "openai" or "openrouter".');
  const model = value?.model?.trim() ?? fallback.model;
  if (!model) throw new Error('Enter a text-processing model name.');
  if (model.length > 200) throw new Error('Text-processing model names must be 200 characters or fewer.');
  const scriptModel = value?.scriptModel?.trim() || fallback.scriptModel || undefined;
  if (scriptModel && scriptModel.length > 200) throw new Error('Script model names must be 200 characters or fewer.');
  const scriptReasoningEffort = value?.scriptReasoningEffort ?? fallback.scriptReasoningEffort;
  if (!['none', 'default', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(scriptReasoningEffort)) {
    throw new Error('Script reasoning effort must be none, default, minimal, low, medium, high, xhigh, or max.');
  }
  return { provider, model, scriptModel, scriptReasoningEffort: scriptReasoningEffort as OpenRouterReasoningEffort };
}

function parseAudioSettings(value?: { provider?: string; model?: string }): { provider: ProviderId; model: string } {
  const fallback = defaultAudioSettings();
  const provider = value?.provider ?? fallback.provider;
  if (provider !== 'openai' && provider !== 'openrouter') throw new Error('Audio provider must be "openai" or "openrouter".');
  const model = value?.model?.trim() ?? fallback.model;
  if (!model) throw new Error('Enter an audio model name.');
  if (model.length > 200) throw new Error('Audio model names must be 200 characters or fewer.');
  return { provider, model };
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
:root{color-scheme:dark;font-family:ui-rounded,"SF Pro Rounded",system-ui,sans-serif;background:#101725;color:#eaf0ff}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 0 0,#243667,transparent 38rem),#101725;min-height:100vh}.shell{max-width:1280px;margin:auto;padding:38px 24px 80px}header{display:flex;justify-content:space-between;align-items:end;margin-bottom:32px}.header-actions{display:flex;align-items:center;gap:12px}.eyebrow{font-size:.72rem;text-transform:uppercase;letter-spacing:.16em;color:#9eb1df;margin:0 0 8px}h1{margin:0;font-size:2.4rem;letter-spacing:-.06em}h2{font-size:1.1rem;margin:0 0 14px}h3{font-size:.9rem;margin:0}.subtle{color:#aebbd9;font-size:.9rem}.panel{background:rgba(20,30,51,.82);border:1px solid #304267;border-radius:18px;padding:20px;box-shadow:0 20px 55px #070b1526}.open{display:grid;grid-template-columns:1fr auto;gap:10px;margin-bottom:20px}input,textarea,select,button{font:inherit}input,textarea,select{border:1px solid #40547d;background:#101a30;color:#edf3ff;border-radius:9px;padding:10px 12px}button{border:0;border-radius:9px;background:#89f0cb;color:#08231e;font-weight:750;padding:10px 14px;cursor:pointer}button:hover{filter:brightness(1.06)}button:disabled{cursor:not-allowed;opacity:.45}.quiet{background:#263754;color:#dfebff}.danger{background:#6d3c53;color:#ffe6ee}.icon{font-size:1.2rem;line-height:1;padding:9px 11px}.books{display:flex;gap:9px;flex-wrap:wrap}.book{background:#192742;color:#dce9ff;border:1px solid #3c5075}.book.missing{border-color:#a65b70;color:#f1b9c7}.book.active{outline:2px solid #89f0cb}.workspace{display:grid;grid-template-columns:minmax(420px,1.35fr) minmax(280px,.65fr);gap:20px;margin-top:20px}.stages{display:grid;gap:9px}.stage{display:grid;grid-template-columns:12px 1fr auto;gap:12px;align-items:center;padding:13px 14px;background:#15213a;border:1px solid #2c3d61;border-radius:12px}.dot{width:10px;height:10px;border-radius:50%;background:#576984}.dot.done{background:#89f0cb}.dot.stale{background:#f3bd63}.dot.running{background:#91b9ff;animation:pulse 1s infinite}.stage-name{text-transform:capitalize;font-weight:700}.stage-meta{font-size:.77rem;color:#a6b7d9;margin-top:2px}.actions{display:flex;gap:6px}.actions button{padding:7px 10px;font-size:.78rem}.chapter-tools{display:flex;gap:8px;align-items:center;margin:18px 0 10px}.chapter-list{max-height:430px;overflow:auto;border-top:1px solid #2d3c5e}.chapter{display:grid;grid-template-columns:auto 34px 1fr auto;gap:9px;align-items:center;padding:9px 2px;border-bottom:1px solid #263653;font-size:.86rem}.chapter.skip{opacity:.48}.badges{display:flex;gap:4px}.badge{font-size:.66rem;border:1px solid #40547d;color:#bcd1f6;border-radius:99px;padding:2px 5px}.badge.ready{border-color:#3c8f77;color:#9ff1d2}.detail{display:grid;gap:20px}.json{margin:0;max-height:210px;overflow:auto;background:#0e172a;color:#c9d9ff;border-radius:10px;padding:13px;font:12px ui-monospace,SFMono-Regular,monospace;white-space:pre-wrap}.cast{display:grid;gap:9px}.voice-row{display:grid;grid-template-columns:110px 1fr 1.5fr;gap:7px;align-items:center}.voice-row label{font-size:.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.voice-row select,.voice-row input{min-width:0;padding:8px}.toast{position:fixed;right:22px;bottom:22px;z-index:10;max-width:min(420px,calc(100vw - 44px));padding:13px 16px;border:1px solid #41577f;border-radius:12px;background:#283a5e;color:#e2ecff;font-size:.9rem;box-shadow:0 16px 42px #0509138c;opacity:0;transform:translateY(14px);pointer-events:none;transition:opacity .18s ease,transform .18s ease}.toast.visible{opacity:1;transform:translateY(0);pointer-events:auto}.toast.success{background:#173d36;border-color:#3d927a;color:#c3f9e3}.toast.error{background:#563145;border-color:#9e5e72;color:#ffe1e9}.toast.progress{background:#263b64;border-color:#6585be;color:#d9e7ff}dialog{width:min(680px,calc(100vw - 32px));border:1px solid #49618e;border-radius:16px;background:#17233c;color:#edf3ff;box-shadow:0 30px 90px #050913b3;padding:22px}dialog::backdrop{background:#050913aa}.dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}.command{margin:0;overflow:auto;border:1px solid #3c5177;border-radius:9px;background:#0d1628;padding:13px;color:#cbdaff;font:13px ui-monospace,SFMono-Regular,monospace;white-space:pre-wrap;word-break:break-word}.settings-grid{display:grid;gap:14px}.settings-grid label{display:grid;gap:6px;font-size:.86rem;font-weight:700}.model-picker{position:relative}.suggestions{position:absolute;z-index:2;left:0;right:0;top:calc(100% + 4px);max-height:180px;overflow:auto;border:1px solid #49618e;border-radius:9px;background:#101a30;box-shadow:0 14px 32px #050913aa}.suggestions:empty{display:none}.suggestion{display:block;width:100%;border-radius:0;text-align:left;background:transparent;color:#dce9ff;padding:9px 12px;font-weight:500}.suggestion:hover{background:#263b5e}.starred-models{display:flex;gap:7px;flex-wrap:wrap}.starred-models button{padding:6px 9px;font-size:.8rem}.settings-file{overflow-wrap:anywhere;font-size:.78rem}.reasoning-toggle{display:flex!important;align-items:center;gap:10px;margin:12px 0}.reasoning-toggle input{width:20px;height:20px;margin:0;accent-color:#89f0cb}.reasoning-toggle:has(input:disabled){opacity:.55}@keyframes pulse{50%{opacity:.35}}@media(max-width:850px){.workspace{grid-template-columns:1fr}.shell{padding:22px 14px}header{align-items:start;flex-direction:column;gap:9px}.open{grid-template-columns:1fr}.voice-row{grid-template-columns:1fr}}
.activity{margin-top:20px}.activity-header{display:flex;justify-content:space-between;align-items:start;gap:12px}.activity-header h2{margin-bottom:14px}.activity-header button{padding:7px 10px;font-size:.8rem}.activity-log{max-height:260px;overflow:auto;display:grid;gap:8px}.activity-event{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:.85rem;color:#bcd1f6}.activity-event.warning{color:#f3bd63}.activity-event.error{color:#ffb6c9}
.chapter-progress{margin-bottom:16px;padding:14px;background:#101a30;border-radius:10px}.chapter-progress p{margin:6px 0}.chapter-progress progress{width:100%;height:14px;accent-color:#89f0cb}
.usage-table{width:100%;border-collapse:collapse;font-size:.76rem;font-variant-numeric:tabular-nums}.usage-table th,.usage-table td{padding:5px 6px;border-bottom:1px solid #263653;text-align:right}.usage-table th:first-child{text-align:left;text-transform:capitalize}.usage-table thead th{color:#9eb1df;font-weight:600}.usage-table tbody tr:last-child{font-weight:700}#usage{overflow-x:auto}
</style></head><body><main class="shell"><header><div><p class="eyebrow">Local audiobook production</p><h1>Lisen workspace</h1></div><div class="header-actions"><p class="subtle">Files and API keys stay on this machine.</p><button class="quiet icon" id="open-settings" aria-label="Model settings" title="Model settings">&#9881;</button></div></header><section class="panel"><form class="open" id="open-form"><input id="source" placeholder="/full/path/to/story.pdf, .html, or .md" aria-label="Source path" required><input id="source-title" placeholder="Title override (optional)" aria-label="Title override"><input id="source-author" placeholder="Author override (optional)" aria-label="Author override"><input id="source-language" placeholder="Language, e.g. en (optional)" aria-label="Language override"><button>Open source</button></form><div id="books" class="books"></div></section><section id="activity" class="panel activity" hidden aria-labelledby="activity-title"><h2 id="activity-title">Stage activity</h2><p id="activity-status" class="subtle" role="status"></p><div id="chapter-progress" class="chapter-progress" hidden><h3 id="progress-title"></h3><p id="progress-phase" class="subtle" role="status"></p><progress id="progress-bar" max="100" value="0" aria-label="Current activity progress"></progress><p id="progress-text" class="subtle"></p><p id="progress-chapters" class="subtle"></p></div><div id="activity-log" class="activity-log" role="log" aria-live="polite" aria-relevant="additions"></div></section><section id="workspace" class="workspace" hidden><div class="panel"><h2 id="book-title">Pipeline</h2><div id="stages" class="stages"></div><div id="chapter-area" hidden><div class="chapter-tools"><button class="quiet" id="select-all">Select narratable</button><button class="quiet" id="clear-selection">Clear</button><span class="subtle" id="selected-count"></span></div><div id="chapters" class="chapter-list"></div></div></div><aside class="detail"><div class="panel"><h2>Book profile</h2><p class="subtle">From Metadata: one call on the chapter openings and a sample, not the whole book.</p><div id="profile"></div></div><div class="panel" id="story-grouping" hidden><h2>Story grouping</h2><p class="subtle" id="story-status"></p><label class="story-toggle"><input type="checkbox" id="collection-toggle" aria-label="Short story collection">Short story collection</label><div id="stories" class="stories"></div><button id="save-stories" hidden>Save grouping</button></div><div class="panel"><h2>Cast</h2><p class="subtle" id="character-status"></p><div id="characters"></div></div><div class="panel"><h2>Voice casting</h2><p class="subtle">Saving changes makes synthesis and assembly stale.</p><form class="cast" id="casting"></form><button id="save-casting">Save casting</button></div><div class="panel"><h2>Usage</h2><div id="usage"></div></div></aside></section></main><dialog id="settings-dialog" aria-labelledby="settings-title"><h2 id="settings-title">Model settings</h2><p class="subtle">The text model is used for Metadata, Casting, and Script's cleanup and verification. Script's per-chunk call can use its own model and optional reasoning for fiction. The selected audio model is recorded when you next run Voices; Synthesis uses that saved voice binding.</p><div class="settings-grid"><section><h3>Text processing</h3><label>Provider<select id="llm-provider" aria-label="Text provider"><option value="openai">OpenAI</option><option value="openrouter">OpenRouter</option></select></label><label>Model<div class="model-picker"><input id="llm-model" autocomplete="off" spellcheck="false" aria-autocomplete="list" aria-controls="model-suggestions" placeholder="Enter a model name"><div id="model-suggestions" class="suggestions" role="listbox"></div></div></label><div><h3>Starred text models</h3><div id="starred-models" class="starred-models"></div></div><p class="subtle settings-file">Edit <code id="models-file"></code> to add text models or set <code>starred</code> to true.</p><h3>Script attribution</h3><label>Model (optional)<input id="script-model" autocomplete="off" spellcheck="false" placeholder="Use text model above"></label><label class="reasoning-toggle"><input type="checkbox" id="script-reasoning-enabled" aria-label="Enable Script reasoning">Enable reasoning for Script</label><label>Reasoning effort<select id="script-reasoning-effort" aria-label="Script reasoning effort"><option value="minimal">Minimal</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Extra high</option><option value="max">Maximum</option></select></label><p class="subtle">Reasoning is off unless enabled here: Script asks the model for short labels, and reasoning can multiply its token use. Turn it on if attribution is not good enough. It needs a compatible model and is unavailable for non-fiction books.</p></section><section><h3>Audio synthesis</h3><label>Provider<select id="audio-provider" aria-label="Audio provider"><option value="openai">OpenAI</option><option value="openrouter">OpenRouter</option></select></label><label>Model<div class="model-picker"><input id="audio-model" autocomplete="off" spellcheck="false" aria-autocomplete="list" aria-controls="audio-model-suggestions" placeholder="Enter an audio model name"><div id="audio-model-suggestions" class="suggestions" role="listbox"></div></div></label><div><h3>Starred audio models</h3><div id="starred-audio-models" class="starred-audio-models"></div></div><p class="subtle settings-file">Edit <code id="audio-models-file"></code> to add audio models or set <code>starred</code> to true.</p></section></div><div class="dialog-actions"><button class="quiet" id="close-settings">Close</button><button id="apply-settings">Use for new runs</button></div></dialog><dialog id="cmd-dialog" aria-labelledby="cmd-title"><h2 id="cmd-title">Run from the command line</h2><pre id="cmd-text" class="command"></pre><div class="dialog-actions"><button class="quiet" id="close-cmd">Close</button><button id="copy-cmd">Copy command</button></div></dialog><div id="toast" class="toast" role="status" aria-live="polite"></div><script>
if(document.body)document.body.insertAdjacentHTML('beforeend','<style>.text-link{display:inline-block;margin-top:10px;background:none;border:0;padding:0;color:#9ff1d2;font-weight:700;text-decoration:underline;cursor:pointer}.character-dialog{width:min(900px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto}.character-review-tools{margin:0 0 12px}.character-editors{display:grid;gap:14px}.character-editor{padding:15px;border:1px solid #3c5177;border-radius:12px;background:#101a30}.character-editor.needs-review{border-color:#a88448}.character-editor h3{margin:0 0 10px}.character-editor label{display:grid;gap:5px;font-size:.78rem;color:#bcd1f6}.character-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.character-fields .wide{grid-column:span 2}.character-issues{margin:0 0 10px;padding-left:20px;color:#f3bd63;font-size:.85rem}.story-toggle{display:flex;gap:8px;align-items:center;margin:0 0 10px;font-size:.85rem;color:#bcd1f6}.stories{display:grid;gap:8px;margin:0 0 12px}.story-row{display:grid;gap:6px;padding:8px 10px;border:1px solid #3c5177;border-radius:10px;background:#101a30}.story-row input{width:100%;box-sizing:border-box}.story-meta{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;justify-content:space-between}.story-actions{display:flex;flex-wrap:wrap;gap:6px}.story-heading{margin:14px 0 6px;font-size:.82rem;text-transform:uppercase;letter-spacing:.05em;color:#9ff1d2}.story-heading:first-child{margin-top:0}.character-evidence{margin:12px 0 0}.character-evidence p{margin:7px 0;font-size:.82rem;white-space:pre-wrap}@media(max-width:640px){.character-fields{grid-template-columns:1fr}.character-fields .wide{grid-column:span 1}}</style><dialog id="character-dialog" class="character-dialog" aria-labelledby="character-dialog-title"><h2 id="character-dialog-title">Review the cast</h2><p class="subtle">The cast Script discovered as it read the book. Renaming a character, or listing one character\'s name among another\'s aliases to merge them, renames the saved scripts without a model. Saving makes Casting and later stages stale, and keeps scripts and the audio cache.</p><div class="character-review-tools"><button class="quiet" type="button" id="show-blocking-character-issues" aria-pressed="false">Show blocking issues only</button></div><p id="character-review-summary" class="subtle"></p><div id="character-editors" class="character-editors"></div><div class="dialog-actions"><button class="quiet" id="ask-llm-resolutions">Ask LLM for proposals</button><button class="quiet" id="close-character-dialog">Cancel</button><button id="save-characters">Save cast</button></div></dialog>');
if(document.body)document.head.insertAdjacentHTML('beforeend','<style>.character-editor{padding:0;overflow:hidden}.character-editor>summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 15px;cursor:pointer;font-weight:750}.character-editor>summary:hover{background:#182945}.character-editor .character-body{padding:0 15px 15px}.character-editor.blocking{border-color:#b75a73;box-shadow:0 0 0 1px #b75a7338}.character-editor.blocking>summary{background:#402336}.character-status{font-size:.76rem;font-weight:700;color:#aebbd9}.character-status.blocking{color:#ffc0ce}.character-status.review{color:#f3bd63}</style>');
if(document.body)document.head.insertAdjacentHTML('beforeend','<style>.conflict-choices{display:inline-flex;gap:6px;flex-wrap:wrap;margin:3px 0}.conflict-choice{padding:4px 7px;border:1px solid #a88448;border-radius:7px;background:#263754;color:#ffe09a;font-size:.82rem;font-weight:650}.conflict-choice:hover{background:#4b3b23}.conflict-help{display:block;margin-top:4px;color:#aebbd9;font-size:.77rem}</style>');
if(document.body)document.head.insertAdjacentHTML('beforeend','<style>.unresolved-candidate{padding:14px 15px;border:1px solid #b75a73;border-radius:12px;background:#402336}.unresolved-candidate.resolved{border-color:#3c8f77;background:#173d36}.unresolved-candidate h3{margin:0 0 7px}.candidate-resolution{display:grid;grid-template-columns:1fr auto;gap:9px;align-items:end;margin-top:10px}.candidate-resolution label{display:grid;gap:5px;font-size:.8rem;color:#bcd1f6}.candidate-samples{margin:10px 0 0;font-size:.83rem}.candidate-samples p{margin:6px 0;white-space:pre-wrap}@media(max-width:640px){.candidate-resolution{grid-template-columns:1fr}}</style>');
const stages=['extract','metadata','script','casting','voices','synth','assemble'];let book=null,voices=[],selected=new Set(),job=null,toastTimer=null,activityJobId=null,activityEventCount=0,activityError=null,modelSettings=null,activeLlm=null,activeAudio=null,candidateResolutions={},candidateSuggestions={},scriptResumeFrom=null,showBlockingCharacterIssues=false,storyDraft=null;
const $=s=>document.querySelector(s);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(url,opts){const r=await fetch(url,opts);const data=await r.json();if(!r.ok)throw Error(data.error||'Request failed.');return data}
function fuzzyScore(value,query){const hay=value.toLowerCase(),needle=query.trim().toLowerCase();if(!needle)return 0;let at=0,score=0;for(const char of needle){const found=hay.indexOf(char,at);if(found<0)return -1;score+=found-at;at=found+1}return score+(hay.startsWith(needle)?-100:0)}
function selectedLlm(){const settings=activeLlm||(modelSettings?{provider:modelSettings.provider,model:modelSettings.model,scriptModel:modelSettings.scriptModel,scriptReasoningEffort:modelSettings.scriptReasoningEffort}:null);return settings&&book?.metadata?.profile?.isFiction===false?{...settings,scriptReasoningEffort:'none'}:settings}
function selectedAudio(){return activeAudio||(modelSettings?.audio?{provider:modelSettings.audio.provider,model:modelSettings.audio.model}:null)}
function syncReasoningControls(){const nonfiction=book?.metadata?.profile?.isFiction===false,enabled=$('#script-reasoning-enabled');enabled.disabled=nonfiction;if(nonfiction)enabled.checked=false;$('#script-reasoning-effort').disabled=nonfiction||!enabled.checked}function renderModelSettings(){if(!modelSettings)return;const current=activeLlm||modelSettings,audio=selectedAudio(),provider=$('#llm-provider'),input=$('#llm-model'),audioProvider=$('#audio-provider'),audioInput=$('#audio-model');provider.value=current.provider;input.value=current.model;$('#script-model').value=current.scriptModel||'';const effort=current.scriptReasoningEffort||'none';$('#script-reasoning-enabled').checked=effort!=='none';$('#script-reasoning-effort').value=effort==='none'?'medium':effort;syncReasoningControls();audioProvider.value=audio.provider;audioInput.value=audio.model;$('#models-file').textContent=modelSettings.modelsFile;$('#audio-models-file').textContent=modelSettings.audio.modelsFile;renderModelChoices();renderAudioModelChoices()}
function renderModelChoices(){if(!modelSettings)return;const provider=$('#llm-provider').value,query=$('#llm-model').value;const matches=modelSettings.models.filter(m=>m.provider===provider).map(m=>({...m,score:fuzzyScore(m.model,query)})).filter(m=>m.score>=0).sort((a,b)=>a.score-b.score||a.model.localeCompare(b.model));$('#model-suggestions').innerHTML=matches.slice(0,8).map(m=>'<button class="suggestion" role="option" data-model-choice="'+esc(m.model)+'">'+esc(m.model)+'</button>').join('');document.querySelectorAll('[data-model-choice]').forEach(x=>x.onclick=()=>{ $('#llm-model').value=x.dataset.modelChoice;renderModelChoices();$('#llm-model').focus() });const starred=modelSettings.models.filter(m=>m.provider===provider&&m.starred);$('#starred-models').innerHTML=starred.length?starred.map(m=>'<button class="quiet" data-model-choice="'+esc(m.model)+'">&#9733; '+esc(m.model)+'</button>').join(''):'<p class="subtle">No starred '+esc(provider)+' models yet.</p>';document.querySelectorAll('#starred-models [data-model-choice]').forEach(x=>x.onclick=()=>{ $('#llm-model').value=x.dataset.modelChoice;renderModelChoices() })}
function renderAudioModelChoices(){if(!modelSettings?.audio)return;const provider=$('#audio-provider').value,query=$('#audio-model').value;const matches=modelSettings.audio.models.filter(m=>m.provider===provider).map(m=>({...m,score:fuzzyScore(m.model,query)})).filter(m=>m.score>=0).sort((a,b)=>a.score-b.score||a.model.localeCompare(b.model));$('#audio-model-suggestions').innerHTML=matches.slice(0,8).map(m=>'<button class="suggestion" role="option" data-audio-model-choice="'+esc(m.model)+'">'+esc(m.model)+'</button>').join('');document.querySelectorAll('[data-audio-model-choice]').forEach(x=>x.onclick=()=>{ $('#audio-model').value=x.dataset.audioModelChoice;renderAudioModelChoices();$('#audio-model').focus() });const starred=modelSettings.audio.models.filter(m=>m.provider===provider&&m.starred);$('#starred-audio-models').innerHTML=starred.length?starred.map(m=>'<button class="quiet" data-audio-model-choice="'+esc(m.model)+'">&#9733; '+esc(m.model)+'</button>').join(''):'<p class="subtle">No starred '+esc(provider)+' audio models yet.</p>';document.querySelectorAll('#starred-audio-models [data-audio-model-choice]').forEach(x=>x.onclick=()=>{ $('#audio-model').value=x.dataset.audioModelChoice;renderAudioModelChoices() })}
function notice(message,kind=''){const toast=$('#toast');clearTimeout(toastTimer);toast.textContent=message||'';toast.className='toast '+(message?'visible ':'')+kind;if(message&&kind!=='progress')toastTimer=setTimeout(()=>{toast.className='toast';},5500)}
async function refreshBooks(){const books=await api('/api/books');$('#books').innerHTML=books.length?books.map(b=>'<button class="book '+(!b.sourceAvailable?'missing ':'')+(book&&b.root===book.root?'active':'')+'" data-root="'+esc(b.root)+'">'+esc(b.sourcePath.split('/').pop())+(b.sourceAvailable?'':' · source missing')+(b.outdated?' · needs rebuild':'')+'</button>').join(''):'<span class="subtle">No existing work folders yet.</span>';document.querySelectorAll('[data-root]').forEach(x=>x.onclick=()=>openExisting(x.dataset.root));}
function sourceMetadata(){const values={title:$('#source-title').value.trim(),author:$('#source-author').value.trim(),language:$('#source-language').value.trim()};return Object.values(values).some(Boolean)?values:undefined}
function showSourceMetadata(){const metadata=book.state.metadataOverrides||{};$('#source-title').value=metadata.title||'';$('#source-author').value=metadata.author||'';$('#source-language').value=metadata.language||''}
async function openBook(source){try{const metadata=sourceMetadata();book=await api('/api/books/open',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source,...(metadata?{metadata}:{})})});selected=new Set();$('#workspace').hidden=false;$('#source').value=book.sourcePath;showSourceMetadata();notice(book.outdated?book.outdated:book.state.sourceChanged?'This source differs from the source used for the existing artifacts. Rebuild Extract before running later stages.':'',(book.outdated||book.state.sourceChanged)?'error':'');render();refreshBooks()}catch(e){notice(e.message,'error')}}
async function openExisting(root){try{book=await api('/api/books/open',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({root})});selected=new Set();$('#workspace').hidden=false;$('#source').value=book.sourcePath;showSourceMetadata();notice(book.outdated?book.outdated:!book.sourceAvailable?'Source file is missing. You can inspect this work folder; paste the current source path above to relink it.':book.state.sourceChanged?'This source differs from the source used for the existing artifacts. Rebuild Extract before running later stages.':'',(book.outdated||!book.sourceAvailable||book.state.sourceChanged)?'error':'');render();refreshBooks()}catch(e){notice(e.message,'error')}}
function stageState(stage){if(job&&job.status==='running'&&job.stage===stage)return 'running';if(book.state.completed[stage])return 'done';const order=stages.indexOf(stage);return stages.slice(0,order).some(s=>book.state.completed[s])?'stale':'ready'}
function render(){if(!book)return;const title=book.metadata?.title||book.sourcePath.split('/').pop();$('#book-title').textContent=title+' · pipeline';renderProfile();$('#stages').innerHTML=stages.map(stage=>{const state=stageState(stage),disabled=job||!book.sourceAvailable,label=stage==='script'&&scriptResumeFrom!==null?'Resume from chapter '+(scriptResumeFrom+1):'Run';return '<div class="stage"><i class="dot '+state+'"></i><div><div class="stage-name">'+stageLabel(stage)+'</div><div class="stage-meta">'+stageHint(stage,state)+'</div></div><div class="actions"><button class="quiet" data-run="'+stage+'" '+(disabled?'disabled':'')+'>'+label+'</button><button class="danger" data-rebuild="'+stage+'" '+(disabled?'disabled':'')+'>Rebuild all</button><button class="quiet" data-cmd="'+stage+'">Cmd</button></div></div>'}).join('');document.querySelectorAll('[data-run]').forEach(x=>x.onclick=()=>run(x.dataset.run,false));document.querySelectorAll('[data-rebuild]').forEach(x=>x.onclick=()=>run(x.dataset.rebuild,true));document.querySelectorAll('[data-cmd]').forEach(x=>x.onclick=()=>showCommand(x.dataset.cmd));renderChapters();renderStories();renderCharacters();renderCasting();renderUsage()}
function stageLabel(stage){return stage}
function profileLine(label,value){return value?'<p class="subtle"><strong>'+esc(label)+':</strong> '+esc(value)+'</p>':''}
function renderProfile(){const profile=book.metadata&&book.metadata.profile,target=$('#profile');if(book.outdated){target.innerHTML='<p class="activity-event error">'+esc(book.outdated)+'</p>';return}if(!profile){target.innerHTML='<p class="subtle">Run Metadata to profile the book.</p>';return}const known=value=>value&&value!=='unknown'?value:'';const by=profile.author||{},narrator=profile.narrator||{},genres=profile.genres||[],plans=profile.chapters||[];const author=[known(by.sex),known(by.age),known(by.race),known(by.country)].filter(Boolean).join(' · ');const narrated=plans.filter(chapter=>chapter.narrate).length;target.innerHTML=profileLine('Form',profile.form+(genres.length?' · '+genres.join(', '):''))+profileLine('Recognised by the model',profile.recognised?'yes':'no')+profileLine('Author',author||'unknown')+profileLine('Narration',narrator.pointOfView?narrator.pointOfView+' person'+(known(narrator.sex)?' · narrator '+narrator.sex:''):'')+profileLine('Dialogue',profile.isFiction?(profile.dialogueStyle==='quoted'?'in quotation marks — Script asks only for speaker labels':'not in double quotation marks — Script asks the model for the segments'):'none to attribute (non-fiction)')+(profile.dialogueStyleNote?'<p class="activity-event warning">'+esc(profile.dialogueStyleNote)+'</p>':'')+profileLine('Chapters',narrated+' narrated of '+plans.length)+profileLine('Summary ('+({model:'from the model',blurb:'from the source blurb',none:'none'}[profile.summarySource]||'none')+')',profile.summary)+'<details><summary class="subtle">Chapter decisions</summary>'+plans.map(chapter=>'<p class="subtle">'+(chapter.index+1)+'. '+esc(chapter.title)+' — '+(chapter.narrate?'narrate':'skip')+(chapter.reason?' ('+esc(chapter.reason)+')':'')+'</p>').join('')+'</details>'}
function usageDuration(ms){const seconds=Math.round(ms/1000);if(seconds<60)return seconds+'s';const minutes=Math.floor(seconds/60);return minutes<60?minutes+'m '+String(seconds%60).padStart(2,'0')+'s':Math.floor(minutes/60)+'h '+String(minutes%60).padStart(2,'0')+'m'}
function usageByStage(records){return stages.map(stage=>{const runs=records.filter(record=>record.stage===stage);return runs.reduce((total,record)=>({stage,runs:total.runs+1,calls:total.calls+record.llm.calls,prompt:total.prompt+record.llm.promptTokens,completion:total.completion+record.llm.completionTokens,reasoning:total.reasoning+record.llm.reasoningTokens,tts:total.tts+record.tts.calls,characters:total.characters+record.tts.characters,wallMs:total.wallMs+record.wallMs}),{stage,runs:0,calls:0,prompt:0,completion:0,reasoning:0,tts:0,characters:0,wallMs:0})}).filter(row=>row.runs)}
function renderUsage(){const records=book.usage||[],rows=usageByStage(records),count=value=>Number(value).toLocaleString('en-US');if(!rows.length){$('#usage').innerHTML='<p class="subtle">No stage has run yet.</p>';return}const total=rows.reduce((sum,row)=>({stage:'total',runs:sum.runs+row.runs,calls:sum.calls+row.calls,prompt:sum.prompt+row.prompt,completion:sum.completion+row.completion,reasoning:sum.reasoning+row.reasoning,tts:sum.tts+row.tts,characters:sum.characters+row.characters,wallMs:sum.wallMs+row.wallMs}),{stage:'total',runs:0,calls:0,prompt:0,completion:0,reasoning:0,tts:0,characters:0,wallMs:0});const cell=row=>'<tr><th scope="row">'+esc(row.stage)+'</th><td>'+count(row.runs)+'</td><td>'+count(row.calls)+'</td><td>'+count(row.prompt)+'</td><td>'+count(row.completion)+'</td><td>'+count(row.reasoning)+'</td><td>'+count(row.tts)+'</td><td>'+usageDuration(row.wallMs)+'</td></tr>';const last=records[records.length-1];$('#usage').innerHTML='<table class="usage-table"><thead><tr><th scope="col">Stage</th><th scope="col">Runs</th><th scope="col">LLM calls</th><th scope="col">Prompt tokens</th><th scope="col">Completion tokens</th><th scope="col">Reasoning tokens</th><th scope="col">TTS requests</th><th scope="col">Wall time</th></tr></thead><tbody>'+rows.map(cell).join('')+cell(total)+'</tbody></table><p class="subtle">Every run of every stage, including failed ones, from usage.json. Last: '+esc(last.stage)+' · '+esc(last.outcome)+' · '+usageDuration(last.wallMs)+'.</p>'}
function stageHint(stage,state){const descriptions={extract:'Read the source file into chapters, metadata, and available cover art.',metadata:'Profile the book in one call: fiction or not, narrator, dialogue style, what to narrate, and story grouping.',script:'One pass over the text: cleanup, who speaks each line, and the cast, a chunk at a time.',casting:'Describe the intended sound and delivery for each speaker.',voices:'Match the cast to voices from the shared library.',synth:'Turn selected script segments into cached speech audio. TTS usage is billable.',assemble:'Combine synthesized chapters into an M4B with chapter markers.'};if(state==='done')return 'Complete · '+descriptions[stage];if(state==='running')return 'Running locally…';return state==='stale'?'Needs a fresh run · '+descriptions[stage]:descriptions[stage]}
function renderChapters(){const has=book.chapters.length>0;$('#chapter-area').hidden=!has;if(!has)return;$('#selected-count').textContent=selected.size?selected.size+' selected':'';$('#chapters').innerHTML=book.chapters.map(c=>'<label class="chapter '+(!c.narrate?'skip':'')+'"><input type="checkbox" data-chapter="'+c.index+'" '+(!c.narrate?'disabled ':'')+(selected.has(c.index)?'checked':'')+'><span>'+String(c.index+1).padStart(2,'0')+'</span><span>'+esc(c.title)+'</span><span class="badges">'+(c.narrate?'<i class="badge">narrate</i>':'<i class="badge">skip</i>')+(c.scripted?'<i class="badge ready">script</i>':'')+(c.synthesized?'<i class="badge ready">audio</i>':'')+'</span></label>').join('');document.querySelectorAll('[data-chapter]').forEach(x=>x.onchange=()=>{x.checked?selected.add(+x.dataset.chapter):selected.delete(+x.dataset.chapter);render()})}
function pad2(index){return String(index).padStart(2,'0')}
function narratableIndexes(){return (book.chapters||[]).filter(chapter=>chapter.narrate).map(chapter=>chapter.index)}
function chapterTitle(index){const chapter=(book.chapters||[]).find(entry=>entry.index===index);return chapter&&chapter.title?chapter.title:'Story '+(index+1)}
function storyPerChapter(index){return {id:'story-'+pad2(index),title:chapterTitle(index),chapters:[index]}}
function defaultStories(collection){const indexes=narratableIndexes();return collection?indexes.map(storyPerChapter):[{id:'book',title:(book.metadata&&book.metadata.title)||'',chapters:indexes}]}
function savedStories(){const saved=book.stories;const collection=saved?saved.collection:Boolean(book.state&&book.state.collection!==undefined?book.state.collection:book.metadata&&book.metadata.profile&&book.metadata.profile.form==='short story collection');return {collection,stories:saved&&saved.stories.length?JSON.parse(JSON.stringify(saved.stories)):defaultStories(collection)}}
function editedStories(){return storyDraft||savedStories()}
function storyRow(story,position,total){const chapters=story.chapters.map(index=>index+1);const range=chapters.length>1?'Chapters '+chapters[0]+'–'+chapters[chapters.length-1]:'Chapter '+chapters[0];return '<div class="story-row" data-story="'+position+'"><input data-story-title="'+position+'" value="'+esc(story.title||'')+'" aria-label="Title of story '+(position+1)+'"><div class="story-meta"><span class="subtle">'+range+'</span><span class="story-actions"><button type="button" class="quiet" data-story-select="'+position+'">Select</button>'+(story.chapters.length>1?'<button type="button" class="quiet" data-story-split="'+position+'">Split</button>':'')+(position<total-1?'<button type="button" class="quiet" data-story-merge="'+position+'">Merge next</button>':'')+'</span></div></div>'}
function renderStories(){const panel=$('#story-grouping'),profiled=Boolean(book.metadata&&book.metadata.profile);panel.hidden=!profiled;if(!profiled)return;const state=editedStories(),toggle=$('#collection-toggle');toggle.checked=state.collection;toggle.disabled=Boolean(job);$('#story-status').textContent=state.collection?state.stories.length+' stories · each story has its own characters and voices':'One continuous work · characters are shared across every chapter';$('#stories').innerHTML=state.collection?state.stories.map((story,position)=>storyRow(story,position,state.stories.length)).join(''):'';$('#save-stories').hidden=JSON.stringify(editedStories())===JSON.stringify(savedStories());
document.querySelectorAll('[data-story-title]').forEach(input=>input.oninput=()=>renameStory(+input.dataset.storyTitle,input.value));
document.querySelectorAll('[data-story-merge]').forEach(button=>button.onclick=()=>mergeStory(+button.dataset.storyMerge));
document.querySelectorAll('[data-story-split]').forEach(button=>button.onclick=()=>splitStory(+button.dataset.storySplit));
document.querySelectorAll('[data-story-select]').forEach(button=>button.onclick=()=>selectStoryChapters(+button.dataset.storySelect))}
function renameStory(position,title){const draft=editedStories();draft.stories[position].title=title;storyDraft=draft;$('#save-stories').hidden=false}
function mergeStory(position){const draft=editedStories(),story=draft.stories[position];story.chapters=[...story.chapters,...draft.stories[position+1].chapters].sort((left,right)=>left-right);draft.stories.splice(position+1,1);storyDraft=draft;renderStories()}
function splitStory(position){const draft=editedStories();draft.stories.splice(position,1,...draft.stories[position].chapters.map(storyPerChapter));storyDraft=draft;renderStories()}
function selectStoryChapters(position){selected=new Set(editedStories().stories[position].chapters);render()}
function storyGroups(entries,storyOf){const stories=(book.stories&&book.stories.collection)?book.stories.stories:[];if(!stories.length)return [['',entries]];const groups=stories.map(story=>[story.title||'Untitled story',entries.filter(entry=>storyOf(entry)===story.id)]);const ids=stories.map(story=>story.id);groups.push(['Not in any story',entries.filter(entry=>ids.indexOf(storyOf(entry))<0)]);return groups.filter(([,rows])=>rows.length)}
function groupedMarkup(entries,storyOf,row){return storyGroups(entries,storyOf).map(([title,rows])=>(title?'<h3 class="story-heading">'+esc(title)+'</h3>':'')+rows.map(row).join('')).join('')}
function unresolvedCandidates(){return ((book.characterRegistry&&book.characterRegistry.unresolved)||[]).map(record=>({key:record.chapter+':'+normCharacter(record.speaker),story:record.story,speaker:record.speaker,chapter:record.chapter,chapters:[record.chapter],samples:record.samples||[],resolveAs:record.resolveAs||''}))}
function renderCharacters(){const registry=book.characterRegistry,entries=(registry&&registry.characters)||[],pending=unresolvedCandidates().filter(candidate=>!candidate.resolveAs),flagged=entries.filter(character=>(character.issues||[]).length).length;$('#character-status').textContent=!registry?'Run Script to discover who speaks. The cast grows as the book is read.':entries.length+' character'+(entries.length===1?'':'s')+(pending.length?' · '+pending.length+' unresolved speaker'+(pending.length===1?'':'s')+' blocking Script':'')+(flagged?' · '+flagged+' with notes for review':'');$('#characters').innerHTML=(registry?'<button class="text-link" id="open-character-review">Review and edit the cast</button>':'')+pending.map(candidate=>'<p class="activity-event error">Unresolved in chapter '+(candidate.chapter+1)+': '+esc(candidate.speaker)+'</p>').join('')+(entries.length?groupedMarkup(entries,c=>c.story,c=>'<details><summary>'+esc(c.name)+' <span class="subtle">· chapters '+c.chapters.map(i=>i+1).join(', ')+'</span></summary><p class="subtle">'+esc(c.aliases.length?'Aliases: '+c.aliases.join(', '):'No known aliases')+'</p><p class="subtle">'+esc([c.sex,c.age,c.named===false?'unnamed role':''].filter(Boolean).join(' · '))+'</p>'+(c.issues||[]).map(issue=>'<p class="activity-event warning">'+esc(issue)+'</p>').join('')+(c.evidence||[]).map(item=>'<p class="subtle">Chapter '+(item.chapter+1)+': '+esc(item.text)+'</p>').join('')+'</details>'):(registry?'<p class="subtle">No speaking characters discovered.</p>':''));const review=$('#open-character-review');if(review)review.onclick=openCharacterDialog}
function normCharacter(value){return String(value||'').normalize('NFKC').trim().toLocaleLowerCase()}
function conflictField(issue){return issue.match(/^Conflicting (sex|age):\s*(.+)\.$/)?.[1]}
function reviewIssues(entries){const saved=new Map((book?.characterRegistry?.characters||[]).map(character=>[character.id,character.issues||[]]));const result=new Map(entries.map(character=>[character.id,[...(saved.get(character.id)||[]).filter(issue=>{const field=conflictField(issue);return !field||normCharacter(character[field])==='unknown'})]]));const labels=new Map;for(const character of entries){const incomplete=['sex','age'].filter(field=>normCharacter(character[field])==='unknown');if(!normCharacter(character.name))result.get(character.id).push('A character name is required.');if(incomplete.length)result.get(character.id).push('Incomplete details: '+incomplete.join(', ')+'.');const seen=new Set;for(const label of [character.name,...character.aliases]){const key=normCharacter(label);if(!key||seen.has(key))continue;seen.add(key);const owners=labels.get(key)||[];owners.push(character);labels.set(key,owners)}}for(const [label,owners] of labels)if(owners.length>1)owners.forEach(character=>result.get(character.id).push('Duplicate name or alias "'+label+'" also belongs to '+owners.filter(other=>other.id!==character.id).map(other=>other.name||'an unnamed character').join(', ')+'.'));return result}
function editorValue(row,field){return row.querySelector('[data-character-field="'+field+'"]').value}
function dialogCharacters(){return [...document.querySelectorAll('[data-character-editor]')].map(row=>({id:row.dataset.id,name:editorValue(row,'name').trim(),aliases:editorValue(row,'aliases').split(/[\\n,]/).map(value=>value.trim()).filter(Boolean),sex:editorValue(row,'sex'),age:editorValue(row,'age').trim()||'unknown'}))}
function isBlockingIssue(issue){return issue.startsWith('A character name is required')||issue.startsWith('Duplicate name or alias')}
function issueMarkup(issue){const match=issue.match(/^Conflicting (sex|age):\s*(.+)\.$/);if(!match)return '<li>'+esc(issue)+'</li>';const options=match[2].split(' / ').map(value=>value.trim()).filter(Boolean);return '<li>Conflicting '+esc(match[1])+': <span class="conflict-choices">'+options.map(value=>'<button type="button" class="conflict-choice" data-conflict-choice data-conflict-field="'+esc(match[1])+'" data-conflict-value="'+esc(value)+'">'+esc(value)+'</button>').join('')+'</span><span class="conflict-help">Choose the supported value to use for this attribute.</span></li>'}
function updateCharacterReviewFilter(){const button=$('#show-blocking-character-issues');button.textContent=showBlockingCharacterIssues?'Show all character issues':'Show blocking issues only';button.setAttribute('aria-pressed',String(showBlockingCharacterIssues));document.querySelectorAll('[data-character-editor]').forEach(row=>{row.hidden=showBlockingCharacterIssues&&!row.classList.contains('blocking')});document.querySelectorAll('[data-candidate-editor]').forEach(row=>{row.hidden=showBlockingCharacterIssues&&Boolean(row.querySelector('[data-candidate-resolution]').value)})}
function refreshCharacterReviewIssues(){const issues=reviewIssues(dialogCharacters());let flagged=0,blocking=0;document.querySelectorAll('[data-character-editor]').forEach(row=>{const list=issues.get(row.dataset.id)||[],hasBlocking=list.some(isBlockingIssue),visibleIssues=showBlockingCharacterIssues?list.filter(isBlockingIssue):list;flagged+=list.length?1:0;blocking+=hasBlocking?1:0;row.classList.toggle('needs-review',list.length>0);row.classList.toggle('blocking',hasBlocking);row.querySelector('[data-character-issues]').innerHTML=visibleIssues.map(issueMarkup).join('')||'<li class="subtle">No '+(showBlockingCharacterIssues?'blocking ':'')+'review issues found.</li>';row.querySelectorAll('[data-conflict-choice]').forEach(choice=>choice.onclick=()=>{row.querySelector('[data-character-field="'+choice.dataset.conflictField+'"]').value=choice.dataset.conflictValue;refreshCharacterReviewIssues()});const status=row.querySelector('[data-character-status]');status.textContent=hasBlocking?'Fix before saving':list.length?'Needs review':'Ready';status.className='character-status '+(hasBlocking?'blocking':list.length?'review':'')});const unresolved=unresolvedCandidateCount(),totalBlocking=blocking+unresolved;$('#character-review-summary').textContent=totalBlocking?totalBlocking+' blocking '+(totalBlocking===1?'issue remains':'issues remain')+' before Script can run. '+(unresolved?unresolved+' unresolved speaker '+(unresolved===1?'needs':'need')+' a resolution. ':'')+(flagged-blocking?String(flagged-blocking)+' character '+(flagged-blocking===1?'needs':'need')+' review.':''):flagged?flagged+' character '+(flagged===1?'needs':'need')+' review.':'No duplicate, unresolved, or incomplete profiles found.';updateCharacterReviewFilter()}
function field(label,field,value,wide=''){return '<label class="'+wide+'">'+label+'<input data-character-field="'+field+'" value="'+esc(value)+'"></label>'}
function selectField(label,field,value,values){return '<label>'+label+'<select data-character-field="'+field+'">'+values.map(option=>'<option value="'+option+'" '+(value===option?'selected':'')+'>'+option+'</option>').join('')+'</select></label>'}
function unresolvedCandidateCount(){return unresolvedCandidates().filter(candidate=>!candidateResolutions[candidate.key]).length}
function resumeFromCandidateChapter(){const chapters=unresolvedCandidates().flatMap(candidate=>candidate.chapters);return chapters.length?Math.min(...chapters):undefined}
function characterResolutionLabel(character){const chapterIndex=character.chapters?.[0]??character.evidence?.[0]?.chapter;const chapter=book?.chapters?.find(item=>item.index===chapterIndex);const chapterNumber=Number.isInteger(chapterIndex)?chapterIndex+1:'?';const name=character.name||character.aliases?.[0]||'Unnamed character';const title=chapter?.title?.trim();return 'C '+chapterNumber+': '+name+(title?" (from Chapter '"+title+"')":'')}
function candidateMarkup(candidate,registry){const resolution=candidateResolutions[candidate.key]||'',suggestion=candidateSuggestions[candidate.key];return '<section class="unresolved-candidate" data-candidate-editor data-key="'+esc(candidate.key)+'"><h3>Unresolved speaker: '+esc(candidate.speaker)+' <span class="subtle">· chapter '+candidate.chapters.map(index=>index+1).join(', ')+'</span></h3><p class="subtle" data-candidate-status>This speaker blocks Script until it is matched or added.</p>'+(suggestion?'<p class="subtle"><strong>LLM proposal:</strong> '+esc(suggestion.reason)+(suggestion.evidence?' Evidence: '+esc(suggestion.evidence):'')+'</p>':'')+'<div class="candidate-resolution"><label>Resolve as<select data-candidate-resolution><option value="">Choose a resolution…</option><option value="new" '+(resolution==='new'?'selected':'')+'>Add '+esc(candidate.speaker)+' as a new character</option><option value="narrator" '+(resolution==='narrator'?'selected':'')+'>Not speech: give it to the narrator</option>'+registry.characters.filter(character=>!candidate.story||!character.story||character.story===candidate.story).map(character=>'<option value="'+esc(character.id)+'" '+(resolution===character.id?'selected':'')+'>'+esc(characterResolutionLabel(character))+'</option>').join('')+'</select></label></div><details class="candidate-samples"><summary>Script evidence · '+candidate.samples.length+' sample'+(candidate.samples.length===1?'':'s')+'</summary>'+candidate.samples.map(sample=>'<p><strong>'+esc(sample.text)+'</strong></p>'+(sample.context?'<p class="subtle">'+esc(sample.context)+'</p>':'')).join('')+'</details></section>'}
function refreshCandidateResolutions(){document.querySelectorAll('[data-candidate-editor]').forEach(row=>{const choice=row.querySelector('[data-candidate-resolution]'),resolved=Boolean(choice.value);candidateResolutions[row.dataset.key]=choice.value;row.classList.toggle('resolved',resolved);row.querySelector('[data-candidate-status]').textContent=resolved?'Will be resolved when you save the registry.':'This speaker blocks Script until it is matched or added.'});refreshCharacterReviewIssues()}
function renderCharacterDialog(){const registry=book.characterRegistry;if(!registry)return;const candidates=unresolvedCandidates().map(candidate=>candidateMarkup(candidate,registry)).join('');$('#ask-llm-resolutions').hidden=!candidates;$('#character-editors').innerHTML=candidates+registry.characters.map(character=>'<details class="character-editor" data-character-editor data-id="'+esc(character.id)+'"><summary><span>'+esc(character.name||'Unnamed character')+' <span class="subtle">· chapters '+character.chapters.map(index=>index+1).join(', ')+'</span></span><span class="character-status" data-character-status></span></summary><div class="character-body"><ul class="character-issues" data-character-issues></ul><div class="character-fields">'+field('Name','name',character.name)+field('Aliases (comma-separated)','aliases',character.aliases.join(', '),'wide')+selectField('Sex','sex',character.sex,['unknown','female','male'])+field('Age','age',character.age)+'</div><details class="character-evidence"><summary>Evidence · '+character.evidence.length+' item'+(character.evidence.length===1?'':'s')+'</summary>'+character.evidence.map(item=>'<p><strong>Chapter '+(item.chapter+1)+', passage '+(item.chunk+1)+':</strong> '+esc(item.text)+'</p>').join('')+'</details></div></details>').join('');document.querySelectorAll('[data-character-editor] input,[data-character-editor] select').forEach(input=>{input.oninput=refreshCharacterReviewIssues;input.onchange=refreshCharacterReviewIssues});document.querySelectorAll('[data-character-editor]').forEach(row=>row.ontoggle=()=>{if(row.open)document.querySelectorAll('[data-character-editor]').forEach(other=>{if(other!==row)other.open=false})});document.querySelectorAll('[data-candidate-resolution]').forEach(choice=>choice.onchange=refreshCandidateResolutions);refreshCandidateResolutions()}
function savedCandidateResolutions(){const result={},registry=book.characterRegistry;for(const candidate of unresolvedCandidates()){if(!candidate.resolveAs)continue;if(normCharacter(candidate.resolveAs)==='narrator'){result[candidate.key]='narrator';continue}const target=registry.characters.find(character=>character.name===candidate.resolveAs);if(target)result[candidate.key]=target.id}return result}
function openCharacterDialog(event){if(event)event.preventDefault();if(!book.characterRegistry)return;candidateResolutions=savedCandidateResolutions();candidateSuggestions={};showBlockingCharacterIssues=false;renderCharacterDialog();$('#character-dialog').showModal()}
function applySpeakerSuggestions(suggestions){candidateResolutions={};candidateSuggestions={};const characters=(book.characterRegistry&&book.characterRegistry.characters)||[];for(const suggestion of suggestions||[]){candidateSuggestions[suggestion.key]=suggestion;const target=suggestion.resolution==='existing'?characters.find(character=>character.name===suggestion.character):undefined;if(target)candidateResolutions[suggestion.key]=target.id;else if(suggestion.resolution==='new')candidateResolutions[suggestion.key]='new'}}
async function askLlmForSpeakerResolutions(){if(!book?.sourcePath)return;try{notice('Asking the LLM to reconcile unresolved speakers…','progress');const result=await api('/api/speaker-reconciliation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source:book.sourcePath,llm:selectedLlm()})});book=await api('/api/book?source='+encodeURIComponent(book.sourcePath));applySpeakerSuggestions(result.suggestions);render();renderCharacterDialog();$('#character-dialog').showModal();const proposed=(result.suggestions||[]).filter(s=>s.resolution!=='unresolved').length;notice(proposed?'Review '+proposed+' LLM proposal'+(proposed===1?'':'s')+' and save to resume Script.':'The LLM could not support a resolution; review the evidence manually.','success')}catch(e){notice(e.message,'error')}}
function applyCandidateResolutions(registry){for(const record of registry.unresolved||[]){const key=record.chapter+':'+normCharacter(record.speaker),resolution=candidateResolutions[key];if(!resolution)continue;if(resolution==='new'){delete record.resolveAs;if(!registry.characters.some(character=>normCharacter(character.name)===normCharacter(record.speaker)))registry.characters.push({id:'manual-'+Date.now()+'-'+Math.random().toString(36).slice(2),name:record.speaker,story:record.story,aliases:[],sex:'unknown',age:'unknown',named:true,chapters:[record.chapter],evidence:(record.samples||[]).map(sample=>({chapter:record.chapter,chunk:0,text:sample.text})),issues:['Added by hand from an unresolved script speaker; review the evidence.']});continue}if(resolution==='narrator'){record.resolveAs='narrator';continue}const target=registry.characters.find(character=>character.id===resolution);if(target)record.resolveAs=target.name}return registry}
const characterDialog=$('#character-dialog');if(characterDialog){$('#close-character-dialog').onclick=()=>characterDialog.close();$('#show-blocking-character-issues').onclick=()=>{showBlockingCharacterIssues=!showBlockingCharacterIssues;refreshCharacterReviewIssues()};$('#ask-llm-resolutions').onclick=askLlmForSpeakerResolutions;$('#save-characters').onclick=async()=>{if(!book?.characterRegistry)return;if(unresolvedCandidateCount())return notice('Resolve every unresolved speaker before saving.','error');const resumeFromChapter=resumeFromCandidateChapter(),edits=dialogCharacters(),issues=reviewIssues(edits);if([...issues.values()].some(list=>list.some(issue=>issue.startsWith('A character name is required')||issue.startsWith('Duplicate name or alias'))))return notice('Resolve the duplicate or missing character names before saving.','error');const editById=new Map(edits.map(character=>[character.id,character]));const registry=structuredClone(book.characterRegistry);registry.characters=registry.characters.map(character=>{const edit=editById.get(character.id),next={...character,...edit};return {...next,issues:next.issues.filter(issue=>{const field=conflictField(issue);return !field||normCharacter(next[field])==='unknown'})}});applyCandidateResolutions(registry);try{book=await api('/api/characters',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source:book.sourcePath,registry})});characterDialog.close();if(resumeFromChapter!==undefined){scriptResumeFrom=resumeFromChapter;selected=new Set(book.chapters.filter(chapter=>chapter.narrate&&chapter.index>=resumeFromChapter).map(chapter=>chapter.index))}notice(resumeFromChapter===undefined?'Cast saved. Casting and later stages need a fresh run; scripts and paid audio are kept.':'Cast saved. Run Script to resume from chapter '+(resumeFromChapter+1)+'; attributed text is not paid for again.','success');render();refreshBooks()}catch(e){notice(e.message,'error')}}}
function renderCasting(){const form=$('#casting');if(!book.casting){form.innerHTML='<p class="subtle">Run Casting after at least one scripted chapter.</p>';return}const storyOf=new Map(((book.characterRegistry&&book.characterRegistry.characters)||[]).map(character=>[character.name,character.story]));const row=([name,a])=>{const binding=name==='narrator'?book.bindings?.narrator:book.bindings?.characters?.[name];const label=a.voiceProfile.presentation+' · '+a.voiceProfile.age+(a.voiceProfile.tone.length?' · '+a.voiceProfile.tone.join(', '):'');return '<div class="voice-row"><label title="'+esc(name)+'">'+esc(name)+'<br><small>'+esc(label)+'</small></label><select data-voice="'+esc(name)+'" '+(!book.bindings?'disabled':'')+'><option value="">'+(book.bindings?'Choose voice':'Run Voices first')+'</option>'+voices.filter(v=>!book.bindings||v.models.includes(book.bindings.target.provider+':'+book.bindings.target.model)).map(v=>'<option value="'+esc(v.id)+'" '+(v.id===binding?.libraryVoiceId?'selected':'')+'>'+esc(v.id)+'</option>').join('')+'</select><input data-instructions="'+esc(name)+'" value="'+esc(a.instructions)+'" aria-label="Instructions for '+esc(name)+'"></div>'};form.innerHTML=row(['narrator',book.casting.narrator])+groupedMarkup(Object.entries(book.casting.characters),([name])=>storyOf.get(name),row)}
async function run(stage,rebuild){if(stage==='synth'&&!confirm('Synthesis sends the selected text to your configured TTS provider and may incur charges. Continue?'))return;try{const chapters=!rebuild&&['script','synth','assemble'].includes(stage)&&selected.size?[...selected]:undefined;if(stage==='script')scriptResumeFrom=null;job=await api('/api/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source:book.sourcePath,stage,chapters,rerun:!rebuild,rebuild,llm:selectedLlm(),audio:selectedAudio()})});notice('Running '+stageLabel(stage)+(chapters?' for '+chapters.length+' selected chapter'+(chapters.length===1?'':'s'):'')+'…','progress');renderJob(job);render();poll()}catch(e){notice(e.message,'error')}}
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
  $('#activity-status').textContent=(current.sourcePath||current.epubPath).split('/').pop()+' · '+current.stage+' · '+current.status+elapsed;
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
    const activity={preparing:'Preparing script',attributing:'Scripting block '+progress.block+'/'+progress.totalBlocks,verifying:'Verifying '+progress.ambiguousSegments+' speaker assignment(s)',saving:'Saving script',completed:'Chapter complete',skipped:'Reusing existing script'}[progress.phase];
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
  if(current.status==='failed'&&current.stage==='script'&&/New or unresolved speakers/.test(current.error||'')&&!log.querySelector('[data-reconcile-speakers]')){const action=document.createElement('button');action.className='quiet';action.textContent='Ask LLM to propose speaker resolutions';action.dataset.reconcileSpeakers='';action.onclick=askLlmForSpeakerResolutions;log.append(action)}
  if(atBottom)log.scrollTop=log.scrollHeight;
}
function shellQuote(value){return "'"+String(value).replaceAll("'","'\"'\"'")+"'"}function showCommand(stage){const chapters=['script','synth','assemble'].includes(stage)&&selected.size?[...selected]:undefined;const parts=['npm run dev -- run',shellQuote(book.sourcePath),stage];if(stage==='script'){const llm=selectedLlm();parts.unshift('LISEN_LLM_PROVIDER='+shellQuote(llm.provider),'LISEN_SCRIPT_MODEL='+shellQuote(llm.scriptModel||llm.model),'LISEN_SCRIPT_REASONING_EFFORT='+shellQuote(llm.scriptReasoningEffort||'none'))}if(chapters)parts.push('--chapters',chapters.join(','));parts.push('--rerun','--work',shellQuote(book.workRoot));if(stage==='assemble'&&book.outDir)parts.push('--out',shellQuote(book.outDir));$('#cmd-title').textContent='Run '+stageLabel(stage)+' from the command line';$('#cmd-text').textContent=parts.join(' ');$('#cmd-dialog').showModal()}async function copyCommand(){const command=$('#cmd-text').textContent;try{await navigator.clipboard.writeText(command);$('#cmd-dialog').close();notice('Command copied.','success')}catch(e){notice('Could not copy the command. Select and copy it manually.','error')}}
async function poll(){if(!job)return;try{const current=await api('/api/job?id='+encodeURIComponent(job.id));job=current;renderJob(current);if(current.status==='running'||current.status==='cancelling'){setTimeout(poll,700);return}if(current.status==='failed')notice(current.error,'error');else if(current.status==='cancelled')notice('Task cancelled.','progress');else notice(current.output?'Created '+current.output:current.events.at(-1)?.message||'Stage complete.','success');job=null;book=await api('/api/book?source='+encodeURIComponent(book.sourcePath||book.epubPath));render();refreshBooks()}catch(e){notice(e.message,'error');job=null;render()}}
$('#open-form').onsubmit=e=>{e.preventDefault();openBook($('#source').value)};$('#select-all').onclick=()=>{book.chapters.filter(c=>c.narrate).forEach(c=>selected.add(c.index));render()};$('#clear-selection').onclick=()=>{selected.clear();render()};$('#open-settings').onclick=async()=>{try{modelSettings=await api('/api/settings');renderModelSettings();$('#settings-dialog').showModal()}catch(e){notice(e.message,'error')}};$('#close-settings').onclick=()=>$('#settings-dialog').close();$('#llm-provider').onchange=renderModelChoices;$('#llm-model').oninput=renderModelChoices;$('#script-reasoning-enabled').onchange=syncReasoningControls;$('#audio-provider').onchange=renderAudioModelChoices;$('#audio-model').oninput=renderAudioModelChoices;$('#apply-settings').onclick=()=>{const provider=$('#llm-provider').value,model=$('#llm-model').value.trim(),audioProvider=$('#audio-provider').value,audioModel=$('#audio-model').value.trim();if(!model)return notice('Enter a text-processing model name.','error');if(!audioModel)return notice('Enter an audio model name.','error');activeLlm={provider,model,scriptModel:$('#script-model').value.trim(),scriptReasoningEffort:$('#script-reasoning-enabled').checked&&!$('#script-reasoning-enabled').disabled?$('#script-reasoning-effort').value:'none'};activeAudio={provider:audioProvider,model:audioModel};$('#settings-dialog').close();notice('New text-processing runs will use '+provider+' / '+model+'. Script reasoning: '+activeLlm.scriptReasoningEffort+'. Voices will use '+audioProvider+' / '+audioModel+'.','success')};$('#collection-toggle').onchange=()=>{const collection=$('#collection-toggle').checked;storyDraft={collection,stories:defaultStories(collection)};renderStories()};$('#save-stories').onclick=async()=>{const state=editedStories();try{book=await api('/api/stories',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source:book.sourcePath,collection:state.collection,stories:state.stories})});storyDraft=null;notice('Story grouping saved. Script and later stages need a fresh run; paid audio is kept.','success');render();refreshBooks()}catch(e){notice(e.message,'error')}};$('#close-cmd').onclick=()=>$('#cmd-dialog').close();$('#copy-cmd').onclick=copyCommand;$('#save-casting').onclick=async()=>{if(!book.casting)return;const next={version:2,narrator:{...book.casting.narrator},characters:{}};const bindings=book.bindings?structuredClone(book.bindings):undefined;document.querySelectorAll('[data-voice]').forEach(x=>{const name=x.dataset.voice;const instructions=document.querySelector('[data-instructions="'+CSS.escape(name)+'"]').value;const current=name==='narrator'?book.casting.narrator:book.casting.characters[name];const item={...current,instructions};if(name==='narrator')next.narrator=item;else next.characters[name]=item;if(bindings&&x.value){const voice=voices.find(v=>v.id===x.value);if(voice){const existing=name==='narrator'?bindings.narrator:bindings.characters[name];const assignment={...existing,libraryVoiceId:voice.id,voiceId:voice.nativeVoiceId,selection:'manual',match:{reasons:['Selected manually in the workspace.'],limitations:[]}};if(name==='narrator')bindings.narrator=assignment;else bindings.characters[name]=assignment}}});try{book=await api('/api/casting',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source:book.sourcePath,casting:next,bindings})});notice('Cast and bindings saved. Existing audio is now stale.','success');render();refreshBooks()}catch(e){notice(e.message,'error')}};Promise.all([refreshBooks(),api('/api/voices'),api('/api/settings')]).then(([,v,settings])=>{voices=v;modelSettings=settings}).catch(e=>notice(e.message,'error'));
$('#source').placeholder='File path or https://example.com/story';
</script></body></html>`;
