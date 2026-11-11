import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import {
  chunkRequest,
  coverageProblem,
  filterNarratableSegments,
  limitQuotesPerBlock,
  runScript,
  scriptSourceHash,
  splitLeadingChapterTitle,
  withChapterTitle,
} from '../src/pipeline/script.js';
import { runStage } from '../src/pipeline/runner.js';
import { WorkDir } from '../src/state.js';
import { jsonCall } from '../src/providers/llm/openai.js';
import type { CharacterRegistry } from '../src/types.js';
import { bookFixture, labelsReply, readScript, removeFixtures } from './helpers.js';

vi.mock('../src/providers/llm/openai.js', () => ({ jsonCall: vi.fn() }));
const llm = vi.mocked(jsonCall);
afterEach(() => {
  vi.resetAllMocks();
  removeFixtures();
});

const ASIMOV = `# The Last Question

Lupov cocked his head sideways. He had a trick of doing that when he wanted to be contrary. "Not forever," he said.

"Oh, hell, just about forever. Till the sun runs down, Bert. Ten billion, maybe. Are you satisfied?"

Lupov put his fingers through his thinning hair and sipped gently at his own drink. "Ten billion years isn't forever."`;

const ADELL = { name: 'Alexander Adell', aliases: ['Adell'], sex: 'male', evidence: 'Till the sun runs down, Bert.' };
const LUPOV = { name: 'Bertram Lupov', aliases: ['Lupov', 'Bert'], sex: 'male', evidence: 'Lupov cocked his head' };
const registryOf = (work: WorkDir): CharacterRegistry => work.readJson<CharacterRegistry>('characters.json');
const speech = (work: WorkDir, index: number) => readScript(work, index).segments.map((segment) => [segment.speaker, segment.text]);

describe('filterNarratableSegments', () => {
  it('removes decorative dividers, keeps pauses and non-ASCII prose, and normalizes non-breaking spaces', () => {
    const segments = filterNarratableSegments([
      { speaker: 'narrator', text: '* * *', confidence: 'high' },
      { speaker: 'narrator', text: '• • •', confidence: 'high', kind: 'pause', pauseMs: 2000 },
      { speaker: 'narrator', text: 'Às três horas.', confidence: 'high' },
    ]);
    expect(segments.map((segment) => segment.text)).toEqual(['• • •', 'Às três horas.']);
  });
});

describe('chapter titles', () => {
  it('turns an opening Markdown heading into a paused narrator title cue', () => {
    const { title, content } = splitLeadingChapterTitle('# **VIEWFINDER** #\n\nA man without hands came to the door.');
    expect(title).toBe('VIEWFINDER');
    expect(content).toBe('A man without hands came to the door.');
    const [cue, first] = withChapterTitle([{ speaker: 'narrator', text: content, confidence: 'high' }], title);
    expect(cue).toMatchObject({ speaker: 'narrator', text: '… VIEWFINDER …' });
    expect(first.text).toBe(content);
  });

  it('leaves a chapter without a heading alone', () => {
    expect(splitLeadingChapterTitle('No heading here.')).toEqual({ content: 'No heading here.' });
  });
});

describe('the cleanup pre-filter', () => {
  it('asks for nothing when fiction has no quotation marks and no cleanup trigger', () => {
    expect(chunkRequest('The road ran north through the hills.', 'quoted')).toBe('none');
    expect(chunkRequest('The road ran north through the hills.', 'narration')).toBe('none');
  });

  it('asks for edits only when there is a trigger but nobody speaks', () => {
    expect(chunkRequest('The road ran 5 km north.', 'quoted')).toBe('edits');
    expect(chunkRequest('He said "no", i.e. never.', 'narration')).toBe('edits');
  });

  it('asks for labels when anything is quoted, and for segments when dialogue is unquoted', () => {
    expect(chunkRequest('"North," she said.', 'quoted')).toBe('labels');
    expect(chunkRequest('The road ran north.', 'unquoted')).toBe('segments');
  });
});

