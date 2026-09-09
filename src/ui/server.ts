import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { STAGES, type Stage } from '../config.js';
import { CastingSchema, VoiceBindingsSchema, type Analysis, type BookMetadata, type Casting, type VoiceBindings } from '../types.js';
import { clearArtifactsFrom, discoverBooks, recoverStageStateFromArtifacts, runStage, type PipelineEvent } from '../pipeline/runner.js';
import { WorkDir, type WorkState } from '../state.js';
import { loadVoiceLibrary } from '../voices/library.js';

interface UiOptions {
  workRoot: string;
  outDir: string;
  port: number;
}

interface LocalJob {
  id: string;
  status: 'running' | 'completed' | 'failed';
  stage: Stage;
  epubPath: string;
  events: PipelineEvent[];
  output?: string;
  error?: string;
}

const JSON_LIMIT = 1_000_000;

/** A deliberately local UI: provider credentials and filesystem access stay in Node, never the browser. */
export async function startLocalUi(options: UiOptions): Promise<string> {
  const jobs = new Map<string, LocalJob>();
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
      if (request.method === 'GET' && url.pathname === '/api/job') {
        const id = url.searchParams.get('id');
        const job = id ? jobs.get(id) : undefined;
        if (!job) return json(response, 404, { error: 'Job not found.' });
        return json(response, 200, job);
      }
      if (request.method === 'POST' && url.pathname === '/api/books/open') {
        const body = await bodyJson<{ epub?: string; root?: string }>(request);
        return json(response, 200, withUiPaths(body.root ? bookDetailFromRoot(body.root, workRoot) : bookDetail(requireEpub(body.epub), workRoot)));
      }
      if (request.method === 'POST' && url.pathname === '/api/run') {
        if (activeJob?.status === 'running') return json(response, 409, { error: `A ${activeJob.stage} job is already running.` });
        const body = await bodyJson<{ epub?: string; stage?: Stage; chapters?: number[]; rerun?: boolean; rebuild?: boolean }>(request);
        const epubPath = requireEpub(body.epub);
        if (!body.stage || !STAGES.includes(body.stage)) return json(response, 400, { error: 'Invalid stage.' });
        const job: LocalJob = {
          id: crypto.randomUUID(), status: 'running', stage: body.stage, epubPath, events: [],
        };
        activeJob = job;
        jobs.set(job.id, job);
        void runStage({
          epubPath,
          workRoot,
          outDir,
          stage: body.stage,
          chapterIndexes: body.chapters,
          rerun: body.rerun,
          rebuild: body.rebuild,
          onEvent: (event) => job.events.push(event),
        }).then((result) => {
          job.status = 'completed';
          job.output = result.output;
        }).catch((error: unknown) => {
          job.status = 'failed';
          job.error = error instanceof Error ? error.message : String(error);
        }).finally(() => {
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
  return { epubPath, epubAvailable: fs.existsSync(epubPath), root: rootResolved, state, metadata, analysis, casting, bindings, chapters };
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
:root{color-scheme:dark;font-family:ui-rounded,"SF Pro Rounded",system-ui,sans-serif;background:#101725;color:#eaf0ff}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 0 0,#243667,transparent 38rem),#101725;min-height:100vh}.shell{max-width:1280px;margin:auto;padding:38px 24px 80px}header{display:flex;justify-content:space-between;align-items:end;margin-bottom:32px}.eyebrow{font-size:.72rem;text-transform:uppercase;letter-spacing:.16em;color:#9eb1df;margin:0 0 8px}h1{margin:0;font-size:2.4rem;letter-spacing:-.06em}h2{font-size:1.1rem;margin:0 0 14px}h3{font-size:.9rem;margin:0}.subtle{color:#aebbd9;font-size:.9rem}.panel{background:rgba(20,30,51,.82);border:1px solid #304267;border-radius:18px;padding:20px;box-shadow:0 20px 55px #070b1526}.open{display:grid;grid-template-columns:1fr auto;gap:10px;margin-bottom:20px}input,textarea,select,button{font:inherit}input,textarea{border:1px solid #40547d;background:#101a30;color:#edf3ff;border-radius:9px;padding:10px 12px}button{border:0;border-radius:9px;background:#89f0cb;color:#08231e;font-weight:750;padding:10px 14px;cursor:pointer}button:hover{filter:brightness(1.06)}button:disabled{cursor:not-allowed;opacity:.45}.quiet{background:#263754;color:#dfebff}.danger{background:#6d3c53;color:#ffe6ee}.books{display:flex;gap:9px;flex-wrap:wrap}.book{background:#192742;color:#dce9ff;border:1px solid #3c5075}.book.missing{border-color:#a65b70;color:#f1b9c7}.book.active{outline:2px solid #89f0cb}.workspace{display:grid;grid-template-columns:minmax(420px,1.35fr) minmax(280px,.65fr);gap:20px;margin-top:20px}.stages{display:grid;gap:9px}.stage{display:grid;grid-template-columns:12px 1fr auto;gap:12px;align-items:center;padding:13px 14px;background:#15213a;border:1px solid #2c3d61;border-radius:12px}.dot{width:10px;height:10px;border-radius:50%;background:#576984}.dot.done{background:#89f0cb}.dot.stale{background:#f3bd63}.dot.running{background:#91b9ff;animation:pulse 1s infinite}.stage-name{text-transform:capitalize;font-weight:700}.stage-meta{font-size:.77rem;color:#a6b7d9;margin-top:2px}.actions{display:flex;gap:6px}.actions button{padding:7px 10px;font-size:.78rem}.chapter-tools{display:flex;gap:8px;align-items:center;margin:18px 0 10px}.chapter-list{max-height:430px;overflow:auto;border-top:1px solid #2d3c5e}.chapter{display:grid;grid-template-columns:auto 34px 1fr auto;gap:9px;align-items:center;padding:9px 2px;border-bottom:1px solid #263653;font-size:.86rem}.chapter.skip{opacity:.48}.badges{display:flex;gap:4px}.badge{font-size:.66rem;border:1px solid #40547d;color:#bcd1f6;border-radius:99px;padding:2px 5px}.badge.ready{border-color:#3c8f77;color:#9ff1d2}.detail{display:grid;gap:20px}.json{margin:0;max-height:210px;overflow:auto;background:#0e172a;color:#c9d9ff;border-radius:10px;padding:13px;font:12px ui-monospace,SFMono-Regular,monospace;white-space:pre-wrap}.cast{display:grid;gap:9px}.voice-row{display:grid;grid-template-columns:110px 1fr 1.5fr;gap:7px;align-items:center}.voice-row label{font-size:.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.voice-row select,.voice-row input{min-width:0;padding:8px}.toast{position:fixed;right:22px;bottom:22px;z-index:10;max-width:min(420px,calc(100vw - 44px));padding:13px 16px;border:1px solid #41577f;border-radius:12px;background:#283a5e;color:#e2ecff;font-size:.9rem;box-shadow:0 16px 42px #0509138c;opacity:0;transform:translateY(14px);pointer-events:none;transition:opacity .18s ease,transform .18s ease}.toast.visible{opacity:1;transform:translateY(0);pointer-events:auto}.toast.success{background:#173d36;border-color:#3d927a;color:#c3f9e3}.toast.error{background:#563145;border-color:#9e5e72;color:#ffe1e9}.toast.progress{background:#263b64;border-color:#6585be;color:#d9e7ff}dialog{width:min(680px,calc(100vw - 32px));border:1px solid #49618e;border-radius:16px;background:#17233c;color:#edf3ff;box-shadow:0 30px 90px #050913b3;padding:22px}dialog::backdrop{background:#050913aa}.dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}.command{margin:0;overflow:auto;border:1px solid #3c5177;border-radius:9px;background:#0d1628;padding:13px;color:#cbdaff;font:13px ui-monospace,SFMono-Regular,monospace;white-space:pre-wrap;word-break:break-word}@keyframes pulse{50%{opacity:.35}}@media(max-width:850px){.workspace{grid-template-columns:1fr}.shell{padding:22px 14px}header{align-items:start;flex-direction:column;gap:9px}.open{grid-template-columns:1fr}.voice-row{grid-template-columns:1fr}}
</style></head><body><main class="shell"><header><div><p class="eyebrow">Local audiobook production</p><h1>Lisen workspace</h1></div><p class="subtle">Files and API keys stay on this machine.</p></header><section class="panel"><form class="open" id="open-form"><input id="epub" placeholder="/full/path/to/book.epub" aria-label="EPUB path" required><button>Open EPUB</button></form><div id="books" class="books"></div></section><section id="workspace" class="workspace" hidden><div class="panel"><h2 id="book-title">Pipeline</h2><div id="stages" class="stages"></div><div id="chapter-area" hidden><div class="chapter-tools"><button class="quiet" id="select-all">Select narratable</button><button class="quiet" id="clear-selection">Clear</button><span class="subtle" id="selected-count"></span></div><div id="chapters" class="chapter-list"></div></div></div><aside class="detail"><div class="panel"><h2>Book analysis</h2><pre class="json" id="analysis"></pre></div><div class="panel"><h2>Voice casting</h2><p class="subtle">Saving changes makes synthesis and assembly stale.</p><form class="cast" id="casting"></form><button id="save-casting">Save casting</button></div></aside></section></main><dialog id="cmd-dialog" aria-labelledby="cmd-title"><h2 id="cmd-title">Run from the command line</h2><pre id="cmd-text" class="command"></pre><div class="dialog-actions"><button class="quiet" id="close-cmd">Close</button><button id="copy-cmd">Copy command</button></div></dialog><div id="toast" class="toast" role="status" aria-live="polite"></div><script>
const stages=['extract','analyze','chapters','script','casting','voices','synth','assemble'];let book=null,voices=[],selected=new Set(),job=null,toastTimer=null;
const $=s=>document.querySelector(s);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(url,opts){const r=await fetch(url,opts);const data=await r.json();if(!r.ok)throw Error(data.error||'Request failed.');return data}
function notice(message,kind=''){const toast=$('#toast');clearTimeout(toastTimer);toast.textContent=message||'';toast.className='toast '+(message?'visible ':'')+kind;if(message&&kind!=='progress')toastTimer=setTimeout(()=>{toast.className='toast';},5500)}
async function refreshBooks(){const books=await api('/api/books');$('#books').innerHTML=books.length?books.map(b=>'<button class="book '+(!b.epubAvailable?'missing ':'')+(book&&b.root===book.root?'active':'')+'" data-root="'+esc(b.root)+'">'+esc(b.epubPath.split('/').pop())+(b.epubAvailable?'':' · source missing')+'</button>').join(''):'<span class="subtle">No existing work folders yet.</span>';document.querySelectorAll('[data-root]').forEach(x=>x.onclick=()=>openExisting(x.dataset.root));}
async function openBook(epub){try{book=await api('/api/books/open',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({epub})});selected=new Set();$('#workspace').hidden=false;$('#epub').value=book.epubPath;notice(book.state.sourceChanged?'This EPUB differs from the source used for the existing artifacts. Rebuild Extract before running later stages.':'',book.state.sourceChanged?'error':'');render();refreshBooks()}catch(e){notice(e.message,'error')}}
async function openExisting(root){try{book=await api('/api/books/open',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({root})});selected=new Set();$('#workspace').hidden=false;$('#epub').value=book.epubPath;notice(!book.epubAvailable?'Source EPUB is missing. You can inspect this work folder; paste the current EPUB path above to relink it.':book.state.sourceChanged?'This EPUB differs from the source used for the existing artifacts. Rebuild Extract before running later stages.':'',(!book.epubAvailable||book.state.sourceChanged)?'error':'');render();refreshBooks()}catch(e){notice(e.message,'error')}}
function stageState(stage){if(job&&job.status==='running'&&job.stage===stage)return 'running';if(book.state.completed[stage])return 'done';const order=stages.indexOf(stage);return stages.slice(0,order).some(s=>book.state.completed[s])?'stale':'ready'}
function render(){if(!book)return;const title=book.metadata?.title||book.epubPath.split('/').pop();$('#book-title').textContent=title+' · pipeline';$('#analysis').textContent=book.analysis?JSON.stringify(book.analysis,null,2):'Run Analyze to inspect the book.';$('#stages').innerHTML=stages.map(stage=>{const state=stageState(stage),disabled=job||!book.epubAvailable;return '<div class="stage"><i class="dot '+state+'"></i><div><div class="stage-name">'+stage+'</div><div class="stage-meta">'+stageHint(stage,state)+'</div></div><div class="actions"><button class="quiet" data-run="'+stage+'" '+(disabled?'disabled':'')+'>Run</button><button class="danger" data-rebuild="'+stage+'" '+(disabled?'disabled':'')+'>Rebuild all</button><button class="quiet" data-cmd="'+stage+'">Cmd</button></div></div>'}).join('');document.querySelectorAll('[data-run]').forEach(x=>x.onclick=()=>run(x.dataset.run,false));document.querySelectorAll('[data-rebuild]').forEach(x=>x.onclick=()=>run(x.dataset.rebuild,true));document.querySelectorAll('[data-cmd]').forEach(x=>x.onclick=()=>showCommand(x.dataset.cmd));renderChapters();renderCasting()}
function stageHint(stage,state){const descriptions={extract:'Read the EPUB into chapters, metadata, and cover art.',analyze:'Identify characters, summarize the book, and choose what to narrate.',chapters:'Clean selected chapters for narration and create chapter summaries.',script:'Split prose and dialogue into speaker-attributed segments.',casting:'Describe the intended sound and delivery for each speaker.',voices:'Match the cast to voices from the shared library.',synth:'Turn selected script segments into cached speech audio. TTS usage is billable.',assemble:'Combine synthesized chapters into an M4B with chapter markers.'};if(state==='done')return 'Complete · '+descriptions[stage];if(state==='running')return 'Running locally…';return state==='stale'?'Needs a fresh run · '+descriptions[stage]:descriptions[stage]}
function renderChapters(){const has=book.chapters.length>0;$('#chapter-area').hidden=!has;if(!has)return;$('#selected-count').textContent=selected.size?selected.size+' selected':'';$('#chapters').innerHTML=book.chapters.map(c=>'<label class="chapter '+(!c.narrate?'skip':'')+'"><input type="checkbox" data-chapter="'+c.index+'" '+(!c.narrate?'disabled ':'')+(selected.has(c.index)?'checked':'')+'><span>'+String(c.index+1).padStart(2,'0')+'</span><span>'+esc(c.title)+'</span><span class="badges">'+(c.narrate?'<i class="badge">narrate</i>':'<i class="badge">skip</i>')+(c.cleaned?'<i class="badge ready">clean</i>':'')+(c.scripted?'<i class="badge ready">script</i>':'')+(c.synthesized?'<i class="badge ready">audio</i>':'')+'</span></label>').join('');document.querySelectorAll('[data-chapter]').forEach(x=>x.onchange=()=>{x.checked?selected.add(+x.dataset.chapter):selected.delete(+x.dataset.chapter);render()})}
function renderCasting(){const form=$('#casting');if(!book.casting){form.innerHTML='<p class="subtle">Run Casting after at least one scripted chapter.</p>';return}const assignments=[['narrator',book.casting.narrator],...Object.entries(book.casting.characters)];form.innerHTML=assignments.map(([name,a])=>{const binding=name==='narrator'?book.bindings?.narrator:book.bindings?.characters?.[name];const label=a.voiceProfile.presentation+' · '+a.voiceProfile.age+(a.voiceProfile.tone.length?' · '+a.voiceProfile.tone.join(', '):'');return '<div class="voice-row"><label title="'+esc(name)+'">'+esc(name)+'<br><small>'+esc(label)+'</small></label><select data-voice="'+esc(name)+'" '+(!book.bindings?'disabled':'')+'><option value="">'+(book.bindings?'Choose voice':'Run Voices first')+'</option>'+voices.filter(v=>!book.bindings||v.models.includes(book.bindings.target.provider+':'+book.bindings.target.model)).map(v=>'<option value="'+esc(v.id)+'" '+(v.id===binding?.libraryVoiceId?'selected':'')+'>'+esc(v.id)+'</option>').join('')+'</select><input data-instructions="'+esc(name)+'" value="'+esc(a.instructions)+'" aria-label="Instructions for '+esc(name)+'"></div>'}).join('')}
async function run(stage,rebuild){if(stage==='synth'&&!confirm('Synthesis sends the selected text to your configured TTS provider and may incur charges. Continue?'))return;try{const chapters=!rebuild&&['chapters','script','synth','assemble'].includes(stage)&&selected.size?[...selected]:undefined;job=await api('/api/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({epub:book.epubPath,stage,chapters,rerun:!rebuild,rebuild})});notice('Running '+stage+(chapters?' for '+chapters.length+' selected chapter'+(chapters.length===1?'':'s'):'')+'…','progress');render();poll()}catch(e){notice(e.message,'error')}}
function shellQuote(value){return JSON.stringify(String(value))}function showCommand(stage){const chapters=['chapters','script','synth','assemble'].includes(stage)&&selected.size?[...selected]:undefined;const parts=['npm run dev -- run',shellQuote(book.epubPath),stage];if(chapters)parts.push('--chapters',chapters.join(','));parts.push('--rerun','--work',shellQuote(book.workRoot));if(stage==='assemble')parts.push('--out',shellQuote(book.outDir));$('#cmd-title').textContent='Run '+stage+' from the command line';$('#cmd-text').textContent=parts.join(' ');$('#cmd-dialog').showModal()}async function copyCommand(){const command=$('#cmd-text').textContent;try{await navigator.clipboard.writeText(command);$('#cmd-dialog').close();notice('Command copied.','success')}catch(e){notice('Could not copy the command. Select and copy it manually.','error')}}
async function poll(){if(!job)return;try{const current=await api('/api/job?id='+encodeURIComponent(job.id));job=current;if(current.status==='running'){setTimeout(poll,700);return}if(current.status==='failed')notice(current.error,'error');else notice(current.output?'Created '+current.output:current.events.at(-1)?.message||'Stage complete.','success');job=null;book=await api('/api/book?epub='+encodeURIComponent(book.epubPath));render();refreshBooks()}catch(e){notice(e.message,'error');job=null;render()}}
$('#open-form').onsubmit=e=>{e.preventDefault();openBook($('#epub').value)};$('#select-all').onclick=()=>{book.chapters.filter(c=>c.narrate).forEach(c=>selected.add(c.index));render()};$('#clear-selection').onclick=()=>{selected.clear();render()};$('#close-cmd').onclick=()=>$('#cmd-dialog').close();$('#copy-cmd').onclick=copyCommand;$('#save-casting').onclick=async()=>{if(!book.casting)return;const next={version:2,narrator:{...book.casting.narrator},characters:{}};const bindings=book.bindings?structuredClone(book.bindings):undefined;document.querySelectorAll('[data-voice]').forEach(x=>{const name=x.dataset.voice;const instructions=document.querySelector('[data-instructions="'+CSS.escape(name)+'"]').value;const current=name==='narrator'?book.casting.narrator:book.casting.characters[name];const item={...current,instructions};if(name==='narrator')next.narrator=item;else next.characters[name]=item;if(bindings&&x.value){const voice=voices.find(v=>v.id===x.value);if(voice){const existing=name==='narrator'?bindings.narrator:bindings.characters[name];const assignment={...existing,libraryVoiceId:voice.id,voiceId:voice.nativeVoiceId,selection:'manual',match:{reasons:['Selected manually in the workspace.'],limitations:[]}};if(name==='narrator')bindings.narrator=assignment;else bindings.characters[name]=assignment}}});try{book=await api('/api/casting',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({epub:book.epubPath,casting:next,bindings})});notice('Cast and bindings saved. Existing audio is now stale.','success');render();refreshBooks()}catch(e){notice(e.message,'error')}};Promise.all([refreshBooks(),api('/api/voices')]).then(([,v])=>{voices=v}).catch(e=>notice(e.message,'error'));
</script></body></html>`;
