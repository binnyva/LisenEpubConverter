import fs from 'node:fs';
import path from 'node:path';
import { BOOK_STORY_ID, StoriesSchema, type Analysis, type BookMetadata, type Stories, type Story } from '../types.js';
import type { WorkDir } from '../state.js';
import { reportWarning } from '../util/warnings.js';

export const STORIES_FILE = 'stories.json';

const pad = (index: number): string => String(index).padStart(2, '0');

/** Narratable chapter indexes in spine order. */
export function narratableChapters(metadata: BookMetadata, analysis: Analysis): number[] {
  return metadata.chapters
    .filter((chapter) => analysis.chapters.some((plan) => plan.index === chapter.index && plan.narrate))
    .map((chapter) => chapter.index);
}

/**
 * Story grouping for a book. A single continuous work is one story covering
 * every narratable chapter, so every later stage can scope characters the same
 * way whether or not the source is a collection. A collection starts with one
 * story per narratable chapter; multi-chapter stories are grouped by editing
 * this file.
 */
export function buildStories(collection: boolean, metadata: BookMetadata, analysis: Analysis): Stories {
  const chapters = narratableChapters(metadata, analysis);
  if (!collection) {
    return { version: 1, collection: false, stories: [{ id: BOOK_STORY_ID, title: metadata.title ?? '', chapters }] };
  }
  return proposedStories(metadata, analysis) ?? oneStoryPerChapter(metadata, chapters);
}

/** The default grouping: a collection's stories are one chapter each. */
function oneStoryPerChapter(metadata: BookMetadata, chapters: number[]): Stories {
  // Chapter-derived ids stay stable while chapters are added or removed, so an
  // unrelated story's scope hash does not change and its script survives.
  return {
    version: 1,
    collection: true,
    stories: chapters.map((index) => ({ id: storyId(index), title: storyTitle(metadata, index, ''), chapters: [index] })),
  };
}

const storyId = (firstChapter: number): string => `story-${pad(firstChapter)}`;

function storyTitle(metadata: BookMetadata, firstChapter: number, proposed: string): string {
  return proposed.trim()
    || metadata.chapters.find((chapter) => chapter.index === firstChapter)?.title
    || `Story ${firstChapter + 1}`;
}

/**
 * Analyze's grouping, which can span several chapters when a story is
 * published in parts. A proposal that does not cover the narratable chapters
 * exactly once is reported and discarded rather than half-applied.
 */
function proposedStories(metadata: BookMetadata, analysis: Analysis): Stories | undefined {
  const narratable = narratableChapters(metadata, analysis);
  // Analyze decides narration in the same response, and its own backstop can
  // skip a chapter afterwards. Drop those rather than losing the grouping.
  const proposal = (analysis.stories ?? [])
    .map((story) => [...new Set(story.chapters)].filter((index) => narratable.includes(index)).sort((left, right) => left - right))
    .map((chapters, position) => ({ chapters, title: analysis.stories![position].title }))
    .filter((story) => story.chapters.length);
  if (!proposal.length) return undefined;
  const stories: Stories = {
    version: 1,
    collection: true,
    stories: proposal
      .map((story) => ({ id: storyId(story.chapters[0]), title: storyTitle(metadata, story.chapters[0], story.title), chapters: story.chapters }))
      .sort((left, right) => left.chapters[0] - right.chapters[0]),
  };
  try {
    validateStories(stories, metadata, analysis);
  } catch (err) {
    reportWarning(`Ignored the proposed story grouping (${(err as Error).message}) and used one story per chapter.`);
    return undefined;
  }
  return stories;
}

/**
 * A grouping must cover every narratable chapter exactly once, in chapter
 * order. Errors are written for the person editing stories.json or the
 * workspace grouping panel.
 */
export function validateStories(stories: Stories, metadata: BookMetadata, analysis: Analysis): void {
  const narratable = narratableChapters(metadata, analysis);
  if (!stories.stories.length) throw new Error('A story grouping needs at least one story.');
  if (!stories.collection && stories.stories.length > 1) {
    throw new Error('A continuous work has one story. Turn on the collection setting to group separate stories.');
  }
  const ids = new Set<string>();
  const seen = new Set<number>();
  let previous = -1;
  for (const [position, story] of stories.stories.entries()) {
    const label = story.title?.trim() || `story ${position + 1}`;
    if (!story.id.trim()) throw new Error(`Story "${label}" needs an id.`);
    if (ids.has(story.id)) throw new Error(`Duplicate story id "${story.id}".`);
    ids.add(story.id);
    if (!story.chapters.length) throw new Error(`Story "${label}" has no chapters.`);
    for (const index of story.chapters) {
      if (!narratable.includes(index)) throw new Error(`Chapter ${index + 1} is not narrated and cannot belong to a story.`);
      if (seen.has(index)) throw new Error(`Chapter ${index + 1} belongs to more than one story.`);
      if (index <= previous) throw new Error('List stories, and the chapters in each story, in chapter order.');
      seen.add(index);
      previous = index;
    }
  }
  const missing = narratable.filter((index) => !seen.has(index));
  if (missing.length) {
    throw new Error(`Every narrated chapter must belong to a story; chapter ${missing.map((index) => index + 1).join(', ')} does not.`);
  }
}

/** Chapter indexes of 1-based story positions, as the CLI and UI select them. */
export function chaptersForStoryNumbers(stories: Stories, numbers: number[]): number[] {
  const chapters = new Set<number>();
  for (const number of numbers) {
    const story = stories.stories[number - 1];
    if (!Number.isInteger(number) || !story) {
      throw new Error(`Story ${number} does not exist; this source has ${stories.stories.length} story/stories.`);
    }
    for (const index of story.chapters) chapters.add(index);
  }
  return [...chapters].sort((left, right) => left - right);
}

/** The saved grouping of a work folder, when it has one. */
export function readStoriesFile(root: string): Stories | undefined {
  const file = path.join(root, STORIES_FILE);
  if (!fs.existsSync(file)) return undefined;
  const stories = StoriesSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  return stories.stories.length ? stories : undefined;
}

/** Read the saved grouping, falling back to the single book scope for older work folders. */
export function readStories(work: WorkDir): Stories {
  return readStoriesFile(work.root) ?? buildStories(
    work.collection() ?? false,
    work.readJson<BookMetadata>('metadata.json'),
    work.readJson<Analysis>('analysis.json'),
  );
}

export function writeStories(work: WorkDir, stories: Stories): void {
  work.writeJson(STORIES_FILE, stories);
}

export function storyFor(stories: Stories, chapterIndex: number): Story | undefined {
  return stories.stories.find((story) => story.chapters.includes(chapterIndex));
}

export function storyIdFor(stories: Stories, chapterIndex: number): string {
  return storyFor(stories, chapterIndex)?.id ?? BOOK_STORY_ID;
}

/**
 * Short label used to disambiguate a character name shared by two stories.
 * Falls back to a position when titles are missing or repeated, so the label
 * identifies exactly one story.
 */
export function storyLabels(stories: Stories): Map<string, string> {
  const counts = new Map<string, number>();
  for (const story of stories.stories) {
    const title = (story.title ?? '').trim();
    if (title) counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  return new Map(stories.stories.map((story, position) => {
    const title = (story.title ?? '').trim();
    return [story.id, title && counts.get(title) === 1 ? title : `story ${position + 1}`];
  }));
}

/** Remove a story label suffix, giving the name as the book's text writes it. */
export function withoutStoryLabel(name: string, label: string | undefined): string {
  const suffix = label ? ` (${label})` : '';
  return suffix && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}