describe('quoted mode', () => {
  it('builds the script from spans and labels: the reply carries none of the book\'s prose', async () => {
    const { work } = bookFixture({ title: 'The Last Question', chapters: [ASIMOV] });
    const reply = labelsReply([[2, 'Lupov'], [4, 'Alexander Adell'], [6, 'Lupov']], { characters: [LUPOV, ADELL] });
    llm.mockResolvedValueOnce(reply as any);

    await runScript(work, undefined, () => {});

    expect(llm).toHaveBeenCalledTimes(1);
    const request = llm.mock.calls[0][0];
    expect(request.user).toContain('[2 QUOTE] "Not forever,"');
    expect(request.user).toContain('[3] he said.');
    expect(request.user).toContain('(nobody yet');
    expect(request.user).not.toContain('# The Last Question');
    // Every word of the reply is a label, a name, or evidence: under 200 characters for 400 of prose.
    const proseInReply = JSON.stringify(reply.labels);
    for (const sentence of ['Not forever', 'Ten billion years', 'cocked his head']) expect(proseInReply).not.toContain(sentence);

    expect(speech(work, 0)).toEqual([
      ['narrator', '… The Last Question …'],
      ['narrator', 'Lupov cocked his head sideways. He had a trick of doing that when he wanted to be contrary.'],
      ['Bertram Lupov', '"Not forever,"'],
      ['narrator', 'he said.'],
      ['Alexander Adell', '"Oh, hell, just about forever. Till the sun runs down, Bert. Ten billion, maybe. Are you satisfied?"'],
      ['narrator', 'Lupov put his fingers through his thinning hair and sipped gently at his own drink.'],
      ['Bertram Lupov', '"Ten billion years isn\'t forever."'],
    ]);
    const script = readScript(work, 0);
    expect(script).toMatchObject({ index: 0, story: 'book', mode: 'quoted' });
    expect(script.sourceHash).toBe(scriptSourceHash(ASIMOV, 'quoted'));
    expect(fs.existsSync(work.path('1-scripts/00-chapter-1.json'))).toBe(true);
    expect(registryOf(work).characters.map((character) => character.name)).toEqual(['Bertram Lupov', 'Alexander Adell']);
  });

  it('applies each edit inside one span and reports one that crosses a boundary', async () => {
    const { work, run, events } = bookFixture({ chapters: ['They had walked 5 km. "Only 5 km?" asked Ann.12 Nobody answered.'] });
    llm.mockResolvedValueOnce(labelsReply([[2, 'Ann']], {
      characters: [{ name: 'Ann' }],
      edits: [
        { find: 'km?" asked', replace: 'km? asked' },
        { find: '5 km', replace: '5 kilometres' },
        { find: 'Ann.12', replace: 'Ann.' },
      ],
    }) as any);

    await runStage({ ...run, stage: 'script' });

    expect(speech(work, 0)).toEqual([
      ['narrator', 'They had walked 5 kilometres.'],
      ['Ann', '"Only 5 kilometres?"'],
      ['narrator', 'asked Ann. Nobody answered.'],
    ]);
    expect(events.find((event) => event.type === 'warning')?.message).toContain('crosses a span boundary');
  });

  it('makes no call for a chunk with no quotation marks and no cleanup trigger', async () => {
    const { work } = bookFixture({ chapters: ['The road ran north.\n\nNobody was on it.', 'Still nobody.'] });

    await runScript(work, undefined, () => {});

    expect(llm).not.toHaveBeenCalled();
    expect(speech(work, 0)).toEqual([['narrator', 'The road ran north.\n\nNobody was on it.']]);
    expect(registryOf(work).characters).toEqual([]);
  });

  it('hands a quoted title back to the narrator and rejoins its sentence', async () => {
    const { work } = bookFixture({ chapters: ['She was reading "Emma" again.'] });
    llm.mockResolvedValueOnce(labelsReply([[2, 'narrator']]) as any);

    await runScript(work, undefined, () => {});

    expect(speech(work, 0)).toEqual([['narrator', 'She was reading "Emma" again.']]);
  });

  it('never gives an unlabelled quote to the narrator: it is verified, then held for review', async () => {
    const { work, run } = bookFixture({ chapters: ['"Who is there?"\n\nNobody answered.'] });
    llm.mockResolvedValueOnce(labelsReply([]) as any)
      .mockResolvedValueOnce({ attributions: [{ id: 0, speaker: 'unresolved speaker' }] } as any);

    await expect(runStage({ ...run, stage: 'script' })).rejects.toThrow(/unresolved speakers in chapter 1: unresolved speaker.*resolveAs/s);

    expect(llm).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(work.path('1-scripts/00-chapter-1.json'))).toBe(false);
    expect(registryOf(work).unresolved).toMatchObject([{ chapter: 0, story: 'book', speaker: 'unresolved speaker', samples: [{ text: '"Who is there?"' }] }]);
    expect(new WorkDir(run.epubPath, run.workRoot).isDone('script')).toBe(false);
  });

  it('resumes a blocked chapter from its checkpoint once a person answers, with no further calls', async () => {
    const { work, run } = bookFixture({ chapters: ['"Who is there?"\n\n"Only me," said Ann.'] });
    llm.mockResolvedValueOnce(labelsReply([[1, 'a voice', 'low'], [2, 'Ann']], { characters: [{ name: 'Ann' }] }) as any)
      .mockResolvedValueOnce({ attributions: [{ id: 0, speaker: 'the stranger' }] } as any);
    await expect(runStage({ ...run, stage: 'script' })).rejects.toThrow('the stranger');
    expect(llm).toHaveBeenCalledTimes(2);

    const registry = registryOf(work);
    registry.unresolved[0].resolveAs = 'Ann';
    work.writeJson('characters.json', registry);
    await runStage({ ...run, stage: 'script' });

    expect(llm).toHaveBeenCalledTimes(2);
    expect(speech(work, 0)).toEqual([['Ann', '"Who is there?"'], ['Ann', '"Only me,"'], ['narrator', 'said Ann.']]);
    expect(registryOf(work).unresolved).toEqual([]);
    expect(fs.existsSync(work.path('checkpoints/script-00.json'))).toBe(false);
    expect(new WorkDir(run.epubPath, run.workRoot).isDone('script')).toBe(true);
  });

  it('verifies only low-confidence labels, in one pass, and accepts a known speaker', async () => {
    const { work } = bookFixture({ chapters: ['"Hello," said Ann.\n\n"Hello."\n\n"Goodbye," said Bob.'] });
    llm.mockResolvedValueOnce(labelsReply([[1, 'Ann'], [3, 'Ann', 'low'], [4, 'Bob']], { characters: [{ name: 'Ann' }, { name: 'Bob' }] }) as any)
      .mockResolvedValueOnce({ attributions: [{ id: 2, speaker: 'Bob' }] } as any);

    await runScript(work, undefined, () => {});

    expect(llm).toHaveBeenCalledTimes(2);
    expect(llm.mock.calls[1][0].user).toContain('Segment id 2 (marked ">>")');
    expect(llm.mock.calls[1][0].user).not.toContain('Segment id 0');
    expect(readScript(work, 0).segments[2]).toMatchObject({ speaker: 'Bob', text: '"Hello."', confidence: 'high' });
  });

  it('adds a speaker the labels named without a record once verification confirms the name, flagged for review', async () => {
    const { work } = bookFixture({ chapters: ['"Look," said Jerrodd.\n\n"Quiet," said Jerrodine.\n\n"Halt," said the guard.'] });
    llm.mockResolvedValueOnce(labelsReply([[1, 'Jerrodd'], [3, 'Jerrodine'], [5, 'the guard']]) as any)
      .mockResolvedValueOnce({
        attributions: [{ id: 0, speaker: 'Jerrodd' }, { id: 2, speaker: 'Jerrodine' }, { id: 4, speaker: 'the guard' }],
        characters: [{ name: 'Jerrodine', aliases: [], sex: 'female', age: 'unknown', named: true, evidence: 'said Jerrodine' }],
      } as any);

    await runScript(work, undefined, () => {});

    expect(llm).toHaveBeenCalledTimes(2);
    expect(llm.mock.calls[1][0].system).toContain('one record for every speaker you return who is not in the character list');
    expect(speech(work, 0).filter(([speaker]) => speaker !== 'narrator').map(([speaker]) => speaker)).toEqual(['Jerrodd', 'Jerrodine', 'the guard (chapter 1)']);
    const cast = registryOf(work).characters;
    expect(cast.map((c) => [c.name, c.sex, c.named, c.issues.length])).toEqual([['Jerrodine', 'female', true, 0], ['Jerrodd', 'unknown', true, 1], ['the guard (chapter 1)', 'unknown', false, 1]]);
    expect(cast[1].issues[0]).toContain('without a character record');
    expect(registryOf(work).unresolved).toEqual([]);
  });

  it('cuts a block so one reply never labels more quotes than the limit', () => {
    const paragraphs = Array.from({ length: 5 }, (_, i) => `"Line ${i}," said Ann. "And ${i}."`);
    const pieces = limitQuotesPerBlock({ text: paragraphs.join('\n\n'), sceneBreak: '* * *' }, 4);
    expect(pieces.map((piece) => piece.text.split('\n\n').length)).toEqual([2, 2, 1]);
    expect(pieces.map((piece) => piece.sceneBreak)).toEqual([undefined, undefined, '* * *']);
  });
});

