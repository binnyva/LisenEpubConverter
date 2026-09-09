import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// Execute the actual browser script with a minimal DOM; no server or paid API calls.
function browser() {
  const nodes = new Map<string, any>();
  const element = () => ({
    textContent: '', className: '', hidden: true, children: [] as any[],
    scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    append(child: any) { this.children.push(child); },
    replaceChildren() { this.children = []; },
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
