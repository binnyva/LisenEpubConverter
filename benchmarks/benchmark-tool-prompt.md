# Prompt: build the Script benchmark tool

Read `AGENTS.md` first. It is the source of truth for how the pipeline works, and its cost rules apply to everything below.

## What I want

Lisen's Script stage is the one LLM pass over a book's text: it attributes each quoted span to a speaker and discovers the cast. I want to know which OpenRouter model and reasoning level does that job best for the money. Build a benchmark tool that runs the Script stage on one fixed story under many model and reasoning combinations, scores each result against a hand-made reference script, and writes a comparison report.

The decision the report has to support is "which model and effort should be the default for Script", so quality, cost and wall time all need to be on one table.

## What already exists

Everything lives in `benchmarks/`:

- `benchmarks/0-target/script/00.json` is the reference: a hand-corrected script of Asimov's "The Last Question" (252 segments, 16 speakers plus the narrator). It has the same shape as a chapter script in `1-scripts/`.
- `benchmarks/0-target/chapters-clean/00.md` is the cleaned chapter text the reference was made from. **This file is the benchmark's source.** Every run starts from it, so each run's script has the same text as the reference and a score difference means an attribution difference.
- `benchmarks/legacy/` holds three earlier runs made by hand, all with `deepseek/deepseek-v4-flash-0731`, each a normal work folder plus its console logs:
  - `deepseek-v4-flash-0731--default/the-last-question/` (reasoning left to the provider; 76k completion tokens, 13 minutes)
  - `deepseek-v4-flash-0731--none/the-last-question/` (reasoning off; 42 seconds)
  - `deepseek-v4-flash-0731--low/the-last-question/` (low reasoning; 42k completion tokens, 8 minutes)

The legacy runs were made from the original web page, not the cleaned text: their chapter carries a 244-word biographical preface the reference drops, and their blocks were cut differently. They are not comparable with new runs, so keep them out of the report. Their use is as free fixtures while you develop the scorer, since they exercise the harder cases (extra text, renamed speakers, merged characters). The scorer must be able to score them when pointed at them. I will delete them once the tool works.

Before anything else, run Extract on the cleaned file (offline, free) and check that its text matches the reference script's text. The file is hard-wrapped and has no heading, so confirm paragraphs are joined correctly and the title and byline come out as the reference has them. If the two do not match, stop and tell me what differs rather than working around it.

Put new runs in `benchmarks/runs/<app-version-label>/<model-slug>--<effort>/`, with the work folder inside, the same shape as the legacy folders. The label is explained under "App versions" below.

## How a run should work

1. **Shared base.** Run Extract and Metadata once on the cleaned file into a base work folder and copy it for every configuration, so each configuration differs only in the Script stage. Metadata picks the script mode, and letting it vary per model would make the Script numbers incomparable. The legacy runs came out in `quoted` mode; check the base does too. Metadata is one small paid call, so it falls under the cost rules below.
2. **One configuration is one child process** of the CLI (`run <source> script --work <run folder>`) with its own environment. Configuration is read from `process.env`, so running configurations in one process would let them leak into each other. Run several at once, with a concurrency limit.
3. **Environment per run.** Set `LISEN_LLM_PROVIDER=openrouter`, `LISEN_SCRIPT_MODEL` (it covers both attribution and verification) and `LISEN_SCRIPT_REASONING_EFFORT`. Also:
   - Unset `LISEN_OPENROUTER_MAX_PRICE`. My `.env` may set a price cap, which would make OpenRouter refuse the expensive models.
   - Raise `LISEN_SCRIPT_MAX_COMPLETION_TOKENS` well above its 8192 default for reasoning runs. Reasoning tokens count against it, and hitting the cap is a non-retryable failure.
   - Raise `LISEN_LLM_RESPONSE_TIMEOUT_MS` above its 120 second default. A single block took about 100 seconds at low reasoning on the cheapest model.
   - Set `LISEN_OPENROUTER_TRACE_FILE` to a file in the run folder, so a surprising score can be traced to the actual request and reply.
4. **A failed run is a result, not an error.** The Script stage stops when a speaker is still unresolved after verification (this happened on the first reasoning-off run), and a model can also hit the token cap, reject the reasoning setting, or keep returning invalid JSON. Record the outcome and the reason, keep going with the other configurations, and never resolve speakers by hand or by rerunning until it passes. A blocked chapter leaves its verified segments in the checkpoint's `result` (`src/pipeline/checkpoint.ts`), so score those and count the unresolved lines as wrong.
5. **Resumable.** A configuration that already has a finished run record under the same app-version label is skipped unless I ask to redo it. Support repeating a configuration N times (default 1), since one run of a model is one sample.
6. **Save a run record** in each run folder: model, effort, start time, wall time, outcome and failure reason, exit code, token counts from `usage.json`, the number of retries and validation failures, the console log, and the app version described below.

