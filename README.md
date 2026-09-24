# Lisen EPUB Convertor

CLI and local web workspace for [lisentome.com](https://lisentome.com/): converts an EPUB into a multi-voice M4B audiobook. An LLM analyzes the book, attributes dialogue to characters, and describes each speaker's desired voice. A shared voice library supplies concrete voice assignments; ffmpeg assembles the result into a single `.m4b` with chapter markers, tags, and cover art. OpenAI and OpenRouter are supported for text processing and speech synthesis.

## Requirements

- Node 22.12+ (the current Commander dependency requires it, although `package.json` still declares Node 20+)
- ffmpeg + ffprobe on PATH (`brew install ffmpeg`)
- An API key for each configured provider: `OPENAI_API_KEY` and/or `OPENROUTER_API_KEY`. The CLI loads the first `.env` found in the current directory or project root.

## Usage

```bash
npm install
npm run dev -- convert book.epub --dry-run       # prepare scripts, casting, and voices
npm run dev -- convert book.epub                 # resume through paid TTS and assembly
npm run dev -- status book.epub                  # stage completion
npm run dev -- ui                               # local web workspace
```

`--dry-run` still makes billable LLM calls; it stops before TTS and assembly. Review `script/`, `casting.json`, and `voice-bindings.json` before continuing. `extract` and voice-library operations are offline. The bundled `library/voices.json` supports the default OpenAI target without a refresh.

Options for `convert`:

| Flag | Meaning |
| --- | --- |
| `--out <dir>` | Where the final `.m4b` goes (default `.`) |
| `--work <dir>` | Work directory for intermediate artifacts (default `./work`) |
| `--from <stage>` | Rebuild that stage and derived artifacts, then continue: extract, analyze, chapters, list-characters, script, casting, voices, synth, assemble |
| `--force` | Rebuild from extract and continue; retain the TTS audio cache |
| `--dry-run` | Stop before synthesis so scripts, casting, and voice bindings can be reviewed |

## Pipeline

```
EPUB → extract → analyze → chapters → list-characters → script → casting → voices → synth → assemble → book.m4b
```

1. **extract** — EPUB → one markdown file per chapter (`chapters/`), plus `metadata.json` and cover. Images become their alt text, links keep only their text, footnote markers are dropped.
2. **analyze** — sampled LLM overview: fiction detection, provisional book summary and character candidates, author profile, and a narrate/skip decision per chapter (ToC, acknowledgments, license pages etc. are skipped).
3. **chapters** — per-chapter summary, minimal audio-friendly cleanup (`chapters-clean/`), and speaking-character observations with evidence (`chapter-characters/`). Discovery reads every chunk of each narratable chapter, including late appearances and unnamed speakers.
4. **list-characters** — **List Characters** consolidates all narratable chapters into the book-specific `characters.json` registry. This offline stage merges exact names and unambiguous explicit aliases, preserves evidence and stable IDs, and flags uncertain identities or conflicting traits. Generic unnamed roles are scoped to their chapter.
5. **script** — dialogue attribution into `{speaker, text, delivery?, confidence}` segments (`script/`), with a verification pass on ambiguous speakers. Non-fiction uses the narrator. Fiction uses the character registry even when Analyze found no characters. Newly discovered or unresolved speakers are saved in `character-candidates/` for review rather than silently becoming narrator dialogue. Layout-only dividers are removed and non-breaking spaces normalized, including when existing chapter scripts are resumed.
6. **casting** — desired voice profile and delivery instructions per speaker (`casting.json`), independent of any TTS model.
7. **voices** — match the cast against the shared voice library and save concrete, reviewable provider/model/voice assignments in `voice-bindings.json`, including match reasons and limitations. Every scripted speaker must have a casting entry.
8. **synth** — validate voice bindings, split speakable text into requests, and cache completed MP3s by content hash in `audio-cache/`. Existing cache files are reused. Requests include a language guard to keep the narration in the book's language.
9. **assemble** — ffmpeg concat into per-chapter M4As, then a single `.m4b` with chapter markers, tags, and cover art.

Every stage records completion in `work/<book>/state.json`; re-running resumes where it left off. `chapters`, `script`, and `synth` track chapter completion; synthesis also reuses individual cached segments. Assembly reuses encoded chapter M4As. If the EPUB content changes, existing history and artifacts are preserved and further runs are blocked until an explicit Extract rebuild:

```bash
npm run dev -- run book.epub extract --rebuild
```

### Local workspace and individual stages

Run `npm run dev -- ui` and open `http://127.0.0.1:3188`. Use `--port`, `--work`, and `--out` to change the port, work root, and output directory. The server binds to localhost and runs one stage job at a time; provider requests originate from Node using the configured API keys.

The workspace shows the provisional book analysis, discovered characters and registry review issues, chapter readiness, and editable speaker instructions and voice assignments. Use the settings gear to choose an OpenAI or OpenRouter **text-processing** provider and a model for new Analyze, Chapters, List Characters, Script, and Casting jobs. The model field offers fuzzy-matched suggestions and one-click starred models. Select chapters, use **Run** to rerun a stage or **Rebuild all** to clear its derived output, and use **Cmd** to copy the corresponding CLI command. The stage activity panel retains start/completion events, retry warnings, and failures for the displayed job. Saving casting changes makes synthesis and assembly stale while preserving cached MP3s.

The model list lives in [`library/preferred-models.json`](library/preferred-models.json) and is re-read whenever the settings dialog opens, so it can be edited while the UI server is running:

```json
{
  "models": [
    { "provider": "openai", "model": "gpt-4.1", "starred": true },
    { "provider": "openrouter", "model": "anthropic/claude-sonnet-4", "starred": false }
  ]
}
```

Set `LISEN_PREFERRED_MODELS_FILE` to use a different list. The UI choice does not change `.env` or CLI defaults, and synthesis continues to use the provider/model saved in `voice-bindings.json`.

EPUBs remain at their original paths. A work folder with a missing source can still be inspected; open the source at its new path with the same filename slug to relink it. Renaming the EPUB changes the slug and selects a different work folder.

The CLI offers the same manual control:

```bash
npm run dev -- books --json
npm run dev -- status book.epub --json
npm run dev -- run book.epub list-characters  # after all narratable chapters
npm run dev -- run book.epub script --chapters 3,4
npm run dev -- run book.epub synth --chapters 3,4
npm run dev -- run book.epub assemble --chapters 3,4 --out output
npm run dev -- run book.epub script --chapters 3 --rerun
npm run dev -- run book.epub script --rebuild  # clear derived output and rerun script
```

`run` executes exactly one stage and checks prerequisites; it does not run missing earlier stages. `chapters`, `script`, `synth`, and `assemble` accept `--chapters` using zero-based EPUB chapter indexes (the UI displays chapter numbers starting at 1). Selected assembly creates a separate file such as `Book Title - chapters 3-4.m4b` and does not mark full-book assembly complete. `books`, `status`, and `run` support `--json`; stage code may still emit progress or warnings during `run --json`.

All stages report activity in the CLI and the UI’s Stage activity panel. Analyze and Casting show preparation, a waiting indicator during their single model request, and saving. Chapters and Script show text processed by block and completed chapter counts. Synth shows audio segments ready, including cache hits. Assembly shows encoded chapters, duration reads, joining, and M4B export; ffmpeg runs asynchronously so the UI stays responsive. Extract, List Characters, and Voices report local-work milestones and counts. Short local stages may finish between UI polls; their milestones remain in the activity log.

Long-running activities print elapsed-time updates every 10 seconds; the UI updates elapsed time while polling and uses an indeterminate bar when there is no measurable percentage. Percentages describe the current activity’s units, not time remaining or full-stage completion (for example, encoding can reach 100% before M4B export). UI progress tracks jobs started in that UI server; separate CLI runs are not attached to it.

List Characters requires all narratable chapters and does not accept `--chapters`. For an older work folder, run `chapters` without `--rerun` to backfill missing character observations while retaining cleaned text and summaries (billable LLM discovery for fiction), then run `list-characters`. Script regenerates chapter scripts when their registry hash changes. A changed registry also clears derived audio manifests and encoded M4As so assembly cannot reuse old speaker assignments; paid MP3 caches and exported books remain. If Script reports new speakers, the workspace failure panel offers **Ask LLM to propose speaker resolutions**. It preselects only evidence-backed matches or new roles in Character Review; inspect the proposal and save the registry to resume Script at the failed chapter. The manual fallback is to review `character-candidates/`, add supported identities or aliases to the corresponding `chapter-characters/` file, and rerun `list-characters --rerun`, then Script.

Without extra flags, completed stages and existing chapter output are reused. `--rerun` invalidates completion from that stage onward and clears the stage output needed to execute it again; downstream artifacts remain. `--rebuild` clears that stage's derived artifacts as well, but runs only the requested stage. It cannot be combined with `--chapters` or `--rerun`. Both preserve `audio-cache/`. Use a rebuild when upstream edits require regenerating downstream artifacts.

### Work directory

Each book gets `work/<book-slug>/` containing its intermediate artifacts and audio cache:

```
work/alice/
  state.json               # source hash, stage/chapter completion, synthesis input hash
  metadata.json  cover.jpg # from extract
  chapters/                # raw markdown, one file per chapter
  analysis.json            # fiction flag, summary, characters, narrate/skip
  chapters-clean/          # audio-friendly text
  chapter-summaries.json
  chapter-characters/      # per-chapter character observations and evidence
  characters.json          # consolidated book character registry
  character-candidates/    # unresolved Script speakers, when present
  script/                  # per-chapter {speaker, text, delivery?, confidence} segments
  casting.json             # speaker → desired voice profile + instructions
  casting.legacy.json      # backup if an old model-specific cast was migrated
  voice-bindings.json      # speaker → concrete library/provider/model/voice choice
  audio-cache/             # one mp3 per synthesized segment, keyed by hash
  audio/                   # per-chapter m4a + segment manifests
```

Text artifacts are inspectable JSON/markdown, so outputs can be reviewed or corrected before the next stage runs. The final M4B is written to `--out` using the book metadata title. Completed cache files are keyed by provider, model, native voice ID, delivery instructions, and speakable text; changing those inputs can incur new TTS charges. Rebuilds retain the cache and previously exported M4Bs; assembly overwrites a matching output filename.

## Configuration

Environment variables (see `src/config.ts` for defaults):

- `LISEN_ANALYSIS_MODEL` — model for whole-book analysis (default `gpt-4.1`)
- `LISEN_CHAPTER_MODEL` — model for per-chapter work (default `gpt-4.1-mini`)
- `LISEN_TTS_MODEL` — default TTS target (`gpt-4o-mini-tts` for OpenAI; `openai/gpt-4o-mini-tts-2025-12-15` for OpenRouter)
- `LISEN_LLM_PROVIDER` — text-processing provider: `openai` or `openrouter` (default `openai`)
- `LISEN_LLM_RESPONSE_TIMEOUT_MS` — maximum wait for each text-model response before retrying (default `120000`)
- `LISEN_LLM_MAX_RETRIES` — total attempts for a transient text-model failure, including the initial request (default `5`)
- `LISEN_LLM_RETRY_BASE_MS` — initial LLM retry delay; each retry doubles it (default `2000`)
- `LISEN_LLM_RETRY_MAX_MS` — maximum exponential LLM retry delay when OpenRouter supplies no `Retry-After` value (default `60000`)
- `LISEN_LLM_MAX_COMPLETION_TOKENS` — maximum tokens requested for each structured text-model response (default `4096`)
- `LISEN_PREFERRED_MODELS_FILE` — editable UI model list (default `./library/preferred-models.json`)
- `LISEN_TTS_PROVIDER` — TTS provider: `openai` or `openrouter` (default `openai`)
- `LISEN_OPENROUTER_BASE_URL` — OpenRouter API base URL (default `https://openrouter.ai/api/v1`)
- `LISEN_OPENROUTER_SITE_URL` — optional application URL sent to OpenRouter for attribution
- `LISEN_OPENROUTER_MAX_PRICE` — optional JSON price caps for OpenRouter text routing, in US dollars per million tokens; for example `{"prompt":0.10,"completion":0.40}`
- `LISEN_OPENROUTER_TRACE_FILE` — optional local JSONL trace of full OpenRouter LLM requests and raw responses; contains book text and generated prose, never API keys
- `LISEN_OPENROUTER_REASONING_EFFORT` — OpenRouter reasoning budget for text processing (default `none`; allowed: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`)
- `LISEN_TTS_MAX_CHARS` — maximum characters in one TTS request (default `4000`)
- `LISEN_TTS_VOICES_FILE` — JSON catalogue of voices for a non-OpenAI OpenRouter speech model
- `LISEN_VOICE_LIBRARY_FILE` — shared model and voice library path (default `./library/voices.json`, relative to the current directory)

Other tunables (concurrency, chunk sizes, voice slots, bitrate) are constants in `src/config.ts`.

### OpenRouter

OpenRouter can be used for text processing, speech synthesis, or both. Its text models must support JSON-mode responses because every LLM stage validates structured JSON. Use OpenRouter model slugs for all model variables, for example:

```env
OPENROUTER_API_KEY=sk-or-...
LISEN_LLM_PROVIDER=openrouter
LISEN_ANALYSIS_MODEL=anthropic/claude-sonnet-4
LISEN_CHAPTER_MODEL=google/gemini-2.5-flash
# Never route an LLM request above these per-million-token prices:
LISEN_OPENROUTER_MAX_PRICE={"prompt":0.10,"completion":0.40}
LISEN_TTS_PROVIDER=openrouter
LISEN_TTS_MODEL=openai/gpt-4o-mini-tts-2025-12-15
```

For OpenRouter's OpenAI speech models, `voices refresh` can create a separate library from Lisen's built-in OpenAI catalogue. The bundled library does not include OpenRouter targets:

```bash
# With the OpenRouter environment above:
npm run dev -- voices refresh --library ./library/openrouter-voices.json
# Set LISEN_VOICE_LIBRARY_FILE=./library/openrouter-voices.json for subsequent runs.
```

Other speech models have model-specific voice IDs. Add their model and compatible voices to the configured shared library, or create a legacy catalogue such as `my-model-voices.json` and point `LISEN_TTS_VOICES_FILE` at it (the legacy file takes precedence):

```json
[
  { "id": "voice-a", "sex": "female", "description": "warm adult female" },
  { "id": "voice-b", "sex": "male", "description": "calm adult male" }
]
```

The catalogue must be a non-empty array with unique IDs. Consult the selected OpenRouter model's documentation for valid voice IDs and its text-length limit; set `LISEN_TTS_MAX_CHARS` when that limit is below 4000. For OpenAI speech models routed through OpenRouter, Lisen forwards narration and delivery instructions. Other models receive the standard text-and-voice request only, since style controls are provider-specific.

To add a direct TTS provider, implement `TTSProvider` (`src/providers/tts/types.ts`) and register it in `getTTSProvider()` (`src/providers/tts/openai.ts`).

### Voice library and casting

The bundled `library/voices.json` is a version-2 catalogue containing OpenAI and Fish model/voice metadata. Both version 1 (`maxChars`) and version 2 (`inputLimits`, including unknown limits) support listing and applying bindings. **Fish bindings can be reviewed, but Fish synthesis is not implemented.** `LISEN_TTS_PROVIDER` accepts only `openai` or `openrouter`.

Use the bundled library directly:

```bash
npm run dev -- voices list
npm run dev -- voices apply book.epub
```

`voices apply` accepts `--provider`, `--model`, `--library`, and `--work`. Specify `--model` when selecting a different provider. Synthesis uses the target saved in `voice-bindings.json`; changing environment defaults alone does not rebind a book. Keep the configured TTS provider aligned with the chosen target for CLI API-key checks.

Refresh and legacy-array import write version-1 libraries; they refuse to overwrite a version-2 library. Choose a separate file:

```bash
npm run dev -- voices refresh --provider openai --model gpt-4o-mini-tts --library ./library/custom-voices.json
npm run dev -- voices import ./my-model-voices.json --provider openrouter --model provider/model --library ./library/imported-voices.json
```

`casting.json` records each character's desired presentation, age, tone, language, accent, and delivery instructions. `voice-bindings.json` records the provider, model, native voice ID, and library path. Automatic matches score presentation, age, tone, accent, and voice reuse, and record limitations when traits are unknown or do not match. Manual assignments are retained when compatible; incompatible manual bindings produce an error so they can be updated explicitly. Legacy casts are backed up as `casting.legacy.json` before migration.

## Development

```bash
npm run dev -- <args>   # run the CLI from source (tsx)
npm run build           # compile to dist/
npm test                # vitest, fully offline
npm run test:watch      # offline tests in watch mode
```

The `lisen` executable points to `dist/cli.js`; build before using an installed or linked binary. Tests cover EPUB/markdown parsing, text and script cleanup, provider requests with mocks, voice libraries and migration, state tracking, retry events, and UI activity rendering. No live LLM or TTS requests are made by the test suite.

See [AGENTS.md](AGENTS.md) for a code map and contributor conventions.
