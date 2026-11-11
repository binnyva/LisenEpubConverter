import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { STAGES } from '../src/config.js';

// Execute the actual browser script with a minimal DOM; no server or paid API calls.
function browser() {
  const nodes = new Map<string, any>();
  const element = () => ({
    textContent: '', className: '', hidden: true, children: [] as any[], dataset: {} as Record<string, string>,
    scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    append(child: any) { this.children.push(child); },
    replaceChildren() { this.children = []; },
    querySelector(selector: string) {
      return selector === '[data-reconcile-speakers]'
        ? this.children.find((child: any) => child.dataset?.reconcileSpeakers !== undefined)
        : undefined;
    },
    attributes: {} as Record<string, string>,
    setAttribute(name: string, value: string) { this.attributes[name] = value; },
    removeAttribute(name: string) { delete (this as any)[name]; },
  });
  const document = {
    querySelector(selector: string) {
      if (!nodes.has(selector)) nodes.set(selector, element());
      return nodes.get(selector);
    },
    querySelectorAll: () => [],
    createElement: element,
  };
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
  const context = vm.createContext({ document, fetch, setTimeout: vi.fn(), clearTimeout: vi.fn() });
  const source = fs.readFileSync(new URL('../src/ui/server.ts', import.meta.url), 'utf8');
  vm.runInContext(source.match(/<script>([\s\S]*?)<\/script>/)![1], context);
  return { nodes, fetch, context };
}

