# AGENTS.md

Guidance for coding agents working on this repo. See [README.md](README.md) for what the tool does and how to use it.

## What this is

A staged, resumable CLI and local web workspace (TypeScript, ESM, Node 22.12+ with current dependencies) that turns an EPUB, PDF, HTML or Markdown source into a multi-voice M4B audiobook. OpenAI and OpenRouter provide LLM processing and TTS; a shared voice library binds speaker profiles to concrete voices; ffmpeg handles assembly. Fish catalogue bindings are supported, but Fish synthesis is not implemented.

## Commands

```bash
npm run dev -- convert book.epub --dry-run # prepare through voices; billable LLM calls
npm run dev -- run book.epub extract      # one offline stage
npm run dev -- books --json               # discover work folders
npm run dev -- status book.epub --json    # source and completion state
npm run dev -- ui                         # local workspace at 127.0.0.1:3188
npm run dev -- voices list                # inspect the shared voice library
npm run build                            # tsc → dist/
npm test                                 # vitest run — fully offline, safe to run anytime
npm run test:watch
```

## Cost warning — read before running the pipeline

Pipeline runs can spend real money on the configured provider APIs, through either the CLI or UI:

- Stages `metadata`, `script`, and `casting` make LLM calls. Script is the only stage that reads the whole text with a model.
- Stage `synth` makes TTS calls — **the expensive part**.

Rules of thumb:

- Never run a full `convert` (or anything that reaches `synth`, including `run ... synth` and UI jobs) without the user asking for it. Use `--dry-run` to stop after Voices, before synthesis and assembly; this still incurs LLM costs.
- `npm run bench -- run --yes` spends on every configuration it runs; `plan`, `score` and `report` are offline. Do not delete `benchmarks/runs/`: it is paid output.
- `extract`, `voices`, and voice-library listing/refresh/import are offline. Assembly uses local ffmpeg. The test suite is fully offline.
- Completed MP3s in `work/<title>/2-audio-cache/` are reused by a SHA-256 key: `[provider, model, nativeVoiceId, instructions, speakableText].join('\x1f')`, truncated to 24 hex characters. Instructions include standing speaker instructions and segment delivery. Do not casually change inputs or splitting rules: affected segments require new synthesis. The language guard is added to requests but intentionally excluded from the key.
- Rebuilds and reruns preserve `2-audio-cache/`. Do not delete it as routine cleanup; it represents paid output.

`OPENAI_API_KEY` and `OPENROUTER_API_KEY` can be loaded from `.env` using `process.loadEnvFile` in `src/cli.ts` (no dotenv dependency). The first existing file in the current directory or project root is used. `.env` is gitignored; never commit or print it.

## Code map