describe('running cast', () => {
  it('sends each chunk the cast as it stands and carries it to the next chapter', async () => {
    const { work } = bookFixture({ chapters: ['"Hello," said Ann.', '"Hello again," said Ann. "Who are you?" asked Bob.'] });
    llm.mockResolvedValueOnce(labelsReply([[1, 'Ann']], { characters: [{ name: 'Ann', sex: 'female', age: '30s', evidence: 'said Ann' }] }) as any)
      .mockResolvedValueOnce(labelsReply([[1, 'Ann'], [3, 'Bob']], { characters: [{ name: 'Bob', sex: 'male' }] }) as any);

    await runScript(work, undefined, () => {});

    expect(llm.mock.calls[0][0].user).toContain('(nobody yet');
    expect(llm.mock.calls[1][0].user).toContain('- Ann: female, 30s');
    expect(registryOf(work).characters.map((c) => [c.name, c.sex, c.chapters])).toEqual([['Ann', 'female', [0, 1]], ['Bob', 'male', [1]]]);
  });

  it('ignores a reported character who was given no lines', async () => {
    const { work } = bookFixture({ chapters: ['"Hello," said Ann, thinking of Carl.'] });
    llm.mockResolvedValueOnce(labelsReply([[1, 'Ann']], { characters: [{ name: 'Ann' }, { name: 'Carl' }] }) as any);

    await runScript(work, undefined, () => {});

    expect(registryOf(work).characters.map((c) => c.name)).toEqual(['Ann']);
  });

  it('folds a short name into the full name a later chapter gives, renaming the saved script offline', async () => {
    const { work } = bookFixture({ chapters: ['"Not forever," said Lupov.', '"Bertram Lupov, at your service," he said.'] });
    llm.mockResolvedValueOnce(labelsReply([[1, 'Lupov']], { characters: [{ name: 'Lupov', sex: 'male' }] }) as any)
      .mockResolvedValueOnce(labelsReply([[1, 'Bertram Lupov']], { characters: [{ name: 'Bertram Lupov', aliases: ['Lupov'] }] }) as any);

    await runScript(work, undefined, () => {});

    expect(llm).toHaveBeenCalledTimes(2);
    expect(readScript(work, 0).segments[0].speaker).toBe('Bertram Lupov');
    expect(readScript(work, 1).segments[0].speaker).toBe('Bertram Lupov');
    expect(registryOf(work).characters).toMatchObject([{ name: 'Bertram Lupov', aliases: ['Lupov'], sex: 'male', chapters: [0, 1] }]);
  });

  it('runs separate stories in parallel, and each story\'s chapters in order', async () => {
    const { work } = bookFixture({
      collection: true,
      chapters: [{ title: 'One', text: '"A," said Ann.' }, { title: 'Two', text: '"B," said Bob.' }, { title: 'Three', text: '"C," said Cy.' }],
    });
    const releases: Array<() => void> = [];
    let inFlight = 0;
    let peak = 0;
    llm.mockImplementation(async (request: any) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight -= 1;
      const name = /said (\w+)\./.exec(request.user)![1];
      return labelsReply([[1, name]], { characters: [{ name }] }) as any;
    });

    const run = runScript(work, undefined, () => {});
    await vi.waitFor(() => expect(releases).toHaveLength(config.llmConcurrency));
    for (const release of releases) release();
    await run;

    expect(peak).toBe(3);
    expect(registryOf(work).characters.map((c) => [c.name, c.story])).toEqual([['Ann', 'story-00'], ['Bob', 'story-01'], ['Cy', 'story-02']]);
    // Each request named only its own story and offered only that story's cast.
    expect(llm.mock.calls.every(([request]) => request.user.includes('(nobody yet'))).toBe(true);
  });

  it('labels a name shared by two stories and renames both stories\' scripts', async () => {
    const { work } = bookFixture({
      collection: true,
      chapters: [{ title: 'Rescue Party', text: '"Go," said John.' }, { title: 'The Sentinel', text: '"Wait," said John.' }],
    });
    llm.mockResolvedValue(labelsReply([[1, 'John']], { characters: [{ name: 'John' }] }) as any);

    await runScript(work, undefined, () => {});

    expect(readScript(work, 0).segments[0].speaker).toBe('John (Rescue Party)');
    expect(readScript(work, 1).segments[0].speaker).toBe('John (The Sentinel)');
    expect(registryOf(work).characters.map((c) => c.name)).toEqual(['John (Rescue Party)', 'John (The Sentinel)']);

    // The label is never shown to the model, and its plain name still resolves.
    work.writeJson('1-scripts/00-rescue-party.json', { ...readScript(work, 0), sourceHash: 'stale' });
    llm.mockClear();
    await runScript(work, [0], () => {});
    expect(llm.mock.calls[0][0].user).toContain('- John: unknown, unknown');
    expect(readScript(work, 0).segments[0].speaker).toBe('John (Rescue Party)');
  });

  it('keeps one story going when another stops for review', async () => {
    const { work } = bookFixture({
      collection: true,
      chapters: [{ title: 'One', text: '"A," said someone.' }, { title: 'Two', text: '"B," said Bob.' }],
    });
    llm.mockImplementation(async (request: any) => {
      if (request.user.includes('Segment id')) return { attributions: [{ id: 0, speaker: 'unresolved speaker' }] } as any;
      return (request.user.includes('said Bob')
        ? labelsReply([[1, 'Bob']], { characters: [{ name: 'Bob' }] })
        : labelsReply([[1, 'unresolved speaker', 'low']])) as any;
    });

    await expect(runScript(work, undefined, () => {})).rejects.toThrow('story "One"');

    expect(readScript(work, 1).segments[0].speaker).toBe('Bob');
    expect(registryOf(work).unresolved.map((record) => [record.story, record.chapter])).toEqual([['story-00', 0]]);
  });
});

