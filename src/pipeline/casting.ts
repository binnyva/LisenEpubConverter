import fs from 'node:fs';
import { jsonCall } from '../providers/llm/openai.js';
import { config } from '../config.js';
import { CastingSchema, ManualSpeakerSettingsSchema, type Analysis, type Casting, type ChapterScript } from '../types.js';
import type { WorkDir } from '../state.js';
import { readCharacterRegistry } from './list-characters.js';
import { reportProgress } from '../util/progress.js';

/**
 * Stage 7: describe intended character voices without selecting a provider or model.
 */
export async function runCasting(work: WorkDir): Promise<Casting> {
  reportProgress({ activity: 'Reading character profiles and counting scripted speakers' });
  const analysis = work.readJson<Analysis>('analysis.json');
  const registry = readCharacterRegistry(work);

  // Count spoken segments per character across all chapter scripts.
  const counts = new Map<string, number>();
  for (const file of fs.readdirSync(work.path('script')).sort()) {
    const script = work.readJson<ChapterScript>(`script/${file}`);
    for (const seg of script.segments) {
      if (seg.speaker !== 'narrator') {
        const key = seg.speakerId ?? seg.speaker;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  if (ranked.length === 0) {
    const casting: Casting = {
      version: 2,
      narrator: {
        voiceProfile: {
          presentation: analysis.author.sex === 'unknown' ? 'unknown' : analysis.author.sex,
          age: analysis.author.age,
          tone: ['measured', 'engaging'],
          language: 'unknown',
          accent: analysis.author.country,
        },
        instructions: 'Measured, engaging audiobook narrator.',
      },
      characters: {},
    };
    work.writeJson('casting.json', casting);
    reportProgress({ activity: 'Narrator profile saved; no character voices needed', phase: 'completed' });
    return casting;
  }

  const castDetails = ranked
    .map(([speakerId, count]) => {
      const c = registry.characters.find((ch) => ch.id === speakerId || ch.name === speakerId);
      const traits = c
        ? `${c.sex}, age ${c.age}, ${c.race}, ${c.class}, ${c.country}`
        : 'unknown traits';
      return `- key ${speakerId}: ${c?.name ?? speakerId} (${count} spoken segments): ${traits}`;
    })
    .join('\n');

  reportProgress({ activity: `Designing narrator and ${ranked.length} character voice profiles — waiting for model response` });
  const casting = await jsonCall({
    model: config.analysisModel,
    schema: CastingSchema,
    system: `You cast voices for a multi-voice audiobook. Respond with JSON:
{"version":2,"narrator":{"voiceProfile":{"presentation","age","tone","language","accent"},"instructions"},"characters":{"<name>":{"voiceProfile":{"presentation","age","tone","language","accent"},"instructions"}, ...}}

Rules:
- Do not select a provider, model, or voice ID. Describe the desired sound only.
- Give every speaker presentation, approximate age, a short tone list, language, accent, and standing delivery instructions. Use a BCP 47 primary language code for language (for example, "en", "fr", or "ja").
- Use "unknown" or "unspecified" where evidence is absent.
- The narrator's instructions describe steady audiobook narration. Character instructions differentiate age, accent, class, and personality.
- Every character listed must appear in "characters". Write instructions for every speaker.`,
    user: `Book summary: ${analysis.summary.slice(0, 600)}

Author: ${analysis.author.name} (${analysis.author.sex}, ${analysis.author.country})

Characters:
${castDetails}`,
  });

  reportProgress({ activity: 'Checking and saving voice profiles', phase: 'saving' });
  casting.version = 2;
  const normalizedCharacters: Casting['characters'] = {};
  for (const [speakerId] of ranked) {
    const c = registry.characters.find((ch) => ch.id === speakerId || ch.name === speakerId);
    const assignment = casting.characters[speakerId] ?? (c ? casting.characters[c.name] : undefined);
    if (!assignment) {
      normalizedCharacters[speakerId] = {
        voiceProfile: {
          presentation: c?.sex ?? 'unknown',
          age: c?.age ?? 'unknown',
          tone: [],
          language: 'unknown',
          accent: c?.country ?? 'unspecified',
        },
        instructions: '',
      };
    } else normalizedCharacters[speakerId] = assignment;
  }
  casting.characters = normalizedCharacters;
  if (fs.existsSync(work.path('manual-speaker-settings.json'))) {
    const manual = ManualSpeakerSettingsSchema.parse(work.readJson('manual-speaker-settings.json'));
    if (manual.instructions.narrator !== undefined) casting.narrator.instructions = manual.instructions.narrator;
    for (const [id, instructions] of Object.entries(manual.instructions)) if (casting.characters[id]) casting.characters[id].instructions = instructions;
  }

  work.writeJson('casting.json', casting);
  reportProgress({ activity: 'Voice profiles saved', phase: 'completed' });
  return casting;
}
