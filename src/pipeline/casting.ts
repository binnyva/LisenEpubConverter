import fs from 'node:fs';
import { z } from 'zod';
import { jsonCall } from '../providers/llm/openai.js';
import { config } from '../config.js';
import {
  BOOK_STORY_ID,
  CastSpeakerSchema,
  CastingSchema,
  VoiceProfileSchema,
  type Analysis,
  type CastSpeaker,
  type Casting,
  type CharacterRegistry,
  type ChapterScript,
  type ChapterSummaries,
  type Story,
} from '../types.js';
import type { WorkDir } from '../state.js';
import { readCharacterRegistry } from './list-characters.js';
import { readStories } from './stories.js';
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
  for (const file of fs.readdirSync(work.path('script')).sort()) {
    const script = work.readJson<ChapterScript>(`script/${file}`);
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
  const traits = character
    ? `${character.sex}, age ${character.age}, ${character.race}, ${character.class}, ${character.country}`
    : 'unknown traits';
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
      accent: character?.country ?? 'unspecified',
    }),
    instructions: '',
  };
}

function narratorFromAuthor(analysis: Analysis): CastSpeaker {
  return {
    voiceProfile: VoiceProfileSchema.parse({
      presentation: analysis.author.sex === 'unknown' ? 'unknown' : analysis.author.sex,
      age: analysis.author.age,
      tone: ['measured', 'engaging'],
      language: 'unknown',
      accent: analysis.author.country,
    }),
    instructions: 'Measured, engaging audiobook narrator.',
  };
}

/**
 * Stage 6: describe intended character voices without selecting a provider or
 * model. A collection is cast one story at a time: a single request for every
 * speaker in a 20-story anthology would not fit the completion budget, and
 * each story's profiles are better with only its own cast in the prompt.
 */
export async function runCasting(work: WorkDir): Promise<Casting> {
  reportProgress({ activity: 'Reading character profiles and counting scripted speakers' });
  const analysis = work.readJson<Analysis>('analysis.json');
  const registry = readCharacterRegistry(work);
  const stories = readStories(work);
  const ranked = speakerCounts(work);

  if (ranked.length === 0) {
    const casting: Casting = { version: 2, narrator: narratorFromAuthor(analysis), characters: {} };
    work.writeJson('casting.json', casting);
    reportProgress({ activity: 'Narrator profile saved; no character voices needed', phase: 'completed' });
    return casting;
  }

  const casting = stories.collection && stories.stories.length > 1
    ? await castCollection(work, analysis, registry, stories.stories, ranked)
    : await castWholeBook(analysis, registry, ranked);

  reportProgress({ activity: 'Checking and saving voice profiles', phase: 'saving' });
  casting.version = 2;
  for (const [name] of ranked) {
    if (!casting.characters[name]) casting.characters[name] = fallbackSpeaker(registry, name);
  }

  work.writeJson('casting.json', casting);
  reportProgress({ activity: 'Voice profiles saved', phase: 'completed' });
  return casting;
}

async function castWholeBook(
  analysis: Analysis,
  registry: CharacterRegistry,
  ranked: Array<[string, number]>,
): Promise<Casting> {
  reportProgress({ activity: `Designing narrator and ${ranked.length} character voice profiles — waiting for model response` });
  return jsonCall({
    model: config.analysisModel,
    schema: CastingSchema,
    system: `You cast voices for a multi-voice audiobook. Respond with JSON:
{"version":2,"narrator":{"voiceProfile":{"presentation","age","tone","language","accent"},"instructions"},"characters":{"<name>":{"voiceProfile":{"presentation","age","tone","language","accent"},"instructions"}, ...}}

Rules:
${PROFILE_RULES}
- The narrator's instructions describe steady audiobook narration. Character instructions differentiate age, accent, class, and personality.
- Every character listed must appear in "characters". Write instructions for every speaker.`,
    user: `Book summary: ${analysis.summary.slice(0, 600)}

Author: ${analysis.author.name} (${analysis.author.sex}, ${analysis.author.country})

Characters:
${ranked.map(([name, count]) => castDetail(registry, name, count)).join('\n')}`,
  });
}

async function castCollection(
  work: WorkDir,
  analysis: Analysis,
  registry: CharacterRegistry,
  stories: Story[],
  ranked: Array<[string, number]>,
): Promise<Casting> {
  const summaries = fs.existsSync(work.path('chapter-summaries.json'))
    ? work.readJson<ChapterSummaries>('chapter-summaries.json')
    : {};
  const storyOfName = new Map(registry.characters.map((character) => [character.name, character.story || BOOK_STORY_ID]));
  const withSpeakers = stories
    .map((story) => ({ story, speakers: ranked.filter(([name]) => storyOfName.get(name) === story.id) }))
    .filter(({ speakers }) => speakers.length);
  const totalUnits = withSpeakers.length + 1;

  reportProgress({ activity: 'Designing the narrator voice profile — waiting for model response', completedUnits: 0, totalUnits, unit: 'casts designed' });
  const { narrator } = await jsonCall({
    model: config.analysisModel,
    schema: NarratorCastSchema,
    system: `You cast the narrator voice for a multi-voice audiobook of a short story collection. Respond with JSON:
{"narrator":{"voiceProfile":{"presentation","age","tone","language","accent"},"instructions"}}

Rules:
${PROFILE_RULES}
- One narrator reads the whole collection. The instructions describe steady audiobook narration that suits every story.`,
    user: `Collection summary: ${analysis.summary.slice(0, 600)}

Author: ${analysis.author.name} (${analysis.author.sex}, ${analysis.author.country})

Stories: ${stories.map((story) => story.title || 'Untitled').join('; ').slice(0, 600)}`,
  });

  const characters: Record<string, CastSpeaker> = {};
  for (const [position, { story, speakers }] of withSpeakers.entries()) {
    reportProgress({
      activity: `Designing ${speakers.length} character voice profile(s) for "${story.title || `story ${position + 1}`}" — waiting for model response`,
      completedUnits: position + 1, totalUnits, unit: 'casts designed',
    });
    const result = await jsonCall({
      model: config.analysisModel,
      schema: StoryCastSchema,
      system: `You cast character voices for one short story inside a multi-voice audiobook collection. Respond with JSON:
{"characters":{"<name>":{"voiceProfile":{"presentation","age","tone","language","accent"},"instructions"}, ...}}

Rules:
${PROFILE_RULES}
- Character instructions differentiate age, accent, class, and personality.
- Cast only the characters listed. Use their names exactly as given, and write instructions for every one of them.
- These characters belong to this story alone. Do not cast a narrator.`,
      user: `Collection: "${analysis.summary.slice(0, 200)}"

Story: "${story.title || `Story ${position + 1}`}"
Story summary: ${story.chapters.map((index) => summaries[index] ?? '').join(' ').slice(0, 800)}

Characters:
${speakers.map(([name, count]) => castDetail(registry, name, count)).join('\n')}`,
    });
    const listed = new Set(speakers.map(([name]) => name));
    for (const [name, speaker] of Object.entries(result.characters)) {
      if (listed.has(name)) characters[name] = speaker;
    }
    const missing = speakers.filter(([name]) => !characters[name]).map(([name]) => name);
    if (missing.length) {
      reportWarning(`Casting omitted ${missing.length} speaker(s) in "${story.title || `story ${position + 1}`}": ${missing.join(', ')}. Registry traits were used instead; review their instructions.`);
    }
  }
  return { version: 2, narrator, characters };
}
