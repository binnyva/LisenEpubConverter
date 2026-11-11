import { z } from 'zod';
import { jsonCall } from '../providers/llm/openai.js';
import { config } from '../config.js';
import {
  BOOK_STORY_ID,
  CastSpeakerSchema,
  VoiceProfileSchema,
  type BookMetadata,
  type BookProfile,
  type CastSpeaker,
  type Casting,
  type CharacterRegistry,
  type ChapterScript,
  type Story,
} from '../types.js';
import type { WorkDir } from '../state.js';
import { SCRIPTS_DIR, listChapterFiles } from '../layout.js';
import { readCharacterRegistry } from './cast.js';
import { readProfiledMetadata, readStories } from './stories.js';
import { reportProgress } from '../util/progress.js';
import { reportWarning } from '../util/warnings.js';

const StoryCastSchema = z.object({ characters: z.record(z.string(), CastSpeakerSchema) });
const NarratorCastSchema = z.object({ narrator: CastSpeakerSchema });

const PROFILE_RULES = `- Do not select a provider, model, or voice ID. Describe the desired sound only.
- Give every speaker presentation, approximate age, a short tone list, language, accent, and standing delivery instructions. Use a BCP 47 primary language code for language (for example, "en", "fr", or "ja").
- Use "unknown" or "unspecified" where evidence is absent.`;

