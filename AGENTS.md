# AGENTS.md

Guidance for coding agents working on this repo. See [README.md](README.md) for what the tool does and how to use it.

## What this is

A staged, resumable CLI and local web workspace (TypeScript, ESM, Node 22.12+ with current dependencies) that turns an EPUB into a multi-voice M4B audiobook. OpenAI and OpenRouter provide LLM processing and TTS; a shared voice library binds speaker profiles to concrete voices; ffmpeg handles assembly. Fish catalogue bindings are supported, but Fish synthesis is not implemented.

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

- Stages `analyze`, `chapters`, `casting`, and fiction dialogue attribution in `script` make LLM calls.
- Stage `synth` makes TTS calls — **the expensive part**.

Rules of thumb:

- Never run a full `convert` (or anything that reaches `synth`, including `run ... synth` and UI jobs) without the user asking for it. Use `--dry-run` to stop before synthesis and assembly; this still incurs LLM costs.
- `extract`, `list-characters`, `voices`, and voice-library listing/refresh/import are offline. Assembly uses local ffmpeg. The test suite is fully offline.
- Completed MP3s in `work/<slug>/audio-cache/` are reused by a SHA-256 key: `[provider, model, nativeVoiceId, instructions, speakableText].join('\x1f')`, truncated to 24 hex characters. Instructions include standing speaker instructions and segment delivery. Do not casually change inputs or splitting rules: affected segments require new synthesis. The language guard is added to requests but intentionally excluded from the key.
- Rebuilds and reruns preserve `audio-cache/`. Do not delete it as routine cleanup; it represents paid output.

`OPENAI_API_KEY` and `OPENROUTER_API_KEY` can be loaded from `.env` using `process.loadEnvFile` in `src/cli.ts` (no dotenv dependency). The first existing file in the current directory or project root is used. `.env` is gitignored; never commit or print it.

## Code map

```
src/
  cli.ts               # commander: convert, run, books, status, ui, voices; .env loading
  config.ts            # env-var config, tunables, and the STAGES list (canonical stage order)
  state.ts             # WorkDir: source hash, stage/chapter completion, synthesis input hash
  checks.ts            # CLI checks for ffmpeg/ffprobe and configured API keys
  types.ts             # shared zod schemas / types for pipeline artifacts
  pipeline/
    runner.ts          # shared orchestration, prerequisites, rebuild/rerun, events, discovery
    *.ts               # extract, analyze, chapters, list-characters, script, casting, voices, synth, assemble
  ui/server.ts         # localhost HTTP API, single active job, embedded HTML/JS workspace
  epub/                # EPUB unzip + OPF parsing (epub.ts), xhtml→markdown (markdown.ts)
  providers/
    llm/openai.ts      # jsonCall(): OpenAI/OpenRouter JSON-mode calls, zod validation, retries
    tts/types.ts       # TTSProvider interface + Voice type
    tts/openai.ts      # OpenAI TTS implementation + getTTSProvider() registry
    tts/openrouter.ts  # OpenRouter speech endpoint adapter
    tts/voices.ts      # built-in OpenAI voices + legacy catalogue parsing
  voices/library.ts    # version-1/2 shared catalogue schemas, loading, refresh/import
  util/text.ts         # chunking, sentence splitting, narratable-text and whitespace helpers
  util/warnings.ts     # AsyncLocalStorage warning reporter for stage events
library/voices.json    # bundled version-2 OpenAI/Fish model and voice catalogue
test/                  # offline parsing, scripts, providers, voices, state, retry/UI tests
work/                  # gitignored per-book artifacts; work/alice/ is a sample run to inspect
0Meta/                 # gitignored background/design notes, when present
```

## Architecture in one paragraph

`convert` iterates the nine stages in `STAGES` order (`src/config.ts`): extract → analyze → chapters → list-characters → script → casting → voices → synth → assemble. CLI commands and the UI call `runStage()` in `src/pipeline/runner.ts`, which checks prerequisites, handles invalidation and cleanup, dispatches stage functions, and records completion. Stages read and write `WorkDir` artifacts, with JSON/markdown available for inspection and editing. `casting.json` describes desired speaker profiles; `voice-bindings.json` records the concrete provider/model/native voices used for synthesis. `chapters`, `script`, and `synth` support chapter selection and chapter completion tracking; assembly also accepts chapter selection but only full-book assembly marks the stage complete.

## Resuming, rerunning, and rebuilding

- Normal runs skip completed stages and reuse existing chapter scripts/cleaned text, cached MP3s, and encoded chapter M4As. Selected chapter indexes are zero-based; UI labels are one-based.
- `run <epub> <stage>` executes exactly one stage. `--rerun` invalidates completion from that stage onward and clears only output needed to execute that stage again; downstream artifacts remain. `--rebuild` removes that stage's derived artifacts as defined in `clearArtifactsFrom()`. It cannot be combined with `--rerun` or a chapter selection.
- `convert --from <stage>` rebuilds from that stage and continues the pipeline; `--force` rebuilds from extract. Audio cache and exported M4Bs are retained; assembly overwrites a matching output filename.
- A changed EPUB hash preserves existing completion history and artifacts, sets `sourceChanged`, and blocks runs until `extract --rebuild`. Matching content at a new path updates the source link. UI artifact recovery only applies when the source matches and completion history is empty.
- Saving casting/bindings in the UI invalidates and clears affected derived output while retaining MP3s. The runner also detects cast/binding file changes after completed synthesis using `synthesisInputHash`. For upstream hand edits that require regenerated downstream artifacts, use an explicit rebuild.

