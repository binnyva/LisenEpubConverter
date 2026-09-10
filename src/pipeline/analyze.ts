import fs from 'node:fs';
import { jsonCall } from '../providers/llm/openai.js';
import { config } from '../config.js';
import { AnalysisSchema, type Analysis, type BookMetadata } from '../types.js';
import type { WorkDir } from '../state.js';

const SKIP_TITLE_RE =
  /\b(contents|table of contents|acknowledg|thanks|appendix|index|copyright|license|colophon|dedication|about the author|also by|praise for|title page|other books|project gutenberg)\b/i;

/**
 * Stage 2: one sampled overview LLM call — fiction detection, provisional summary, character and
 * author profiles, and a narrate/skip decision per chapter.
 */
export async function runAnalyze(work: WorkDir): Promise<Analysis> {
  const meta = work.readJson<BookMetadata>('metadata.json');

  const chapterOutlines = meta.chapters
    .map((ch) => {
      const text = fs.readFileSync(work.path(ch.file), 'utf8');
      const opening = text.slice(0, 600).replace(/\s+/g, ' ');
      return `Chapter ${ch.index} — title: "${ch.title}" (${ch.words} words${ch.isNav ? ', nav/TOC document' : ''})\nOpening: ${opening}`;
    })
    .join('\n\n');

  // Sample body text so character extraction has something to work with.
  const bodyChapters = meta.chapters.filter((ch) => !ch.isNav && ch.words > 300);
  const sampled = bodyChapters
    .filter((_, i) => i % Math.max(1, Math.floor(bodyChapters.length / 8)) === 0)
    .slice(0, 8)
    .map((ch) => `--- From chapter ${ch.index} ("${ch.title}") ---\n${fs.readFileSync(work.path(ch.file), 'utf8').slice(0, 4000)}`)
    .join('\n\n');

  const analysis = await jsonCall({
    model: config.analysisModel,
    schema: AnalysisSchema,
    system: `You analyze books to prepare them for audiobook narration. Respond with JSON matching:
{
  "isFiction": boolean,
  "summary": "2-3 paragraph summary of the book",
  "characters": [{"name", "aliases": [], "sex": "male|female|unknown", "age", "race", "class", "country", "importance": "main|secondary|minor"}],
  "author": {same fields as a character},
  "chapters": [{"index": number, "narrate": boolean, "reason": "short"}]
}
Rules:
- For non-fiction, "characters" should be an empty array.
- The text is a sample, not the whole book. The summary and character list are provisional.
- List only speaking characters supported by the supplied excerpts; do not invent a complete cast or rely on prior knowledge of the book.
- Set character traits only when supported by the supplied text; otherwise use "unknown". Do not infer an accent from a name.
- For the author, infer sex/age/country from the name and content; use "unknown" when unclear.
- chapters: include EVERY chapter index given. narrate=false for: table of contents, appendix, index, acknowledgments/thanks, copyright, dedication, title pages, "also by" pages. narrate=true for: introduction, prologue, epilogue, and all body chapters.`,
    user: `Book: "${meta.title}" by ${meta.author} (language: ${meta.language})

Chapter list:
${chapterOutlines}

Sample text:
${sampled}`,
  });

  // Backstop the LLM's chapter decisions with structural and keyword heuristics.
  const planByIndex = new Map(analysis.chapters.map((c) => [c.index, c]));
  analysis.chapters = meta.chapters.map((ch) => {
    const plan = planByIndex.get(ch.index) ?? { index: ch.index, narrate: true, reason: 'default' };
    if (ch.isNav) return { index: ch.index, narrate: false, reason: 'nav/TOC document' };
    if (SKIP_TITLE_RE.test(ch.title)) {
      return { index: ch.index, narrate: false, reason: `title matches skip list: "${ch.title}"` };
    }
    if (ch.words < 10) return { index: ch.index, narrate: false, reason: 'empty chapter' };
    // Rescue false skips: a title like "Chapter XII" is story content no matter
    // what the LLM decided.
    if (!plan.narrate && /^(chapter|prologue|epilogue|part|book)\b/i.test(ch.title)) {
      return { index: ch.index, narrate: true, reason: `title looks like a story chapter: "${ch.title}"` };
    }
    return plan;
  });

  work.writeJson('analysis.json', analysis);
  return analysis;
}