/** Spoken-segment counts per character across every saved chapter script. */
function speakerCounts(work: WorkDir): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const { file } of listChapterFiles(work.root, SCRIPTS_DIR, '.json')) {
    const script = work.readJson<ChapterScript>(file);
    for (const seg of script.segments) {
      if (seg.speaker !== 'narrator') {
        counts.set(seg.speaker, (counts.get(seg.speaker) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function castDetail(registry: CharacterRegistry, name: string, count: number): string {
  const character = registry.characters.find((entry) => entry.name === name);
  const traits = character ? `${character.sex}, age ${character.age}` : 'unknown traits';
  return `- ${name} (${count} spoken segments): ${traits}`;
}

/** Traits from the registry, used when a response omits a listed speaker. */
function fallbackSpeaker(registry: CharacterRegistry, name: string): CastSpeaker {
  const character = registry.characters.find((entry) => entry.name === name);
  return {
    voiceProfile: VoiceProfileSchema.parse({
      presentation: character?.sex ?? 'unknown',
      age: character?.age ?? 'unknown',
      tone: [],
      language: 'unknown',
      accent: 'unspecified',
    }),
    instructions: '',
  };
}

/**
 * Who the narrator should sound like: a first-person narrator of known sex is
 * the voice of the book; otherwise the author is the best evidence there is.
 */
export function narratorPresentation(profile: BookProfile): 'male' | 'female' | 'unknown' {
  if (profile.narrator.pointOfView === 'first' && profile.narrator.sex !== 'unknown') return profile.narrator.sex;
  return profile.author.sex;
}

function narratorFromProfile(profile: BookProfile): CastSpeaker {
  return {
    voiceProfile: VoiceProfileSchema.parse({
      presentation: narratorPresentation(profile),
      age: profile.author.age,
      tone: ['measured', 'engaging'],
      language: 'unknown',
      accent: profile.author.country === 'unknown' ? 'unspecified' : profile.author.country,
    }),
    instructions: 'Measured, engaging audiobook narrator.',
  };
}

/** What a casting request is told about the book. The summary is optional context only. */
function bookContext(metadata: BookMetadata, profile: BookProfile): string {
  return [
    `Book: "${metadata.title}" by ${metadata.author} (${profile.form}${profile.genres.length ? `; ${profile.genres.join(', ')}` : ''})`,
    profile.summary ? `Summary: ${profile.summary.slice(0, 600)}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Stage 4: describe intended voices without selecting a provider or model.
 * One request designs the book's single narrator, then one request per story
 * designs that story's speakers, so a 20-story anthology never has to fit
 * every cast into one reply and each story sees only its own characters.
 */
export async function runCasting(work: WorkDir): Promise<Casting> {
  reportProgress({ activity: 'Reading the cast and counting scripted speakers' });
  const metadata = readProfiledMetadata(work);
  const profile = metadata.profile;
  const stories = readStories(work);
  const registry = readCharacterRegistry(work, stories);
  const ranked = speakerCounts(work);

  if (ranked.length === 0) {
    const casting: Casting = { version: 2, narrator: narratorFromProfile(profile), characters: {} };
    work.writeJson('casting.json', casting);
    reportProgress({ activity: 'Narrator profile saved; no character voices needed', phase: 'completed' });
    return casting;
  }

  const storyOfName = new Map(registry.characters.map((character) => [character.name, character.story || BOOK_STORY_ID]));
  const firstStory = stories.stories[0]?.id ?? BOOK_STORY_ID;
  // A scripted speaker the registry no longer lists is still cast, with the first story.
  const withSpeakers = stories.stories
    .map((story) => ({ story, speakers: ranked.filter(([name]) => (storyOfName.get(name) ?? firstStory) === story.id) }))
    .filter(({ speakers }) => speakers.length);
  const batches = withSpeakers.flatMap(({ story, speakers }) => {
    const parts: Array<{ story: Story; speakers: Array<[string, number]> }> = [];
    for (let offset = 0; offset < speakers.length; offset += config.castingBatchSize) {
      parts.push({ story, speakers: speakers.slice(offset, offset + config.castingBatchSize) });
    }
    return parts;
  });
  const totalUnits = batches.length + 1;

  reportProgress({ activity: 'Designing the narrator voice profile — waiting for model response', completedUnits: 0, totalUnits, unit: 'casts designed' });
  const { narrator } = await jsonCall({
    model: config.analysisModel,
    schema: NarratorCastSchema,
    system: `You cast the narrator voice for a multi-voice audiobook. Respond with JSON:
{"narrator":{"voiceProfile":{"presentation","age","tone","language","accent"},"instructions"}}

Rules:
${PROFILE_RULES}
- One narrator reads the whole book. The instructions describe steady audiobook narration that suits all of it.
- Choose the presentation from the narration first: a first-person narrator of known sex is voiced as that sex. Otherwise follow the author profile.`,
    user: `${bookContext(metadata, profile)}

Narration: ${profile.narrator.pointOfView} person${profile.narrator.pointOfView === 'first' ? `, narrator apparently ${profile.narrator.sex}` : ''}
Author profile: ${profile.author.sex}, age ${profile.author.age}, ${profile.author.country}${stories.collection
  ? `\n\nStories: ${stories.stories.map((story) => story.title || 'Untitled').join('; ').slice(0, 600)}` : ''}`,
  });
  // The evidence decides the narrator's sex, not the model's taste.
  const presentation = narratorPresentation(profile);
  if (presentation !== 'unknown' && (profile.narrator.pointOfView === 'first' || narrator.voiceProfile.presentation === 'unknown')) {
    narrator.voiceProfile.presentation = presentation;
  }

  const characters: Record<string, CastSpeaker> = {};
  for (const [position, { story, speakers }] of batches.entries()) {
    const storyName = story.title || metadata.title;
    reportProgress({
      activity: `Designing ${speakers.length} character voice profile(s) for "${storyName}" — waiting for model response`,
      completedUnits: position + 1, totalUnits, unit: 'casts designed',
    });
    const result = await jsonCall({
      model: config.analysisModel,
      schema: StoryCastSchema,
      system: `You cast character voices for a multi-voice audiobook. Respond with JSON:
{"characters":{"<name>":{"voiceProfile":{"presentation","age","tone","language","accent"},"instructions"}, ...}}

Rules:
${PROFILE_RULES}
- Character instructions differentiate age, accent, class, and personality.
- Cast only the characters listed. Use their names exactly as given, and write instructions for every one of them.
- Do not cast a narrator.`,
      user: `${bookContext(metadata, profile)}${stories.collection ? `\n\nStory: "${storyName}" — one story in a collection; these characters belong to it alone.` : ''}

Characters:
${speakers.map(([name, count]) => castDetail(registry, name, count)).join('\n')}`,
    });
    const listed = new Set(speakers.map(([name]) => name));
    for (const [name, speaker] of Object.entries(result.characters)) {
      if (listed.has(name)) characters[name] = speaker;
    }
    const missing = speakers.filter(([name]) => !characters[name]).map(([name]) => name);
    if (missing.length) {
      reportWarning(`Casting omitted ${missing.length} speaker(s) in "${storyName}": ${missing.join(', ')}. Registry traits were used instead; review their instructions.`);
    }
  }

  reportProgress({ activity: 'Checking and saving voice profiles', phase: 'saving' });
  const casting: Casting = { version: 2, narrator, characters };
  for (const [name] of ranked) {
    if (!casting.characters[name]) casting.characters[name] = fallbackSpeaker(registry, name);
  }
  work.writeJson('casting.json', casting);
  reportProgress({ activity: 'Voice profiles saved', phase: 'completed' });
  return casting;
}