describe('checkpoints and hashes', () => {
  const TWO_BLOCKS = `"One," said Ann.\n\n* * *\n\n"Two," said Bob.`;

  it('resumes mid-chapter after a failed block, with the cast as of the finished one', async () => {
    const { work } = bookFixture({ chapters: [TWO_BLOCKS] });
    llm.mockResolvedValueOnce(labelsReply([[1, 'Ann']], { characters: [{ name: 'Ann', sex: 'female' }] }) as any)
      .mockRejectedValueOnce(new Error('timed out'));
    await expect(runScript(work, undefined, () => {})).rejects.toThrow('timed out');
    expect(fs.existsSync(work.path('1-scripts/00-chapter-1.json'))).toBe(false);
    const checkpoint = JSON.parse(fs.readFileSync(work.path('checkpoints/script-00.json'), 'utf8'));
    expect(checkpoint.blocks).toHaveLength(1);
    expect(checkpoint.blocks[0].characters).toMatchObject([{ name: 'Ann', sex: 'female' }]);

    // The registry is lost; the checkpoint alone restores the cast as of block 1.
    fs.rmSync(work.path('characters.json'));
    llm.mockResolvedValueOnce(labelsReply([[1, 'Bob']], { characters: [{ name: 'Bob' }] }) as any);
    await runScript(work, undefined, () => {});

    expect(llm).toHaveBeenCalledTimes(3);
    expect(llm.mock.calls[2][0].user).toContain('- Ann: female, unknown');
    expect(llm.mock.calls[2][0].user).toContain('"Two,"');
    expect(llm.mock.calls[2][0].user.split('Passage:\n')[1]).toBe('[1 QUOTE] "Two,"\n[2] said Bob.');
    expect(readScript(work, 0).segments.map((segment) => segment.kind === 'pause' ? 'pause' : segment.speaker))
      .toEqual(['Ann', 'narrator', 'pause', 'Bob', 'narrator']);
    expect(fs.existsSync(work.path('checkpoints/script-00.json'))).toBe(false);
  });

  it('keeps a script whose text is unchanged however much the cast grows', async () => {
    const { work } = bookFixture({ chapters: ['"Hello," said Ann.', '"Hello," said Bob.'] });
    llm.mockResolvedValueOnce(labelsReply([[1, 'Ann']], { characters: [{ name: 'Ann' }] }) as any);
    await runScript(work, [0], () => {});
    const saved = fs.readFileSync(work.path('1-scripts/00-chapter-1.json'), 'utf8');

    llm.mockResolvedValueOnce(labelsReply([[1, 'Bob']], { characters: [{ name: 'Bob' }] }) as any);
    await runScript(work, undefined, () => {});

    expect(llm).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(work.path('1-scripts/00-chapter-1.json'), 'utf8')).toBe(saved);
  });

  it('scripts a chapter again when its text, mode or chunk size changes, and ignores a stale checkpoint', async () => {
    expect(scriptSourceHash('Text.', 'quoted')).not.toBe(scriptSourceHash('Text.', 'unquoted'));
    expect(scriptSourceHash('Text.', 'quoted')).not.toBe(scriptSourceHash('Text!', 'quoted'));

    const { work, metadata } = bookFixture({ chapters: ['"Hello," said Ann.'] });
    llm.mockResolvedValue(labelsReply([[1, 'Ann']], { characters: [{ name: 'Ann' }] }) as any);
    await runScript(work, undefined, () => {});
    work.writeJson('checkpoints/script-00.json', { key: 'another text', blocks: [{ segments: [{ speaker: 'Zed', text: 'Stale.' }], characters: [] }] });
    fs.writeFileSync(work.path(metadata.chapters[0].file), '"Hello there," said Ann.');
    await runScript(work, undefined, () => {});

    expect(llm).toHaveBeenCalledTimes(2);
    expect(readScript(work, 0).segments[0].text).toBe('"Hello there,"');
  });

  it('starts over on an explicit rerun and keeps the script folder name from an earlier title', async () => {
    const { work, run } = bookFixture({ chapters: ['"Hello," said Ann.'] });
    llm.mockResolvedValue(labelsReply([[1, 'Ann']], { characters: [{ name: 'Ann' }] }) as any);
    await runStage({ ...run, stage: 'script' });
    fs.renameSync(work.path('1-scripts/00-chapter-1.json'), work.path('1-scripts/00-an-earlier-title.json'));

    await runStage({ ...run, stage: 'script' });
    expect(llm).toHaveBeenCalledTimes(1);

    await runStage({ ...run, stage: 'script', chapterIndexes: [0], rerun: true });
    expect(llm).toHaveBeenCalledTimes(2);
    expect(fs.readdirSync(work.path('1-scripts'))).toEqual(['00-chapter-1.json']);
  });
});