```
src/
  cli.ts               # commander: convert, run, books, status, ui, voices; .env loading
  config.ts            # env-var config, tunables, and the STAGES list (canonical stage order)
  layout.ts            # work folder and file names; chapter files found by index prefix
  state.ts             # WorkDir: source hash, stage/chapter completion, synthesis input hash, layout version
  checks.ts            # CLI checks for ffmpeg/ffprobe and configured API keys
  types.ts             # shared zod schemas / types for pipeline artifacts
  pipeline/
    runner.ts          # shared orchestration, prerequisites, rebuild/rerun, events, usage, discovery
    extract.ts         # source → 0-chapters/ + metadata.json
    metadata.ts        # one call: book profile, narrate/skip, dialogue style, story proposal
    stories.ts         # story grouping (stories.json), labels, narratable chapters, chapter titles
    script.ts          # the Script stage: chunking, the per-chunk call, verification, resume
    spans.ts           # splitting a passage into numbered narration/quote spans, and back into segments
    cleanup.ts         # applying {find, replace} edits under size guards, per span
    cleanup-triggers.ts # the patterns that decide whether narration needs a cleanup call
    cast.ts            # characters.json: running cast, consolidation, shared-name labels, renames
    checkpoint.ts      # per-chunk Script checkpoints
    reconcile-speakers.ts # optional LLM proposals for unresolved speakers (UI)
    casting.ts, voices.ts, synth.ts, assemble.ts
  benchmark/           # Script benchmark (npm run bench): score.ts (offline scorer), runner.ts, report.ts, matrix.ts, version.ts
  ui/server.ts         # localhost HTTP API, single active job, embedded HTML/JS workspace
  epub/                # EPUB unzip + OPF parsing (epub.ts), xhtml→markdown (markdown.ts)
  source/              # readers for every source format (read.ts), oversized-chapter splitting (split.ts)
  providers/
    llm/openai.ts      # jsonCall(): OpenAI/OpenRouter JSON-mode calls, zod validation, retries, usage
    tts/types.ts       # TTSProvider interface + Voice type
    tts/openai.ts      # OpenAI TTS implementation + getTTSProvider() registry
    tts/openrouter.ts  # OpenRouter speech endpoint adapter
    tts/voices.ts      # built-in OpenAI voices + legacy catalogue parsing
  voices/library.ts    # version-1/2 shared catalogue schemas, loading, refresh/import
  util/text.ts         # chunking, sentence splitting, narratable-text and whitespace helpers
  util/usage.ts        # AsyncLocalStorage usage collector, usage.json, summaries
  util/warnings.ts     # AsyncLocalStorage warning reporter for stage events
library/voices.json    # bundled version-2 OpenAI/Fish model and voice catalogue
benchmarks/            # Script benchmark: 0-target/ reference, models.json matrix, runs/<label>/ (paid output), report.md
test/                  # offline tests; test/helpers.ts builds a work folder as Metadata leaves it
work/                  # gitignored per-book artifacts
0Meta/                 # gitignored background/design notes, when present
```

## Architecture in one paragraph

`convert` iterates the seven stages in `STAGES` order (`src/config.ts`): extract → metadata → script → casting → voices → synth → assemble. CLI commands and the UI call `runStage()` in `src/pipeline/runner.ts`, which checks prerequisites, handles invalidation and cleanup, dispatches stage functions, records completion, and logs usage. Stages read and write `WorkDir` artifacts, with JSON/markdown available for inspection and editing. Metadata profiles the book from its openings without reading it; Script is the single LLM pass over the text and discovers the cast as it goes. Characters are scoped by story: `stories.json` holds one story for a continuous work and one per short story for a collection, and Script, Casting and Voices all scope their work through it. `casting.json` describes desired speaker profiles; `voice-bindings.json` records the concrete provider/model/native voices used for synthesis. `script` and `synth` support chapter selection and chapter completion tracking; assembly also accepts chapter selection but only full-book assembly marks the stage complete.

## Work folder layout

```
work/<title>/
  state.json, metadata.json, stories.json, characters.json, casting.json, voice-bindings.json, usage.json
  0-chapters/<NN>-<slug>.md      # Extract
  1-scripts/<NN>-<slug>.json     # Script
  2-audio-cache/<hash>.mp3       # Synth; paid output
  3-audio/<NN>-<slug>.m4a        # Assemble, beside Synth's <NN>-<slug>.json manifest
  checkpoints/script-<NN>.json   # unfinished chapters only
  <title>.m4b
```

- All names come from `src/layout.ts`. `<slug>` is the chapter title capped at 60 characters. **Always find a chapter's file by its index prefix** (`findChapterFile()`, `listChapterFiles()`, `chapterFile()`), never by building the name from the title: Metadata can retitle a chapter, and a retitled chapter must keep its script and audio.
- `metadata.json` has two owners. Extract writes everything except `profile`; Metadata writes only `profile`. Rebuilding Metadata removes `profile` (`clearProfile()` in the runner) and must never require Extract to run again. Read it through `readProfiledMetadata()` when a stage needs the profile.
- `state.json` carries `version: 3`. A folder with any other version was made by an earlier pipeline: `WorkDir.isOutdated()` is true, every mutation throws `OUTDATED_WORK_FOLDER_MESSAGE`, and the runner refuses every stage except `extract --rebuild`. There is no migration and nothing in such a folder is read or deleted; the rebuild writes the current layout beside the old files. Do not add migration paths.