## App versions

I will run this benchmark again whenever the pipeline changes, for example after adding a second attribution pass, and I want to see whether the change helped. So every run has to record which version of the app produced it, and the report has to compare versions.

- **Label.** Each benchmark invocation takes a short label I choose, such as `baseline` or `two-pass`, and it is the folder the runs go in. If I give none, derive one from the date and the short commit hash. Results for one label never overwrite another's.
- **What to record per run.** The label, the git commit and branch, whether the working tree had uncommitted changes, the `package.json` version, and a content hash of the pipeline's source (`src/`). The content hash matters because I often benchmark uncommitted work, where the commit alone would say two different pipelines are the same. Also record the effective tunables that shape Script (chunk sizes, quote cap, verification batch size, completion-token cap, timeout) and an optional free-text note from the command line saying what changed.
- **Guard the label.** If I reuse a label and the source hash differs from the runs already under it, stop and say so, so one label never mixes two pipelines. Give me a flag to override.
- **Base folder per label.** The shared Extract and Metadata base belongs to the label, since a pipeline change can alter either stage. Reuse the previous label's base only when the source hash shows those stages are unchanged; otherwise rebuild it and say that it costs one Metadata call.
- **Report across versions.** The main table covers one label, the latest by default. Add a comparison section that lines up the same model and effort across labels and shows the change in attribution accuracy, cost, calls and wall time, so a new pass that costs twice as much for one point of accuracy is obvious. Configurations present in only one label are listed but not compared.
- **Scoring is not versioned with the app.** The scorer is offline and re-scores every saved run each time the report is built, so a scoring change applies to all labels equally. Do not store scores as the only record of a run; the saved script and run record are the record.

A new pass will show up in the existing run facts as more calls and tokens. If `usage.json` lets you split spend by call type or pass without changing the pipeline, show that split; if it does not, say so and leave it out.

## Cost safety

Every run spends real money, so the tool needs to make spending deliberate:

- Before any paid call, print the matrix with an estimated cost per run and in total, and require an explicit confirmation flag to proceed. A plan-only mode should print this and exit.
- Validate every model id against `https://openrouter.ai/api/v1/models` (public, no key needed) before starting, and take prices and the `supported_parameters` list from there. A model that does not list `reasoning` gets only the `default` effort.
- Report the cost of each finished run. Use the cost OpenRouter reports if `jsonCall` can capture it without disturbing the usage logging; otherwise compute it from the token counts and the listed prices and label it as an estimate. Reasoning tokens are already included in completion tokens.

While building this, do not run the paid matrix yourself. Develop the scorer against the three legacy runs, which costs nothing. When the runner is ready, ask me before making any paid call, and start with a single cheap configuration.

## Scoring

The scorer is offline, pure, and takes any folder that has a `1-scripts/` chapter file, so it works on the legacy runs and can be re-run when the scoring changes. This benchmark measures speaker attribution and cast discovery. Starting from clean text gives a model almost nothing to correct, so cleanup quality is deliberately not measured.

Three things I found comparing the legacy runs to the reference shape how the scorer has to work:

- **Align on text, not on segment indexes.** New runs start from the reference's text, but segments can still be cut differently (the legacy runs have 237 against the reference's 252) and a cleanup edit can change a word. Normalise both sides, align them with a diff, and compare who speaks each stretch of text. Text present on only one side is a text-fidelity finding and must not count for or against attribution. On new runs that finding should be close to empty, and anything else is worth flagging; on the legacy runs it will show the preface.
- **Speaker names do not match literally.** The runs produced `Man (chapter 1)`, `the one man (chapter 1)` and `VJ-23X of Lameth` where the reference has `Man`, `One man` and `VJ-23X`. Map run speakers to reference speakers before scoring: use an alias file kept beside the reference for known equivalents, then a best-overlap one-to-one assignment for the rest. Report which mapping was used, so a wrong mapping is visible.
- **Merged characters are the interesting failure.** The reference has `Cosmic AC`, `Galactic AC`, `Universal AC` and `AC` as separate speakers and `Man` separate from `One man`; all three runs folded the computers into `Universal AC`. A one-to-one mapping will score the folded lines as wrong, which is correct for a multi-voice audiobook, but report merges and splits separately from plain misattributions because they are a different kind of error.