describe('unquoted dialogue', () => {
  const DASHES = '— Bom dia, disse Baltasar.\n\n— Bom dia.';

  it('falls back to segments from the model, guarded for coverage, with edits and characters', async () => {
    const { work } = bookFixture({ chapters: [DASHES], profile: { dialogueStyle: 'unquoted' } });
    llm.mockResolvedValueOnce({
      segments: [
        { speaker: 'Baltasar', text: '— Bom dia,', confidence: 'high' },
        { speaker: 'narrator', text: 'disse Baltasar.', confidence: 'high' },
        { speaker: 'Blimunda', text: '— Bom dia.', confidence: 'high' },
      ],
      edits: [{ find: 'Bom dia.', replace: 'Bom dia!' }],
      characters: [{ name: 'Baltasar', aliases: [], sex: 'male', age: 'unknown', named: true, evidence: 'disse Baltasar' },
        { name: 'Blimunda', aliases: [], sex: 'female', age: 'unknown', named: true, evidence: '' }],
    } as any);

    await runScript(work, undefined, () => {});

    const request = llm.mock.calls[0][0];
    expect(request.user).toContain(DASHES);
    expect(request.validate!({ segments: [{ speaker: 'narrator', text: 'Bom dia.' }] } as any)).toContain('do not reproduce the text');
    expect(speech(work, 0)).toEqual([['Baltasar', '— Bom dia,'], ['narrator', 'disse Baltasar.'], ['Blimunda', '— Bom dia!']]);
    expect(readScript(work, 0).mode).toBe('unquoted');
    expect(registryOf(work).characters.map((c) => c.name)).toEqual(['Baltasar', 'Blimunda']);
  });

  it('refuses segments that drop or rewrite the text, and saves nothing', async () => {
    const { work } = bookFixture({ chapters: [DASHES], profile: { dialogueStyle: 'unquoted' } });
    llm.mockResolvedValueOnce({ segments: [{ speaker: 'narrator', text: '— Bom dia, disse Baltasar.', confidence: 'high' }], edits: [], characters: [] } as any);

    await expect(runScript(work, undefined, () => {})).rejects.toThrow('do not reproduce the text');
    expect(fs.existsSync(work.path('1-scripts/00-chapter-1.json'))).toBe(false);
  });

  it('accepts a copy that differs only in spacing and punctuation style', () => {
    expect(coverageProblem('“Olá,”  disse\nela.', [{ text: '"Olá," disse ela.' }])).toBeUndefined();
    expect(coverageProblem('One. Two.', [{ text: 'One.' }])).toContain('first differs near');
  });

  it('uses the smaller chunk size, because the reply carries the text', async () => {
    const paragraph = `${'Palavra '.repeat(400).trim()}.`;
    const { work } = bookFixture({ chapters: [`${paragraph}\n\n${paragraph}\n\n${paragraph}`], profile: { dialogueStyle: 'unquoted' } });
    llm.mockImplementation(async (request: any) => ({
      segments: [{ speaker: 'narrator', text: request.user.split('Text:\n')[1], confidence: 'high' }], edits: [], characters: [],
    }) as any);

    await runScript(work, undefined, () => {});

    expect(config.scriptUnquotedChunkChars).toBeLessThan(config.scriptChunkChars);
    expect(llm).toHaveBeenCalledTimes(3);
  });
});