## Metadata

- One `jsonCall` on the analysis model. The request (`metadataRequest()`) carries the source's title, author, language, subjects and description, each chapter's index, title, word count and first `config.metadataOpeningWords` words, and `config.metadataSampleWords` words from the first chapter that does not look like front matter (`firstBodyChapter()`). It must not grow into reading the book, and it uses no tools or web search.
- `recognised` gates the summary: a summary from the model is kept only when it says it knows the book; otherwise the summary is the source's description or empty (`summarySource`). Nothing downstream may depend on the summary; Casting passes it as optional context only.
- The narrate/skip decisions are backstopped in code (nav documents, skip-list titles, empty chapters, and a rescue for titles like "Chapter XII").
- `dialogueStyle` decides Script's mode, and the model judges it from one sample, so `settleDialogueStyle()` overrules it from the whole text: a book is `quoted` only when its narrated chapters hold at least `config.quotedDialoguePairsPerThousandWords` double-quote pairs per 1,000 words. A book that marks speech with single quotes or dashes is therefore `unquoted`, because spans cannot be split on apostrophes.

## Script

One LLM call per chunk does cleanup, attribution and character discovery together. `scriptModeOf()` picks one of three modes for the whole book:

- **`quoted`** — the chunk is split in code into numbered spans (`splitSpans()`): narration, quoted speech, and the tags between quotes. The model returns `labels` for quoted spans only, `edits`, and `characters`. **It never returns the book's text; do not add a field that does.** A quoted span that is not speech is labelled `narrator` and `spansToSegments()` rejoins it with its sentence. A quoted span that comes back unlabelled is marked unresolved, never given to the narrator.
- **`unquoted`** — spans cannot be found in code, so the model returns `{speaker, text, confidence}` segments plus `edits` and `characters`. `coverageProblem()` rejects a reply that does not reproduce the text, as a `jsonCall` validation (so the model is told and retried) and again after it.
- **`narration`** (non-fiction) — every paragraph is the narrator.

Rules that hold across modes:

- **Skip the call when there is nothing to ask** (`chunkRequest()`): no quoted span and no cleanup trigger means no request, and narration with a trigger gets the edits-only request. The triggers live in one place, `src/pipeline/cleanup-triggers.ts`, with tests for what they flag and what they let through. A scanning error in an otherwise clean chunk is missed, and that trade is accepted; do not widen the triggers to catch it.
- **Cleanup is a list of edits, not a rewrite.** The model returns `{find, replace}` corrections and `applySpanEdits()` (`src/pipeline/cleanup.ts`) applies each one inside a single span or segment, so prose cannot be paraphrased or dropped. An edit that does not quote the text, deletes or adds more than a small correction, is a bare number occurring more than once, or only matches across a span boundary is skipped with a warning. Do not loosen the size guards to let a model delete passages; skipping unwanted material is Metadata's narrate decision.
- The edits-only request carries only the book title, chapter title and text, with no character rules or fields.
- **A scene break is silence, not text.** A paragraph with no narratable text but some content (`• • •`, `* * *`, a `<hr>`) is a scene-break divider: `isSceneBreak()` (`src/util/text.ts`). `attributionBlocks()` cuts the chapter at it and keeps it out of the request, and the block that ends on one gets a `pauseSegment()` — a segment with `kind: 'pause'` and `pauseMs`, which `filterNarratableSegments()` deliberately keeps. Synth makes no request for it and records `{ pauseMs }` in the chapter manifest; Assemble encodes one silence MP3 per length, matching the synthesized audio's sample rate and channels. Keep pauses out of LLM-facing schemas (`SpeechSegmentSchema`) and show them to a model as `[scene break]`, never as the divider: a model given the glyphs will read them aloud.
- Chunk sizes are tunables: `scriptChunkChars` (labels come back, so chunks are large), `scriptUnquotedChunkChars` (the text comes back, so they are small), and `scriptMaxQuotesPerChunk`, which cuts a dialogue-heavy block so one reply's labels fit the completion budget.
- Preserve the script guard that removes layout-only/punctuation-only segments and normalizes non-breaking spaces. Non-ASCII narration must remain intact.

