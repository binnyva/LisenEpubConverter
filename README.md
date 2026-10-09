# Lisen Document Convertor

CLI and local web workspace for [lisentome.com](https://lisentome.com/): converts an EPUB, text PDF, HTML, Markdown, plain-text document, or HTML page URL into a multi-voice M4B audiobook. A local BookNLP pipeline identifies entities, links coreference, and attributes quotations across the whole book. LLM use remains limited to book analysis and voice casting; deterministic converters preserve the exact prepared source text. A shared voice library supplies concrete voice assignments, TTS produces cached audio, and ffmpeg assembles the result.

## Requirements

- Node 22.12+
- ffmpeg + ffprobe on PATH (`brew install ffmpeg`)
- Conda environment `booknlp` containing BookNLP, `en_core_web_sm`, and the selected local model files. The default Conda executable is `/Users/binnyva/Projects/Tools/MiniConda3/bin/conda`.
- An API key only for a stage that uses a configured provider: Analyze/Casting use the LLM key and Synth uses the provider saved in `voice-bindings.json`.

Lisen never installs Python packages or downloads BookNLP models. Missing dependencies produce an actionable error. BookNLP 1.0.8's published weights contain obsolete BERT `position_ids` entries; the repository runner removes only those entries in memory while loading, following the upstream compatibility fix, without modifying the environment or model files.

## Usage

```bash
npm install
npm run dev -- convert story.md --dry-run         # prepare scripts, casting, and voices
npm run dev -- convert story.txt --dry-run        # plain text is supported directly
npm run dev -- convert story.pdf                  # resume through paid TTS and assembly
npm run dev -- status story.html                  # stage completion
npm run dev -- convert https://example.com/story  # download HTML, then convert
npm run dev -- ui                               # local web workspace
```

`--dry-run` still makes the billable Analyze and Casting LLM calls; it stops before TTS and assembly. BookNLP, extraction, deterministic preparation/script conversion, and voice-library operations are local/offline. Review unresolved quotations, `script/`, `casting.json`, and `voice-bindings.json` before continuing.

Options for `convert`:

| Flag | Meaning |
| --- | --- |
| `--out <dir>` | Export the final `.m4b` to a different directory (by default it is saved in that book's work folder) |
| `--work <dir>` | Work directory for intermediate artifacts (default `./work`) |
| `--from <stage>` | Rebuild that stage and derived artifacts, then continue: extract, analyze, chapters, booknlp, list-characters, script, casting, voices, synth, assemble |
| `--force` | Rebuild from extract and continue; retain the TTS audio cache |
| `--dry-run` | Stop before synthesis so scripts, casting, and voice bindings can be reviewed |

## Pipeline

```
Source document → extract → analyze → chapters → booknlp → list-characters → script → casting → voices → synth → assemble → book.m4b
```

1. **extract** — every source reader produces Unicode-preserving plain text in `chapters/`, with titles/order/metadata/cover stored separately. Markdown is parsed structurally rather than stripped with broad expressions.
2. **analyze** — one sampled LLM overview and a reviewable narrate/skip plan. Structural chapter evidence takes precedence over broad title keywords.
3. **chapters** — deterministic normalization into frozen `chapters-clean/*.txt`; no chapter rewriting or mandatory summaries.
4. **booknlp** — assemble all narratable chapters into `booknlp/input.txt`, record exact Unicode code-point boundaries in `chapter-map.json`, run `entity,quote,coref` once for the complete book, preserve raw outputs, and publish validated `annotations.json` atomically.
5. **list-characters** — build `characters.json` from every attributed entity, including minor, unnamed, duplicate-name, and nonhuman speakers. Application IDs remain stable where evidence reconciles unambiguously; inferred pronouns stay separate from presentation traits.
6. **script** — deterministically interleave quotation spans and surrounding narrator prose, slice exact wording from frozen input, map back to chapters, and validate complete ordered coverage. Unresolved/cross-chapter quotations are saved for manual review without an LLM fallback.
7. **casting** — LLM-generated desired voice profiles keyed by stable speaker ID.
8. **voices** — bind the cast to provider/model/native voices. Compatible manual choices are persisted separately and reapplied.
9. **synth** — block affected unresolved quotations, split plain text with Unicode-safe bounds, deduplicate identical in-flight requests, and retain repeated occurrences in ordered, fingerprinted manifests.
10. **assemble** — use exactly the current narration plan in numeric chapter order. Encoded M4As are reused only when manifest and encoding fingerprints match; final M4Bs are published atomically.

Every stage records completion in `work/<book>/state.json`; `chapters`, `script`, and `synth` track the exact narration plan by chapter. Assembly reuses an encoded chapter only when its manifest and encoding sidecar fingerprints match. Stale files outside the current plan are ignored. If source content changes, runs are blocked until an explicit Extract rebuild:

```bash
npm run dev -- run story.pdf extract --rebuild
```

### Local workspace and individual stages

Run `npm run dev -- ui` and open `http://127.0.0.1:3188`. Use `--port` and `--work` to change the port and work root. Finished M4Bs are saved in each book's work folder; pass `--out` only to export them elsewhere. The server binds to localhost and runs one stage job at a time; provider requests originate from Node using the configured API keys.

The workspace shows the provisional analysis, editable narrate/skip plan, BookNLP-derived speakers, unresolved quotations with speaker selectors, chapter readiness, and editable speaker instructions and voice assignments. Text-provider settings affect Analyze and Casting only; BookNLP and Script need no API key. Select chapters, use **Run** or **Rebuild all**, and use **Cmd** to copy the equivalent CLI command. Saving corrections regenerates scripts without rerunning BookNLP; paid MP3 cache files are retained.

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

Source files remain at their original paths. New work folders are named from the document title (or a supplied `--title` override), not from the source filename or URL. If two works have the same title, the later folder receives a numeric suffix. A work folder with a missing source can still be inspected; open the source at its new path to relink it. Existing folders retain their original names.

The CLI offers the same manual control:

```bash
npm run dev -- books --json
npm run dev -- status story.md --json
npm run dev -- run story.md list-characters  # after all narratable chapters
npm run dev -- run story.md script --chapters 0
npm run dev -- run story.md synth --chapters 0
npm run dev -- run story.md assemble --chapters 0
npm run dev -- run story.md script --chapters 0 --rerun
npm run dev -- run story.md script --rebuild  # clear derived output and rerun script
```

`run` executes exactly one stage and checks prerequisites; it does not run missing earlier stages. `chapters`, `script`, `synth`, and `assemble` accept zero-based chapter indexes (the UI displays chapter numbers starting at 1). Standalone stories have chapter `0`. Selected assembly creates a separate file such as `Book Title - chapters 0.m4b` and does not mark full-book assembly complete. `books`, `status`, and `run` support `--json`; stage code may still emit progress or warnings during `run --json`.

Supported sources are `http://` or `https://` HTML URLs plus `.epub`, `.pdf`, `.html`, `.htm`, `.md`, `.markdown`, and `.txt` files. A URL is downloaded when a new work folder needs its title, and Extract downloads it again to save the source content; run `extract --rebuild` to download a fresh copy. URL imports accept HTML or text responses up to 10 MB. Use `--title`, `--author`, and `--language` to correct source metadata. Text PDFs are supported; scanned or image-only PDFs need OCR first.

All stages report activity in the CLI and the UI’s Stage activity panel. Analyze and Casting show preparation, a waiting indicator during their single model request, and saving. Chapters and Script show text processed by block and completed chapter counts. Synth shows audio segments ready, including cache hits. Assembly shows encoded chapters, duration reads, joining, and M4B export; ffmpeg runs asynchronously so the UI stays responsive. Extract, List Characters, and Voices report local-work milestones and counts. Short local stages may finish between UI polls; their milestones remain in the activity log.

Long-running activities print elapsed-time updates every 10 seconds; the UI updates elapsed time while polling and uses an indeterminate bar when there is no measurable percentage. Percentages describe the current activity’s units, not time remaining or full-stage completion (for example, encoding can reach 100% before M4B export). UI progress tracks jobs started in that UI server; separate CLI runs are not attached to it.

BookNLP and List Characters are whole-book stages and do not accept `--chapters`; Script can regenerate selected chapters from the whole-book annotations. Resolve entries in `unresolved-quotes.json` through the workspace (or `corrections.json`) and rerun Script—BookNLP does not need to rerun. Synthesis blocks only selections affected by unresolved quotations. Existing name-keyed casts/bindings are migrated to stable IDs when the match is unambiguous; legacy manifests without provenance must be regenerated, reusing paid MP3 cache entries where their request hashes still match.

For a workspace created before canonical plain-text/BookNLP support, rebuild from Extract so old Markdown-derived offsets cannot be reused:

```bash
npm run dev -- convert old-book.epub --from extract --dry-run
```

This retains `audio-cache/`, prior exported books, `corrections.json`, and compatible manual speaker settings, but it reruns Analyze and Casting and therefore makes billable LLM calls. Fix the BookNLP Conda environment and install the selected model files explicitly before migrating; Lisen never modifies that environment for you.

Without extra flags, completed stages and existing chapter output are reused. `--rerun` invalidates completion from that stage onward and clears the stage output needed to execute it again; downstream artifacts remain. `--rebuild` clears that stage's derived artifacts as well, but runs only the requested stage. It cannot be combined with `--chapters` or `--rerun`. Both preserve `audio-cache/`. Use a rebuild when upstream edits require regenerating downstream artifacts.

### Work directory

Each book gets `work/<book-slug>/` containing its intermediate artifacts and audio cache:

```
work/alice/
  state.json               # source hash, completion, and synthesis input hash
  metadata.json  cover.jpg # from extract
  chapters/                # canonical plain text, one file per chapter
  analysis.json            # fiction flag, summary, characters, narrate/skip
  chapters-clean/          # frozen normalized plain text
  booknlp/input.txt        # exact whole-book annotation input
  booknlp/chapter-map.json # Unicode code-point chapter boundaries
  booknlp/output/          # raw BookNLP inspection files
  booknlp/annotations.json # validated normalized annotations
  corrections.json        # persistent character and quotation corrections
  unresolved-quotes.json  # manual review queue
  characters.json         # stable-ID speaker registry
  script/                  # exact-source segments and fingerprints
  casting.json             # speaker → desired voice profile + instructions
  casting.legacy.json      # backup if an old model-specific cast was migrated
  voice-bindings.json      # speaker → concrete library/provider/model/voice choice
  manual-speaker-settings.json # persistent instructions/manual bindings
  audio-cache/             # one mp3 per synthesized segment, keyed by hash
  audio/                   # per-chapter m4a + segment manifests
  Book Title.m4b           # assembled audiobook
```

Text artifacts are inspectable JSON/plain text. Generated artifacts can be rebuilt; corrections and manual speaker settings live separately and are reapplied when compatible. The final M4B is published atomically. Completed cache files keep the existing provider/model/native-voice/instructions/text key convention; the request-only language guard remains excluded.

## Configuration

Environment variables (see `src/config.ts` for defaults):

- `LISEN_ANALYSIS_MODEL` — model for whole-book analysis (default `gpt-4.1`)
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
- `LISEN_CONDA_EXECUTABLE` — Conda executable (default `/Users/binnyva/Projects/Tools/MiniConda3/bin/conda`)
- `LISEN_BOOKNLP_ENV` — Conda environment name (default `booknlp`)
- `LISEN_BOOKNLP_MODEL` — `big` (default) or `small`
- `LISEN_BOOKNLP_TIMEOUT_MS` — whole-book subprocess timeout (default one hour)

Other tunables (concurrency, chunk sizes, voice slots, bitrate) are constants in `src/config.ts`.

### OpenRouter

OpenRouter can be used for text processing, speech synthesis, or both. Its text models must support JSON-mode responses because every LLM stage validates structured JSON. Use OpenRouter model slugs for all model variables, for example:

```env
OPENROUTER_API_KEY=sk-or-...
LISEN_LLM_PROVIDER=openrouter
LISEN_ANALYSIS_MODEL=anthropic/claude-sonnet-4
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

The `lisen` executable points to `dist/cli.js`; build before using an installed or linked binary. Tests cover plain-text extraction, Unicode offset recovery, deterministic quotation conversion and coverage, stable identity reconciliation/corrections, TTS deduplication/failure settling, workspace locks, authoritative assembly, atomic publication, providers, voices, state, and UI rendering. No live LLM or TTS requests are made by the suite.

See [AGENTS.md](AGENTS.md) for a code map and contributor conventions.
