# AGENTS.md

Guidance for coding agents working on this repo. See [README.md](README.md) for what the tool does and how to use it.

## What this is

A staged, resumable CLI and local web workspace (TypeScript, ESM, Node 22.12+) that turns EPUB/PDF/HTML/Markdown/plain text into a multi-voice M4B. Local BookNLP performs whole-book entity/coreference/quotation annotation. OpenAI/OpenRouter LLMs remain for Analyze and Casting; TTS, voice libraries, and ffmpeg retain their provider/assembly architecture.

## Commands

```bash
npm run dev -- convert book.epub --dry-run # prepare through voices; billable LLM calls
npm run dev -- run book.epub extract      # one offline stage
npm run dev -- run book.epub booknlp      # whole-book local annotation
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

- Stages `analyze` and `casting` make LLM calls. `booknlp`, `chapters`, `list-characters`, and `script` are local/offline.
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
    runner.ts          # shared orchestration, locking, prerequisites, rebuild/rerun, events
    booknlp.ts         # input/map preparation, Conda subprocess, normalized annotations
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
scripts/booknlp.py     # repository-owned non-installing Python adapter
test/                  # offline parsing, scripts, providers, voices, state, retry/UI tests
work/                  # gitignored per-book artifacts; work/alice/ is a sample run to inspect
0Meta/                 # gitignored background/design notes, when present
```

## Architecture in one paragraph

`convert` iterates ten stages: extract → analyze → chapters → booknlp → list-characters → script → casting → voices → synth → assemble. `STAGE_DEFINITIONS` is the canonical capability/prerequisite metadata. Canonical chapter text is frozen before BookNLP; Python code-point offsets are normalized into versioned annotations; Script slices the frozen input exactly. BookNLP and List Characters are whole-book stages, while Chapters/Script/Synth support chapter completion tracking.

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
- **Adding/reordering a stage** requires updating `STAGES`/`STAGE_DEFINITIONS`, runner dispatch/cleanup, and the UI metadata mirror. Stage order controls invalidation.
- **Stage contract**: read inputs via `work.readJson()` / files under `work.path(...)`, write outputs the same way, and stay idempotent — a stage may be re-run over existing partial output and must skip or overwrite cleanly.
- Tunables (concurrency, chunk sizes, voice slot count, bitrate) belong in `config.ts`, not inline.
- Route retry warnings through `reportWarning()` (`src/util/warnings.ts`) so the runner can deliver them to CLI or UI activity events. Keep provider credentials in Node and the UI server bound to `127.0.0.1`.
- Preserve the layout-only/punctuation-only guard, non-breaking-space normalization, exact-source coverage validation, and Unicode code-point offset handling, including non-BMP characters.
- `scripts/booknlp.py` must never install/download dependencies. Keep argument-array spawning, process-group cancellation, timeouts, raw outputs, and atomic publication.
- `corrections.json` and `manual-speaker-settings.json` are persistent user inputs; rebuild cleanup must retain them.
- Errors from the CLI should be user-actionable (see `checks.ts` for tone); the top-level handler prints `err.message` and exits 1.

## Testing

`npm test` runs offline Vitest tests covering EPUB/OPF parsing, markdown/text cleanup, script segment filtering, mocked OpenRouter LLM/TTS requests, catalogue parsing and migration, voice matching/manual overrides, source and chapter state, retry warning events, and UI activity rendering. Use these mocks for provider and orchestration regressions; no live API calls are needed for the suite. Run `npm run build` for TypeScript validation. Live output quality can be reviewed with an authorized `--dry-run` and artifact inspection; dry runs do not test TTS. Existing `work/alice/` output, when present, is useful reference material and may use older artifact formats.

## BookNLP, characters, and scripts

- Source readers create real plain text. Markdown is parsed structurally and PDF preparation preserves paragraph/dialogue boundaries where possible.
- `booknlp/input.txt` plus `chapter-map.json` freeze the whole-book annotation boundary using half-open Unicode code-point offsets. BookNLP 1.0.8 columns named `byte_onset`/`byte_offset` are actually Python character positions; never treat them as UTF-8 bytes or JS UTF-16 indexes.
- List Characters includes every attributed entity, not only filtered `.book` entries. Keep duplicate names distinct, pronouns separate from presentation, and reconcile application IDs only when unambiguous.
- Script is deterministic: quotations are character segments and all gaps/tags/actions are narrator segments. It must pass exact ordered coverage validation. Unresolved/cross-chapter quotes require manual review and block affected synthesis; there is no LLM fallback.

## Voice library

- Default path: `./library/voices.json`, relative to the current directory; override with `LISEN_VOICE_LIBRARY_FILE`. Voice commands also accept `--library`.
- The bundled version-2 catalogue supports listing and applying OpenAI/Fish bindings. Version 1 uses `maxChars`; version 2 uses structured `inputLimits`, where `null` means unknown. These metadata limits do not automatically replace the adapter's `config.ttsMaxChars` request splitter.
- `voices refresh` and legacy-array `voices import` write version-1 libraries and refuse to overwrite version 2. Use a separate library file. Fish refresh and synthesis are unimplemented; OpenRouter targets also require a separate compatible library.
- Keep desired profiles in version-2 `casting.json` separate from concrete version-1 `voice-bindings.json`. Applying voices validates all scripted speakers and backs up legacy casting to `casting.legacy.json` before migration.
- Preserve compatible manual bindings; incompatible manual choices must fail explicitly. Preserve catalogue metadata/annotations and unknown traits instead of inventing values. Model availability in the catalogue does not establish a working synthesis adapter.

## Gotchas

- The project requires Node 22.12+ because the current Commander dependency does too.
- `dist/` is gitignored build output; the `lisen` bin points at `dist/cli.js`, so `npm run build` before testing the installed binary.
- New work-dir slugs come from source title metadata; existing folders are rediscovered by saved source path or matching local content hash.
- `synth` splits plain script text at Unicode-safe boundaries, deduplicates in-flight hashes, and retains repeated manifest occurrences. Legacy Markdown scripts use an explicit format path only.
- Encoded chapters need matching manifest and encoding fingerprints; file existence is never freshness proof. Preserve `audio-cache/` MP3s and prior exports.
- CLI dependency checks are stage-specific: Analyze/Casting check the selected LLM provider, Synth checks the provider saved in `voice-bindings.json`, and only Assemble checks ffmpeg/ffprobe. Preparation and BookNLP need no API key.
- Synthesis uses the target saved in bindings rather than `LISEN_TTS_PROVIDER`; reapply voices explicitly when changing the book's target model.
- `run --json` emits a JSON result but stage code may also print progress/warnings; do not assume its entire stdout is a single JSON document.
