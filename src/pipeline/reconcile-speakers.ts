import { z } from 'zod';
import { config } from '../config.js';
import { jsonCall } from '../providers/llm/openai.js';
import { BOOK_STORY_ID, type CastCharacter, type UnresolvedSpeakerRecord } from '../types.js';
import type { WorkDir } from '../state.js';
import { nameKey, readCharacterRegistry } from './cast.js';
import { chapterTitle, readProfiledMetadata, readStories } from './stories.js';

export interface SpeakerResolution {
  /** Identifies one unresolved record: its chapter and speaker. */
  key: string;
  chapter: number;
  speaker: string;
  /** Existing identities are safe to preselect; new roles still need confirmation in the UI. */
  resolution: 'existing' | 'new' | 'unresolved';
  /** Canonical name of the existing character, for `resolveAs`. */
  character?: string;
  reason: string;
  evidence: string;
}

const ReconciliationSchema = z.object({
  resolutions: z.array(z.object({
    chapter: z.number().int(),
    speaker: z.string(),
    resolution: z.enum(['existing', 'new', 'unresolved']),
    /** Must be an exact canonical name from the supplied cast for "existing". */
    character: z.string().optional(),
    reason: z.string(),
    evidence: z.string(),
  })),
});

export const unresolvedKey = (record: Pick<UnresolvedSpeakerRecord, 'chapter' | 'speaker'>): string =>
  `${record.chapter}:${nameKey(record.speaker)}`;

/**
 * Ask for conservative, reviewable choices after Script stops on an unknown
 * speaker. This intentionally does not change the registry: the caller must
 * show the proposal and require an explicit save before attribution changes.
 */
export async function reconcileUnresolvedSpeakers(work: WorkDir): Promise<SpeakerResolution[]> {
  const stories = readStories(work);
  const registry = readCharacterRegistry(work, stories);
  const pending = registry.unresolved.filter((record) => !record.resolveAs?.trim());
  if (!pending.length) throw new Error('There are no unresolved Script speakers to reconcile. Run Script first.');

  const metadata = readProfiledMetadata(work);
  const byStory = new Map<string, UnresolvedSpeakerRecord[]>();
  for (const record of pending) byStory.set(record.story, [...(byStory.get(record.story) ?? []), record]);

  const resolutions: SpeakerResolution[] = [];
  for (const [story, records] of byStory) {
    // One name can belong to two different people in two stories, so a
    // speaker is only ever matched against the cast of its own story.
    const scoped = registry.characters.filter((character) => (character.story || BOOK_STORY_ID) === story);
    resolutions.push(...await reconcileStory(scoped, records, (index) => chapterTitle(metadata, index)));
  }
  const byKey = new Map(resolutions.map((resolution) => [resolution.key, resolution]));
  return pending.map((record) => byKey.get(unresolvedKey(record)) ?? undecided(record, 'The reconciliation pass did not return a decision.'));
}

function undecided(record: UnresolvedSpeakerRecord, reason: string, evidence = ''): SpeakerResolution {
  return { key: unresolvedKey(record), chapter: record.chapter, speaker: record.speaker, resolution: 'unresolved', reason, evidence };
}

/** One conservative pass over the unresolved speakers of a single story. */
async function reconcileStory(
  scoped: CastCharacter[],
  records: UnresolvedSpeakerRecord[],
  titleOf: (chapter: number) => string,
): Promise<SpeakerResolution[]> {
  const characters = scoped.map((character) => ({
    name: character.name, aliases: character.aliases, chapters: character.chapters,
    evidence: character.evidence.slice(-3).map((entry) => entry.text),
  }));
  const result = await jsonCall({
    model: config.analysisModel,
    schema: ReconciliationSchema,
    system: `You reconcile unresolved audiobook dialogue speakers. Respond with JSON: {"resolutions":[{"chapter","speaker","resolution","character?","reason","evidence"}]}.

Rules:
- Use resolution="existing" only when the passage supports one exact canonical character from the supplied cast. Set character to that exact name.
- Use resolution="new" when the speaker is clearly a distinct, durable role or character but is not in the cast. Do not invent a personal name or traits.
- Use resolution="unresolved" when the text does not establish the identity. Never guess merely from gender, clothing, or voice.
- evidence must be a short quoted or closely paraphrased fact from the supplied context; reason must explain the choice briefly.
- Return one decision for every unresolved speaker, with its chapter number as given, and no others.`,
    user: `Canonical characters (the only allowed existing choices):\n${JSON.stringify(characters)}\n\nUnresolved speakers:\n${records.map((record) =>
      `Chapter ${record.chapter}: ${JSON.stringify(titleOf(record.chapter))}\nSpeaker: ${JSON.stringify(record.speaker)}\n${record.samples.map((sample) => `Dialogue: ${JSON.stringify(sample.text)}\nIn context (the line is marked ">>"):\n${sample.context}`).join('\n')}`).join('\n\n---\n\n')}`,
  });

  const proposals = new Map(result.resolutions.map((resolution) => [unresolvedKey(resolution), resolution]));
  const byName = new Map(scoped.map((character) => [nameKey(character.name), character]));
  return records.map((record) => {
    const proposal = proposals.get(unresolvedKey(record));
    if (!proposal) return undecided(record, 'The reconciliation pass did not return a decision.');
    if (proposal.resolution === 'existing') {
      const character = proposal.character ? byName.get(nameKey(proposal.character)) : undefined;
      if (!character) return undecided(record, 'The reconciliation pass selected a character outside the current cast.', proposal.evidence);
      return { key: unresolvedKey(record), chapter: record.chapter, speaker: record.speaker, resolution: 'existing', character: character.name, reason: proposal.reason, evidence: proposal.evidence };
    }
    return { key: unresolvedKey(record), chapter: record.chapter, speaker: record.speaker, resolution: proposal.resolution, reason: proposal.reason, evidence: proposal.evidence };
  });
}
