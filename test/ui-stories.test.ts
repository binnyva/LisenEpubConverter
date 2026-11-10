import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// The real browser script with a minimal DOM; no server or paid API calls.
function browser() {
  const nodes = new Map<string, any>();
  const element = () => ({
    textContent: '', innerHTML: '', className: '', hidden: true, checked: false, disabled: false,
    value: '', children: [] as any[], dataset: {} as Record<string, string>,
    scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    append(child: any) { this.children.push(child); },
    replaceChildren() { this.children = []; },
    querySelector() { return undefined; },
    classList: { toggle() {} },
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
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sourcePath: '/book.epub' }) });
  const context = vm.createContext({ document, fetch, setTimeout: vi.fn(), clearTimeout: vi.fn() });
  const source = fs.readFileSync(new URL('../src/ui/server.ts', import.meta.url), 'utf8');
  vm.runInContext(source.match(/<script>([\s\S]*?)<\/script>/)![1], context);
  return { nodes, fetch, context };
}

const book = (overrides: object = {}) => ({
  sourcePath: '/book.epub',
  sourceAvailable: true,
  metadata: { title: 'Collected Stories', chapters: [] },
  analysis: { isFiction: true, isCollection: true },
  state: { completed: {}, collection: true },
  chapters: [
    { index: 0, title: 'The Sentinel', narrate: true },
    { index: 1, title: 'Rescue Party', narrate: true },
    { index: 2, title: 'Notes', narrate: false },
  ],
  characterObservations: [],
  characterCandidates: [],
  ...overrides,
});

function workspace(overrides: object = {}) {
  const harness = browser();
  // `book` is a let binding inside the script, so it is assigned in the VM.
  vm.runInContext(`book=${JSON.stringify(book(overrides))}`, harness.context);
  return harness;
}

describe('UI story grouping', () => {
  it('ships the grouping panel and its save control', () => {
    const source = fs.readFileSync(new URL('../src/ui/server.ts', import.meta.url), 'utf8');
    expect(source).toContain('<input type="checkbox" id="collection-toggle"');
    expect(source).toContain('id="save-stories"');
  });

  it('lists one story per narrated chapter and hides save until something changes', () => {
    const { nodes, context } = workspace();
    vm.runInContext('renderStories()', context);

    expect(nodes.get('#story-grouping').hidden).toBe(false);
    expect(nodes.get('#collection-toggle').checked).toBe(true);
    expect(nodes.get('#story-status').textContent).toBe('2 stories · each story has its own characters and voices');
    const rows = nodes.get('#stories').innerHTML;
    expect(rows).toContain('value="The Sentinel"');
    expect(rows).toContain('Chapter 2');
    // The skipped chapter belongs to no story.
    expect(rows).not.toContain('Notes');
    expect(nodes.get('#save-stories').hidden).toBe(true);
  });

  it('merges a story told in two chapters and splits it again', () => {
    const { nodes, context } = workspace();
    vm.runInContext('renderStories();mergeStory(0)', context);

    expect(vm.runInContext('JSON.stringify(editedStories().stories)', context)).toBe(JSON.stringify([
      { id: 'story-00', title: 'The Sentinel', chapters: [0, 1] },
    ]));
    expect(nodes.get('#stories').innerHTML).toContain('Chapters 1–2');
    expect(nodes.get('#save-stories').hidden).toBe(false);

    vm.runInContext('splitStory(0)', context);
    expect(vm.runInContext('editedStories().stories.length', context)).toBe(2);
    expect(vm.runInContext("editedStories().stories[1].title", context)).toBe('Rescue Party');
  });

  it('turns a collection back into one continuous work', () => {
    const { nodes, context } = workspace();
    vm.runInContext("renderStories();document.querySelector('#collection-toggle').checked=false;$('#collection-toggle').onchange()", context);

    expect(vm.runInContext('JSON.stringify(editedStories())', context)).toBe(JSON.stringify({
      collection: false,
      stories: [{ id: 'book', title: 'Collected Stories', chapters: [0, 1] }],
    }));
    expect(nodes.get('#story-status').textContent).toBe('One continuous work · characters are shared across every chapter');
    expect(nodes.get('#stories').innerHTML).toBe('');
    expect(nodes.get('#save-stories').hidden).toBe(false);
  });

  it('selects a story\'s chapters for a stage run', () => {
    const { context } = workspace();
    vm.runInContext('renderStories();mergeStory(0);selectStoryChapters(0)', context);
    expect(vm.runInContext('[...selected]', context)).toEqual([0, 1]);
  });

  it('saves the grouping through the stories endpoint', async () => {
    const { context, fetch } = workspace();
    vm.runInContext("renderStories();mergeStory(0);renameStory(0,'Two Parts')", context);
    await vm.runInContext("$('#save-stories').onclick()", context);

    expect(fetch).toHaveBeenCalledWith('/api/stories', expect.objectContaining({ method: 'POST' }));
    const save = fetch.mock.calls.find(([url]) => url === '/api/stories')!;
    expect(JSON.parse(save[1].body)).toEqual({
      source: '/book.epub',
      collection: true,
      stories: [{ id: 'story-00', title: 'Two Parts', chapters: [0, 1] }],
    });
    expect(vm.runInContext('storyDraft', context)).toBe(null);
  });

  it('hides the panel until the book has been analyzed', () => {
    const { nodes, context } = workspace({ analysis: undefined });
    vm.runInContext('renderStories()', context);
    expect(nodes.get('#story-grouping').hidden).toBe(true);
  });
});

