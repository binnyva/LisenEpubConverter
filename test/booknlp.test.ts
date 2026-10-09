import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { codePointOffsetToUtf16, normalizeBookNlpOutput } from '../src/pipeline/booknlp.js';
import { annotationSegmentsForChapter, validateScriptCoverage } from '../src/pipeline/script.js';
import { CorrectionsSchema, type BookAnnotations, type CharacterRegistry, type ChapterMap } from '../src/types.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const cp = (text: string, utf16: number) => [...text.slice(0, utf16)].length;
const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

function tsvFixture(input: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lisen-booknlp-')); roots.push(root);
  const tokens = ['😀', 'Tom', 'said', ',', '“', 'Hello', ',', '”', 'and', 'left', '.'];
  let cursor = 0;
  const rows = tokens.map((token, id) => {
    const startUtf16 = input.indexOf(token, cursor); const endUtf16 = startUtf16 + token.length; cursor = endUtf16;
    return ['0', '0', String(id), String(id), token, token, String(cp(input, startUtf16)), String(cp(input, endUtf16)), 'X', 'X', 'dep', '0', 'O'].join('\t');
  });
  fs.writeFileSync(path.join(root, 'book.tokens'), ['paragraph_ID\tsentence_ID\ttoken_ID_within_sentence\ttoken_ID_within_document\tword\tlemma\tbyte_onset\tbyte_offset\tPOS_tag\tfine_POS_tag\tdependency_relation\tsyntactic_head_ID\tevent', ...rows].join('\n'));
  fs.writeFileSync(path.join(root, 'book.entities'), 'COREF\tstart_token\tend_token\tprop\tcat\ttext\n1\t1\t1\tPROP\tPER\tTom\n');
  fs.writeFileSync(path.join(root, 'book.quotes'), 'quote_start\tquote_end\tmention_start\tmention_end\tmention_phrase\tchar_id\tquote\n4\t7\t1\t1\tTom\t1\t“ Hello , ”\n');
  return root;
}

describe('BookNLP normalization', () => {
  it('translates Python code-point offsets across non-BMP Unicode and recovers exact source text', () => {
    const input = '😀 Tom said, “Hello,” and left.';
    const root = tsvFixture(input);
    const map: ChapterMap = { version: 1, offsetConvention: 'unicode-code-points-half-open', inputSha256: hash(input), chapters: [{ index: 0, title: 'One', start: 0, end: [...input].length, titleInText: false }] };
    const annotations = normalizeBookNlpOutput(input, map, root, { toolVersion: '1.0.8', model: 'small', fingerprint: 'fingerprint' });
    expect(codePointOffsetToUtf16(input, 1)).toBe(2);
    expect(annotations.quotations[0].text).toBe('“Hello,”');
    expect(annotations.quotations[0]).toMatchObject({ entityId: 'booknlp:1', chapterIndex: 0, assignment: 'generated' });
    expect(annotations.mentions[0].text).toBe('Tom');
  });

  it('rejects overlapping quotation output', () => {
    const input = '😀 Tom said, “Hello,” and left.'; const root = tsvFixture(input);
    fs.appendFileSync(path.join(root, 'book.quotes'), '5\t7\tNone\tNone\tNone\tNone\tHello , ”\n');
    const map: ChapterMap = { version: 1, offsetConvention: 'unicode-code-points-half-open', inputSha256: hash(input), chapters: [{ index: 0, title: 'One', start: 0, end: [...input].length, titleInText: false }] };
    expect(() => normalizeBookNlpOutput(input, map, root, { toolVersion: '1.0.8', model: 'small', fingerprint: 'f' })).toThrow('overlaps');
  });

  it('marks a quotation crossing a chapter boundary unresolved', () => {
    const input = '😀 Tom said, “Hello,” and left.'; const root = tsvFixture(input);
    const boundary = cp(input, input.indexOf('Hello') + 2);
    const map: ChapterMap = { version: 1, offsetConvention: 'unicode-code-points-half-open', inputSha256: hash(input), chapters: [
      { index: 0, title: 'One', start: 0, end: boundary, titleInText: false },
      { index: 1, title: 'Two', start: boundary, end: [...input].length, titleInText: false },
    ] };
    expect(normalizeBookNlpOutput(input, map, root, { toolVersion: '1.0.8', model: 'small', fingerprint: 'f' }).quotations[0]).toMatchObject({ chapterIndex: null, assignment: 'unresolved' });
  });
});