describe('non-fiction', () => {
  it('is all narrator, and calls the model only where a cleanup trigger fires, for edits only', async () => {
    const { work } = bookFixture({
      title: 'Invisible Women',
      chapters: ['# One\n\nHalf of all women.12 He said "no" to that.\n\n• • •\n\nNothing here needs fixing.'],
      profile: { isFiction: false, form: 'non-fiction' },
    });
    llm.mockResolvedValueOnce({ edits: [{ find: 'women.12', replace: 'women.' }] } as any);

    await runScript(work, undefined, () => {});

    expect(llm).toHaveBeenCalledTimes(1);
    const request = llm.mock.calls[0][0];
    expect(request.disableReasoning).toBe(true);
    expect(request.user).toBe('Book: "Invisible Women"\nChapter: "Chapter 1" (part 1 of 2)\n\nText:\nHalf of all women.12 He said "no" to that.');
    expect(request.system).not.toMatch(/characters|speaker/i);
    expect(readScript(work, 0).segments.map((segment) => [segment.kind ?? 'speech', segment.speaker, segment.text])).toEqual([
      ['speech', 'narrator', '… One …'],
      ['speech', 'narrator', 'Half of all women. He said "no" to that.'],
      ['pause', 'narrator', '• • •'],
      ['speech', 'narrator', 'Nothing here needs fixing.'],
    ]);
    expect(readScript(work, 0).mode).toBe('narration');
    expect(registryOf(work).characters).toEqual([]);
  });
});
