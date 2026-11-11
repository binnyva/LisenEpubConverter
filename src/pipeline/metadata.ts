import fs from 'node:fs';
import { jsonCall } from '../providers/llm/openai.js';
import { config } from '../config.js';
import { MetadataResponseSchema, type BookMetadata, type BookProfile, type ExtractedChapter, type MetadataResponse } from '../types.js';
import type { WorkDir } from '../state.js';
import { METADATA_FILE } from '../layout.js';
import { reportProgress } from '../util/progress.js';
import { reportWarning } from '../util/warnings.js';
import { countWords } from '../util/text.js';
import { buildStories, writeStories } from './stories.js';

/** Titles of matter that is never narrated. */
const SKIP_TITLE_RE =
  /\b(contents|table of contents|acknowledg|thanks|appendix|index|copyright|license|colophon|dedication|about the author|also by|praise for|title page|other books|project gutenberg)\b/i;

/** Titles that are not the book's own prose, so not a fair sample of it. */
const FRONT_MATTER_RE =
  /\b(cover|half[- ]title|frontispiece|epigraph|preface|foreword|introduction|translator|editor|a note on|note to the reader|maps?|list of|praise)\b/i;

const MIN_BODY_WORDS = 300;

function firstWords(text: string, count: number): string {
  return text.split(/\s+/).filter(Boolean).slice(0, count).join(' ');
}

/** The first chapter that reads like the book itself rather than its front matter. */
export function firstBodyChapter(chapters: ExtractedChapter[]): ExtractedChapter | undefined {
  const candidates = chapters.filter((chapter) => !chapter.isNav);
  return candidates.find((chapter) => chapter.words >= MIN_BODY_WORDS && !SKIP_TITLE_RE.test(chapter.title) && !FRONT_MATTER_RE.test(chapter.title))
    // Every title looked like front matter: the longest document is the safest sample.
    ?? [...candidates].sort((left, right) => right.words - left.words)[0];
}