describe('annotation script conversion', () => {
  const input = '“Hello,” said Tom. “Goodbye.”';
  const pos = (needle: string, from = 0) => { const start16 = input.indexOf(needle, from); return { start: cp(input, start16), end: cp(input, start16 + needle.length) }; };
  const first = pos('“Hello,”'); const second = pos('“Goodbye.”', input.indexOf('“Goodbye.”'));
  const quotations: BookAnnotations['quotations'] = [
    { id: 'q1', startToken: 0, endToken: 0, ...first, text: '“Hello,”', chapterIndex: 0, entityId: 'booknlp:1', mention: null, assignment: 'generated' },
    { id: 'q2', startToken: 1, endToken: 1, ...second, text: '“Goodbye.”', chapterIndex: 0, entityId: 'booknlp:1', mention: null, assignment: 'generated' },
  ];
  const character = { id: 'speaker-tom', name: 'Tom', aliases: [], sex: 'unknown' as const, age: 'unknown', race: 'unknown', class: 'unknown', country: 'unknown', importance: 'minor' as const, chapters: [0], evidence: [], issues: [], sourceEntityIds: ['booknlp:1'], sourceQuoteIds: ['q1', 'q2'], inferredPronouns: [] };
  const registry: CharacterRegistry = { version: 2, chapters: [0], characters: [character] };

  it('preserves interleaving and exact source coverage', () => {
    const segments = annotationSegmentsForChapter(input, { index: 0, start: 0, end: [...input].length }, quotations, registry, CorrectionsSchema.parse({ version: 1 }));
    expect(segments.map((segment) => segment.speaker)).toEqual(['Tom', 'narrator', 'Tom']);
    expect(segments.map((segment) => segment.text)).toEqual(['“Hello,”', ' said Tom. ', '“Goodbye.”']);
    expect(() => validateScriptCoverage({ version: 2, format: 'plain-text', index: 0, segments }, input, 0, [...input].length)).not.toThrow();
  });

  it('represents unresolved quotations explicitly and accepts a persistent override', () => {
    const unresolved = [{ ...quotations[0], entityId: null, assignment: 'unresolved' as const }];
    expect(annotationSegmentsForChapter(input, { index: 0, start: 0, end: [...input].length }, unresolved, registry, CorrectionsSchema.parse({ version: 1 }))[0]).toMatchObject({ speakerId: 'unresolved', confidence: 'low' });
    const corrected = CorrectionsSchema.parse({ version: 1, quotationSpeakers: { q1: 'speaker-tom' } });
    expect(annotationSegmentsForChapter(input, { index: 0, start: 0, end: [...input].length }, unresolved, registry, corrected)[0]).toMatchObject({ speakerId: 'speaker-tom', speaker: 'Tom' });
    const narrator = CorrectionsSchema.parse({ version: 1, quotationSpeakers: { q1: 'narrator' } });
    expect(annotationSegmentsForChapter(input, { index: 0, start: 0, end: [...input].length }, unresolved, registry, narrator)[0]).toMatchObject({ speakerId: 'narrator', speaker: 'narrator' });
  });

  it('maps BookNLP entity zero to the narrator instead of creating a cast speaker', () => {
    const narratorQuote = [{ ...quotations[0], entityId: 'booknlp:0' }];
    expect(annotationSegmentsForChapter(input, { index: 0, start: 0, end: [...input].length }, narratorQuote, registry, CorrectionsSchema.parse({ version: 1 }))[0])
      .toMatchObject({ speakerId: 'narrator', speaker: 'narrator', text: '“Hello,”' });
  });

  it('splits a manually resolved cross-chapter quotation at exact chapter boundaries', () => {
    const boundary = first.start + 3;
    const crossing = [{ ...quotations[0], chapterIndex: null, assignment: 'unresolved' as const }];
    const corrected = CorrectionsSchema.parse({ version: 1, quotationSpeakers: { q1: 'speaker-tom' } });
    const left = annotationSegmentsForChapter(input, { index: 0, start: 0, end: boundary }, crossing, registry, corrected);
    const right = annotationSegmentsForChapter(input, { index: 1, start: boundary, end: [...input].length }, crossing, registry, corrected);
    expect(left.at(-1)).toMatchObject({ speakerId: 'speaker-tom', text: [...input].slice(first.start, boundary).join('') });
    expect(right[0]).toMatchObject({ speakerId: 'speaker-tom', text: [...input].slice(boundary, first.end).join('') });
  });

  it('rejects rewritten and empty scripts when narration exists', () => {
    const bad = { version: 2 as const, format: 'plain-text' as const, index: 0, segments: [{ speaker: 'narrator', text: 'Changed', confidence: 'high' as const, sourceStart: 0, sourceEnd: 8 }] };
    expect(() => validateScriptCoverage(bad, input, 0, [...input].length)).toThrow('rewrites');
    expect(() => validateScriptCoverage({ version: 2, format: 'plain-text', index: 0, segments: [] }, input, 0, [...input].length)).toThrow('empty');
  });
});
