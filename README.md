# Lisen EPUB Convertor

Backend CLI for [lisentome.com](https://lisentome.com/): converts an EPUB into a multi-voice M4B audiobook. An LLM analyzes the book, attributes dialogue to characters, and casts a distinct TTS voice per major character; ffmpeg assembles the result into a single `.m4b` with chapter markers, tags, and cover art.

## Requirements

- Node 20+
- ffmpeg + ffprobe on PATH (`brew install ffmpeg`)
- An API key for each configured provider: `OPENAI_API_KEY` and/or `OPENROUTER_API_KEY` (a `.env` file in the project root is loaded automatically)

## Usage

```bash
npm install
npm run dev -- convert book.epub                # full pipeline
npm run dev -- convert book.epub --dry-run      # everything except TTS spend
npm run dev -- status book.epub                 # stage completion
```

Options for `convert`:

| Flag | Meaning |
| --- | --- |
| `--out <dir>` | Where the final `.m4b` goes (default `.`) |
| `--work <dir>` | Work directory for intermediate artifacts (default `./work`) |
| `--from <stage>` | Re-run from a stage: extract, analyze, chapters, script, casting, synth, assemble |
| `--force` | Re-run everything from scratch |
| `--dry-run` | Stop before synthesis so `script/` and `casting.json` can be reviewed |

## Pipeline

```
EPUB → extract → analyze → chapters → script → casting → synth → assemble → book.m4b
```

1. **extract** — EPUB → one markdown file per chapter (`chapters/`), plus `metadata.json` and cover. Images become their alt text, links keep only their text, footnote markers are dropped.
2. **analyze** — LLM pass: fiction detection, book summary, character/author profiles, and a narrate/skip decision per chapter (ToC, acknowledgments, license pages etc. are skipped).
3. **chapters** — per-chapter summary + minimal audio-friendly cleanup (`chapters-clean/`).
4. **script** — dialogue attribution into `{speaker, text, delivery}` segments (`script/`), with a verification pass on low-confidence lines. Non-fiction is all narrator.
5. **casting** — voice per speaker (`casting.json`). The most talkative characters get distinct voices; minor ones share voices differentiated by delivery instructions. **Hand-edit this file before synthesis if you want different voices.**
6. **synth** — TTS per segment, cached by content hash in `audio-cache/` — crashes and re-runs never pay for the same audio twice.
7. **assemble** — ffmpeg concat into per-chapter M4As, then a single `.m4b` with chapter markers, tags, and cover art.

Every stage records completion in `work/<book>/state.json`; re-running resumes where it left off. Stages 3, 4, and 6 also resume mid-stage (per chapter / per segment). If the EPUB file itself changes, the stage state is cleared automatically.

### Work directory

Each book gets `work/<book-slug>/` containing everything the pipeline produces:

```
work/alice/
  state.json               # stage-completion manifest
  metadata.json  cover.jpg # from extract
  chapters/                # raw markdown, one file per chapter
  analysis.json            # fiction flag, summary, characters, narrate/skip
  chapters-clean/          # audio-friendly text
  chapter-summaries.json
  script/                  # per-chapter {speaker, text, delivery} segments
  casting.json             # speaker → voice + instructions (hand-editable)
  audio-cache/             # one mp3 per synthesized segment, keyed by hash
  audio/                   # per-chapter m4a + segment manifests
```

All of it is inspectable JSON/markdown, so any stage's output can be reviewed (or corrected) before the next stage runs.

## Configuration

Environment variables (see `src/config.ts` for defaults):

- `LISEN_ANALYSIS_MODEL` — model for whole-book analysis (default `gpt-4.1`)
- `LISEN_CHAPTER_MODEL` — model for per-chapter work (default `gpt-4.1-mini`)
- `LISEN_TTS_MODEL` — TTS model (default `gpt-4o-mini-tts`)
- `LISEN_LLM_PROVIDER` — text-processing provider: `openai` or `openrouter` (default `openai`)
- `LISEN_TTS_PROVIDER` — TTS provider: `openai` or `openrouter` (default `openai`)
- `LISEN_OPENROUTER_BASE_URL` — OpenRouter API base URL (default `https://openrouter.ai/api/v1`)
- `LISEN_OPENROUTER_SITE_URL` — optional application URL sent to OpenRouter for attribution
- `LISEN_TTS_MAX_CHARS` — maximum characters in one TTS request (default `4000`)
- `LISEN_TTS_VOICES_FILE` — JSON catalogue of voices for a non-OpenAI OpenRouter speech model

Other tunables (concurrency, chunk sizes, voice slots, bitrate) are constants in `src/config.ts`.

### OpenRouter

OpenRouter can be used for text processing, speech synthesis, or both. Its text models must support JSON-mode responses because every LLM stage validates structured JSON. Use OpenRouter model slugs for all model variables, for example:

```env
OPENROUTER_API_KEY=sk-or-...
LISEN_LLM_PROVIDER=openrouter
LISEN_ANALYSIS_MODEL=anthropic/claude-sonnet-4
LISEN_CHAPTER_MODEL=google/gemini-2.5-flash
LISEN_TTS_PROVIDER=openrouter
LISEN_TTS_MODEL=openai/gpt-4o-mini-tts-2025-12-15
```

OpenRouter's OpenAI speech models use Lisen's built-in OpenAI voice catalogue. Other speech models have model-specific voice IDs, so create a catalogue such as `voices.json` and point `LISEN_TTS_VOICES_FILE` at it:

```json
[
  { "id": "voice-a", "sex": "female", "description": "warm adult female" },
  { "id": "voice-b", "sex": "male", "description": "calm adult male" }
]
```

The catalogue must be a non-empty array with unique IDs. Consult the selected OpenRouter model's documentation for valid voice IDs and its text-length limit; set `LISEN_TTS_MAX_CHARS` when that limit is below 4000. For OpenAI speech models routed through OpenRouter, Lisen forwards narration and delivery instructions. Other models receive the standard text-and-voice request only, since style controls are provider-specific.

To add a direct TTS provider, implement `TTSProvider` (`src/providers/tts/types.ts`) and register it in `getTTSProvider()` (`src/providers/tts/openai.ts`).

## Development

```bash
npm run dev -- <args>   # run the CLI from source (tsx)
npm run build           # compile to dist/
npm test                # vitest, fully offline
```

See [AGENTS.md](AGENTS.md) for a code map and contributor conventions.
