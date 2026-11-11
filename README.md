# Lisen Document Convertor

CLI and local web workspace for [lisentome.com](https://lisentome.com/): converts an EPUB, text PDF, HTML, Markdown document, or an HTML page URL into a multi-voice M4B audiobook. An LLM profiles the book, attributes dialogue to characters in a single pass over the text, and describes each speaker's desired voice. A shared voice library supplies concrete voice assignments; ffmpeg assembles the result into a single `.m4b` with chapter markers, tags, and cover art. OpenAI and OpenRouter are supported for text processing and speech synthesis.

## Requirements

- Node 22.12+ (the current Commander dependency requires it, although `package.json` still declares Node 20+)
- ffmpeg + ffprobe on PATH (`brew install ffmpeg`)
- An API key for each configured provider: `OPENAI_API_KEY` and/or `OPENROUTER_API_KEY`. The CLI loads the first `.env` found in the current directory or project root.

## Usage

```bash
npm install
npm run dev -- convert story.md --dry-run         # prepare scripts, casting, and voices
npm run dev -- convert story.pdf                  # resume through paid TTS and assembly
npm run dev -- status story.html                  # stage completion
npm run dev -- convert https://example.com/story  # download HTML, then convert
npm run dev -- ui                               # local web workspace
```

`--dry-run` still makes billable LLM calls; it stops after Voices, before TTS and assembly. Review `1-scripts/`, `characters.json`, `casting.json`, and `voice-bindings.json` before continuing. `extract` and voice-library operations are offline. The bundled `library/voices.json` supports the default OpenAI target without a refresh.

Options for `convert`:

| Flag | Meaning |
| --- | --- |
| `--out <dir>` | Export the final `.m4b` to a different directory (by default it is saved in that book's work folder) |
| `--work <dir>` | Work directory for intermediate artifacts (default `./work`) |
| `--from <stage>` | Rebuild that stage and derived artifacts, then continue: extract, metadata, script, casting, voices, synth, assemble |
| `--force` | Rebuild from extract and continue; retain the TTS audio cache |
| `--dry-run` | Stop before synthesis so scripts, casting, and voice bindings can be reviewed |
| `--collection` | Treat the source as a short story collection: characters are scoped per story |
| `--no-collection` | Treat the source as one continuous work, overriding detection |

## Pipeline

```
Source document → extract → metadata → script → casting → voices → synth → assemble → book.m4b
```

The text is read by a model once, in Script, and for quoted dialogue the model returns labels rather than prose.

1. **extract** — source document → one markdown file per chapter (`0-chapters/`), plus `metadata.json` and an EPUB cover when available. HTML becomes audio-friendly Markdown; Markdown is preserved; a standalone PDF/HTML/Markdown story becomes one chapter. The source's subjects and description (often the publisher's blurb) are kept for Metadata.
2. **metadata** — one LLM call that profiles the book without reading it: it is sent the source metadata, each chapter's title, word count and first 150 words, and about 1,500 words from the first body chapter. It returns whether the model recognises the book, an author profile, fiction or not, the form and genres, the narrator's point of view, the dialogue style, a cleaned title and narrate/skip decision per chapter (ToC, acknowledgments, copyright pages etc. are skipped), and the story grouping of a collection. The result is saved as `profile` in `metadata.json`, and the grouping in `stories.json`. A summary is only kept from the model's memory when it recognised the book; otherwise it is the source's blurb or empty, and nothing downstream depends on it. The dialogue style is checked against the whole text: a book is treated as `quoted` only when it actually carries double quotation marks.
3. **script** — one LLM call per chunk does cleanup, speaker attribution and character discovery together, writing `{speaker, text, delivery?, confidence}` segments to `1-scripts/` and the running cast to `characters.json`.
   - The chapter is split in code into numbered spans: narration, quoted speech, and the dialogue tags between quotes. For quoted dialogue the model returns a speaker label for each quoted span, a list of small `{find, replace}` corrections, and a record for any speaker the cast lacks. It never returns the text.
   - A chunk with no quotation marks and no cleanup trigger (attached footnote digits, bracketed numbers, common abbreviations and units, unusual symbols) makes no call at all. This can miss a scanning error in otherwise clean prose.
   - A book whose dialogue is not in double quotation marks (dashes, single quotes, or unmarked) falls back to the model returning the text as segments, checked word for word against the source. Non-fiction is all narrator and is only sent for corrections.
   - The cast is discovered as the book is read, so the chapters of a story run in order; separate stories run in parallel. A short name met early is folded offline into the full name a later chapter gives, and the saved scripts are renamed without a model. Uncertain merges are recorded as issues, not guessed.
   - One verification pass covers low-confidence labels and speakers missing from the cast. A speaker still unresolved is saved under `unresolved` in `characters.json` and stops the stage; it is never given to the narrator.
   - A scene-break divider (`• • •`, `* * *`, `<hr>`) becomes a pause segment (`kind: "pause"`), shown to the model only as `[scene break]`.
4. **casting** — desired voice profile and delivery instructions per speaker (`casting.json`), independent of any TTS model: one request for the book's single narrator, then one per story. The narrator's voice follows a first-person narrator's sex first and the author profile second.
5. **voices** — match the cast against the shared voice library and save concrete, reviewable provider/model/voice assignments in `voice-bindings.json`, including match reasons and limitations. Every scripted speaker must have a casting entry. Voices are allocated per story: characters in one story avoid sharing a voice, while separate stories reuse the catalogue freely.
6. **synth** — validate voice bindings, split speakable text into requests, and cache completed MP3s by content hash in `2-audio-cache/`. Existing cache files are reused. Requests include a language guard to keep the narration in the book's language. Pause segments make no request and cost nothing: they are recorded in the chapter manifest as `{"pauseMs": 2000}`.
7. **assemble** — ffmpeg concatenates each chapter's cached segments and encodes them once to an M4A in `3-audio/`, then stream-copies the chapters into a single `.m4b` with chapter markers, tags, and cover art. Each distinct pause length is encoded once as silence matching the synthesized audio's sample rate and channels. Scene-break silence is 2 seconds; set `LISEN_SCENE_BREAK_PAUSE_MS` before Script to change it.

Every stage records completion in `work/<book>/state.json`; re-running resumes where it left off. `script` and `synth` track chapter completion; Script also checkpoints each finished chunk, and synthesis reuses individual cached segments. Assembly reuses encoded chapter M4As. If the source content changes, existing history and artifacts are preserved and further runs are blocked until an explicit Extract rebuild:

```bash
npm run dev -- run story.pdf extract --rebuild
```

A work folder made by an earlier version of the pipeline cannot be continued. Opening one fails with a message asking for the same Extract rebuild (or `convert --force`), and until then nothing in the folder is read or changed. The rebuild writes the current layout beside the old files and leaves the old audio where it is.

### Usage log

Each stage prints what it cost when it finishes — LLM calls, prompt, completion and reasoning tokens, TTS requests, and wall time — and appends the same record to `usage.json` in the work folder. `convert` prints a per-stage table and a total at the end, and the workspace shows the totals per stage. Failed and cancelled runs are logged too, because they were paid for. The log survives every rebuild, so books and stages can be compared with real numbers.

### Local workspace and individual stages

Run `npm run dev -- ui` and open `http://127.0.0.1:3188`. Use `--port` and `--work` to change the port and work root. Finished M4Bs are saved in each book's work folder; pass `--out` only to export them elsewhere. The server binds to localhost and runs one stage job at a time; provider requests originate from Node using the configured API keys.

The workspace shows the book profile from Metadata, the story grouping, the running cast with its review issues and unresolved speakers, chapter readiness, editable speaker instructions and voice assignments, and usage per stage. Use the settings gear to choose an OpenAI or OpenRouter **text-processing** provider and a model for new Metadata and Casting jobs and for Script's cleanup and verification. Script's per-chunk call can use a separate model; leave it blank to use the selected text model. Enable Script reasoning with the toggle and choose an effort when using a compatible model. The toggle is disabled for non-fiction books. The model field offers fuzzy-matched suggestions and one-click starred models. Select chapters, use **Run** to rerun a stage or **Rebuild all** to clear its derived output first, and **Cmd** to see the equivalent command.

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
npm run dev -- run story.md metadata
npm run dev -- run story.md script --chapters 0
npm run dev -- run anthology.epub script --story 2   # that story's chapters
npm run dev -- run story.md synth --chapters 0
npm run dev -- run story.md assemble --chapters 0
npm run dev -- run story.md script --chapters 0 --rerun
npm run dev -- run story.md script --rebuild  # clear derived output and rerun script
```

`run` executes exactly one stage and checks prerequisites; it does not run missing earlier stages. `script`, `synth`, and `assemble` accept zero-based chapter indexes (the UI displays chapter numbers starting at 1). `--story` selects by 1-based story number from `stories.json` instead, and cannot be combined with `--chapters`. Standalone stories have chapter `0`. Selected assembly creates a separate file such as `Book Title - chapters 0.m4b` and does not mark full-book assembly complete. `books`, `status`, and `run` support `--json`; stage code may still emit progress or warnings during `run --json`.

Supported sources are `http://` or `https://` HTML URLs plus `.epub`, `.pdf`, `.html`, `.htm`, `.md`, and `.markdown` files. A URL is downloaded when a new work folder needs its title, and Extract downloads it again to save the source content; run `extract --rebuild` to download a fresh copy. URL imports accept HTML or text responses up to 10 MB. Use `--title`, `--author`, and `--language` on `convert` or `run … extract` to override missing source metadata. Text PDFs are supported; scanned or image-only PDFs need OCR before import, and password-protected PDFs must be unlocked first.

All stages report activity in the CLI and the UI's Stage activity panel. Metadata and Casting show preparation, a waiting indicator during a model request, and saving. Script shows text processed by block and completed chapter counts. Synth shows audio segments ready, including cache hits. Assembly shows encoded chapters, duration reads, joining, and M4B export; ffmpeg runs asynchronously so the UI stays responsive. Extract and Voices report local-work milestones and counts. Short local stages may finish between UI polls; their milestones remain in the activity log.

Long-running activities print elapsed-time updates every 10 seconds; the UI updates elapsed time while polling and uses an indeterminate bar when there is no measurable percentage. Percentages describe the current activity's units, not time remaining or full-stage completion (for example, encoding can reach 100% before M4B export). UI progress tracks jobs started in that UI server; separate CLI runs are not attached to it.

### Reviewing the cast

`characters.json` holds the cast Script discovered, scoped per story, with the evidence for each character and any issues: a conflicting trait, an alias two characters claim, a merge the text did not settle. Edit it in the workspace's **Cast** panel or by hand.

When Script stops on a speaker it cannot place, each one is listed under `unresolved` with the line and its surrounding context. Settle each in one of three ways, then run Script again:

- add the speaker to the cast under the same name;
- set `resolveAs` to an existing character's name, which applies to that chapter only;
- set `resolveAs` to `narrator` when the quoted text is not speech.

The chapter resumes from its checkpoint: the attributed text and the verification pass are kept, so nothing is paid for twice. The workspace failure panel also offers **Ask LLM to propose speaker resolutions**, which preselects only evidence-backed choices for you to confirm.

In the workspace, renaming a character, or merging one into another by listing its name among the other's aliases, renames the saved scripts offline. Saving the cast makes Casting and later stages stale and keeps the scripts and the audio cache. A chapter's script is keyed by its own text, chunking and mode, never by the cast, so a new character does not invalidate chapters already scripted.

Without extra flags, completed stages and existing chapter output are reused. `--rerun` invalidates completion from that stage onward and clears the stage output needed to execute it again; downstream artifacts remain. A whole-stage Script rerun also rediscovers the cast. `--rebuild` clears that stage's derived artifacts as well, but runs only the requested stage. It cannot be combined with `--chapters` or `--rerun`. Both preserve `2-audio-cache/`. Rebuilding Metadata does not need Extract to run again. Use a rebuild when upstream edits require regenerating downstream artifacts.

### Work directory

Each book gets `work/<title>/` containing its intermediate artifacts and audio cache:

```
work/the-last-question/
  state.json               # source hash, stage/chapter completion, synthesis input hash
  metadata.json  cover.jpg # from extract; metadata adds the book profile
  stories.json             # story grouping: one story, or one per short story
  characters.json          # the running cast, its review issues, unresolved speakers
  casting.json             # speaker → desired voice profile + instructions
  voice-bindings.json      # speaker → concrete library/provider/model/voice choice
  usage.json               # calls, tokens and wall time of every stage run
  0-chapters/<NN>-<slug>.md      # raw markdown, one file per chapter
  1-scripts/<NN>-<slug>.json     # per-chapter {speaker, text, delivery?, confidence} segments
  2-audio-cache/<hash>.mp3       # one mp3 per synthesized segment, keyed by hash
  3-audio/<NN>-<slug>.m4a        # encoded chapter, beside its <NN>-<slug>.json manifest
  checkpoints/             # finished chunks of a chapter Script has not completed
  Book Title.m4b           # assembled audiobook
```

`<slug>` is the chapter title, capped at 60 characters. A chapter's files are always found by the `<NN>` index prefix, so a chapter retitled by a Metadata rerun keeps the script and audio already made for it.

Text artifacts are inspectable JSON/markdown, so outputs can be reviewed or corrected before the next stage runs. The final M4B is saved in its book's work folder using the book metadata title. Pass `--out` to export it to another directory. Completed cache files are keyed by provider, model, native voice ID, delivery instructions, and speakable text; changing those inputs can incur new TTS charges. Rebuilds retain the cache and previously assembled M4Bs; assembly overwrites a matching output filename.

### Short story collections

Each story in a collection has its own cast, so a "John" in one story is not the "John" in another. Metadata detects a collection from the chapter titles and openings; `--collection` and `--no-collection` override that decision, are remembered in `state.json`, and survive a rebuild of Metadata:

```bash
npm run dev -- convert anthology.epub --collection --dry-run
npm run dev -- run anthology.epub script --collection   # change an existing work folder
```

Metadata proposes the grouping, keeping the parts of one story together when the titles say so (a repeated title, "Part II"). A proposal that does not cover the narrated chapters exactly once is reported and replaced by one story per chapter. The grouping lives in `stories.json`:

```json
{
  "version": 1,
  "collection": true,
  "stories": [
    { "id": "story-03", "title": "The Nine Billion Names of God", "chapters": [3] },
    { "id": "story-04", "title": "Rescue Party", "chapters": [4, 5] }
  ]
}
```

A story told across several chapters is grouped by listing those chapter indexes in one entry, as `story-04` does above. Use the workspace **Story grouping** panel, or edit the file directly: entries and their chapters go in chapter order, each `id` is distinct, and every narrated chapter belongs to exactly one story.

Scoping affects scripting, casting, and voice allocation:

- Each story has its own running cast, so two stories can use one name for two people with their own traits and voices. A name shared by two stories is labelled with its story title, for example `John (Rescue Party)`, because casting, bindings, and script segments are keyed by name.
- Script sends the model only the current story's cast, which is both cheaper and less error-prone than a whole anthology's names, and runs separate stories in parallel.
- Changing the collection flag or the grouping clears the cast, scripts, casting, bindings, and encoded chapters, while keeping the paid MP3 cache. Re-running voices after a regrouping can choose different voices, and new voices mean new TTS charges on the next synthesis.

## Configuration

Environment variables (see `src/config.ts` for defaults):

- `LISEN_ANALYSIS_MODEL` — model for Metadata, Casting and Script verification (default `gpt-4.1`)
- `LISEN_CHAPTER_MODEL` — model for Script's per-chunk work (default `gpt-4.1-mini`)
- `LISEN_SCRIPT_MODEL` — model for Script's attribution and verification calls when set; otherwise the UI uses its selected text model, while the CLI uses `LISEN_CHAPTER_MODEL` for attribution and `LISEN_ANALYSIS_MODEL` for verification
- `LISEN_SCRIPT_REASONING_EFFORT` — reasoning for Script's attribution and verification calls (default: the value of `LISEN_OPENROUTER_REASONING_EFFORT`; same allowed values). Turn it on if speaker attribution is not good enough
- `LISEN_SCRIPT_MAX_COMPLETION_TOKENS` — Script response token cap (default: `8192`, or the general cap when that is higher)
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
- `LISEN_OPENROUTER_MAX_PRICE` — optional JSON price caps for OpenRouter text routing, in US dollars per million tokens; for example `{"prompt":0.10,"completion":0.40}`. An empty value means no cap.
- `LISEN_OPENROUTER_TRACE_FILE` — optional local JSONL trace of full OpenRouter LLM requests and raw responses; contains book text and generated prose, never API keys
- `LISEN_OPENROUTER_REASONING_EFFORT` — reasoning for every text-model call (default `none`, which switches reasoning off; allowed: `none`, `default`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Reasoning is off by default because the stages ask for short structured answers, and a model that reasons by default can spend many times its answer in reasoning tokens. `default` sends no setting and leaves the choice to the provider; use it for a model with no endpoint that accepts a reasoning setting
- `LISEN_TTS_MAX_CHARS` — maximum characters in one TTS request (default `4000`)
- `LISEN_SCENE_BREAK_PAUSE_MS` — silence inserted where the book marks a scene break; read when Script writes a chapter, and recorded per pause in the script (default `2000`)
- `LISEN_TTS_VOICES_FILE` — JSON catalogue of voices for a non-OpenAI OpenRouter speech model
- `LISEN_VOICE_LIBRARY_FILE` — shared model and voice library path (default `./library/voices.json`, relative to the current directory)

Other tunables (concurrency, Script chunk sizes and quote limit, Metadata sample sizes, casting batch size, bitrate) are constants in `src/config.ts`.

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

## Script benchmark

`npm run bench` measures which OpenRouter model and reasoning effort does the Script stage best for the money. It runs Script on one fixed story ("The Last Question") under every configuration in `benchmarks/models.json`, scores each result against the hand-made reference script in `benchmarks/0-target/`, and writes `benchmarks/report.md`, `benchmarks/report.html` (every run on one page, with an accuracy-against-cost chart and a sortable table; open it in a browser) and `benchmarks/results.json`.

**Runs spend real money.** Every command prints the plan with estimated costs first; only `run --yes` makes paid calls. Prices and each model's support for a reasoning setting come from OpenRouter's public model list at run time.

```bash
npm run bench -- plan                                     # matrix and estimated cost; no paid calls
npm run bench -- run --label baseline --models glm-5.3-flash --efforts none --yes   # one cheap run first
npm run bench -- run --label baseline --yes               # everything not yet run under this label
npm run bench -- run --label two-pass --note "second attribution pass" --groups cheap --repeat 3 --yes
npm run bench -- report                                   # re-score every saved run; offline
npm run bench -- score benchmarks/runs/baseline/z-ai_glm-5.3-flash--none   # one folder; offline
```

- `--models` takes ids or parts of ids (`haiku,deepseek/`), `--efforts` and `--groups` narrow the matrix, `--repeat N` runs each configuration N times, `--concurrency N` sets how many run at once (default 4), and `--redo` reruns configurations that already finished under the label.
- **Labels are app versions.** Runs go in `benchmarks/runs/<label>/<model>--<effort>/`. Without `--label` the label is the date and short commit. Each run records the commit, branch, uncommitted changes, package version, a content hash of `src/` (so uncommitted work is told apart), the Script tunables, and your `--note`. Reusing a label for a different `src/` is refused unless you pass `--allow-version-mismatch`.
- **Shared base.** Extract and one Metadata call build `runs/<label>/base/` once, and every run starts from a copy, so configurations differ only in Script. The base must come out in `quoted` mode. A new label reuses an earlier label's base when the files Extract and Metadata depend on are unchanged; otherwise it is rebuilt for one Metadata call (model set under `metadata` in `models.json`).
- **Each run is a child process** of the CLI with its own environment: the model in `LISEN_SCRIPT_MODEL`, the effort in `LISEN_SCRIPT_REASONING_EFFORT`, no price cap, a higher completion cap and response timeout (`benchmarkConfig` in `src/config.ts`), and a request trace in the run folder (`trace.jsonl`). A failed run is a result: a run blocked on an unresolved speaker is scored from its checkpoint, with the unresolved lines counted wrong. `run.json` holds the outcome, reason, exit code, tokens, retries, invalid replies, cost and version; `console.log` holds the output.

Reading the report: the main table covers one label (the latest by default, or `report --label <label>`), sorted by the share of the reference's character lines given to the right speaker, with word-weighted accuracy, narrator-boundary errors (narration given to a character, speech given to the narrator), merged and split characters, cost, wall time, calls, tokens and retries beside it. With repeats it shows the mean and the range. Cost is what OpenRouter reported per call; "est." marks one computed from tokens and listed prices. "Spend by call type" splits calls into attribution, verification and edits from the traces, since `usage.json` only has stage totals. "Version comparison" lines up the same model and effort across labels with the change in accuracy, cost, calls and wall time. Each run then lists the lines it got wrong.

Scoring aligns the run's text with the reference word by word, so differently cut segments or a corrected word do not count; text on only one side is reported as text fidelity. Run speaker names are mapped to the reference's by exact name, then `benchmarks/0-target/aliases.json`, then best overlap, and the mapping is shown. A reference line with no double quotation marks cannot be attributed by quoted-mode Script and is left out. Cleanup quality is not measured.

## Development

```bash
npm run dev -- <args>   # run the CLI from source (tsx)
npm run build           # compile to dist/
npm test                # vitest, fully offline
npm run test:watch      # offline tests in watch mode
```

The `lisen` executable points to `dist/cli.js`; build before using an installed or linked binary. Tests cover EPUB, PDF, HTML, and Markdown extraction; text and script cleanup; provider requests with mocks; voice libraries and migration; state tracking; retry events; and UI activity rendering. No live LLM or TTS requests are made by the test suite.

See [AGENTS.md](AGENTS.md) for a code map and contributor conventions.
