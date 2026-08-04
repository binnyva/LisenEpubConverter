# AGENTS.md

Guidance for coding agents working on this repo. See [README.md](README.md) for what the tool does and how to use it.

## What this is

A staged, resumable CLI pipeline (TypeScript, ESM, Node 20+) that turns an EPUB into a multi-voice M4B audiobook using OpenAI for analysis/dialogue-attribution and TTS, and ffmpeg for assembly.

## Commands

```bash
npm run dev -- convert book.epub   # run CLI from source via tsx
npm run build                      # tsc → dist/
npm test                           # vitest run — fully offline, safe to run anytime
npm run test:watch
```

## Cost warning — read before running the pipeline

`convert` spends real money on the OpenAI API:

- Stages `analyze`, `chapters`, `script`, `casting` make LLM calls (cheap-ish).
- Stage `synth` makes TTS calls — **the expensive part**.

Rules of thumb:

- Never run a full `convert` (or anything that reaches `synth`) without the user asking for it. Use `--dry-run`, which stops before synthesis.
- `extract` is fully offline; the unit tests are fully offline.
- TTS output is cached in `work/<slug>/audio-cache/` by sha256(text + voice + instructions + provider + model) — re-runs only pay for segments whose inputs changed. Don't casually change anything that feeds that cache key, or every segment re-synthesizes.

`OPENAI_API_KEY` is loaded from `.env` in the project root (plain `process.loadEnvFile` in `src/cli.ts` — no dotenv dependency). `.env` is gitignored; never commit or print it.

## Code map

```
src/
  cli.ts               # commander CLI: convert + status; runs stages in order
  config.ts            # env-var config, tunables, and the STAGES list (canonical stage order)
  state.ts             # WorkDir: work-dir layout, state.json manifest, resumability
  checks.ts            # startup checks: ffmpeg on PATH, API key set
  types.ts             # shared zod schemas / types for pipeline artifacts
  pipeline/            # one file per stage: extract, analyze, chapters, script,
                       #   casting, synth, assemble
  epub/                # EPUB unzip + OPF parsing (epub.ts), xhtml→markdown (markdown.ts)
  providers/
    llm/openai.ts      # jsonCall(): JSON-mode chat call + zod validation + retries
    tts/types.ts       # TTSProvider interface + Voice type
    tts/openai.ts      # OpenAI TTS implementation + getTTSProvider() registry
test/                  # vitest unit tests (epub parsing, markdown conversion, text utils)
work/                  # gitignored per-book artifacts; work/alice/ is a sample run to inspect
0Meta/Lisen Plan.md    # original design/implementation plan — background context
```

## Architecture in one paragraph

`cli.ts` runs the seven stages in `STAGES` order (`src/config.ts`). Each stage is a `run<Stage>(work)` function in `src/pipeline/` that reads the previous stage's artifacts from the `WorkDir` and writes its own — all artifacts are human-readable JSON/markdown so users can inspect and hand-edit between stages (notably `casting.json`). `WorkDir` (`src/state.ts`) records stage completion in `state.json` and clears it if the EPUB's hash changes; stages `chapters`, `script`, and `synth` additionally resume mid-stage by skipping per-chapter/per-segment outputs that already exist.

## Conventions

- **ESM with `.js` suffixes**: imports of local files use `./foo.js` even though sources are `.ts`. Keep this or the compiled output breaks.
- **All LLM calls go through `jsonCall()`** (`src/providers/llm/openai.ts`): JSON mode, a zod schema for the response, retries with the validation error fed back to the model. Don't call the OpenAI client directly from pipeline code; define/extend zod schemas for any new structured output.
- **TTS is behind `TTSProvider`** (`src/providers/tts/types.ts`). New providers: new file in `src/providers/tts/`, register in `getTTSProvider()` (`src/providers/tts/openai.ts`), select via `LISEN_TTS_PROVIDER`.
- **Adding/reordering a stage** touches two places: the `STAGES` const in `src/config.ts` and the `stages` array in `cli.ts`. Stage order is meaningful — `invalidateFrom()` clears a stage and everything after it.
- **Stage contract**: read inputs via `work.readJson()` / files under `work.path(...)`, write outputs the same way, and stay idempotent — a stage may be re-run over existing partial output and must skip or overwrite cleanly.
- Tunables (concurrency, chunk sizes, voice slot count, bitrate) belong in `config.ts`, not inline.
- Errors from the CLI should be user-actionable (see `checks.ts` for tone); the top-level handler prints `err.message` and exits 1.

## Testing

Tests are offline unit tests only (EPUB/OPF parsing, xhtml→markdown edge cases, text utilities). There is no mocked-LLM test layer; LLM/TTS behavior is verified manually with `--dry-run` on a sample book and by inspecting `work/<slug>/` artifacts. `work/alice/` holds a real run of *Alice in Wonderland* — useful as reference output when changing pipeline stages.

## Gotchas

- `dist/` is committed-adjacent build output but gitignored; the `lisen` bin points at `dist/cli.js`, so `npm run build` before testing the installed binary.
- The work-dir slug comes from the EPUB *filename*, not its metadata — renaming the file orphans its work directory.
- OpenAI TTS caps requests at 4096 chars; `synth` splits long segments at sentence boundaries under `config.ttsMaxChars` (4000). Keep that margin.
- ffmpeg and ffprobe are hard requirements checked at startup; `assemble` shells out to them.
