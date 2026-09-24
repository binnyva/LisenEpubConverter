import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { jsonCall } from '../providers/llm/openai.js';
import type { ScriptSegment, BookMetadata, ChapterSummaries } from '../types.js';
import type { WorkDir } from '../state.js';
import { readCharacterRegistry } from './list-characters.js';

export interface UnresolvedSpeaker {
  /** Stable within a work folder and shared with the workspace UI. */
  key: string;
  speaker: string;
  chapters: number[];
  samples: Array<Pick<ScriptSegment, 'text' | 'delivery' | 'confidence'> & { chapter: number }>;
}

export interface SpeakerResolution {
  key: string;
  speaker: string;
  /** Existing identities are safe to preselect; new roles still need confirmation in the UI. */
  resolution: 'existing' | 'new' | 'unresolved';
  characterId?: string;
  reason: string;
  evidence: string;
}

const ReconciliationSchema = z.object({
  resolutions: z.array(z.object({
    speaker: z.string(),
    resolution: z.enum(['existing', 'new', 'unresolved']),
    /** Must be an exact canonical name from the supplied registry for "existing". */
    character: z.string().optional(),
    reason: z.string(),
    evidence: z.string(),
  })),
});

const normalize = (value: string): string => value.normalize('NFKC').trim().toLocaleLowerCase();

/** Read the stopped Script stage's evidence without trusting file names or malformed output. */
export function unresolvedSpeakers(work: WorkDir): UnresolvedSpeaker[] {
  const directory = work.path('character-candidates');
  if (!fs.existsSync(directory)) return [];
  const groups = new Map<string, UnresolvedSpeaker>();
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('.json'))) {
    let data: { index?: unknown; candidates?: unknown };
    try {
      data = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')) as { index?: unknown; candidates?: unknown };
    } catch {
      continue;
    }
    if (!Number.isInteger(data.index) || !Array.isArray(data.candidates)) continue;
    for (const item of data.candidates) {
      if (!item || typeof item !== 'object') continue;
      const segment = item as Partial<ScriptSegment>;
      const speaker = segment.speaker?.trim();
      const text = segment.text?.trim();
      if (!speaker || !text) continue;
      const id = normalize(speaker);
      if (!id || id === 'narrator') continue;
      const group = groups.get(id) ?? { key: `candidate-${id}`, speaker, chapters: [], samples: [] };
      if (!group.chapters.includes(data.index as number)) group.chapters.push(data.index as number);
      if (group.samples.length < 3) {
        group.samples.push({ chapter: data.index as number, text, delivery: segment.delivery, confidence: segment.confidence ?? 'low' });
      }
      groups.set(id, group);
    }
  }
  return [...groups.values()].sort((a, b) => a.speaker.localeCompare(b.speaker));
}

function chapterContext(metadata: BookMetadata, summaries: ChapterSummaries, candidate: UnresolvedSpeaker): string {
  return candidate.chapters.map((index) => {
    const title = metadata.chapters.find((chapter) => chapter.index === index)?.title ?? `Chapter ${index + 1}`;
    const samples = candidate.samples.filter((sample) => sample.chapter === index)
      .map((sample) => `Dialogue: ${JSON.stringify(sample.text)}`).join('\n');
    return `Chapter ${index + 1}: ${JSON.stringify(title)}\nSummary: ${summaries[index] ?? 'No summary available.'}\n${samples}`;
  }).join('\n\n');
}

/**
 * Ask for conservative, reviewable choices after Script stops on an unknown
 * speaker. This intentionally does not change the registry: the caller must
 * show the proposal and require an explicit save before attribution changes.
 */
export async function reconcileUnresolvedSpeakers(work: WorkDir): Promise<SpeakerResolution[]> {
  const candidates = unresolvedSpeakers(work);
  if (!candidates.length) throw new Error('There are no unresolved Script speakers to reconcile. Run Script first.');

  const registry = readCharacterRegistry(work);
  const metadata = work.readJson<BookMetadata>('metadata.json');
  const summaries = work.readJson<ChapterSummaries>('chapter-summaries.json');
  const characters = registry.characters.map((character) => ({
    name: character.name, aliases: character.aliases, chapters: character.chapters,
    evidence: character.evidence.slice(-3),
  }));
  const result = await jsonCall({
    model: config.analysisModel,
    schema: ReconciliationSchema,
    system: `You reconcile unresolved audiobook dialogue speakers. Respond with JSON: {"resolutions":[{"speaker","resolution","character?","reason","evidence"}]}.

Rules:
- Use resolution="existing" only when the passage supports one exact canonical character from the supplied registry. Set character to that exact name.
- Use resolution="new" when the speaker is clearly a distinct, durable role or character but is not in the registry. Do not invent a personal name or traits.
- Use resolution="unresolved" when the text does not establish the identity. Never guess merely from gender, clothing, or voice.
- evidence must be a short quoted or closely paraphrased fact from the supplied context; reason must explain the choice briefly.
- Return one decision for every unresolved speaker and no others.`,
    user: `Canonical characters (the only allowed existing choices):\n${JSON.stringify(characters)}\n\nUnresolved speakers:\n${candidates.map((candidate) => `Speaker: ${JSON.stringify(candidate.speaker)}\n${chapterContext(metadata, summaries, candidate)}`).join('\n\n---\n\n')}`,
  });

  const bySpeaker = new Map(result.resolutions.map((resolution) => [normalize(resolution.speaker), resolution]));
  const byName = new Map(registry.characters.map((character) => [normalize(character.name), character]));
  return candidates.map((candidate) => {
    const proposal = bySpeaker.get(normalize(candidate.speaker));
    if (!proposal) return { ...candidate, resolution: 'unresolved', reason: 'The reconciliation pass did not return a decision.', evidence: '' };
    if (proposal.resolution === 'existing') {
      const character = proposal.character ? byName.get(normalize(proposal.character)) : undefined;
      if (character) return { key: candidate.key, speaker: candidate.speaker, resolution: 'existing', characterId: character.id, reason: proposal.reason, evidence: proposal.evidence };
      return { key: candidate.key, speaker: candidate.speaker, resolution: 'unresolved', reason: 'The reconciliation pass selected a character outside the current registry.', evidence: proposal.evidence };
    }
    return { key: candidate.key, speaker: candidate.speaker, resolution: proposal.resolution, reason: proposal.reason, evidence: proposal.evidence };
  });
}