## Conventions

- **ESM with `.js` suffixes**: imports of local files use `./foo.js` even though sources are `.ts`. Keep this or the compiled output breaks.
- **All LLM calls go through `jsonCall()`** (`src/providers/llm/openai.ts`): JSON mode, a zod schema for the response, retries with the validation error fed back to the model. Don't call the OpenAI client directly from pipeline code; define/extend zod schemas for any new structured output.
- **TTS is behind `TTSProvider`** (`src/providers/tts/types.ts`). Synthesis uses the target recorded in bindings, not just current environment defaults. New adapters belong in `src/providers/tts/` and `getTTSProvider()` (`src/providers/tts/openai.ts`); update provider config, key checks, catalogue/binding schemas, and CLI validation as needed.
- **Adding/reordering a stage** requires updating `STAGES`, runner dispatch/prerequisites/artifact cleanup, and the UI's embedded stage list and descriptions. `convert` already iterates `STAGES`. Stage order controls `invalidateFrom()`, including chapter completion and synthesis input state.
- **Stage contract**: read inputs via `work.readJson()` / files under `work.path(...)`, write outputs the same way, and stay idempotent — a stage may be re-run over existing partial output and must skip or overwrite cleanly.
- Tunables (concurrency, chunk sizes, voice slot count, bitrate) belong in `config.ts`, not inline.
- Route retry warnings through `reportWarning()` (`src/util/warnings.ts`) so the runner can deliver them to CLI or UI activity events. Keep provider credentials in Node and the UI server bound to `127.0.0.1`.
- Preserve the script guard that removes layout-only/punctuation-only segments and normalizes non-breaking spaces, including when resuming old scripts. Non-ASCII narration must remain intact.
- Errors from the CLI should be user-actionable (see `checks.ts` for tone); the top-level handler prints `err.message` and exits 1.

## Testing

`npm test` runs offline Vitest tests covering EPUB/OPF parsing, markdown/text cleanup, script segment filtering, mocked OpenRouter LLM/TTS requests, catalogue parsing and migration, voice matching/manual overrides, source and chapter state, retry warning events, and UI activity rendering. Use these mocks for provider and orchestration regressions; no live API calls are needed for the suite. Run `npm run build` for TypeScript validation. Live output quality can be reviewed with an authorized `--dry-run` and artifact inspection; dry runs do not test TTS. Existing `work/alice/` output, when present, is useful reference material and may use older artifact formats.

## Book characters

- Analyze produces provisional candidates from samples. Chapters saves evidence-backed speaker observations under `chapter-characters/` while processing full chapter text.
- `list-characters` (UI: **List Characters**) is an offline, whole-book stage before Script. It requires all narratable chapters and consolidates observations into `characters.json`, merging exact names and unambiguous explicit aliases. Uncertain identities and conflicting traits are retained for review; unnamed roles stay chapter-scoped.
- Script and Casting use this book-specific registry, separate from the shared voice catalogue. Script saves unresolved speakers in `character-candidates/` and reports an actionable error instead of assigning them to the narrator. Review candidates, update chapter observations, then rerun List Characters and Script.
- Legacy chapter runs can backfill missing observations with a normal `chapters` run, preserving cleaned text/summaries. Fiction backfill makes LLM calls. Scripts carry a registry hash and regenerate when it changes. A changed registry clears derived audio manifests/encoded chapters, retaining paid MP3 caches and exported books.

## Voice library

- Default path: `./library/voices.json`, relative to the current directory; override with `LISEN_VOICE_LIBRARY_FILE`. Voice commands also accept `--library`.
- The bundled version-2 catalogue supports listing and applying OpenAI/Fish bindings. Version 1 uses `maxChars`; version 2 uses structured `inputLimits`, where `null` means unknown. These metadata limits do not automatically replace the adapter's `config.ttsMaxChars` request splitter.
- `voices refresh` and legacy-array `voices import` write version-1 libraries and refuse to overwrite version 2. Use a separate library file. Fish refresh and synthesis are unimplemented; OpenRouter targets also require a separate compatible library.
- Keep desired profiles in version-2 `casting.json` separate from concrete version-1 `voice-bindings.json`. Applying voices validates all scripted speakers and backs up legacy casting to `casting.legacy.json` before migration.
- Preserve compatible manual bindings; incompatible manual choices must fail explicitly. Preserve catalogue metadata/annotations and unknown traits instead of inventing values. Model availability in the catalogue does not establish a working synthesis adapter.

## Gotchas

- `package.json` still declares Node 20+, but the current Commander dependency requires Node 22.12+. Use a runtime that meets the dependency requirements.
- `dist/` is gitignored build output; the `lisen` bin points at `dist/cli.js`, so `npm run build` before testing the installed binary.
- The work-dir slug comes from the EPUB *filename*, not its metadata — renaming the file orphans its work directory.
- `synth` splits speakable text at sentence boundaries using the adapter's `maxChars` (`LISEN_TTS_MAX_CHARS`, default 4000). Keep the configured margin and account for model-specific limits.
- `convert` checks ffmpeg/ffprobe and both configured provider keys even with `--dry-run`. `run` checks keys for the requested LLM/TTS stage and ffmpeg/ffprobe only for assembly. The UI invokes the runner directly rather than these CLI startup checks.
- Keep `LISEN_TTS_PROVIDER` aligned with the saved binding target: CLI key checks use configuration while synthesis uses the bindings. Reapply voices explicitly when changing the book's target model.
- `run --json` emits a JSON result but stage code may also print progress/warnings; do not assume its entire stdout is a single JSON document.