describe('UI story grouping in the character and casting panels', () => {
  const registry = {
    version: 2,
    chapters: [0, 1],
    stories: [{ id: 'story-00', title: 'The Sentinel' }, { id: 'story-01', title: 'Rescue Party' }],
    characters: [
      { id: 'a', name: 'John (The Sentinel)', story: 'story-00', aliases: [], sex: 'male', age: '40s', country: 'unknown', chapters: [0], evidence: [], issues: [] },
      { id: 'b', name: 'John (Rescue Party)', story: 'story-01', aliases: [], sex: 'female', age: 'child', country: 'unknown', chapters: [1], evidence: [], issues: [] },
    ],
  };
  const stories = { version: 1, collection: true, stories: [
    { id: 'story-00', title: 'The Sentinel', chapters: [0] },
    { id: 'story-01', title: 'Rescue Party', chapters: [1] },
  ] };

  it('groups the character list under its story headings', () => {
    const { nodes, context } = workspace({
      stories, characterRegistry: registry, state: { completed: { 'list-characters': 'now' }, collection: true },
    });
    vm.runInContext('renderCharacters()', context);

    const markup = nodes.get('#characters').innerHTML;
    expect(markup.indexOf('<h3 class="story-heading">The Sentinel</h3>')).toBeLessThan(markup.indexOf('John (The Sentinel)'));
    expect(markup.indexOf('John (The Sentinel)')).toBeLessThan(markup.indexOf('<h3 class="story-heading">Rescue Party</h3>'));
    expect(nodes.get('#character-status').textContent).toContain('2 characters');
  });

  it('keeps the narrator first and groups cast rows by story, including a speaker in none', () => {
    const { nodes, context } = workspace({
      stories, characterRegistry: registry, state: { completed: { 'list-characters': 'now' }, collection: true },
      casting: {
        version: 2,
        narrator: { voiceProfile: { presentation: 'male', age: 'unknown', tone: [] }, instructions: 'Narrate.' },
        characters: {
          'John (Rescue Party)': { voiceProfile: { presentation: 'female', age: 'child', tone: [] }, instructions: '' },
          'John (The Sentinel)': { voiceProfile: { presentation: 'male', age: '40s', tone: [] }, instructions: '' },
          Stranger: { voiceProfile: { presentation: 'unknown', age: 'unknown', tone: [] }, instructions: '' },
        },
      },
    });
    vm.runInContext('renderCasting()', context);

    const markup = nodes.get('#casting').innerHTML;
    expect(markup.indexOf('narrator')).toBeLessThan(markup.indexOf('story-heading'));
    expect(markup.indexOf('The Sentinel</h3>')).toBeLessThan(markup.indexOf('Rescue Party</h3>'));
    expect(markup).toContain('<h3 class="story-heading">Not in any story</h3>');
  });
});