describe('UI stage activity', () => {
  it('shows a reasoning toggle and disables it for non-fiction books', () => {
    const source = fs.readFileSync(new URL('../src/ui/server.ts', import.meta.url), 'utf8');
    expect(source).toContain('<input type="checkbox" id="script-reasoning-enabled"');
    const { nodes, context } = browser();
    vm.runInContext(`modelSettings={provider:'openai',model:'text-model',scriptModel:'',scriptReasoningEffort:'high',models:[],modelsFile:'models.json',audio:{provider:'openai',model:'audio-model',models:[],modelsFile:'audio.json'}};book={metadata:{profile:{isFiction:false}}};renderModelSettings()`, context);
    expect(nodes.get('#script-reasoning-enabled')).toMatchObject({ checked: false, disabled: true });
    expect(nodes.get('#script-reasoning-effort').disabled).toBe(true);
    expect(vm.runInContext('selectedLlm().scriptReasoningEffort', context)).toBe('none');

    vm.runInContext('book.metadata.profile.isFiction=true;renderModelSettings()', context);
    expect(nodes.get('#script-reasoning-enabled')).toMatchObject({ checked: true, disabled: false });
    expect(nodes.get('#script-reasoning-effort')).toMatchObject({ value: 'high', disabled: false });
    expect(vm.runInContext('selectedLlm().scriptReasoningEffort', context)).toBe('high');
    vm.runInContext("document.querySelector('#script-reasoning-enabled').checked=false;syncReasoningControls()", context);
    expect(nodes.get('#script-reasoning-effort').disabled).toBe(true);
  });

  it('offers a close-task control only while a task is active', () => {
    const { nodes, context } = browser();
    context.current = { id: 'activity-1', epubPath: '/book.epub', stage: 'metadata', status: 'running', events: [] };
    vm.runInContext('renderJob(current)', context);
    expect(nodes.get('#close-task')).toMatchObject({ hidden: false, textContent: 'Close task' });

    vm.runInContext("current.status='cancelling';renderJob(current)", context);
    expect(nodes.get('#close-task')).toMatchObject({ hidden: false, disabled: true, textContent: 'Cancelling…' });

    vm.runInContext("current.status='cancelled';renderJob(current)", context);
    expect(nodes.get('#close-task').hidden).toBe(true);
  });

  it('shows indeterminate model work, measured audio units, and clears stale percentages for export', () => {
    const { nodes, context } = browser();
    context.current = { id: 'activity-1', epubPath: '/book.epub', stage: 'metadata', status: 'running',
      startedAt: Date.now() - 20000, progressUpdatedAt: Date.now() - 5000, events: [],
      progress: { activity: 'Analyzing sampled text — waiting for model response', elapsedMs: 15000 } };
    vm.runInContext('renderJob(current)', context);
    expect(nodes.get('#progress-title').textContent).toBe('Metadata');
    expect(nodes.get('#progress-bar').hidden).toBe(false);
    expect(nodes.get('#progress-bar').value).toBeUndefined();
    expect(nodes.get('#progress-phase').textContent).toContain('waiting for model response · 20s elapsed');
    expect(nodes.get('#progress-text').textContent).toBe('');
    vm.runInContext("current.stage='synth';current.progress={activity:'Synthesizing speech',completedUnits:3,totalUnits:4,unit:'audio segments ready',chapterIndex:2,chapterTitle:'<Alice>',completedChapters:0,totalChapters:2,elapsedMs:15000};renderJob(current)", context);
    expect(nodes.get('#progress-bar').value).toBe(75);
    expect(nodes.get('#progress-text').textContent).toBe('3/4 audio segments ready · 75%');
    expect(nodes.get('#progress-title').textContent).toBe('Chapter 3: <Alice>');
    expect(nodes.get('#progress-chapters').textContent).toBe('0/2 chapters complete');
    vm.runInContext("current.stage='assemble';current.progress={activity:'Writing M4B',elapsedMs:15000};renderJob(current)", context);
    expect(nodes.get('#progress-bar').value).toBeUndefined();
    expect(nodes.get('#progress-text').textContent).toBe('');
    expect(nodes.get('#progress-chapters').textContent).toBe('');
    vm.runInContext("current.status='failed';current.finishedAt=Date.now();renderJob(current)", context);
    expect(nodes.get('#progress-bar').hidden).toBe(true);
  });

  it('renders live text progress separately from chapter completion and resets it for another job', () => {
    const { nodes, context } = browser();
    const current = { id: 'progress-1', epubPath: '/book.epub', stage: 'script', status: 'running',
      startedAt: Date.now() - 20000, progressUpdatedAt: Date.now() - 5000, events: [],
      progress: { chapterIndex: 2, chapterTitle: '<Alice>', phase: 'attributing', block: 2, totalBlocks: 2,
        processedChars: 8000, totalChars: 11000, completedChapters: 0, totalChapters: 2, elapsedMs: 10000 } };
    context.current = current;
    vm.runInContext('renderJob(current)', context);
    expect(nodes.get('#chapter-progress').hidden).toBe(false);
    expect(nodes.get('#progress-title').textContent).toBe('Chapter 3: <Alice>');
    expect(nodes.get('#progress-bar').value).toBe(72);
    expect(nodes.get('#progress-text').textContent).toBe('72% of text processed');
    expect(nodes.get('#progress-phase').textContent).toContain('Scripting block 2/2 · 15s elapsed');
    expect(nodes.get('#progress-chapters').textContent).toBe('0/2 chapters complete');
    vm.runInContext("current.progress.phase='verifying';current.progress.processedChars=11000;current.progress.ambiguousSegments=4;renderJob(current)", context);
    expect(nodes.get('#progress-bar').value).toBe(100);
    expect(nodes.get('#progress-phase').textContent).toContain('Verifying 4');
    expect(nodes.get('#progress-chapters').textContent).toBe('0/2 chapters complete');
    vm.runInContext("current.status='failed';current.error='Verification failed';current.finishedAt=current.progressUpdatedAt;renderJob(current)", context);
    expect(nodes.get('#activity-status').textContent).toContain('failed');
    expect(nodes.get('#progress-phase').textContent).toContain('10s elapsed');
    vm.runInContext("renderJob({id:'next',epubPath:'/book.epub',stage:'analyze',status:'running',events:[]})", context);
    expect(nodes.get('#chapter-progress').hidden).toBe(true);
  });

  it('lists the seven stages and renders the profile, cast and usage safely', () => {
    const { nodes, context } = browser();
    expect(Array.from(vm.runInContext('stages', context))).toEqual([...STAGES]);
    context.currentBook = {
      sourcePath: '/book.epub', sourceAvailable: true, state: { completed: { extract: 'done' } }, chapters: [],
      metadata: { title: 'Book', profile: {
        recognised: false, summary: '<blurb>', summarySource: 'blurb', isFiction: true, form: 'novel', genres: ['mystery'],
        author: { sex: 'female', age: 'unknown', race: 'unknown', country: 'Ireland' }, narrator: { pointOfView: 'first', sex: 'female' },
        dialogueStyle: 'unquoted', dialogueStyleNote: 'The text has 0.1 double-quote pairs per 1,000 words.',
        chapters: [{ index: 0, title: '<One>', narrate: true, reason: 'body' }, { index: 1, title: 'Index', narrate: false, reason: 'index' }],
      } },
      characterRegistry: {
        characters: [{ id: 'a', name: '<Alice>', story: 'book', aliases: [], sex: 'female', age: 'child', named: true, chapters: [4], evidence: [{ chapter: 4, chunk: 0, text: '<quoted evidence>' }], issues: ['Conflicting sex: female / male.'] }],
        unresolved: [{ story: 'book', chapter: 6, speaker: '<a voice>', samples: [] }, { story: 'book', chapter: 7, speaker: 'answered', samples: [], resolveAs: '<Alice>' }],
      },
      usage: [
        { runId: 'r', stage: 'metadata', outcome: 'completed', wallMs: 4000, llm: { calls: 1, promptTokens: 9000, completionTokens: 400, reasoningTokens: 0 }, tts: { calls: 0, characters: 0 } },
        { runId: 'r', stage: 'script', outcome: 'failed', wallMs: 60000, llm: { calls: 10, promptTokens: 50000, completionTokens: 2000, reasoningTokens: 500 }, tts: { calls: 0, characters: 0 } },
        { runId: 's', stage: 'script', outcome: 'completed', wallMs: 65000, llm: { calls: 2, promptTokens: 1000, completionTokens: 100, reasoningTokens: 0 }, tts: { calls: 0, characters: 0 } },
      ],
    };
    vm.runInContext('book=currentBook;render()', context);
    const stageMarkup = nodes.get('#stages').innerHTML;
    expect(stageMarkup).toContain('Profile the book in one call');
    expect(stageMarkup).toContain('One pass over the text');
    expect(stageMarkup).not.toMatch(/analy[sz]e|List Characters/i);

    const profile = nodes.get('#profile').innerHTML;
    expect(profile).toContain('novel · mystery');
    expect(profile).toContain('first person · narrator female');
    expect(profile).toContain('Script asks the model for the segments');
    expect(profile).toContain('0.1 double-quote pairs');
    expect(profile).toContain('Summary (from the source blurb)');
    expect(profile).toContain('&lt;blurb&gt;');
    expect(profile).toContain('1 narrated of 2');
    expect(profile).toContain('&lt;One&gt;');

    expect(nodes.get('#character-status').textContent).toBe('1 character · 1 unresolved speaker blocking Script · 1 with notes for review');
    const cast = nodes.get('#characters').innerHTML;
    expect(cast).toContain('Review and edit the cast');
    expect(cast).toContain('&lt;Alice&gt;');
    expect(cast).toContain('chapters 5');
    expect(cast).toContain('&lt;quoted evidence&gt;');
    expect(cast).toContain('Unresolved in chapter 7: &lt;a voice&gt;');
    expect(cast).not.toContain('answered');

    const usage = nodes.get('#usage').innerHTML;
    expect(usage).toContain('<th scope="row">metadata</th><td>1</td><td>1</td><td>9,000</td><td>400</td><td>0</td><td>0</td><td>4s</td>');
    expect(usage).toContain('<th scope="row">script</th><td>2</td><td>12</td><td>51,000</td><td>2,100</td><td>500</td><td>0</td><td>2m 05s</td>');
    expect(usage).toContain('<th scope="row">total</th><td>3</td><td>13</td><td>60,000</td>');
    expect(usage).toContain('Last: script · completed');
  });

  it('prompts for Metadata and Script before they have run, and explains an outdated folder', () => {
    const { nodes, context } = browser();
    vm.runInContext("book={sourcePath:'/book.epub',sourceAvailable:true,state:{completed:{}},chapters:[],metadata:{title:'Book'},usage:[]};render()", context);
    expect(nodes.get('#profile').innerHTML).toContain('Run Metadata to profile the book.');
    expect(nodes.get('#character-status').textContent).toContain('Run Script to discover who speaks');
    expect(nodes.get('#usage').innerHTML).toContain('No stage has run yet.');
    vm.runInContext("book={sourcePath:'/book.epub',sourceAvailable:true,state:{completed:{}},chapters:[],usage:[],outdated:'Rebuild it from Extract <now>.'};render()", context);
    expect(nodes.get('#profile').innerHTML).toContain('Rebuild it from Extract &lt;now&gt;.');
  });

  it('renders conflicting character details as selectable choices', () => {
    const { context } = browser();
    const markup = vm.runInContext("issueMarkup('Conflicting age: young girl / young / child.')", context);
    expect(markup).toContain('data-conflict-choice');
    expect(markup).toContain('data-conflict-field="age"');
    expect(markup).toContain('young girl');
  });

  it('can hide non-blocking character review cards', () => {
    const { nodes, context } = browser();
    context.reviewRows = [{ hidden: false, classList: { contains: () => false } }, { hidden: false, classList: { contains: () => true } }];
    vm.runInContext("document.querySelectorAll=selector=>selector==='[data-character-editor]'?reviewRows:[];showBlockingCharacterIssues=true;updateCharacterReviewFilter()", context);
    expect(context.reviewRows.map((row: any) => row.hidden)).toEqual([true, false]);
    expect(nodes.get('#show-blocking-character-issues')).toMatchObject({ textContent: 'Show all character issues' });
    expect(nodes.get('#show-blocking-character-issues').attributes['aria-pressed']).toBe('true');
  });

  it('offers an unresolved speaker a match, add or narrator resolution in the cast dialog', () => {
    const { context } = browser();
    vm.runInContext("candidateResolutions={};book={chapters:[{index:12,title:'Sacks'}],characterRegistry:{characters:[{id:'alice',name:'Alice',story:'book',chapters:[12]},{id:'bob',name:'Bob',story:'story-09',chapters:[2]}],unresolved:[{story:'book',chapter:4,speaker:'Poem Fury',samples:[{text:'\"Mine!\"',context:'>> [Poem Fury] \"Mine!\"'}]}]}}", context);
    const markup = vm.runInContext('candidateMarkup(unresolvedCandidates()[0],book.characterRegistry)', context);
    expect(markup).toContain('data-key="4:poem fury"');
    expect(markup).toContain('Unresolved speaker: Poem Fury');
    expect(markup).toContain('Add Poem Fury as a new character');
    expect(markup).toContain('Not speech: give it to the narrator');
    expect(markup).toContain("C 13: Alice (from Chapter &#39;Sacks&#39;)");
    // Only the cast of the speaker's own story is offered.
    expect(markup).not.toContain('Bob');
    expect(markup).toContain('&gt;&gt; [Poem Fury]');
  });

  it('turns resolutions into a chapter-scoped answer or a new character, never an alias', () => {
    const { context } = browser();
    vm.runInContext("book={chapters:[],characterRegistry:{characters:[{id:'alice',name:'Alice',story:'book',aliases:[],chapters:[1]}],unresolved:[{story:'book',chapter:4,speaker:'a voice',samples:[]},{story:'book',chapter:5,speaker:'the porter',samples:[{text:'Sir?'}]},{story:'book',chapter:6,speaker:'sign',samples:[]}]}};candidateResolutions={'4:a voice':'alice','5:the porter':'new','6:sign':'narrator'}", context);
    const registry = JSON.parse(vm.runInContext('JSON.stringify(applyCandidateResolutions(JSON.parse(JSON.stringify(book.characterRegistry))))', context));
    expect(registry.unresolved.map((record: any) => record.resolveAs)).toEqual(['Alice', undefined, 'narrator']);
    expect(registry.characters[0].aliases).toEqual([]);
    expect(registry.characters[1]).toMatchObject({ name: 'the porter', story: 'book', chapters: [5], evidence: [{ chapter: 5, text: 'Sir?' }] });
    expect(vm.runInContext('unresolvedCandidateCount()', context)).toBe(0);
  });

  it('preselects supported LLM speaker proposals but leaves unsupported ones unresolved', () => {
    const { context } = browser();
    vm.runInContext("book={characterRegistry:{characters:[{id:'alice',name:'Alice'}],unresolved:[]}}", context);
    vm.runInContext("applySpeakerSuggestions([{key:'4:fellow',resolution:'existing',character:'Alice',reason:'Explicit dialogue tag.',evidence:'Alice said.'},{key:'5:girl',resolution:'new',reason:'A distinct role speaks.',evidence:'the girl said'},{key:'6:unknown',resolution:'unresolved',reason:'No support.',evidence:''},{key:'7:ghost',resolution:'existing',character:'Nobody',reason:'',evidence:''}])", context);
    expect(vm.runInContext('candidateResolutions["4:fellow"]', context)).toBe('alice');
    expect(vm.runInContext('candidateResolutions["5:girl"]', context)).toBe('new');
    expect(vm.runInContext('candidateResolutions["6:unknown"]', context)).toBeUndefined();
    expect(vm.runInContext('candidateResolutions["7:ghost"]', context)).toBeUndefined();
    expect(vm.runInContext('candidateSuggestions["4:fellow"].reason', context)).toBe('Explicit dialogue tag.');
  });

  it('offers LLM reconciliation directly beside an unresolved Script failure', () => {
    const { nodes, context } = browser();
    context.current = { id: 'speaker-failure', epubPath: '/book.epub', stage: 'script', status: 'failed', events: [],
      error: 'New or unresolved speakers in chapter 15: fellow in denim.' };
    vm.runInContext('renderJob(current)', context);
    expect(nodes.get('#activity-log').children.at(-1)).toMatchObject({
      textContent: 'Ask LLM to propose speaker resolutions', className: 'quiet',
    });
  });

  it('resumes Script at the first chapter with an unresolved speaker', () => {
    const { context } = browser();
    vm.runInContext("book={characterRegistry:{characters:[],unresolved:[{chapter:8,speaker:'a'},{chapter:4,speaker:'b'},{chapter:7,speaker:'c'}]}}", context);
    expect(vm.runInContext('resumeFromCandidateChapter()', context)).toBe(4);
  });

  it.each(['completed', 'failed'])('shows retry warnings while polling and retains them after %s', async (status) => {
    const { nodes, fetch, context } = browser();
    await new Promise((resolve) => setImmediate(resolve));
    const warning = 'LLM failed (429): <script>provider text</script>, retrying in 2s...';
    const current = { id: 'job-1', epubPath: '/books/book.epub', stage: 'script', status: 'running',
      events: [{ type: 'started', message: 'Running script…' }, { type: 'warning', message: warning }] };
    context.current = current;
    vm.runInContext('job=current; book={epubPath:current.epubPath}; render=()=>{}; refreshBooks=()=>{};', context);
    fetch.mockResolvedValue({ ok: true, json: async () => current });
    await vm.runInContext('poll()', context);
    expect(nodes.get('#activity').hidden).toBe(false);
    expect(nodes.get('#activity-status').textContent).toContain('running');
    expect(nodes.get('#activity-log').children[1]).toMatchObject({ textContent: warning, className: 'activity-event warning' });
    await vm.runInContext('poll()', context);
    expect(nodes.get('#activity-log').children).toHaveLength(2);

    const finished = { ...current, status, error: status === 'failed' ? 'Retries exhausted (429)' : undefined,
      events: status === 'completed' ? [...current.events, { type: 'completed', message: 'script complete.' }] : current.events };
    fetch.mockResolvedValue({ ok: true, json: async () => finished });
    await vm.runInContext('poll()', context);
    expect(nodes.get('#activity-status').textContent).toContain(status);
    expect(nodes.get('#activity-log').children).toHaveLength(3);
    expect(nodes.get('#activity-log').children[1].textContent).toBe(warning);
    expect(nodes.get('#activity-log').children[2].textContent).toBe(status === 'failed' ? finished.error : 'script complete.');
    expect(vm.runInContext('job', context)).toBeNull();

    context.next = { ...current, id: 'job-2', events: [{ type: 'started', message: 'Running script…' }] };
    vm.runInContext('renderJob(next)', context);
    expect(nodes.get('#activity-log').children).toHaveLength(1);
  });
});
