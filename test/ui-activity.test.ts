import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { STAGES } from '../src/config.js';

// Execute the actual browser script with a minimal DOM; no server or paid API calls.
function browser() {
  const nodes = new Map<string, any>();
  const element = () => ({
    textContent: '', className: '', hidden: true, children: [] as any[],
    scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    append(child: any) { this.children.push(child); },
    replaceChildren() { this.children = []; },
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
  it('offers a close-task control only while a task is active', () => {
    const { nodes, context } = browser();
    context.current = { id: 'activity-1', epubPath: '/book.epub', stage: 'analyze', status: 'running', events: [] };
    vm.runInContext('renderJob(current)', context);
    expect(nodes.get('#close-task')).toMatchObject({ hidden: false, textContent: 'Close task' });

    vm.runInContext("current.status='cancelling';renderJob(current)", context);
    expect(nodes.get('#close-task')).toMatchObject({ hidden: false, disabled: true, textContent: 'Cancelling…' });

    vm.runInContext("current.status='cancelled';renderJob(current)", context);
    expect(nodes.get('#close-task').hidden).toBe(true);
  });

  it('shows indeterminate model work, measured audio units, and clears stale percentages for export', () => {
    const { nodes, context } = browser();
    context.current = { id: 'activity-1', epubPath: '/book.epub', stage: 'analyze', status: 'running',
      startedAt: Date.now() - 20000, progressUpdatedAt: Date.now() - 5000, events: [],
      progress: { activity: 'Analyzing sampled text — waiting for model response', elapsedMs: 15000 } };
    vm.runInContext('renderJob(current)', context);
    expect(nodes.get('#progress-title').textContent).toBe('Analyze');
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
    expect(nodes.get('#progress-phase').textContent).toContain('Attributing block 2/2 · 15s elapsed');
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

  it('shows List Characters between Chapters and Script and renders discoveries safely', () => {
    const { nodes, context } = browser();
    expect(Array.from(vm.runInContext('stages', context))).toEqual([...STAGES]);
    context.currentBook = {
      epubPath: '/book.epub', epubAvailable: true, metadata: { title: 'Book' },
      state: { completed: { chapters: 'done' } }, chapters: [],
      characterObservations: [{ index: 4, observations: [{ name: '<Alice>', aliases: [], sex: 'unknown', age: 'unknown', country: 'unknown', evidence: '<quoted evidence>', confidence: 'low' }] }],
    };
    vm.runInContext('book=currentBook;render()', context);
    expect(nodes.get('#stages').innerHTML).toContain('List Characters');
    expect(nodes.get('#character-status').textContent).toContain('1 chapters scanned');
    expect(nodes.get('#characters').innerHTML).toContain('&lt;Alice&gt;');
    expect(nodes.get('#characters').innerHTML).toContain('chapters 5');
    expect(nodes.get('#characters').innerHTML).toContain('Needs review');
    vm.runInContext("book.state.completed['list-characters']='done';book.characterRegistry={characters:[]};renderCharacters()", context);
    expect(nodes.get('#character-status').textContent).toBe('Book character registry · 0 characters');
    expect(nodes.get('#characters').innerHTML).toContain('Review and edit registry');
  });

  it('renders conflicting character details as selectable choices', () => {
    const { context } = browser();
    const markup = vm.runInContext("issueMarkup('Conflicting age: young girl / young / child.')", context);
    expect(markup).toContain('data-conflict-choice');
    expect(markup).toContain('data-conflict-field="age"');
    expect(markup).toContain('young girl');
  });

  it('offers an unresolved speaker a match-or-add resolution in the character dialog', () => {
    const { context } = browser();
    vm.runInContext("candidateResolutions={};book={characterCandidates:[],characterRegistry:{characters:[{id:'alice',name:'Alice'}]}}", context);
    const markup = vm.runInContext("candidateMarkup({key:'candidate-poem-fury',speaker:'Poem Fury',chapters:[4],samples:[]},book.characterRegistry)", context);
    expect(markup).toContain('Unresolved speaker: Poem Fury');
    expect(markup).toContain('Add Poem Fury as a new character');
    expect(markup).toContain('Use existing character: Alice');
  });

  it('resumes Script at the first chapter with an unresolved speaker', () => {
    const { context } = browser();
    vm.runInContext("book={characterCandidates:[{chapters:[8]},{chapters:[4,7]}]}", context);
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
