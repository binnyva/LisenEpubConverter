import fs from 'node:fs';
import { jsonCall } from '../providers/llm/openai.js';
import { getTTSProvider } from '../providers/tts/openai.js';
import { config } from '../config.js';
import { CastingSchema, type Analysis, type Casting, type ChapterScript } from '../types.js';
import type { WorkDir } from '../state.js';

/**
 * Stage 5: assign a voice to the narrator and every speaking character.
 * The most talkative characters get distinct voices; the rest reuse voices,
 * differentiated by delivery instructions. Output (casting.json) is meant to
 * be hand-editable before synthesis.
 */
export async function runCasting(work: WorkDir): Promise<Casting> {
  const analysis = work.readJson<Analysis>('analysis.json');
  const provider = getTTSProvider();
  const voices = provider.listVoices();

  // Count spoken segments per character across all chapter scripts.
  const counts = new Map<string, number>();
  for (const file of fs.readdirSync(work.path('script')).sort()) {
    const script = work.readJson<ChapterScript>(`script/${file}`);
    for (const seg of script.segments) {
      if (seg.speaker !== 'narrator') {
        counts.set(seg.speaker, (counts.get(seg.speaker) ?? 0) + 1);
      }
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  if (ranked.length === 0) {
    // Non-fiction or no dialogue: narrator only, matched to the author.
    const narratorVoice =
      voices.find((v) => v.sex === (analysis.author.sex === 'female' ? 'female' : 'male')) ??
      voices[0];
    const casting: Casting = {
      narrator: { voiceId: narratorVoice.id, instructions: 'Measured, engaging audiobook narrator.' },
      characters: {},
    };
    work.writeJson('casting.json', casting);
    return casting;
  }

  const voiceCatalog = voices.map((v) => `- ${v.id}: ${v.sex}, ${v.description}`).join('\n');
  const castDetails = ranked
    .map(([name, count]) => {
      const c = analysis.characters.find((ch) => ch.name === name);
      const traits = c
        ? `${c.sex}, age ${c.age}, ${c.race}, ${c.class}, ${c.country}`
        : 'unknown traits';
      return `- ${name} (${count} spoken segments): ${traits}`;
    })
    .join('\n');

  const casting = await jsonCall({
    model: config.analysisModel,
    schema: CastingSchema,
    system: `You cast voices for a multi-voice audiobook. Respond with JSON:
{"narrator": {"voiceId", "instructions"}, "characters": {"<name>": {"voiceId", "instructions"}, ...}}

Rules:
- Use ONLY voiceIds from the voice catalog.
- Assign the narrator a voice suited to the book's tone and the author's profile; its instructions describe a steady audiobook narration style.
- The top ${config.distinctVoiceSlots} characters by spoken segments each get a DIFFERENT voice (also different from the narrator's), matched to their sex and age.
- Remaining characters REUSE voices (never the narrator's); differentiate them with "instructions" describing age, accent, class and personality, e.g. "Elderly Scottish fisherman, gruff and slow."
- Every character listed must appear in "characters". Write instructions for every speaker.`,
    user: `Book summary: ${analysis.summary.slice(0, 600)}

Author: ${analysis.author.name} (${analysis.author.sex}, ${analysis.author.country})

Voice catalog:
${voiceCatalog}

Characters:
${castDetails}`,
  });

  // Validate voice ids; fall back deterministically on anything invalid.
  const validIds = new Set(voices.map((v) => v.id));
  if (!validIds.has(casting.narrator.voiceId)) casting.narrator.voiceId = voices[0].id;
  for (const [name] of ranked) {
    const assignment = casting.characters[name];
    if (!assignment || !validIds.has(assignment.voiceId)) {
      const c = analysis.characters.find((ch) => ch.name === name);
      const pool = voices.filter(
        (v) => v.id !== casting.narrator.voiceId && (c?.sex === 'unknown' || v.sex === c?.sex || v.sex === 'neutral')
      );
      casting.characters[name] = {
        voiceId: (pool[0] ?? voices[0]).id,
        instructions: assignment?.instructions ?? '',
      };
    }
  }

  work.writeJson('casting.json', casting);
  return casting;
}