/** Double-quote pairs per 1,000 words: how much of a text sits inside quotation marks code can split. */
export function doubleQuoteDensity(text: string): number {
  const words = countWords(text);
  if (!words) return 0;
  return ((text.match(/["“”]/g)?.length ?? 0) / 2) / words * 1000;
}

/**
 * Script splits quoted dialogue in code, which only works when the book marks
 * speech with double quotation marks. The model judges the style from a short
 * sample; the whole text is the better witness to whether those marks exist,
 * so it overrules the model in either direction.
 */
export function settleDialogueStyle(
  proposed: MetadataResponse['dialogueStyle'],
  density: number,
): Pick<BookProfile, 'dialogueStyle' | 'dialogueStyleNote'> {
  const dense = density >= config.quotedDialoguePairsPerThousandWords;
  const measured = `${density.toFixed(1)} double-quote pairs per 1,000 words`;
  if (proposed === 'quoted' && !dense) {
    return { dialogueStyle: 'unquoted', dialogueStyleNote: `The model reported quoted dialogue, but the text has ${measured}; dialogue in single quotes or dashes cannot be split in code, so Script asks the model for the segments.` };
  }
  if (proposed === 'unquoted' && dense) {
    return { dialogueStyle: 'quoted', dialogueStyleNote: `The model reported unquoted dialogue from its sample, but the text has ${measured}.` };
  }
  return { dialogueStyle: proposed };
}

/** The request text: source metadata, every chapter's opening, and one prose sample. Never the whole book. */
export function metadataRequest(metadata: BookMetadata, read: (chapter: ExtractedChapter) => string): string {
  const outlines = metadata.chapters
    .map((chapter) => `${chapter.index} — "${chapter.title}" — ${chapter.words} words${chapter.isNav ? ' — navigation document' : ''}\n   Opening: ${firstWords(read(chapter), config.metadataOpeningWords)}`)
    .join('\n');
  const body = firstBodyChapter(metadata.chapters);
  const sample = body ? firstWords(read(body), config.metadataSampleWords) : '';
  return `Title: ${metadata.title}
Author: ${metadata.author}
Language: ${metadata.language}
Subjects: ${metadata.subjects?.length ? metadata.subjects.join('; ') : 'none given'}
Description from the source file (often the publisher's blurb): ${metadata.description?.trim() || 'none given'}

Chapters (index — title — length, then the opening words):
${outlines}
${body ? `\nSample from chapter ${body.index}, "${body.title}":\n${sample}` : ''}`;
}

const SYSTEM = `You profile a book so it can be narrated as a multi-voice audiobook. You are given the source file's metadata, the opening words of every chapter, and one sample of prose. You are not given the whole book. Respond with JSON matching:
{
  "recognised": boolean,
  "summary": "one or two paragraphs, or empty",
  "author": {"sex": "male|female|unknown", "race": "...", "age": "...", "country": "..."},
  "isFiction": boolean,
  "form": "novel|short story|short story collection|non-fiction",
  "genres": ["..."],
  "narrator": {"pointOfView": "first|third|unknown", "sex": "male|female|unknown"},
  "dialogueStyle": "quoted|unquoted",
  "chapters": [{"index": number, "title": "cleaned title", "narrate": boolean, "reason": "short"}],
  "stories": [{"title": "story title", "chapters": [number]}]
}
Rules:
- recognised: true only if you know this specific book by this author. When false, set "summary" to "": do not summarise from the opening words or guess.
- summary: only from what you know of a recognised book. No spoilers are needed; it is background for casting voices.
- author: what you know or can reasonably infer from the name and the text; "unknown" otherwise.
- narrator: the point of view of the sample. For a first-person narrator, the narrator's apparent sex; "unknown" when the text does not show it or the narration is third person.
- dialogueStyle: "quoted" when spoken dialogue is enclosed in quotation marks. "unquoted" when it is marked with dashes, or not marked at all.
- form: "short story collection" for a collection or anthology where each story has its own cast and the chapters do not share one plot. A novel in parts is a "novel". Judge this from the chapter titles and openings.
- chapters: include EVERY chapter index given. title is the chapter's title tidied for reading aloud and for display: fix capitalisation and spacing, drop file-name debris, keep numbering; do not invent a title. narrate=false for: table of contents, appendix, index, acknowledgments, copyright page, dedication, title page, "also by" page. narrate=true for: introduction, prologue, epilogue, and all body chapters.
- stories: [] unless form is "short story collection". Otherwise group the narrated chapters into stories, in chapter order, using the chapter index numbers given. Every narrated chapter belongs to exactly one story. A story is usually one chapter; list several chapters together only when they are parts of the same story, such as a repeated title or "Part II".`;

/**
 * Stage 2: one call on the analysis model that profiles the book from its
 * metadata, chapter openings and one sample — fiction or not, form, narrator,
 * dialogue style, what to narrate, and the story grouping of a collection.
 * The result is saved as the `profile` of metadata.json, beside what Extract
 * wrote, so this stage can be rebuilt on its own.
 */
export async function runMetadata(work: WorkDir): Promise<BookProfile> {
  reportProgress({ activity: 'Reading chapter openings and one prose sample' });
  const metadata = work.readJson<BookMetadata>(METADATA_FILE);
  const texts = new Map<number, string>();
  const read = (chapter: ExtractedChapter): string => {
    if (!texts.has(chapter.index)) texts.set(chapter.index, fs.readFileSync(work.path(chapter.file), 'utf8'));
    return texts.get(chapter.index)!;
  };

  reportProgress({ activity: `Profiling the book from ${metadata.chapters.length} chapter openings — waiting for model response` });
  const response = await jsonCall({
    model: config.analysisModel,
    schema: MetadataResponseSchema,
    system: SYSTEM,
    user: metadataRequest(metadata, read),
  });

  reportProgress({ activity: 'Checking chapter decisions and saving the profile', phase: 'saving' });
  // Backstop the model's chapter decisions with structural and keyword heuristics.
  const planByIndex = new Map(response.chapters.map((plan) => [plan.index, plan]));
  const chapters = metadata.chapters.map((chapter) => {
    const proposed = planByIndex.get(chapter.index);
    const title = proposed?.title.trim() || chapter.title;
    const plan = proposed ? { ...proposed, title } : { index: chapter.index, title, narrate: true, reason: 'default' };
    if (chapter.isNav) return { ...plan, narrate: false, reason: 'nav/TOC document' };
    if (SKIP_TITLE_RE.test(chapter.title)) return { ...plan, narrate: false, reason: `title matches skip list: "${chapter.title}"` };
    if (chapter.words < 10) return { ...plan, narrate: false, reason: 'empty chapter' };
    // Rescue false skips: a title like "Chapter XII" is story content no matter
    // what the model decided.
    if (!plan.narrate && /^(chapter|prologue|epilogue|part|book)\b/i.test(chapter.title)) {
      return { ...plan, narrate: true, reason: `title looks like a story chapter: "${chapter.title}"` };
    }
    return plan;
  });

  const blurb = metadata.description?.trim() ?? '';
  // A summary the model did not get from knowing the book is not kept.
  const summary = response.recognised && response.summary.trim() ? response.summary.trim() : blurb;
  const summarySource = response.recognised && response.summary.trim() ? 'model' as const : blurb ? 'blurb' as const : 'none' as const;

  const narrated = chapters.filter((plan) => plan.narrate).map((plan) => plan.index);
  const bodyText = metadata.chapters.filter((chapter) => narrated.includes(chapter.index)).map(read).join('\n\n');
  const dialogue = response.isFiction
    ? settleDialogueStyle(response.dialogueStyle, doubleQuoteDensity(bodyText))
    : { dialogueStyle: response.dialogueStyle };
  if (dialogue.dialogueStyleNote) reportWarning(`Dialogue style set to "${dialogue.dialogueStyle}". ${dialogue.dialogueStyleNote}`);

  const form = !response.isFiction ? 'non-fiction' as const : response.form === 'non-fiction' ? 'novel' as const : response.form;
  const profile: BookProfile = {
    ...response,
    form,
    summary,
    summarySource,
    ...dialogue,
    chapters,
    stories: form === 'short story collection' || work.collection() ? response.stories : [],
  };
  const saved: BookMetadata = { ...metadata, profile };
  work.writeJson(METADATA_FILE, saved);

  // An explicit choice always wins over detection, and survives a rebuild of
  // this stage. Later stages read the grouping, never the raw flag.
  const collection = work.collection() ?? form === 'short story collection';
  const stories = buildStories(collection, saved);
  writeStories(work, stories);
  reportProgress({
    activity: collection
      ? `Profile saved; treating the source as a collection of ${stories.stories.length} stories`
      : 'Profile saved',
    phase: 'completed',
  });
  return profile;
}