### Running cast

- `characters.json` is the cast, scoped per story, plus `unresolved` speakers. Script sends each chunk only the current story's cast (`chapterCast()`), adds the characters a reply reports (`addCharacters()`), and carries the last three segments into the next chunk as context.
- Chapters of one story therefore run in order; separate stories run in parallel up to `config.llmConcurrency`. One story stopping does not stop the others.
- Unnamed roles ("the guard") are scoped to their chapter and offered to no other chapter. A reported character who was given no lines is ignored.
- `consolidateStory()` is offline and runs when a chapter's blocks are done: exact names and unambiguous aliases only, so "Lupov" folds into "Bertram Lupov" once a later reply lists the alias. A merge the text does not settle — an alias two characters claim, a sex that differs — is recorded in `issues` and left alone. Renames are applied to the story's saved scripts by `renameSpeakers()` with no LLM call.
- `labelSharedNames()` runs once at the end of a Script run: a name shared by two stories is labelled with its story title (`John (Rescue Party)`), because `casting.json`, `voice-bindings.json`, and script segments are all keyed by name. Prompts show the name without the label.
- One verification pass covers labels with low confidence and speakers missing from the cast after consolidation. There is no narration-boundary repair call; the split is done in code.
- A speaker still unresolved after verification is saved under `unresolved` and stops the stage with an actionable error. **Never assign it to the narrator.** A person settles it by adding the character, or by setting `resolveAs` (a character's name, or `narrator`) on the record, which applies to that chapter only.

### Resume and invalidation

- Each finished chunk is checkpointed under `checkpoints/` (`src/pipeline/checkpoint.ts`) with the characters it added, so a resumed chapter has the cast as of that chunk even if `characters.json` was lost. The verified segments are saved as the checkpoint's `result`, so a chapter blocked on an unresolved speaker resumes with no further calls once a person answers.
- A chapter script records `sourceHash`: its own text, the chunking tunables, and the mode (`scriptSourceHash()`), which is also the checkpoint key. **Keep the cast out of this hash**, or every new character would invalidate the chapters before it. A changed Metadata mode changes the hash, so those chapters regenerate.
- A checkpoint is removed when the chapter's script is saved, and cleared by `--rerun`, rebuilds, and story regrouping. A whole-stage Script rerun also removes `characters.json`.

## Resuming, rerunning, and rebuilding

- Normal runs skip completed stages and reuse existing chapter scripts, cached MP3s, and encoded chapter M4As. Selected chapter indexes are zero-based; UI labels are one-based.
- `run <source> <stage>` executes exactly one stage. `--rerun` invalidates completion from that stage onward and clears only output needed to execute that stage again; downstream artifacts remain. `--rebuild` removes that stage's derived artifacts as defined in `clearArtifactsFrom()`. It cannot be combined with `--rerun` or a chapter selection.
- `convert --from <stage>` rebuilds from that stage and continues the pipeline; `--force` rebuilds from extract. The audio cache, `usage.json` and exported M4Bs are retained; assembly overwrites a matching output filename.
- A changed source hash preserves existing completion history and artifacts, sets `sourceChanged`, and blocks runs until `extract --rebuild`. Matching content at a new path updates the source link.
- Changing the collection flag (`--collection` / `--no-collection`, recorded in `state.json`) or the grouping regroups stories and clears the cast, scripts, casting, bindings, and encoded chapters, retaining `2-audio-cache/`. A Metadata run that changes the grouping does the same.
- Saving the cast in the UI (`saveCharacterRegistry()`) renames speakers in saved scripts offline, refuses to drop a character who still has lines, and invalidates from Casting. Saving casting/bindings in the UI invalidates and clears affected derived output while retaining MP3s. The runner also detects cast/binding file changes after completed synthesis using `synthesisInputHash`. For upstream hand edits that require regenerated downstream artifacts, use an explicit rebuild.

## Usage logging

- `jsonCall()` reports every model response to the collector in `src/util/usage.ts`, including one later rejected as invalid, and Synth reports each speech request. `runStage()` wraps the stage in `collectUsage()`, then prints a one-line summary, emits a `usage` event, and appends a record to `usage.json`: call count, prompt, completion and reasoning tokens per model, TTS requests, wall time, and outcome.
- Failed and cancelled stages are recorded; skipped stages and ones refused before starting are not. `usage.json` survives every rebuild. Records from one `convert` or UI job share a `runId`.
- A new provider adapter or a direct model call must report its usage, or the numbers stop being comparable.
- **Reasoning is off by default.** `none` sends OpenRouter `reasoning: { enabled: false }` rather than nothing, because many models reason unless told not to: a dry run of one short story spent 82,000 of its 87,000 completion tokens reasoning before this. `LISEN_OPENROUTER_REASONING_EFFORT` sets it for every call and `LISEN_SCRIPT_REASONING_EFFORT` for Script's attribution and verification; `default` sends no setting, for a model whose endpoints do not accept one. Do not go back to omitting the setting for `none`.

## Conventions

- **ESM with `.js` suffixes**: imports of local files use `./foo.js` even though sources are `.ts`. Keep this or the compiled output breaks.
- **All LLM calls go through `jsonCall()`** (`src/providers/llm/openai.ts`): JSON mode, a zod schema for the response, retries with the validation error fed back to the model, and an optional `validate` for checks a schema cannot express. Don't call the OpenAI client directly from pipeline code; define/extend zod schemas for any new structured output.
- **TTS is behind `TTSProvider`** (`src/providers/tts/types.ts`). Synthesis uses the target recorded in bindings, not just current environment defaults. New adapters belong in `src/providers/tts/` and `getTTSProvider()` (`src/providers/tts/openai.ts`); update provider config, key checks, catalogue/binding schemas, and CLI validation as needed.
- **Adding/reordering a stage** requires updating `STAGES`, runner dispatch/prerequisites/artifact cleanup, the CLI key checks, and the UI's embedded stage list and descriptions. `convert` already iterates `STAGES`. Stage order controls `invalidateFrom()`, including chapter completion and synthesis input state.
- **Stage contract**: read inputs via `work.readJson()` / files under `work.path(...)`, write outputs the same way, and stay idempotent — a stage may be re-run over existing partial output and must skip or overwrite cleanly.
- Tunables (concurrency, chunk sizes, sample sizes, batch sizes, bitrate) belong in `config.ts`, not inline.
- Route retry warnings through `reportWarning()` (`src/util/warnings.ts`) so the runner can deliver them to CLI or UI activity events. Keep provider credentials in Node and the UI server bound to `127.0.0.1`.
- The UI page is one `String.raw` template in `src/ui/server.ts`. Its script is executed by the UI tests in a minimal DOM, so keep it free of template literals and build markup with `esc()`.
- Errors from the CLI should be user-actionable (see `checks.ts` for tone); the top-level handler prints `err.message` and exits 1.

## Testing

`npm test` runs offline Vitest tests covering EPUB/OPF parsing, markdown/text cleanup, span splitting, the cleanup pre-filter, edit application, the Script stage in all three modes, the running cast and consolidation, checkpoint resume, the Metadata request and response, story grouping, casting and voice matching, source and chapter state, old-folder handling, usage logging, retry warning events, and UI rendering. `test/helpers.ts` builds a work folder as Metadata leaves it (`bookFixture()`) and a labels reply (`labelsReply()`). Most tests mock `jsonCall`; the Metadata and retry tests stub `fetch` instead, so the real provider code runs. No live API calls are needed for the suite. Run `npm run build` for TypeScript validation; tests are not type-checked. Live output quality can be reviewed with an authorized `--dry-run` and artifact inspection; dry runs do not test TTS.

## Short story collections

- Metadata detects a collection, proposes the grouping (`profile.stories`), and writes `stories.json`; a user override in `state.json` always wins and survives a Metadata rebuild. Later stages read the grouping, never the raw flag.
- `validateStories()` is the single gate: a grouping must cover every narratable chapter exactly once, in chapter order, with distinct ids. A proposal that fails it is reported and replaced by one story per chapter; a hand edit or UI save that fails it is rejected. Story ids are `story-<first chapter>`.
- Grouping changes go through `saveStoryGrouping()` (runner), used by `--collection`, `POST /api/stories`, and the UI panel. `--story` / `storyIndexes` select a stage's chapters by 1-based story number.
- Casting makes one request for the single book narrator plus one per story (split at `config.castingBatchSize` speakers so a reply fits), for a continuous work as well. The narrator's presentation comes from a first-person narrator of known sex first and the author profile second (`narratorPresentation()`). Voices allocate per story with the narrator's voice reserved book-wide, so stories reuse voices but a story does not.

## Voice library

- Default path: `./library/voices.json`, relative to the current directory; override with `LISEN_VOICE_LIBRARY_FILE`. Voice commands also accept `--library`.
- The bundled version-2 catalogue supports listing and applying OpenAI/Fish bindings. Version 1 uses `maxChars`; version 2 uses structured `inputLimits`, where `null` means unknown. These metadata limits do not automatically replace the adapter's `config.ttsMaxChars` request splitter.
- `voices refresh` and legacy-array `voices import` write version-1 libraries and refuse to overwrite version 2. Use a separate library file. Fish refresh and synthesis are unimplemented; OpenRouter targets also require a separate compatible library.
- Keep desired profiles in version-2 `casting.json` separate from concrete version-1 `voice-bindings.json`. Applying voices validates all scripted speakers.
- Voice allocation resets its used-voice set per story. Do not reintroduce a book-wide set: a collection has far more characters than any catalogue has voices, and characters in separate stories never share a scene.
- Preserve compatible manual bindings; incompatible manual choices must fail explicitly. Preserve catalogue metadata/annotations and unknown traits instead of inventing values. Model availability in the catalogue does not establish a working synthesis adapter.

## Gotchas

- Extract splits a source chapter over `config.maxChapterWords` into parts of about `config.targetChapterWords` (`src/source/split.ts`), cutting only between paragraphs and preferring headings, section markers, then scene breaks. Parts are ordinary chapters titled `Title (part N)` and carry `part: { first, number, total }` in `metadata.json`; `buildStories()` keeps the parts of one source chapter in one story. Only part 1 holds the source heading, so the title is announced once. Chapter indexes therefore differ from spine positions.
- Span splitting only pairs double quotation marks, straight or curly. A quote still open at the end of a paragraph runs to its end, a second opening mark closes an unclosed quote, and a straight mark is read as opening or closing from its neighbours so an inch mark does not open a quote. Change `quotedRanges()` with its tests in `test/spans.test.ts`.
- `package.json` still declares Node 20+, but the current Commander dependency requires Node 22.12+. Use a runtime that meets the dependency requirements.
- `dist/` is gitignored build output; the `lisen` bin points at `dist/cli.js`, so `npm run build` before testing the installed binary.
- A work folder is named from the document title when it is created and found afterwards by the source path or content hash saved in its `state.json`.
- A chapter audio manifest entry is a cache hash or `{ pauseMs }`, so `ChapterAudioManifest.segments` is a union. Assemble reuses an encoded chapter M4A only while it is newer than its manifest. The chapter M4A is the only encode after synthesis; the M4B is a stream copy.
- `synth` splits speakable text at sentence boundaries using the adapter's `maxChars` (`LISEN_TTS_MAX_CHARS`, default 4000). Keep the configured margin and account for model-specific limits.
- `convert` checks ffmpeg/ffprobe and both configured provider keys even with `--dry-run`. `run` checks keys for the requested LLM/TTS stage and ffmpeg/ffprobe only for assembly. The UI invokes the runner directly rather than these CLI startup checks.
- Keep `LISEN_TTS_PROVIDER` aligned with the saved binding target: CLI key checks use configuration while synthesis uses the bindings. Reapply voices explicitly when changing the book's target model.
- `run --json` emits a JSON result but stage code may also print progress, warnings and the usage line; do not assume its entire stdout is a single JSON document.