Metrics I want per run:

- **Dialogue attribution accuracy**: of the reference's character lines, the share given to the right speaker, counted both per line and weighted by words.
- **Narrator boundary errors**: narration given to a character, and character speech given to the narrator. These are the errors a listener hears most.
- **Cast**: characters found, missing, extra, merged and split against the reference.
- **Text fidelity**: words added and removed against the reference text.
- **Run facts**: outcome, calls, prompt, completion and reasoning tokens, wall time, cost, retries, unresolved speakers, and the count of low-confidence segments.

Pause segments and the `delivery` field are worth a count in the report but not a score.

If you find the reference itself is wrong somewhere (I noticed a `PREDECESORS` typo and some lines in single quotes), tell me rather than editing it.

## Report

Write a machine-readable results file and a Markdown report into `benchmarks/`. The report opens with one table of all runs sorted by attribution accuracy, with cost and wall time beside it, then a short section per run listing the lines it got wrong (reference speaker, run speaker, the first words of the line) so I can judge whether the errors are reasonable. When a configuration was repeated, show the mean and the spread.

## Models

Keep the matrix in a JSON file under `benchmarks/` that I can edit, and let the command line select a subset by model or effort. Start it with the list below. The ids and prices (US dollars per million tokens, prompt/completion) come from OpenRouter's model list on 2026-11-11; re-check them at run time as described above.

Frontier, efforts `none`, `low`, `high`:

- `anthropic/claude-opus-5.5` (4 / 20)
- `openai/gpt-6.1-sol` (2 / 10)
- `google/gemini-4-carbon` (2 / 10)

Mid-range, efforts `none`, `low`, `high`:

- `anthropic/claude-sonnet-5.5` (2 / 10)
- `x-ai/grok-4.7` (2 / 6)
- `openai/gpt-6.1-terra` (1 / 5)
- `google/gemini-3.8-flash` (0.83 / 4.12)
- `mistralai/mistral-large-4-0` (0.70 / 2.10)
- `deepseek/deepseek-v4-pro-0813` (0.11 / 4.44)
- `z-ai/glm-5.3` (0.07 / 1.40)

Cheap, efforts `none`, `low`, `medium`, `high`:

- `anthropic/claude-haiku-5.5` (0.10 / 0.50)
- `openai/gpt-6-luna` (0.10 / 0.50)
- `meta/muse-ember` (0.10 / 0.50)
- `qwen/qwen3.8-flash` (0.15 / 0.47)
- `minimax/minimax-m3.1-flash` (0.15 / 0.60)
- `deepseek/deepseek-v4-flash-0731` (0.04 / 0.30), the model the legacy runs used; add `default` to its efforts so all three legacy settings are repeated on the clean text
- `deepseek/deepseek-v4.1-flash-1017` (0.006 / 0.50)
- `z-ai/glm-5.3-flash` (0.04 / 0.08)
- `inclusionai/ling-3.0-tiny` (0.015 / 0.045), a floor to show where quality falls off

Some models may not allow reasoning to be switched off, or may reject a particular effort. Record that as the run's outcome and move on. Always report the reasoning tokens actually used, so a `none` run that reasoned anyway shows up.

## Constraints

- Follow the repo conventions in `AGENTS.md`: ESM with `.js` import suffixes, tunables in `config.ts`, user-actionable errors.
- Do not change pipeline behaviour, prompts, chunking or hashes to suit the benchmark. If the tool needs something the pipeline does not expose, such as per-call cost, add it without changing what existing runs produce.
- Do not touch `work/` or any `2-audio-cache/`. The benchmark never reaches Casting, Synth or Assemble.
- Add offline tests for the scorer: text alignment, speaker mapping, merge and split detection, and scoring a blocked run from its checkpoint. `npm test` must stay offline, and `npm run build` must pass.
- Add an npm script for the tool and a short section in `README.md` on how to run it and read the report.

## Done means

- You have confirmed the cleaned file extracts to the reference's text, or told me where it does not.
- The scorer works on the three legacy runs with no network access, and you have shown me their scores.
- The plan-only mode prints the full matrix with estimated costs.
- The runner is tested offline with a stubbed child process, and has made no paid call without my go-ahead.
- You have told me anything in the reference script that looks wrong, and anything about the legacy runs that the scores reveal.
