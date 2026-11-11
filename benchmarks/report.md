# Script benchmark

Generated 2026-11-11T18:33:36.560Z. Scores are recomputed from the saved scripts every time this report is built.

Reference: "The Last Question", 256 segments, 144 scorable character lines (1 more have no double quotation marks, so quoted-mode Script cannot attribute them; they are left out: Galactic AC "THERE IS INSUFFICIENT DATA FOR A MEANING…").

## Results: baseline

Commit `920e654cb8` on `new-flow` with uncommitted changes · source hash `a5336e00992be66f` · package 0.1.0

Sorted by the share of character lines given to the right speaker. Runs whose text covers less than 95.0% of the reference lines (⚠) are ranked below the rest. With repeats, values are means with the range in brackets. "est." marks a cost computed from tokens and listed prices rather than reported by OpenRouter.

| # | Model | Effort | Runs | Outcome | Lines right | Words right | Narration → char (words) | Speech → narrator | Merges / splits | Cost | Wall | Calls | Tokens in / out (reasoning) | Low conf. | Retries / invalid |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `qwen/qwen3.8-flash` | high | 1 | completed | 100.0% | 100.0% | 0 | 0 | 0 / 0 | $0.039 | 23m 12s | 8 | 21k / 80k (75k) | 0 | 0 / 0 |
| 2 | `google/gemini-4-carbon` | low | 3 | completed ×3 | 100.0% | 100.0% | 0 | 0 | 0 / 0 | $0.092 ($0.091–$0.092) | 4m 38s (1m 34s–10m 41s) | 7 (7–8) | 24k / 4.4k (0) | 0 | 2 (0–5) / 0 |
| 3 | `google/gemini-4-carbon` | high | 1 | completed | 100.0% | 100.0% | 0 | 0 | 0 / 0 | $0.857 | 22m 45s | 7 | 24k / 81k (77k) | 0 | 4 / 0 |
| 4 | `deepseek/deepseek-v4-flash-0731` | default | 1 | completed | 98.6% | 99.2% | 0 | 0 | 1 / 0 | $0.019 | 9m 17s | 8 | 20k / 52k (47k) | 0 | 0 / 0 |
| 5 | `deepseek/deepseek-v4.1-flash-1017` | high | 1 | completed | 98.6% | 99.2% | 0 | 0 | 1 / 0 | $0.023 | 2m 51s | 10 | 25k / 38k (32k) | 28 | 0 / 0 |
| 6 | `anthropic/claude-opus-5.5` | low | 1 | completed | 98.6% | 99.2% | 0 | 0 | 1 / 0 | $0.243 | 1m 11s | 8 | 34k / 5.3k (0) | 0 | 0 / 0 |
| 7 | `anthropic/claude-opus-5.5` | high | 1 | completed | 98.6% | 99.2% | 0 | 0 | 1 / 0 | $0.294 | 1m 37s | 8 | 36k / 7.6k (1.8k) | 0 | 0 / 0 |
| 8 | `x-ai/grok-4.7` | high | 1 | completed | 98.6% | 99.2% | 0 | 0 | 1 / 0 | $0.323 | 12m 05s | 7 | 29k / 47k (43k) | 0 | 4 / 0 |
| 9 | `google/gemini-3.8-flash` | low | 1 | completed | 98.6% | 99.1% | 0 | 0 | 1 / 0 | $0.035 | 48s | 7 | 22k / 4.8k (0) | 0 | 0 / 0 |
| 10 | `google/gemini-3.8-flash` | high | 1 | completed | 98.6% | 99.1% | 0 | 0 | 1 / 0 | $0.323 | 12m 41s | 7 | 22k / 82k (77k) | 0 | 4 / 0 |
| 11 | `deepseek/deepseek-v4.1-flash-1017` | low | 3 | completed ×3 | 98.4% (97.9%–98.6%) | 99.0% (98.7%–99.2%) | 0 | 0 | 1 / 0 | $0.016 ($0.013–$0.018) | 2m 01s (1m 44s–2m 13s) | 8 (8–9) | 21k / 23k (19k) | 5 (0–14) | 0 / 0 |
| 12 | `x-ai/grok-4.7` | low | 1 | blocked | 97.9% | 98.7% | 0 | 0 | 1 / 0 | $0.133 | 2m 29s | 8 | 31k / 14k (10k) | 1 | 0 / 0 |
| 13 | `openai/gpt-6-luna` | high | 1 | completed | 97.9% | 98.4% | 0 | 0 | 2 / 1 | $0.0085 | 1m 04s | 7 | 19k / 12k (9.2k) | 0 | 0 / 0 |
| 14 | `z-ai/glm-5.3` | high | 3 | completed ×3 | 97.7% (96.5%–98.6%) | 98.6% (98.1%–99.2%) | 0 | 0 | 2 (1–2) / 0 (0–1) | $0.042 ($0.033–$0.052) | 2m 22s (1m 33s–3m 25s) | 8 | 19k / 19k (14k) | 0 | 0 / 0 |
| 15 | `qwen/qwen3.8-flash` | none | 1 | completed | 97.2% | 98.3% | 0 | 0 | 1 / 0 | $0.0042 | 1m 02s | 8 | 20k / 4.8k (0) | 0 | 0 / 0 |
| 16 | `openai/gpt-6-luna` | medium | 1 | completed | 97.2% | 98.3% | 0 | 0 | 1 / 0 | $0.0060 | 40s | 8 | 20k / 7.1k (4.1k) | 0 | 0 / 0 |
| 17 | `openai/gpt-6-luna` | low | 1 | completed | 96.5% | 97.5% | 0 | 0 | 2 / 0 | $0.0057 | 35s | 11 | 27k / 4.6k (1.1k) | 37 | 0 / 0 |
| 18 | `anthropic/claude-haiku-5.5` | medium | 1 | completed | 96.5% | 95.7% | 0 | 0 | 2 / 1 | $0.013 | 1m 14s | 10 | 45k / 17k (11k) | 0 | 0 / 0 |
| 19 | `z-ai/glm-5.3` | low | 1 | completed | 95.8% | 97.6% | 0 | 0 | 2 / 0 | $0.020 | 35s | 8 | 20k / 5.2k (1.0k) | 0 | 0 / 0 |
| 20 | `deepseek/deepseek-v4-flash-0731` | none | 1 | completed | 95.1% | 95.7% | 0 | 0 | 1 / 0 | $0.0033 | 29s | 8 | 20k / 4.1k (0) | 0 | 0 / 0 |
| 21 | `deepseek/deepseek-v4-flash-0731` | medium | 1 | completed | 95.1% | 95.7% | 0 | 0 | 1 / 0 | $0.011 | 3m 40s | 8 | 21k / 32k (26k) | 0 | 0 / 0 |
| 22 | `deepseek/deepseek-v4.1-flash-1017` | medium | 1 | completed | 95.1% | 95.7% | 0 | 0 | 1 / 0 | $0.018 | 1m 53s | 8 | 19k / 21k (17k) | 0 | 0 / 0 |
| 23 | `deepseek/deepseek-v4-pro-0813` | high | 1 | completed | 95.1% | 95.7% | 0 | 0 | 1 / 0 | $0.111 | 8m 25s | 7 | 20k / 36k (33k) | 0 | 0 / 0 |
| 24 | `qwen/qwen3.8-flash` | medium | 3 | completed ×3 | 94.7% (85.4%–100.0%) | 95.5% (87.4%–100.0%) | 0 | 0 | 1 (0–2) / 0 (0–1) | $0.038 ($0.032–$0.046) | 20m 14s (17m 28s–25m 20s) | 8 | 21k / 77k (71k) | 0 | 0 / 0 |
| 25 | `anthropic/claude-sonnet-5.5` | low | 1 | completed | 94.4% | 95.9% | 0 | 0 | 1 / 0 | $0.122 | 37s | 8 | 35k / 5.2k (0) | 0 | 0 / 0 |
| 26 | `anthropic/claude-haiku-5.5` | high | 1 | completed | 94.4% | 94.8% | 0 | 0 | 1 / 0 | $0.014 | 1m 26s | 8 | 35k / 20k (14k) | 0 | 0 / 0 |
| 27 | `z-ai/glm-5.3-flash` | high | 3 | completed ×2, blocked ×1 | 94.2% (93.8%–95.1%) | 95.7% (94.8%–97.2%) | 0 | 0 | 1 (1–2) / 0 | $0.0064 ($0.0059–$0.0072) | 1m 13s (52s–1m 37s) | 9 (8–10) | 21k / 11k (6.4k) | 6 (0–18) | 0 / 0 |
| 28 | `deepseek/deepseek-v4-flash-0731` | high | 3 | completed ×3 | 94.2% (88.9%–100.0%) | 95.3% (90.9%–100.0%) | 0 | 0 | 1 (0–2) / 0 | $0.016 ($0.014–$0.019) | 11m 19s (8m 22s–14m 32s) | 9 (8–10) | 22k / 57k (52k) | 2 (0–5) | 0 / 1 (0–2) |
| 29 | `z-ai/glm-5.3-flash` | medium | 1 | completed | 93.8% | 94.8% | 0 | 0 | 2 / 0 | $0.0066 | 1m 01s | 10 | 24k / 9.2k (4.4k) | 31 | 0 / 0 |
| 30 | `deepseek/deepseek-v4-flash-0731` | low | 1 | completed | 93.8% | 94.8% | 0 | 0 | 2 / 0 | $0.016 | 7m 09s | 9 | 23k / 50k (45k) | 0 | 0 / 1 |
| 31 | `anthropic/claude-sonnet-5.5` | high | 1 | completed | 93.8% | 94.8% | 0 | 0 | 1 / 0 | $0.141 | 48s | 8 | 35k / 7.1k (1.9k) | 0 | 0 / 0 |
| 32 | `openai/gpt-6-luna` | none | 1 | completed | 93.1% | 94.0% | 0 | 0 | 1 / 0 | $0.0039 | 18s | 8 | 20k / 2.9k (0) | 0 | 0 / 0 |
| 33 | `mistralai/mistral-large-4-0` | low | 1 | completed | 92.4% | 94.5% | 0 | 0 | 1 / 0 | $0.113 | 6m 28s | 7 | 21k / 47k (42k) | 0 | 0 / 0 |
| 34 | `z-ai/glm-5.3-flash` | low | 1 | blocked | 92.4% | 93.7% | 0 | 0 | 2 / 1 | $0.0066 | 46s | 12 | 29k / 6.1k (1.2k) | 53 | 0 / 0 |
| 35 | `anthropic/claude-haiku-5.5` | low | 1 | blocked | 92.4% | 92.1% | 0 | 0 | 1 / 0 | $0.010 | 52s | 9 | 42k / 12k (5.7k) | 1 | 0 / 0 |
| 36 | `minimax/minimax-m3.1-flash` | medium | 1 | completed | 91.7% | 90.4% | 0 | 0 | 1 / 0 | $0.0054 | 54s | 9 | 22k / 4.5k (309) | 14 | 0 / 0 |
| 37 | `deepseek/deepseek-v4-pro-0813` | none | 1 | completed | 91.0% | 92.0% | 0 | 6 | 1 / 0 | $0.051 | 1m 00s | 11 | 28k / 5.0k (0) | 40 | 0 / 0 |
| 38 | `mistralai/mistral-large-4-0` | high | 1 | completed | 91.0% | 90.8% | 0 | 0 | 1 / 0 | $0.120 | 6m 36s | 7 | 21k / 49k (45k) | 0 | 0 / 0 |
| 39 | `deepseek/deepseek-v4.1-flash-1017` | none | 1 | completed | 90.3% | 91.9% | 0 | 0 | 1 / 0 | $0.0046 | 24s | 9 | 23k / 4.2k (0) | 0 | 0 / 0 |
| 40 | `anthropic/claude-haiku-5.5` | none | 1 | completed | 89.6% | 91.0% | 0 | 0 | 2 / 0 | $0.0079 | 33s | 11 | 46k / 6.4k (0) | 35 | 0 / 0 |
| 41 | `minimax/minimax-m3.1-flash` | low | 1 | completed | 89.6% | 89.7% | 0 | 0 | 1 / 1 | $0.0045 | 44s | 8 | 20k / 3.7k (0) | 1 | 0 / 0 |
| 42 | `qwen/qwen3.8-flash` | low | 1 | completed | 88.9% | 90.9% | 0 | 0 | 2 / 0 | $0.044 | 22m 41s | 8 | 21k / 89k (83k) | 0 | 0 / 0 |
| 43 | `minimax/minimax-m3.1-flash` | high | 1 | completed | 88.9% | 88.5% | 0 | 0 | 2 / 0 | $0.0041 | 32s | 8 | 20k / 3.3k (0) | 1 | 0 / 0 |
| 44 | `deepseek/deepseek-v4-pro-0813` | low | 1 | completed | 85.4% | 87.4% | 0 | 0 | 2 / 0 | $0.101 | 5m 40s | 8 | 21k / 29k (25k) | 0 | 0 / 0 |
| 45 | `inclusionai/ling-3.0-tiny` | medium | 1 | failed | 68.8% | 61.7% | 4 | 0 | 5 / 7 | $0.0055 | 13m 08s | 8 | 21k / 119k (113k) | 6 | 0 / 0 |
| 46 | `inclusionai/ling-3.0-tiny` | low | 1 | blocked | 66.7% | 62.4% | 2 | 7 | 2 / 4 | $0.0079 | 18m 59s | 8 | 20k / 171k (165k) | 4 | 0 / 0 |
| 47 | `inclusionai/ling-3.0-tiny` | high | 1 | failed | 37.5% | 31.2% | 2 | 37 | 3 / 3 | $0.011 | 27m 09s | 8 | 22k / 235k (230k) | 26 | 0 / 0 |
| 48 | `inclusionai/ling-3.0-tiny` | none | 1 | failed | 16.7% | 13.0% | 0 | 0 | 3 / 6 | $0.0006 | 51s | 8 | 22k / 7.1k (0) | 10 | 0 / 0 |
| 49 | `anthropic/claude-opus-5.5` | none | 1 | rejected | – | – | – | – | – / – | $0.0000 | 2s | 0 | 0 / 0 (0) | – | 0 / 0 |
| 50 | `anthropic/claude-sonnet-5.5` | none | 1 | rejected | – | – | – | – | – / – | $0.0000 | 1s | 0 | 0 / 0 (0) | – | 0 / 0 |
| 51 | `google/gemini-3.8-flash` | none | 1 | rejected | – | – | – | – | – / – | $0.0000 | 1s | 0 | 0 / 0 (0) | – | 0 / 0 |
| 52 | `google/gemini-4-carbon` | none | 1 | rejected | – | – | – | – | – / – | $0.0000 | 1s | 0 | 0 / 0 (0) | – | 0 / 0 |
| 53 | `meta/muse-ember` | high | 1 | rejected | – | – | – | – | – / – | $0.0000 | 2s | 0 | 0 / 0 (0) | – | 0 / 0 |
| 54 | `meta/muse-ember` | low | 1 | rejected | – | – | – | – | – / – | $0.0000 | 2s | 0 | 0 / 0 (0) | – | 0 / 0 |
| 55 | `meta/muse-ember` | medium | 1 | rejected | – | – | – | – | – / – | $0.0000 | 2s | 0 | 0 / 0 (0) | – | 0 / 0 |
| 56 | `meta/muse-ember` | none | 1 | rejected | – | – | – | – | – / – | $0.0000 | 1s | 0 | 0 / 0 (0) | – | 0 / 0 |
| 57 | `minimax/minimax-m3.1-flash` | none | 1 | rejected | – | – | – | – | – / – | $0.0000 | 1s | 0 | 0 / 0 (0) | – | 0 / 0 |
| 58 | `mistralai/mistral-large-4-0` | none | 1 | rejected | – | – | – | – | – / – | $0.0000 | 5s | 0 | 0 / 0 (0) | – | 0 / 0 |
| 59 | `openai/gpt-6.1-sol` | high | 1 | rejected | – | – | – | – | – / – | $0.0000 | 2s | 0 | 0 / 0 (0) | – | 0 / 0 |
| 60 | `openai/gpt-6.1-sol` | low | 1 | rejected | – | – | – | – | – / – | $0.0000 | 2s | 0 | 0 / 0 (0) | – | 0 / 0 |
| 61 | `openai/gpt-6.1-sol` | none | 1 | rejected | – | – | – | – | – / – | $0.0000 | 2s | 0 | 0 / 0 (0) | – | 0 / 0 |
| 62 | `openai/gpt-6.1-terra` | high | 1 | rejected | – | – | – | – | – / – | $0.0000 | 2s | 0 | 0 / 0 (0) | – | 0 / 0 |
| 63 | `openai/gpt-6.1-terra` | low | 1 | rejected | – | – | – | – | – / – | $0.0000 | 2s | 0 | 0 / 0 (0) | – | 0 / 0 |
| 64 | `openai/gpt-6.1-terra` | none | 1 | rejected | – | – | – | – | – / – | $0.0000 | 1s | 0 | 0 / 0 (0) | – | 0 / 0 |
| 65 | `x-ai/grok-4.7` | none | 1 | rejected | – | – | – | – | – / – | $0.0000 | 2s | 0 | 0 / 0 (0) | – | 0 / 0 |
| 66 | `z-ai/glm-5.3` | none | 1 | rejected | – | – | – | – | – / – | $0.0000 | 1s | 0 | 0 / 0 (0) | – | 0 / 0 |
| 67 | `z-ai/glm-5.3-flash` | none | 1 | rejected | – | – | – | – | – / – | $0.0000 est. | 1s | 0 | 0 / 0 (0) | – | 0 / 0 |

## Spend by call type

From the request traces; usage.json records only totals per stage. Per run, mean over repeats: calls · tokens in/out · cost.

| Model | Effort | attribution | verification |
|---|---|---|---|
| `qwen/qwen3.8-flash` | high | 7.0 calls · 19k/75k · $0.036 | 1.0 calls · 1.6k/4.8k · $0.0024 |
| `google/gemini-4-carbon` | low | 7.0 calls · 24k/4.4k · $0.092 | – |
| `google/gemini-4-carbon` | high | 7.0 calls · 24k/81k · $0.857 | – |
| `deepseek/deepseek-v4-flash-0731` | default | 7.0 calls · 19k/52k · $0.019 | 1.0 calls · 797/549 · $0.0002 |
| `deepseek/deepseek-v4.1-flash-1017` | high | 7.0 calls · 18k/25k · $0.015 | 3.0 calls · 6.4k/13k · $0.0086 |
| `anthropic/claude-opus-5.5` | low | 7.0 calls · 33k/5.3k · $0.236 | 1.0 calls · 1.5k/38 · $0.0067 |
| `anthropic/claude-opus-5.5` | high | 7.0 calls · 33k/7.1k · $0.273 | 1.0 calls · 2.9k/462 · $0.021 |
| `x-ai/grok-4.7` | high | 7.0 calls · 29k/47k · $0.323 | – |
| `google/gemini-3.8-flash` | low | 7.0 calls · 22k/4.8k · $0.035 | – |
| `google/gemini-3.8-flash` | high | 7.0 calls · 22k/82k · $0.323 | – |
| `deepseek/deepseek-v4.1-flash-1017` | low | 7.0 calls · 19k/22k · $0.015 | 1.3 calls · 2.1k/974 · $0.0009 |
| `x-ai/grok-4.7` | low | 7.0 calls · 29k/13k · $0.125 | 1.0 calls · 2.1k/941 · $0.0081 |
| `openai/gpt-6-luna` | high | 7.0 calls · 19k/12k · $0.0085 | – |
| `z-ai/glm-5.3` | high | 7.0 calls · 18k/18k · $0.041 | 1.0 calls · 1.3k/412 · $0.0013 |
| `qwen/qwen3.8-flash` | none | 7.0 calls · 19k/4.7k · $0.0040 | 1.0 calls · 1.1k/117 · $0.0002 |
| `openai/gpt-6-luna` | medium | 7.0 calls · 19k/6.9k · $0.0058 | 1.0 calls · 745/158 · $0.0002 |
| `openai/gpt-6-luna` | low | 7.0 calls · 19k/3.4k · $0.0041 | 4.0 calls · 8.3k/1.1k · $0.0016 |
| `anthropic/claude-haiku-5.5` | medium | 7.0 calls · 33k/15k · $0.011 | 3.0 calls · 13k/2.3k · $0.0024 |
| `z-ai/glm-5.3` | low | 7.0 calls · 18k/5.0k · $0.019 | 1.0 calls · 1.9k/202 · $0.0014 |
| `deepseek/deepseek-v4-flash-0731` | none | 7.0 calls · 19k/4.1k · $0.0032 | 1.0 calls · 782/42 · $0.0000 |
| `deepseek/deepseek-v4-flash-0731` | medium | 7.0 calls · 20k/31k · $0.011 | 1.0 calls · 1.2k/1.2k · $0.0005 |
| `deepseek/deepseek-v4.1-flash-1017` | medium | 7.0 calls · 18k/20k · $0.017 | 1.0 calls · 1.1k/764 · $0.0004 |
| `deepseek/deepseek-v4-pro-0813` | high | 7.0 calls · 20k/36k · $0.111 | – |
| `qwen/qwen3.8-flash` | medium | 7.0 calls · 19k/69k · $0.034 | 1.0 calls · 1.5k/7.8k · $0.0039 |
| `anthropic/claude-sonnet-5.5` | low | 7.0 calls · 33k/5.1k · $0.116 | 1.0 calls · 2.6k/121 · $0.0064 |
| `anthropic/claude-haiku-5.5` | high | 7.0 calls · 33k/19k · $0.013 | 1.0 calls · 2.9k/769 · $0.0007 |
| `z-ai/glm-5.3-flash` | high | 7.0 calls · 18k/8.9k · $0.0055 | 1.7 calls · 2.8k/1.7k · $0.0009 |
| `deepseek/deepseek-v4-flash-0731` | high | 7.7 calls · 21k/54k · $0.015 | 1.0 calls · 1.0k/3.5k · $0.0010 |
| `z-ai/glm-5.3-flash` | medium | 7.0 calls · 18k/7.3k · $0.0047 | 3.0 calls · 6.3k/1.9k · $0.0019 |
| `deepseek/deepseek-v4-flash-0731` | low | 8.0 calls · 22k/49k · $0.016 | 1.0 calls · 1.2k/891 · $0.0004 |
| `anthropic/claude-sonnet-5.5` | high | 7.0 calls · 33k/7.1k · $0.136 | 1.0 calls · 2.4k/97 · $0.0057 |
| `openai/gpt-6-luna` | none | 7.0 calls · 19k/2.9k · $0.0038 | 1.0 calls · 614/28 · $0.0001 |
| `mistralai/mistral-large-4-0` | low | 7.0 calls · 21k/47k · $0.113 | – |
| `z-ai/glm-5.3-flash` | low | 7.0 calls · 18k/4.5k · $0.0044 | 5.0 calls · 12k/1.6k · $0.0021 |
| `anthropic/claude-haiku-5.5` | low | 7.0 calls · 33k/11k · $0.0088 | 2.0 calls · 9.1k/548 · $0.0012 |
| `minimax/minimax-m3.1-flash` | medium | 7.0 calls · 19k/4.1k · $0.0047 | 2.0 calls · 3.5k/343 · $0.0007 |
| `deepseek/deepseek-v4-pro-0813` | none | 7.0 calls · 19k/3.7k · $0.036 | 4.0 calls · 9.3k/1.2k · $0.016 |
| `mistralai/mistral-large-4-0` | high | 7.0 calls · 21k/49k · $0.120 | – |
| `deepseek/deepseek-v4.1-flash-1017` | none | 7.0 calls · 19k/4.0k · $0.0043 | 2.0 calls · 3.2k/207 · $0.0004 |
| `anthropic/claude-haiku-5.5` | none | 7.0 calls · 32k/5.3k · $0.0058 | 4.0 calls · 14k/1.2k · $0.0020 |
| `minimax/minimax-m3.1-flash` | low | 7.0 calls · 19k/3.7k · $0.0044 | 1.0 calls · 789/28 · $0.0001 |
| `qwen/qwen3.8-flash` | low | 7.0 calls · 19k/84k · $0.041 | 1.0 calls · 1.5k/4.3k · $0.0022 |
| `minimax/minimax-m3.1-flash` | high | 7.0 calls · 19k/3.3k · $0.0040 | 1.0 calls · 766/28 · $0.0001 |
| `deepseek/deepseek-v4-pro-0813` | low | 7.0 calls · 19k/25k · $0.089 | 1.0 calls · 1.8k/3.5k · $0.012 |
| `inclusionai/ling-3.0-tiny` | medium | 7.0 calls · 19k/107k · $0.0050 | 1.0 calls · 1.5k/11k · $0.0005 |
| `inclusionai/ling-3.0-tiny` | low | 7.0 calls · 19k/148k · $0.0069 | 1.0 calls · 1.2k/23k · $0.0011 |
| `inclusionai/ling-3.0-tiny` | high | 7.0 calls · 19k/182k · $0.0084 | 1.0 calls · 2.7k/53k · $0.0024 |
| `inclusionai/ling-3.0-tiny` | none | 7.0 calls · 19k/6.4k · $0.0005 | 1.0 calls · 2.8k/663 · $0.0001 |
| `anthropic/claude-opus-5.5` | none | – | – |
| `anthropic/claude-sonnet-5.5` | none | – | – |
| `google/gemini-3.8-flash` | none | – | – |
| `google/gemini-4-carbon` | none | – | – |
| `meta/muse-ember` | high | – | – |
| `meta/muse-ember` | low | – | – |
| `meta/muse-ember` | medium | – | – |
| `meta/muse-ember` | none | – | – |
| `minimax/minimax-m3.1-flash` | none | – | – |
| `mistralai/mistral-large-4-0` | none | – | – |
| `openai/gpt-6.1-sol` | high | – | – |
| `openai/gpt-6.1-sol` | low | – | – |
| `openai/gpt-6.1-sol` | none | – | – |
| `openai/gpt-6.1-terra` | high | – | – |
| `openai/gpt-6.1-terra` | low | – | – |
| `openai/gpt-6.1-terra` | none | – | – |
| `x-ai/grok-4.7` | none | – | – |
| `z-ai/glm-5.3` | none | – | – |
| `z-ai/glm-5.3-flash` | none | – | – |

## Version comparison

Only one label has runs, so there is nothing to compare yet.

## Runs: baseline

### `qwen/qwen3.8-flash` · high

Folder `runs/baseline/qwen_qwen3.8-flash--high` · completed
8 calls · 20,832 prompt + 79,513 completion tokens (74,527 reasoning) · 23m 12s · $0.039 · 0 retries, 0 invalid replies
Scored from the saved script: 144/144 lines right (100.0%), 100.0% of words.
Cast 15/15.
- Mapping: the man whose thoughts had penetrated within sensing distance of Universal AC (chapter 1) → One man (overlap)
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

### `google/gemini-4-carbon` · low

Folder `runs/baseline/google_gemini-4-carbon--low` · completed
8 calls · 23,626 prompt + 4,411 completion tokens (0 reasoning) · 10m 41s · $0.091 · 5 retries, 0 invalid replies
Scored from the saved script: 144/144 lines right (100.0%), 100.0% of words.
Cast 15/15.
- Mapping: MQ-17J of Nicron → MQ-17J (alias); the man (chapter 1) → One man (overlap); VJ-23X of Lameth → VJ-23X (alias)
- Text fidelity: +15 / −8 words −"i"; −"ii"; −"i"; −"ii"; −"i"; −"i"; −"ii"; −"predecesors"

### `google/gemini-4-carbon` · low · repeat 2

Folder `runs/baseline/google_gemini-4-carbon--low--r2` · completed
7 calls · 23,653 prompt + 4,466 completion tokens (0 reasoning) · 1m 39s · $0.092 · 0 retries, 0 invalid replies
Scored from the saved script: 144/144 lines right (100.0%), 100.0% of words.
Cast 15/15.
- Mapping: MQ-17J of Nicron → MQ-17J (alias); the man who sensed Universal AC (chapter 1) → One man (overlap); VJ-23X of Lameth → VJ-23X (alias)
- Text fidelity: +14 / −8 words −"i"; −"ii"; −"i"; −"ii"; −"i"; −"i"; −"ii"; −"predecesors"

### `google/gemini-4-carbon` · low · repeat 3

Folder `runs/baseline/google_gemini-4-carbon--low--r3` · completed
7 calls · 23,671 prompt + 4,452 completion tokens (0 reasoning) · 1m 34s · $0.092 · 0 retries, 0 invalid replies
Scored from the saved script: 144/144 lines right (100.0%), 100.0% of words.
Cast 15/15.
- Mapping: MQ-17J of Nicron → MQ-17J (alias); a man who had sensed Universal AC (chapter 1) → One man (overlap); VJ-23X of Lameth → VJ-23X (alias)
- Text fidelity: +15 / −8 words −"i"; −"ii"; −"i"; −"ii"; −"i"; −"i"; −"ii"; −"predecesors"

### `google/gemini-4-carbon` · high

Folder `runs/baseline/google_gemini-4-carbon--high` · completed
7 calls · 23,626 prompt + 81,230 completion tokens (77,015 reasoning) · 22m 45s · $0.857 · 4 retries, 0 invalid replies
Scored from the saved script: 144/144 lines right (100.0%), 100.0% of words.
Cast 15/15.
- Mapping: MQ-17J of Nicron → MQ-17J (alias); the man who sensed Universal AC (chapter 1) → One man (overlap); VJ-23X of Lameth → VJ-23X (alias)
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

### `deepseek/deepseek-v4-flash-0731` · default

Folder `runs/baseline/deepseek_deepseek-v4-flash-0731--default` · completed
8 calls · 20,230 prompt + 52,050 completion tokens (46,516 reasoning) · 9m 17s · $0.019 · 0 retries, 0 invalid replies
Scored from the saved script: 142/144 lines right (98.6%), 99.2% of words.
Cast 14/15; missing AC.
- Merged: AC + Cosmic AC → **Cosmic AC**
- Mapping: the man who had sensed Universal AC (chapter 1) → One man (overlap)

| Kind | Reference | Run | Line |
|---|---|---|---|
| merge | AC | Cosmic AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Cosmic AC | "LET THERE BE LIGHT!" |

### `deepseek/deepseek-v4.1-flash-1017` · high

Folder `runs/baseline/deepseek_deepseek-v4.1-flash-1017--high` · completed
10 calls · 24,628 prompt + 38,011 completion tokens (32,374 reasoning) · 2m 51s · $0.023 · 0 retries, 0 invalid replies
Scored from the saved script: 142/144 lines right (98.6%), 99.2% of words.
Cast 14/15; missing AC.
- Merged: AC + Cosmic AC → **Cosmic AC**
- Mapping: MQ-17J of Nicron → MQ-17J (alias); the man who had sensed Universal AC (chapter 1) → One man (overlap); VJ-23X of Lameth → VJ-23X (alias)
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

| Kind | Reference | Run | Line |
|---|---|---|---|
| merge | AC | Cosmic AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Cosmic AC | "LET THERE BE LIGHT!" |

### `anthropic/claude-opus-5.5` · low

Folder `runs/baseline/anthropic_claude-opus-5.5--low` · completed
8 calls · 34,118 prompt + 5,321 completion tokens (0 reasoning) · 1m 11s · $0.243 · 0 retries, 0 invalid replies
Scored from the saved script: 142/144 lines right (98.6%), 99.2% of words.
Cast 14/15; missing AC.
- Merged: AC + Cosmic AC → **Cosmic AC**
- Mapping: MQ-17J of Nicron → MQ-17J (alias); the man who sensed Universal AC (chapter 1) → One man (overlap); VJ-23X of Lameth → VJ-23X (alias)
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

| Kind | Reference | Run | Line |
|---|---|---|---|
| merge | AC | Cosmic AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Cosmic AC | "LET THERE BE LIGHT!" |

### `anthropic/claude-opus-5.5` · high

Folder `runs/baseline/anthropic_claude-opus-5.5--high` · completed
8 calls · 35,543 prompt + 7,584 completion tokens (1,827 reasoning) · 1m 37s · $0.294 · 0 retries, 0 invalid replies
Scored from the saved script: 142/144 lines right (98.6%), 99.2% of words.
Cast 14/15; missing AC.
- Merged: AC + Cosmic AC → **Cosmic AC**
- Mapping: MQ-17J of Nicron → MQ-17J (alias); the man who sensed Universal AC (chapter 1) → One man (overlap); VJ-23X of Lameth → VJ-23X (alias)
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

| Kind | Reference | Run | Line |
|---|---|---|---|
| merge | AC | Cosmic AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Cosmic AC | "LET THERE BE LIGHT!" |

### `x-ai/grok-4.7` · high

Folder `runs/baseline/x-ai_grok-4.7--high` · completed
7 calls · 29,130 prompt + 46,924 completion tokens (43,207 reasoning) · 12m 05s · $0.323 · 4 retries, 0 invalid replies
Scored from the saved script: 142/144 lines right (98.6%), 99.2% of words.
Cast 14/15; missing AC.
- Merged: AC + Cosmic AC → **Cosmic AC**
- Mapping: MQ-17J of Nicron → MQ-17J (alias); the man who sensed Universal AC (chapter 1) → One man (overlap); VJ-23X of Lameth → VJ-23X (alias)

| Kind | Reference | Run | Line |
|---|---|---|---|
| merge | AC | Cosmic AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Cosmic AC | "LET THERE BE LIGHT!" |

### `google/gemini-3.8-flash` · low

Folder `runs/baseline/google_gemini-3.8-flash--low` · completed
7 calls · 22,259 prompt + 4,797 completion tokens (0 reasoning) · 48s · $0.035 · 0 retries, 0 invalid replies
Scored from the saved script: 142/144 lines right (98.6%), 99.1% of words.
Cast 14/15; missing One man.
- Merged: Man + One man → **the man (chapter 1)**
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

| Kind | Reference | Run | Line |
|---|---|---|---|
| merge | One man | the man (chapter 1) | "Most of it," |
| merge | One man | the man (chapter 1) | "is in hyperspace. In what form it is … |

### `google/gemini-3.8-flash` · high

Folder `runs/baseline/google_gemini-3.8-flash--high` · completed
7 calls · 22,270 prompt + 81,725 completion tokens (77,063 reasoning) · 12m 41s · $0.323 · 4 retries, 0 invalid replies
Scored from the saved script: 142/144 lines right (98.6%), 99.1% of words.
Cast 14/15; missing One man.
- Merged: Man + One man → **the man (chapter 1)**
- Mapping: MQ-17J of Nicron → MQ-17J (alias); VJ-23X of Lameth → VJ-23X (alias)

| Kind | Reference | Run | Line |
|---|---|---|---|
| merge | One man | the man (chapter 1) | "Most of it," |
| merge | One man | the man (chapter 1) | "is in hyperspace. In what form it is … |

### `deepseek/deepseek-v4.1-flash-1017` · low

Folder `runs/baseline/deepseek_deepseek-v4.1-flash-1017--low` · completed
8 calls · 19,736 prompt + 19,992 completion tokens (16,014 reasoning) · 1m 44s · $0.016 · 0 retries, 0 invalid replies
Scored from the saved script: 142/144 lines right (98.6%), 99.2% of words.
Cast 14/15; missing AC.
- Merged: AC + Cosmic AC → **Cosmic AC**
- Mapping: MQ-17J of Nicron → MQ-17J (alias); the man who sensed Universal AC (chapter 1) → One man (overlap); VJ-23X of Lameth → VJ-23X (alias)
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

| Kind | Reference | Run | Line |
|---|---|---|---|
| merge | AC | Cosmic AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Cosmic AC | "LET THERE BE LIGHT!" |

### `deepseek/deepseek-v4.1-flash-1017` · low · repeat 2

Folder `runs/baseline/deepseek_deepseek-v4.1-flash-1017--low--r2` · completed
8 calls · 19,238 prompt + 24,088 completion tokens (20,186 reasoning) · 2m 13s · $0.013 · 0 retries, 0 invalid replies
Scored from the saved script: 142/144 lines right (98.6%), 99.2% of words.
Cast 14/15; missing AC.
- Merged: AC + Cosmic AC → **Cosmic AC**
- Mapping: MQ-17J of Nicron → MQ-17J (alias); the man who had sensed Universal AC (chapter 1) → One man (overlap); VJ-23X of Lameth → VJ-23X (alias)
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

| Kind | Reference | Run | Line |
|---|---|---|---|
| merge | AC | Cosmic AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Cosmic AC | "LET THERE BE LIGHT!" |

### `deepseek/deepseek-v4.1-flash-1017` · low · repeat 3

Folder `runs/baseline/deepseek_deepseek-v4.1-flash-1017--low--r3` · completed
9 calls · 23,213 prompt + 25,967 completion tokens (21,553 reasoning) · 2m 06s · $0.018 · 0 retries, 0 invalid replies
Scored from the saved script: 141/144 lines right (97.9%), 98.7% of words.
Cast 14/15; missing AC; extra the Jerrodettes (chapter 1).
- Merged: AC + Cosmic AC → **Cosmic AC**
- Mapping: MQ-17J of Nicron → MQ-17J (alias); VJ-23X of Lameth → VJ-23X (alias)
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

| Kind | Reference | Run | Line |
|---|---|---|---|
| misattribution | Jerrodette I | the Jerrodettes (chapter 1) | "We've reached X-23 -- we've reached X-23 -- … |
| merge | AC | Cosmic AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Cosmic AC | "LET THERE BE LIGHT!" |

### `x-ai/grok-4.7` · low

Folder `runs/baseline/x-ai_grok-4.7--low` · blocked: New or unresolved speakers in chapter 1: Jerrodette I and Jerrodette II. They are listed under "unresolved" in characters.json and in the workspace's Cast panel. For each, add the character, or set "resolveAs" to an existing character's name or to "narrator", then run Script again: the attributed text is kept and is not paid for twice.
8 calls · 31,215 prompt + 14,091 completion tokens (10,198 reasoning) · 2m 29s · $0.133 · 0 retries, 0 invalid replies
Scored from the checkpoint's verified segments (blocked run): 141/144 lines right (97.9%), 98.7% of words.
Cast 14/15; missing AC.
- Merged: AC + Cosmic AC → **Cosmic AC**
- Mapping: MQ-17J of Nicron → MQ-17J (alias); the man who sensed Universal AC (chapter 1) → One man (overlap); VJ-23X of Lameth → VJ-23X (alias)
- Unresolved: Jerrodette I and Jerrodette II

| Kind | Reference | Run | Line |
|---|---|---|---|
| unresolved | Jerrodette I | Jerrodette I and Jerrodette II | "We've reached X-23 -- we've reached X-23 -- … |
| merge | AC | Cosmic AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Cosmic AC | "LET THERE BE LIGHT!" |

### `openai/gpt-6-luna` · high

Folder `runs/baseline/openai_gpt-6-luna--high` · completed
7 calls · 19,071 prompt + 12,262 completion tokens (9,228 reasoning) · 1m 04s · $0.0085 · 0 retries, 0 invalid replies
Scored from the saved script: 141/144 lines right (97.9%), 98.4% of words.
Cast 14/15; missing AC.
- Merged: AC + Universal AC → **Universal AC**
- Merged: AC + Cosmic AC → **Cosmic AC**
- Split: **AC** → Cosmic AC + Universal AC
- Mapping: MQ-17J of Nicron → MQ-17J (alias); the man whose thoughts had penetrated within sensing distance of Universal AC (chapter 1) → One man (overlap); VJ-23X of Lameth → VJ-23X (alias)
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

| Kind | Reference | Run | Line |
|---|---|---|---|
| misattribution | Alexander Adell | Bertram Lupov | "Don't shout. When the sun is done, the … |
| merge | AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Cosmic AC | "LET THERE BE LIGHT!" |

### `z-ai/glm-5.3` · high

Folder `runs/baseline/z-ai_glm-5.3--high` · completed
8 calls · 19,878 prompt + 13,807 completion tokens (8,960 reasoning) · 1m 33s · $0.033 · 0 retries, 0 invalid replies
Scored from the saved script: 142/144 lines right (98.6%), 99.2% of words.
Cast 14/15; missing AC.
- Merged: AC + Cosmic AC → **Cosmic AC**
- Mapping: the man who sensed Universal AC (chapter 1) → One man (overlap)
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

| Kind | Reference | Run | Line |
|---|---|---|---|
| merge | AC | Cosmic AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Cosmic AC | "LET THERE BE LIGHT!" |

### `z-ai/glm-5.3` · high · repeat 2

Folder `runs/baseline/z-ai_glm-5.3--high--r2` · completed
8 calls · 18,787 prompt + 24,209 completion tokens (20,031 reasoning) · 3m 25s · $0.052 · 0 retries, 0 invalid replies
Scored from the saved script: 141/144 lines right (97.9%), 98.4% of words.
Cast 14/15; missing AC.
- Merged: AC + Universal AC → **Universal AC**
- Merged: AC + Cosmic AC → **Cosmic AC**
- Split: **AC** → Cosmic AC + Universal AC
- Mapping: MQ-17J of Nicron → MQ-17J (alias); the man whose thoughts had penetrated within sensing distance of Universal AC (chapter 1) → One man (overlap); VJ-23X of Lameth → VJ-23X (alias)
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

| Kind | Reference | Run | Line |
|---|---|---|---|
| misattribution | Alexander Adell | Bertram Lupov | "Don't shout. When the sun is done, the … |
| merge | AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Cosmic AC | "LET THERE BE LIGHT!" |

### `z-ai/glm-5.3` · high · repeat 3

Folder `runs/baseline/z-ai_glm-5.3--high--r3` · completed
8 calls · 19,386 prompt + 17,696 completion tokens (12,461 reasoning) · 2m 09s · $0.042 · 0 retries, 0 invalid replies
Scored from the saved script: 139/144 lines right (96.5%), 98.1% of words.
Cast 13/15; missing One man, AC.
- Merged: One man + Universal AC → **Universal AC**
- Merged: AC + Cosmic AC → **Cosmic AC**
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

| Kind | Reference | Run | Line |
|---|---|---|---|
| misattribution | Alexander Adell | Bertram Lupov | "It did all right." |
| merge | One man | Universal AC | "Most of it," |
| merge | One man | Universal AC | "is in hyperspace. In what form it is … |
| merge | AC | Cosmic AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Cosmic AC | "LET THERE BE LIGHT!" |

### `qwen/qwen3.8-flash` · none

Folder `runs/baseline/qwen_qwen3.8-flash--none` · completed
8 calls · 20,021 prompt + 4,809 completion tokens (0 reasoning) · 1m 02s · $0.0042 · 0 retries, 0 invalid replies
Scored from the saved script: 140/144 lines right (97.2%), 98.3% of words.
Cast 13/15; missing One man, AC.
- Merged: AC + One man + Universal AC → **Universal AC (chapter 1)**

| Kind | Reference | Run | Line |
|---|---|---|---|
| merge | One man | Universal AC (chapter 1) | "Most of it," |
| merge | One man | Universal AC (chapter 1) | "is in hyperspace. In what form it is … |
| merge | AC | Universal AC (chapter 1) | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Universal AC (chapter 1) | "LET THERE BE LIGHT!" |

### `openai/gpt-6-luna` · medium

Folder `runs/baseline/openai_gpt-6-luna--medium` · completed
8 calls · 19,819 prompt + 7,079 completion tokens (4,108 reasoning) · 40s · $0.0060 · 0 retries, 0 invalid replies
Scored from the saved script: 140/144 lines right (97.2%), 98.3% of words.
Cast 14/15; missing AC.
- Merged: AC + Cosmic AC → **Cosmic AC**
- Mapping: MQ-17J of Nicron → MQ-17J (alias); the man who had penetrated sensing distance of Universal AC (chapter 1) → One man (overlap); VJ-23X of Lameth → VJ-23X (alias)

| Kind | Reference | Run | Line |
|---|---|---|---|
| misattribution | Alexander Adell | Bertram Lupov | "Don't shout. When the sun is done, the … |
| misattribution | Zee Prime | Dee Sub Wun | "And you?" |
| merge | AC | Cosmic AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Cosmic AC | "LET THERE BE LIGHT!" |

### `openai/gpt-6-luna` · low

Folder `runs/baseline/openai_gpt-6-luna--low` · completed
11 calls · 27,176 prompt + 4,572 completion tokens (1,054 reasoning) · 35s · $0.0057 · 0 retries, 0 invalid replies
Scored from the saved script: 139/144 lines right (96.5%), 97.5% of words.
Cast 13/15; missing One man, AC.
- Merged: Man + One man → **Unnamed man (chapter 1)**
- Merged: AC + Cosmic AC → **Cosmic AC**
- Mapping: Unnamed man (chapter 1) → Man (overlap)
- Text fidelity: +4 / −2 words −"acs"; −"ac"; +"a cs"; +"a c"

| Kind | Reference | Run | Line |
|---|---|---|---|
| misattribution | Alexander Adell | Bertram Lupov | "Don't shout. When the sun is done, the … |
| merge | One man | Unnamed man (chapter 1) | "Most of it," |
| merge | One man | Unnamed man (chapter 1) | "is in hyperspace. In what form it is … |
| merge | AC | Cosmic AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Cosmic AC | "LET THERE BE LIGHT!" |

### `anthropic/claude-haiku-5.5` · medium

Folder `runs/baseline/anthropic_claude-haiku-5.5--medium` · completed
10 calls · 45,254 prompt + 17,058 completion tokens (10,545 reasoning) · 1m 14s · $0.013 · 0 retries, 0 invalid replies
Scored from the saved script: 139/144 lines right (96.5%), 95.7% of words.
Cast 13/15; missing One man, AC.
- Merged: AC + One man + Universal AC → **Universal AC**
- Merged: AC + Cosmic AC → **Cosmic AC (chapter 1)**
- Split: **AC** → Cosmic AC (chapter 1) + Universal AC
- Mapping: MQ-17J of Nicron → MQ-17J (alias); VJ-23X of Lameth → VJ-23X (alias)
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

| Kind | Reference | Run | Line |
|---|---|---|---|
| misattribution | Jerrodd | Jerrodine | "We had nothing there. We'll have everything on … |
| merge | One man | Universal AC | "Most of it," |
| merge | One man | Universal AC | "is in hyperspace. In what form it is … |
| merge | AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Cosmic AC (chapter 1) | "LET THERE BE LIGHT!" |

### `z-ai/glm-5.3` · low

Folder `runs/baseline/z-ai_glm-5.3--low` · completed
8 calls · 19,763 prompt + 5,215 completion tokens (1,011 reasoning) · 35s · $0.020 · 0 retries, 0 invalid replies
Scored from the saved script: 138/144 lines right (95.8%), 97.6% of words.
Cast 13/15; missing One man, AC.
- Merged: One man + Universal AC → **Universal AC**
- Merged: AC + Cosmic AC → **Cosmic AC**
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

| Kind | Reference | Run | Line |
|---|---|---|---|
| misattribution | Alexander Adell | Bertram Lupov | "It did all right." |
| misattribution | VJ-23X | MQ-17J | "Yet you wouldn't want to abandon life, I … |
| merge | One man | Universal AC | "Most of it," |
| merge | One man | Universal AC | "is in hyperspace. In what form it is … |
| merge | AC | Cosmic AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Cosmic AC | "LET THERE BE LIGHT!" |

### `deepseek/deepseek-v4-flash-0731` · none

Folder `runs/baseline/deepseek_deepseek-v4-flash-0731--none` · completed
8 calls · 19,685 prompt + 4,095 completion tokens (0 reasoning) · 29s · $0.0033 · 0 retries, 0 invalid replies
Scored from the saved script: 137/144 lines right (95.1%), 95.7% of words.
Cast 13/15; missing Cosmic AC, AC.
- Merged: AC + Cosmic AC + Universal AC → **Universal AC**
- Mapping: unknown man (chapter 1) → One man (overlap)

| Kind | Reference | Run | Line |
|---|---|---|---|
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL DO SO. I HAVE BEEN DOING … |
| merge | Cosmic AC | Universal AC | "NO PROBLEM IS INSOLUBLE IN ALL CONCEIVABLE CIRCUMSTANCES." |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL." |
| merge | AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Universal AC | "LET THERE BE LIGHT!" |

### `deepseek/deepseek-v4-flash-0731` · medium

Folder `runs/baseline/deepseek_deepseek-v4-flash-0731--medium` · completed
8 calls · 21,087 prompt + 32,439 completion tokens (26,382 reasoning) · 3m 40s · $0.011 · 0 retries, 0 invalid replies
Scored from the saved script: 137/144 lines right (95.1%), 95.7% of words.
Cast 13/15; missing Cosmic AC, AC.
- Merged: AC + Cosmic AC + Universal AC → **Universal AC**
- Mapping: the man who had penetrated within sensing distance of Universal AC (chapter 1) → One man (overlap)

| Kind | Reference | Run | Line |
|---|---|---|---|
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL DO SO. I HAVE BEEN DOING … |
| merge | Cosmic AC | Universal AC | "NO PROBLEM IS INSOLUBLE IN ALL CONCEIVABLE CIRCUMSTANCES." |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL." |
| merge | AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Universal AC | "LET THERE BE LIGHT!" |

### `deepseek/deepseek-v4.1-flash-1017` · medium

Folder `runs/baseline/deepseek_deepseek-v4.1-flash-1017--medium` · completed
8 calls · 19,360 prompt + 21,074 completion tokens (17,149 reasoning) · 1m 53s · $0.018 · 0 retries, 0 invalid replies
Scored from the saved script: 137/144 lines right (95.1%), 95.7% of words.
Cast 13/15; missing Cosmic AC, AC.
- Merged: AC + Cosmic AC + Universal AC → **Universal AC**
- Mapping: MQ-17J of Nicron → MQ-17J (alias); VJ-23X of Lameth → VJ-23X (alias)
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

| Kind | Reference | Run | Line |
|---|---|---|---|
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL DO SO. I HAVE BEEN DOING … |
| merge | Cosmic AC | Universal AC | "NO PROBLEM IS INSOLUBLE IN ALL CONCEIVABLE CIRCUMSTANCES." |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL." |
| merge | AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Universal AC | "LET THERE BE LIGHT!" |

### `deepseek/deepseek-v4-pro-0813` · high

Folder `runs/baseline/deepseek_deepseek-v4-pro-0813--high` · completed
7 calls · 19,787 prompt + 36,469 completion tokens (32,988 reasoning) · 8m 25s · $0.111 · 0 retries, 0 invalid replies
Scored from the saved script: 137/144 lines right (95.1%), 95.7% of words.
Cast 13/15; missing Cosmic AC, AC.
- Merged: AC + Cosmic AC + Universal AC → **Universal AC**
- Mapping: the man who had approached Universal AC (chapter 1) → One man (overlap)

| Kind | Reference | Run | Line |
|---|---|---|---|
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL DO SO. I HAVE BEEN DOING … |
| merge | Cosmic AC | Universal AC | "NO PROBLEM IS INSOLUBLE IN ALL CONCEIVABLE CIRCUMSTANCES." |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL." |
| merge | AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Universal AC | "LET THERE BE LIGHT!" |

### `qwen/qwen3.8-flash` · medium

Folder `runs/baseline/qwen_qwen3.8-flash--medium` · completed
8 calls · 20,656 prompt + 65,936 completion tokens (59,529 reasoning) · 17m 28s · $0.032 · 0 retries, 0 invalid replies
Scored from the saved script: 144/144 lines right (100.0%), 100.0% of words.
Cast 15/15.
- Mapping: Jerroddette I → Jerrodette I (overlap); Jerroddette II → Jerrodette II (overlap); the man whose thoughts had penetrated within sensing distance of Universal AC (chapter 1) → One man (overlap)
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

### `qwen/qwen3.8-flash` · medium · repeat 2

Folder `runs/baseline/qwen_qwen3.8-flash--medium--r2` · completed
8 calls · 21,153 prompt + 94,829 completion tokens (89,708 reasoning) · 25m 20s · $0.046 · 0 retries, 0 invalid replies
Scored from the saved script: 123/144 lines right (85.4%), 87.4% of words.
Cast 12/15; missing Man, Cosmic AC, AC.
- Merged: Man + One man → **the one man (chapter 1)**
- Merged: AC + Cosmic AC + Universal AC → **Universal AC**
- Mapping: Jerroette I → Jerrodette I (overlap); MQ-17J of Nicron → MQ-17J (alias); VJ-23X of Lameth → VJ-23X (alias)
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

| Kind | Reference | Run | Line |
|---|---|---|---|
| merge | Man | the one man (chapter 1) | "The Universe is dying." |
| merge | Man | the one man (chapter 1) | "Carefully husbanded, as directed by the Cosmic AC, … |
| merge | Man | the one man (chapter 1) | "But even so," |
| merge | Man | the one man (chapter 1) | "eventually it will all come to an end. … |
| merge | Man | the one man (chapter 1) | "Can entropy not be reversed? Let us ask … |
| merge | Man | the one man (chapter 1) | "Cosmic AC," |
| merge | Man | the one man (chapter 1) | "how may entropy be reversed?" |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Man | the one man (chapter 1) | "Collect additional data." |
| merge | Cosmic AC | Universal AC | "I WILL DO SO. I HAVE BEEN DOING … |
| merge | Man | the one man (chapter 1) | "Will there come a time," |
| merge | Man | the one man (chapter 1) | "when data will be sufficient or is the … |
| merge | Cosmic AC | Universal AC | "NO PROBLEM IS INSOLUBLE IN ALL CONCEIVABLE CIRCUMSTANCES." |
| merge | Man | the one man (chapter 1) | "When will you have enough data to answer … |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Man | the one man (chapter 1) | "Will you keep working on it?" |
| merge | Cosmic AC | Universal AC | "I WILL." |
| merge | Man | the one man (chapter 1) | "We shall wait." |
| merge | Man | the one man (chapter 1) | "AC, is this the end? Can this chaos … |
| merge | AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Universal AC | "LET THERE BE LIGHT!" |

### `qwen/qwen3.8-flash` · medium · repeat 3

Folder `runs/baseline/qwen_qwen3.8-flash--medium--r3` · completed
8 calls · 20,653 prompt + 69,901 completion tokens (64,381 reasoning) · 17m 53s · $0.035 · 0 retries, 0 invalid replies
Scored from the saved script: 142/144 lines right (98.6%), 99.2% of words.
Cast 14/15; missing AC.
- Merged: AC + Universal AC → **Universal AC**
- Merged: AC + Cosmic AC → **Cosmic AC**
- Split: **AC** → Cosmic AC + Universal AC
- Mapping: the man who had sensed the Universal AC (chapter 1) → One man (overlap)
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

| Kind | Reference | Run | Line |
|---|---|---|---|
| merge | AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Cosmic AC | "LET THERE BE LIGHT!" |

### `anthropic/claude-sonnet-5.5` · low

Folder `runs/baseline/anthropic_claude-sonnet-5.5--low` · completed
8 calls · 35,126 prompt + 5,190 completion tokens (0 reasoning) · 37s · $0.122 · 0 retries, 0 invalid replies
Scored from the saved script: 136/144 lines right (94.4%), 95.9% of words.
Cast 12/15; missing One man, Universal AC, AC.
- Merged: AC + Cosmic AC + One man + Universal AC → **Cosmic AC**

| Kind | Reference | Run | Line |
|---|---|---|---|
| merge | One man | Cosmic AC | "Most of it," |
| merge | One man | Cosmic AC | "is in hyperspace. In what form it is … |
| merge | Universal AC | Cosmic AC | "THIS IS THE ORIGINAL GALAXY OF MAN." |
| merge | Universal AC | Cosmic AC | "MAN'S ORIGINAL STAR HAS GONE NOVA. IT IS … |
| merge | Universal AC | Cosmic AC | "A NEW WORLD, AS IN SUCH CASES WAS … |
| merge | Universal AC | Cosmic AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Cosmic AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Cosmic AC | "LET THERE BE LIGHT!" |

### `anthropic/claude-haiku-5.5` · high

Folder `runs/baseline/anthropic_claude-haiku-5.5--high` · completed
8 calls · 35,485 prompt + 20,105 completion tokens (14,254 reasoning) · 1m 26s · $0.014 · 0 retries, 0 invalid replies
Scored from the saved script: 136/144 lines right (94.4%), 94.8% of words.
Cast 13/15; missing Cosmic AC, AC.
- Merged: AC + Cosmic AC + Universal AC → **Universal AC**
- Mapping: MQ-17J of Nicron → MQ-17J (alias); Man who glimpsed Universal AC (chapter 1) → One man (overlap); VJ-23X of Lameth → VJ-23X (alias)
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

| Kind | Reference | Run | Line |
|---|---|---|---|
| misattribution | Jerrodd | Jerrodine | "The stars are the power-units. dear. Once they're … |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL DO SO. I HAVE BEEN DOING … |
| merge | Cosmic AC | Universal AC | "NO PROBLEM IS INSOLUBLE IN ALL CONCEIVABLE CIRCUMSTANCES." |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL." |
| merge | AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Universal AC | "LET THERE BE LIGHT!" |

### `z-ai/glm-5.3-flash` · high

Folder `runs/baseline/z-ai_glm-5.3-flash--high` · completed
10 calls · 23,576 prompt + 11,014 completion tokens (6,474 reasoning) · 1m 12s · $0.0072 · 0 retries, 0 invalid replies
Scored from the saved script: 135/144 lines right (93.8%), 95.0% of words.
Cast 13/15; missing Cosmic AC, AC; extra Jerrodettes (chapter 1).
- Merged: AC + Cosmic AC + Universal AC → **Universal AC**
- Mapping: the man who saw Universal AC (chapter 1) → One man (overlap)

| Kind | Reference | Run | Line |
|---|---|---|---|
| misattribution | Jerrodette I | Jerrodettes (chapter 1) | "We've reached X-23 -- we've reached X-23 -- … |
| misattribution | Zee Prime | Dee Sub Wun | "And you?" |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL DO SO. I HAVE BEEN DOING … |
| merge | Cosmic AC | Universal AC | "NO PROBLEM IS INSOLUBLE IN ALL CONCEIVABLE CIRCUMSTANCES." |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL." |
| merge | AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Universal AC | "LET THERE BE LIGHT!" |

### `z-ai/glm-5.3-flash` · high · repeat 2

Folder `runs/baseline/z-ai_glm-5.3-flash--high--r2` · completed
8 calls · 19,009 prompt + 7,803 completion tokens (3,695 reasoning) · 52s · $0.0059 · 0 retries, 0 invalid replies
Scored from the saved script: 135/144 lines right (93.8%), 94.8% of words.
Cast 12/15; missing Jerrodette II, Cosmic AC, AC.
- Merged: Jerrodette I + Jerrodette II → **Jerrodettes**
- Merged: AC + Cosmic AC + Universal AC → **Universal AC**
- Mapping: Jerrodettes → Jerrodette I (overlap); the man who sensed the Universal AC (chapter 1) → One man (overlap)

| Kind | Reference | Run | Line |
|---|---|---|---|
| merge | Jerrodette II | Jerrodettes | "What's entropy, daddy?" |
| merge | Jerrodette II | Jerrodettes | "Can't you just put in a new power-unit, … |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL DO SO. I HAVE BEEN DOING … |
| merge | Cosmic AC | Universal AC | "NO PROBLEM IS INSOLUBLE IN ALL CONCEIVABLE CIRCUMSTANCES." |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL." |
| merge | AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Universal AC | "LET THERE BE LIGHT!" |

### `z-ai/glm-5.3-flash` · high · repeat 3

Folder `runs/baseline/z-ai_glm-5.3-flash--high--r3` · blocked: New or unresolved speakers in chapter 1: Jerrodette I and Jerrodette II. They are listed under "unresolved" in characters.json and in the workspace's Cast panel. For each, add the character, or set "resolveAs" to an existing character's name or to "narrator", then run Script again: the attributed text is kept and is not paid for twice.
8 calls · 19,747 prompt + 13,102 completion tokens (8,917 reasoning) · 1m 37s · $0.0061 · 0 retries, 0 invalid replies
Scored from the checkpoint's verified segments (blocked run): 137/144 lines right (95.1%), 97.2% of words.
Cast 13/15; missing One man, AC.
- Merged: AC + One man + Universal AC → **Universal AC**
- Mapping: MQ-17J of Nicron → MQ-17J (alias); VJ-23X of Lameth → VJ-23X (alias)
- Unresolved: Jerrodette I and Jerrodette II
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

| Kind | Reference | Run | Line |
|---|---|---|---|
| unresolved | Jerrodette I | Jerrodette I and Jerrodette II | "We've reached X-23 -- we've reached X-23 -- … |
| misattribution | Zee Prime | Dee Sub Wun | "And you?" |
| merge | One man | Universal AC | "Most of it," |
| merge | One man | Universal AC | "is in hyperspace. In what form it is … |
| misattribution | Dee Sub Wun | Universal AC | "You're asking how entropy might be reversed in … |
| merge | AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Universal AC | "LET THERE BE LIGHT!" |

### `deepseek/deepseek-v4-flash-0731` · high

Folder `runs/baseline/deepseek_deepseek-v4-flash-0731--high` · completed
8 calls · 20,115 prompt + 55,289 completion tokens (50,695 reasoning) · 14m 32s · $0.014 · 0 retries, 0 invalid replies
Scored from the saved script: 144/144 lines right (100.0%), 100.0% of words.
Cast 15/15.
- Mapping: the one man who had sensed Universal AC (chapter 1) → One man (overlap)

### `deepseek/deepseek-v4-flash-0731` · high · repeat 2

Folder `runs/baseline/deepseek_deepseek-v4-flash-0731--high--r2` · completed
8 calls · 20,205 prompt + 54,761 completion tokens (49,839 reasoning) · 8m 22s · $0.019 · 0 retries, 0 invalid replies
Scored from the saved script: 128/144 lines right (88.9%), 90.9% of words.
Cast 13/15; missing Man, AC.
- Merged: Man + One man → **the one man (chapter 1)**
- Merged: AC + Universal AC → **Universal AC**
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

| Kind | Reference | Run | Line |
|---|---|---|---|
| merge | Man | the one man (chapter 1) | "The Universe is dying." |
| merge | Man | the one man (chapter 1) | "Carefully husbanded, as directed by the Cosmic AC, … |
| merge | Man | the one man (chapter 1) | "But even so," |
| merge | Man | the one man (chapter 1) | "eventually it will all come to an end. … |
| merge | Man | the one man (chapter 1) | "Can entropy not be reversed? Let us ask … |
| merge | Man | the one man (chapter 1) | "Cosmic AC," |
| merge | Man | the one man (chapter 1) | "how may entropy be reversed?" |
| merge | Man | the one man (chapter 1) | "Collect additional data." |
| merge | Man | the one man (chapter 1) | "Will there come a time," |
| merge | Man | the one man (chapter 1) | "when data will be sufficient or is the … |
| merge | Man | the one man (chapter 1) | "When will you have enough data to answer … |
| merge | Man | the one man (chapter 1) | "Will you keep working on it?" |
| merge | Man | the one man (chapter 1) | "We shall wait." |
| merge | Man | the one man (chapter 1) | "AC, is this the end? Can this chaos … |
| merge | AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Universal AC | "LET THERE BE LIGHT!" |

### `deepseek/deepseek-v4-flash-0731` · high · repeat 3

Folder `runs/baseline/deepseek_deepseek-v4-flash-0731--high--r3` · completed
10 calls · 27,165 prompt + 61,490 completion tokens (54,841 reasoning) · 11m 02s · $0.017 · 0 retries, 2 invalid replies
Scored from the saved script: 135/144 lines right (93.8%), 94.8% of words.
Cast 12/15; missing One man, Cosmic AC, AC.
- Merged: Man + One man → **the man (chapter 1)**
- Merged: AC + Cosmic AC + Universal AC → **Universal AC**
- Mapping: MQ-17J of Nicron → MQ-17J (alias); VJ-23X of Lameth → VJ-23X (alias)

| Kind | Reference | Run | Line |
|---|---|---|---|
| merge | One man | the man (chapter 1) | "Most of it," |
| merge | One man | the man (chapter 1) | "is in hyperspace. In what form it is … |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL DO SO. I HAVE BEEN DOING … |
| merge | Cosmic AC | Universal AC | "NO PROBLEM IS INSOLUBLE IN ALL CONCEIVABLE CIRCUMSTANCES." |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL." |
| merge | AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Universal AC | "LET THERE BE LIGHT!" |

### `z-ai/glm-5.3-flash` · medium

Folder `runs/baseline/z-ai_glm-5.3-flash--medium` · completed
10 calls · 24,004 prompt + 9,220 completion tokens (4,399 reasoning) · 1m 01s · $0.0066 · 0 retries, 0 invalid replies
Scored from the saved script: 135/144 lines right (93.8%), 94.8% of words.
Cast 12/15; missing One man, Cosmic AC, AC.
- Merged: Dee Sub Wun + One man → **Dee Sub Wun**
- Merged: AC + Cosmic AC + Universal AC → **Universal AC**
- Mapping: MQ-17J of Nicron → MQ-17J (alias); VJ-23X of Lameth → VJ-23X (alias)
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

| Kind | Reference | Run | Line |
|---|---|---|---|
| merge | One man | Dee Sub Wun | "Most of it," |
| merge | One man | Dee Sub Wun | "is in hyperspace. In what form it is … |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL DO SO. I HAVE BEEN DOING … |
| merge | Cosmic AC | Universal AC | "NO PROBLEM IS INSOLUBLE IN ALL CONCEIVABLE CIRCUMSTANCES." |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL." |
| merge | AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Universal AC | "LET THERE BE LIGHT!" |

### `deepseek/deepseek-v4-flash-0731` · low

Folder `runs/baseline/deepseek_deepseek-v4-flash-0731--low` · completed
9 calls · 23,098 prompt + 50,035 completion tokens (44,591 reasoning) · 7m 09s · $0.016 · 0 retries, 1 invalid replies
Scored from the saved script: 135/144 lines right (93.8%), 94.8% of words.
Cast 12/15; missing One man, Cosmic AC, AC.
- Merged: Man + One man → **the man (chapter 1)**
- Merged: AC + Cosmic AC + Universal AC → **Universal AC**
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

| Kind | Reference | Run | Line |
|---|---|---|---|
| merge | One man | the man (chapter 1) | "Most of it," |
| merge | One man | the man (chapter 1) | "is in hyperspace. In what form it is … |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL DO SO. I HAVE BEEN DOING … |
| merge | Cosmic AC | Universal AC | "NO PROBLEM IS INSOLUBLE IN ALL CONCEIVABLE CIRCUMSTANCES." |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL." |
| merge | AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Universal AC | "LET THERE BE LIGHT!" |

### `anthropic/claude-sonnet-5.5` · high

Folder `runs/baseline/anthropic_claude-sonnet-5.5--high` · completed
8 calls · 34,937 prompt + 7,148 completion tokens (1,923 reasoning) · 48s · $0.141 · 0 retries, 0 invalid replies
Scored from the saved script: 135/144 lines right (93.8%), 94.8% of words.
Cast 12/15; missing One man, Cosmic AC, AC.
- Merged: AC + Cosmic AC + One man + Universal AC → **Universal AC**
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

| Kind | Reference | Run | Line |
|---|---|---|---|
| merge | One man | Universal AC | "Most of it," |
| merge | One man | Universal AC | "is in hyperspace. In what form it is … |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL DO SO. I HAVE BEEN DOING … |
| merge | Cosmic AC | Universal AC | "NO PROBLEM IS INSOLUBLE IN ALL CONCEIVABLE CIRCUMSTANCES." |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL." |
| merge | AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Universal AC | "LET THERE BE LIGHT!" |

### `openai/gpt-6-luna` · none

Folder `runs/baseline/openai_gpt-6-luna--none` · completed
8 calls · 19,620 prompt + 2,937 completion tokens (0 reasoning) · 18s · $0.0039 · 0 retries, 0 invalid replies
Scored from the saved script: 134/144 lines right (93.1%), 94.0% of words.
Cast 12/15; missing One man, Cosmic AC, AC.
- Merged: AC + Cosmic AC + One man + Universal AC → **Universal AC**
- Mapping: MQ-17J of Nicron → MQ-17J (alias); VJ-23X of Lameth → VJ-23X (alias)

| Kind | Reference | Run | Line |
|---|---|---|---|
| misattribution | Alexander Adell | Bertram Lupov | "Don't shout. When the sun is done, the … |
| merge | One man | Universal AC | "Most of it," |
| merge | One man | Universal AC | "is in hyperspace. In what form it is … |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL DO SO. I HAVE BEEN DOING … |
| merge | Cosmic AC | Universal AC | "NO PROBLEM IS INSOLUBLE IN ALL CONCEIVABLE CIRCUMSTANCES." |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL." |
| merge | AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Universal AC | "LET THERE BE LIGHT!" |

### `mistralai/mistral-large-4-0` · low

Folder `runs/baseline/mistralai_mistral-large-4-0--low` · completed
7 calls · 21,138 prompt + 46,595 completion tokens (42,340 reasoning) · 6m 28s · $0.113 · 0 retries, 0 invalid replies
Scored from the saved script: 133/144 lines right (92.4%), 94.5% of words.
Cast 12/15; missing One man, Cosmic AC, AC.
- Merged: AC + Cosmic AC + One man + Universal AC → **Universal AC**
- Mapping: MQ-17J of Nicron → MQ-17J (alias); VJ-23X of Lameth → VJ-23X (alias)

| Kind | Reference | Run | Line |
|---|---|---|---|
| misattribution | Alexander Adell | Bertram Lupov | "It did all right." |
| misattribution | Zee Prime | Dee Sub Wun | "And you?" |
| merge | One man | Universal AC | "Most of it," |
| merge | One man | Universal AC | "is in hyperspace. In what form it is … |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL DO SO. I HAVE BEEN DOING … |
| merge | Cosmic AC | Universal AC | "NO PROBLEM IS INSOLUBLE IN ALL CONCEIVABLE CIRCUMSTANCES." |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL." |
| merge | AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Universal AC | "LET THERE BE LIGHT!" |

### `z-ai/glm-5.3-flash` · low

Folder `runs/baseline/z-ai_glm-5.3-flash--low` · blocked: New or unresolved speakers in chapter 1: Jerrodine. They are listed under "unresolved" in characters.json and in the workspace's Cast panel. For each, add the character, or set "resolveAs" to an existing character's name or to "narrator", then run Script again: the attributed text is kept and is not paid for twice.
12 calls · 29,389 prompt + 6,132 completion tokens (1,213 reasoning) · 46s · $0.0066 · 0 retries, 0 invalid replies
Scored from the checkpoint's verified segments (blocked run): 133/144 lines right (92.4%), 93.7% of words.
Cast 13/15; missing Cosmic AC, AC.
- Merged: Jerrodette I + Jerrodette II → **Jerroddette I**
- Merged: AC + Cosmic AC + Universal AC → **Universal AC (chapter 1)**
- Split: **Jerrodette II** → Jerroddette I + Jerroddette II
- Mapping: Jerroddette I → Jerrodette I (overlap); Jerroddette II → Jerrodette II (overlap); Jerroddine → Jerrodine (overlap); MQ-17J of Nicron → MQ-17J (alias); the man who sensed the Universal AC (chapter 1) → One man (overlap); VJ-23X of Lameth → VJ-23X (alias)
- Unresolved: Jerrodine
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

| Kind | Reference | Run | Line |
|---|---|---|---|
| merge | Jerrodette II | Jerroddette I | "Can't you just put in a new power-unit, … |
| unresolved | Jerrodine | Jerrodine | "Go ahead," |
| unresolved | Jerrodine | Jerrodine | "It will quiet them down." |
| unresolved | Jerrodine | Jerrodine | "And now, children, it's time for bed. We'll … |
| merge | Cosmic AC | Universal AC (chapter 1) | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC (chapter 1) | "I WILL DO SO. I HAVE BEEN DOING … |
| merge | Cosmic AC | Universal AC (chapter 1) | "NO PROBLEM IS INSOLUBLE IN ALL CONCEIVABLE CIRCUMSTANCES." |
| merge | Cosmic AC | Universal AC (chapter 1) | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC (chapter 1) | "I WILL." |
| merge | AC | Universal AC (chapter 1) | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Universal AC (chapter 1) | "LET THERE BE LIGHT!" |

### `anthropic/claude-haiku-5.5` · low

Folder `runs/baseline/anthropic_claude-haiku-5.5--low` · blocked: New or unresolved speakers in chapter 1: unresolved speaker. They are listed under "unresolved" in characters.json and in the workspace's Cast panel. For each, add the character, or set "resolveAs" to an existing character's name or to "narrator", then run Script again: the attributed text is kept and is not paid for twice.
9 calls · 41,629 prompt + 11,739 completion tokens (5,727 reasoning) · 52s · $0.010 · 0 retries, 0 invalid replies
Scored from the checkpoint's verified segments (blocked run): 133/144 lines right (92.4%), 92.1% of words.
Cast 12/15; missing One man, Cosmic AC, AC.
- Merged: AC + Cosmic AC + One man + Universal AC → **Universal AC**
- Mapping: MQ-17J of Nicron → MQ-17J (alias); VJ-23X of Lameth → VJ-23X (alias)
- Unresolved: unresolved speaker
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

| Kind | Reference | Run | Line |
|---|---|---|---|
| misattribution | Jerrodd | Jerrodine | "We had nothing there. We'll have everything on … |
| unresolved | VJ-23X | unresolved speaker | "See!" |
| merge | One man | Universal AC | "Most of it," |
| merge | One man | Universal AC | "is in hyperspace. In what form it is … |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL DO SO. I HAVE BEEN DOING … |
| merge | Cosmic AC | Universal AC | "NO PROBLEM IS INSOLUBLE IN ALL CONCEIVABLE CIRCUMSTANCES." |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL." |
| merge | AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Universal AC | "LET THERE BE LIGHT!" |

### `minimax/minimax-m3.1-flash` · medium

Folder `runs/baseline/minimax_minimax-m3.1-flash--medium` · completed
9 calls · 22,407 prompt + 4,475 completion tokens (309 reasoning) · 54s · $0.0054 · 0 retries, 0 invalid replies
Scored from the saved script: 132/144 lines right (91.7%), 90.4% of words.
Cast 13/15; missing One man, Cosmic AC; extra Jerrodette I and II.
- Merged: Cosmic AC + One man + Universal AC → **Universal AC**

| Kind | Reference | Run | Line |
|---|---|---|---|
| misattribution | Alexander Adell | Bertram Lupov | "It did all right." |
| misattribution | Alexander Adell | Bertram Lupov | "Don't shout. When the sun is done, the … |
| misattribution | Jerrodette I | Jerrodette I and II | "We've reached X-23 -- we've reached X-23 -- … |
| misattribution | Jerrodd | Jerrodine | "We had nothing there. We'll have everything on … |
| misattribution | Jerrodd | Jerrodine | "I tell you, it's a lucky thing the … |
| merge | One man | Universal AC | "Most of it," |
| merge | One man | Universal AC | "is in hyperspace. In what form it is … |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL DO SO. I HAVE BEEN DOING … |
| merge | Cosmic AC | Universal AC | "NO PROBLEM IS INSOLUBLE IN ALL CONCEIVABLE CIRCUMSTANCES." |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL." |

### `deepseek/deepseek-v4-pro-0813` · none

Folder `runs/baseline/deepseek_deepseek-v4-pro-0813--none` · completed
11 calls · 28,488 prompt + 4,953 completion tokens (0 reasoning) · 1m 00s · $0.051 · 0 retries, 0 invalid replies
Scored from the saved script: 131/144 lines right (91.0%), 92.0% of words.
Cast 13/15; missing One man, Cosmic AC.
- Merged: Dee Sub Wun + One man → **Dee Sub Wun**
- Mapping: Adell → Alexander Adell (overlap); Lupov → Bertram Lupov (overlap)

| Kind | Reference | Run | Line |
|---|---|---|---|
| misattribution | Alexander Adell | Lupov | "It did all right." |
| misattribution | Bertram Lupov | Adell | "Who says it didn't? What I say is … |
| misattribution | Alexander Adell | Lupov | "Don't shout. When the sun is done, the … |
| misattribution | Bertram Lupov | Adell | "Darn right they will," |
| misattribution | Jerrodine | Jerrodd | "It will quiet them down." |
| merge | One man | Dee Sub Wun | "Most of it," |
| merge | One man | Dee Sub Wun | "is in hyperspace. In what form it is … |
| to-narrator | Cosmic AC | narrator | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| to-narrator | Cosmic AC | narrator | "I WILL DO SO. I HAVE BEEN DOING … |
| to-narrator | Cosmic AC | narrator | "NO PROBLEM IS INSOLUBLE IN ALL CONCEIVABLE CIRCUMSTANCES." |
| to-narrator | Cosmic AC | narrator | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| to-narrator | Cosmic AC | narrator | "I WILL." |
| to-narrator | AC | narrator | "THERE IS AS YET INSUFFICIENT DATA FOR A … |

### `mistralai/mistral-large-4-0` · high

Folder `runs/baseline/mistralai_mistral-large-4-0--high` · completed
7 calls · 21,155 prompt + 49,151 completion tokens (44,660 reasoning) · 6m 36s · $0.120 · 0 retries, 0 invalid replies
Scored from the saved script: 131/144 lines right (91.0%), 90.8% of words.
Cast 12/15; missing One man, Cosmic AC, AC.
- Merged: AC + Cosmic AC + One man + Universal AC → **Universal AC**
- Mapping: MQ-17J of Nicron → MQ-17J (alias); VJ-23X of Lameth → VJ-23X (alias)

| Kind | Reference | Run | Line |
|---|---|---|---|
| misattribution | Alexander Adell | Bertram Lupov | "It did all right." |
| misattribution | Jerrodd | Jerrodine | "We had nothing there. We'll have everything on … |
| misattribution | Jerrodd | Jerrodine | "I tell you, it's a lucky thing the … |
| misattribution | Zee Prime | Dee Sub Wun | "And you?" |
| merge | One man | Universal AC | "Most of it," |
| merge | One man | Universal AC | "is in hyperspace. In what form it is … |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL DO SO. I HAVE BEEN DOING … |
| merge | Cosmic AC | Universal AC | "NO PROBLEM IS INSOLUBLE IN ALL CONCEIVABLE CIRCUMSTANCES." |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL." |
| merge | AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Universal AC | "LET THERE BE LIGHT!" |

### `deepseek/deepseek-v4.1-flash-1017` · none

Folder `runs/baseline/deepseek_deepseek-v4.1-flash-1017--none` · completed
9 calls · 22,589 prompt + 4,168 completion tokens (0 reasoning) · 24s · $0.0046 · 0 retries, 0 invalid replies
Scored from the saved script: 130/144 lines right (90.3%), 91.9% of words.
Cast 12/15; missing One man, Universal AC, Cosmic AC.
- Merged: AC + Cosmic AC + One man + Universal AC → **AC**
- Mapping: MQ-17J of Nicron → MQ-17J (alias); VJ-23X of Lameth → VJ-23X (alias)
- Text fidelity: +14 / −1 words −"predecesors"; +"the"; +"the"; +"the"; +"the"; +"the"; +"the"; +"the"

| Kind | Reference | Run | Line |
|---|---|---|---|
| misattribution | MQ-17J | VJ-23X of Lameth | "Or out of dissipated heat?" |
| misattribution | VJ-23X | MQ-17J of Nicron | "There may be some way to reverse entropy. … |
| misattribution | Zee Prime | Dee Sub Wun | "And you?" |
| merge | One man | AC | "Most of it," |
| merge | One man | AC | "is in hyperspace. In what form it is … |
| merge | Universal AC | AC | "THIS IS THE ORIGINAL GALAXY OF MAN." |
| merge | Universal AC | AC | "MAN'S ORIGINAL STAR HAS GONE NOVA. IT IS … |
| merge | Universal AC | AC | "A NEW WORLD, AS IN SUCH CASES WAS … |
| merge | Universal AC | AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | AC | "I WILL DO SO. I HAVE BEEN DOING … |
| merge | Cosmic AC | AC | "NO PROBLEM IS INSOLUBLE IN ALL CONCEIVABLE CIRCUMSTANCES." |
| merge | Cosmic AC | AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | AC | "I WILL." |

### `anthropic/claude-haiku-5.5` · none

Folder `runs/baseline/anthropic_claude-haiku-5.5--none` · completed
11 calls · 46,452 prompt + 6,441 completion tokens (0 reasoning) · 33s · $0.0079 · 0 retries, 0 invalid replies
Scored from the saved script: 129/144 lines right (89.6%), 91.0% of words.
Cast 12/15; missing One man, Cosmic AC, AC.
- Merged: One man + Zee Prime → **Zee Prime**
- Merged: AC + Cosmic AC + Universal AC → **Universal AC**

| Kind | Reference | Run | Line |
|---|---|---|---|
| misattribution | Alexander Adell | Bertram Lupov | "It did all right." |
| misattribution | Bertram Lupov | Alexander Adell | "Who says it didn't? What I say is … |
| misattribution | Alexander Adell | Bertram Lupov | "Don't shout. When the sun is done, the … |
| misattribution | Bertram Lupov | Alexander Adell | "Darn right they will," |
| misattribution | Jerrodd | Jerrodine | "The stars are the power-units. dear. Once they're … |
| misattribution | Jerrodine | Jerrodd | "Go ahead," |
| merge | One man | Zee Prime | "Most of it," |
| merge | One man | Zee Prime | "is in hyperspace. In what form it is … |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL DO SO. I HAVE BEEN DOING … |
| merge | Cosmic AC | Universal AC | "NO PROBLEM IS INSOLUBLE IN ALL CONCEIVABLE CIRCUMSTANCES." |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL." |
| merge | AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Universal AC | "LET THERE BE LIGHT!" |

### `minimax/minimax-m3.1-flash` · low

Folder `runs/baseline/minimax_minimax-m3.1-flash--low` · completed
8 calls · 19,698 prompt + 3,715 completion tokens (0 reasoning) · 44s · $0.0045 · 0 retries, 0 invalid replies
Scored from the saved script: 129/144 lines right (89.6%), 89.7% of words.
Cast 14/15; missing One man; extra Jerrodette I and II.
- Merged: AC + One man + Universal AC → **Universal AC**
- Split: **AC** → AC (chapter 1) + Universal AC
- Mapping: MQ-17J of Nicron (chapter 1) → MQ-17J (alias); VJ-23X of Lameth (chapter 1) → VJ-23X (alias)

| Kind | Reference | Run | Line |
|---|---|---|---|
| misattribution | Alexander Adell | Bertram Lupov | "It did all right." |
| misattribution | Bertram Lupov | Alexander Adell | "Who says it didn't? What I say is … |
| misattribution | Bertram Lupov | Alexander Adell | "And don't say we'll switch to another sun." |
| misattribution | Alexander Adell | Bertram Lupov | "Don't shout. When the sun is done, the … |
| misattribution | Bertram Lupov | Alexander Adell | "Darn right they will," |
| misattribution | Jerrodette I | Jerrodette I and II | "We've reached X-23 -- we've reached X-23 -- … |
| misattribution | Jerrodd | Jerrodine | "We had nothing there. We'll have everything on … |
| misattribution | Jerrodd | Jerrodine | "I tell you, it's a lucky thing the … |
| misattribution | VJ-23X | MQ-17J of Nicron (chapter 1) | "Yet you wouldn't want to abandon life, I … |
| misattribution | MQ-17J | VJ-23X of Lameth (chapter 1) | "Not at all," |
| misattribution | MQ-17J | VJ-23X of Lameth (chapter 1) | "Or out of dissipated heat?" |
| misattribution | MQ-17J | VJ-23X of Lameth (chapter 1) | "Do you have trees on your world?" |
| merge | One man | Universal AC | "Most of it," |
| merge | One man | Universal AC | "is in hyperspace. In what form it is … |
| merge | AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |

### `qwen/qwen3.8-flash` · low

Folder `runs/baseline/qwen_qwen3.8-flash--low` · completed
8 calls · 20,818 prompt + 88,500 completion tokens (83,268 reasoning) · 22m 41s · $0.044 · 0 retries, 0 invalid replies
Scored from the saved script: 128/144 lines right (88.9%), 90.9% of words.
Cast 13/15; missing Man, AC.
- Merged: Man + One man → **the one man (chapter 1)**
- Merged: AC + Cosmic AC → **Cosmic AC**
- Mapping: MQ-17J of Nicron → MQ-17J (alias); VJ-23X of Lameth → VJ-23X (alias)
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

| Kind | Reference | Run | Line |
|---|---|---|---|
| merge | Man | the one man (chapter 1) | "The Universe is dying." |
| merge | Man | the one man (chapter 1) | "Carefully husbanded, as directed by the Cosmic AC, … |
| merge | Man | the one man (chapter 1) | "But even so," |
| merge | Man | the one man (chapter 1) | "eventually it will all come to an end. … |
| merge | Man | the one man (chapter 1) | "Can entropy not be reversed? Let us ask … |
| merge | Man | the one man (chapter 1) | "Cosmic AC," |
| merge | Man | the one man (chapter 1) | "how may entropy be reversed?" |
| merge | Man | the one man (chapter 1) | "Collect additional data." |
| merge | Man | the one man (chapter 1) | "Will there come a time," |
| merge | Man | the one man (chapter 1) | "when data will be sufficient or is the … |
| merge | Man | the one man (chapter 1) | "When will you have enough data to answer … |
| merge | Man | the one man (chapter 1) | "Will you keep working on it?" |
| merge | Man | the one man (chapter 1) | "We shall wait." |
| merge | Man | the one man (chapter 1) | "AC, is this the end? Can this chaos … |
| merge | AC | Cosmic AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Cosmic AC | "LET THERE BE LIGHT!" |

### `minimax/minimax-m3.1-flash` · high

Folder `runs/baseline/minimax_minimax-m3.1-flash--high` · completed
8 calls · 19,613 prompt + 3,342 completion tokens (0 reasoning) · 32s · $0.0041 · 0 retries, 0 invalid replies
Scored from the saved script: 128/144 lines right (88.9%), 88.5% of words.
Cast 12/15; missing One man, Cosmic AC, AC; extra Jerrodette I and II.
- Merged: Dee Sub Wun + One man → **Dee Sub Wun**
- Merged: AC + Cosmic AC + Universal AC → **Universal AC**

| Kind | Reference | Run | Line |
|---|---|---|---|
| misattribution | Alexander Adell | Bertram Lupov | "It did all right." |
| misattribution | Bertram Lupov | Alexander Adell | "Who says it didn't? What I say is … |
| misattribution | Bertram Lupov | Alexander Adell | "And don't say we'll switch to another sun." |
| misattribution | Jerrodette I | Jerrodette I and II | "We've reached X-23 -- we've reached X-23 -- … |
| misattribution | Jerrodd | Jerrodine | "We had nothing there. We'll have everything on … |
| misattribution | Jerrodette I | Jerrodette II | "Ask him how to turn the stars on … |
| misattribution | Zee Prime | Dee Sub Wun | "Shall we ask him? I am suddenly curious." |
| merge | One man | Dee Sub Wun | "Most of it," |
| merge | One man | Dee Sub Wun | "is in hyperspace. In what form it is … |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL DO SO. I HAVE BEEN DOING … |
| merge | Cosmic AC | Universal AC | "NO PROBLEM IS INSOLUBLE IN ALL CONCEIVABLE CIRCUMSTANCES." |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL." |
| merge | AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Universal AC | "LET THERE BE LIGHT!" |

### `deepseek/deepseek-v4-pro-0813` · low

Folder `runs/baseline/deepseek_deepseek-v4-pro-0813--low` · completed
8 calls · 20,755 prompt + 28,905 completion tokens (24,873 reasoning) · 5m 40s · $0.101 · 0 retries, 0 invalid replies
Scored from the saved script: 123/144 lines right (85.4%), 87.4% of words.
Cast 12/15; missing Man, Cosmic AC, AC.
- Merged: Man + One man → **The One Man (chapter 1)**
- Merged: AC + Cosmic AC + Universal AC → **Universal AC**
- Mapping: MQ-17J of Nicron → MQ-17J (alias); VJ-23X of Lameth → VJ-23X (alias)
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"

| Kind | Reference | Run | Line |
|---|---|---|---|
| merge | Man | The One Man (chapter 1) | "The Universe is dying." |
| merge | Man | The One Man (chapter 1) | "Carefully husbanded, as directed by the Cosmic AC, … |
| merge | Man | The One Man (chapter 1) | "But even so," |
| merge | Man | The One Man (chapter 1) | "eventually it will all come to an end. … |
| merge | Man | The One Man (chapter 1) | "Can entropy not be reversed? Let us ask … |
| merge | Man | The One Man (chapter 1) | "Cosmic AC," |
| merge | Man | The One Man (chapter 1) | "how may entropy be reversed?" |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Man | The One Man (chapter 1) | "Collect additional data." |
| merge | Cosmic AC | Universal AC | "I WILL DO SO. I HAVE BEEN DOING … |
| merge | Man | The One Man (chapter 1) | "Will there come a time," |
| merge | Man | The One Man (chapter 1) | "when data will be sufficient or is the … |
| merge | Cosmic AC | Universal AC | "NO PROBLEM IS INSOLUBLE IN ALL CONCEIVABLE CIRCUMSTANCES." |
| merge | Man | The One Man (chapter 1) | "When will you have enough data to answer … |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Man | The One Man (chapter 1) | "Will you keep working on it?" |
| merge | Cosmic AC | Universal AC | "I WILL." |
| merge | Man | The One Man (chapter 1) | "We shall wait." |
| merge | Man | The One Man (chapter 1) | "AC, is this the end? Can this chaos … |
| merge | AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Universal AC | "LET THERE BE LIGHT!" |

### `inclusionai/ling-3.0-tiny` · medium

Folder `runs/baseline/inclusionai_ling-3.0-tiny--medium` · failed: Speaker verification returned missing, duplicate, or unexpected segment ids. Script was not saved; run the script stage again, and finished blocks are kept.
8 calls · 20,701 prompt + 118,624 completion tokens (112,619 reasoning) · 13m 08s · $0.0055 · 0 retries, 0 invalid replies
Scored from the checkpoint's finished blocks (stopped before verification): 99/144 lines right (68.8%), 61.7% of words.
Cast 12/15; missing Jerrodette II, One man, AC.
- Merged: Jerrodd + Jerrodette II → **Jerrodd**
- Merged: Jerrodette II + Jerrodine → **Jerrodine**
- Merged: One man + Zee Prime → **Zee Prime**
- Merged: One man + Universal AC → **Universal AC**
- Merged: AC + Cosmic AC → **The Cosmic AC**
- Split: **Alexander Adell** → Alexander Adell + Bertram Lupov
- Split: **Bertram Lupov** → Alexander Adell + Bertram Lupov
- Split: **Jerrodette I** → Jerrodd + Jerrodette I
- Split: **Jerrodette II** → Jerrodd + Jerrodine
- Split: **MQ-17J** → MQ-17J + VJ-23X
- Split: **Zee Prime** → Dee Sub Wun + Zee Prime
- Split: **One man** → Universal AC + Zee Prime
- Unresolved: unresolved speaker
- Text fidelity: +1 / −1 words −"predecesors"; +"predecessors"
- Narration given to a character: Jerrodd "ac" (1 words); Jerrodd "microvac" (1 words); Jerrodd "automatic computer" (2 words)

| Kind | Reference | Run | Line |
|---|---|---|---|
| split | Alexander Adell | Bertram Lupov | "Oh, hell, just about forever. Till the sun … |
| split | Bertram Lupov | Alexander Adell | "That's not forever." |
| split | Alexander Adell | Bertram Lupov | "All right, then. Billions and billions of years. … |
| split | Alexander Adell | Bertram Lupov | "Well, it will last our time, won't it?" |
| split | Bertram Lupov | Alexander Adell | "I don't have to ask Multivac. I know … |
| split | Bertram Lupov | Alexander Adell | "Who says it didn't? What I say is … |
| split | Bertram Lupov | Alexander Adell | "Sure you are. You're weak on logic, that's … |
| split | Alexander Adell | Bertram Lupov | "Don't shout. When the sun is done, the … |
| split | Bertram Lupov | Alexander Adell | "Then you know everything's got to run down … |
| split | Alexander Adell | Bertram Lupov | "All right. Who says they won't?" |
| split | Bertram Lupov | Alexander Adell | "You did, you poor sap. You said we … |
| split | Alexander Adell | Bertram Lupov | "Why not? Someday." |
| split | Alexander Adell | Bertram Lupov | "Ask Multivac." |
| split | Jerrodette I | Jerrodd | "We've reached X-23 -- we've reached X-23 -- … |
| unresolved | Jerrodine | unresolved speaker | "Quiet, children." |
| unresolved | Jerrodine | unresolved speaker | "Are you sure, Jerrodd?" |
| unresolved | Jerrodine | unresolved speaker | "So many stars, so many planets," |
| unresolved | Jerrodine | unresolved speaker | "I suppose families will be going out to … |
| misattribution | Jerrodd | Jerrodine | "Not forever," |
| unresolved | Jerrodd | unresolved speaker | "It will all stop someday, but not for … |
| merge | Jerrodette II | Jerrodd | "What's entropy, daddy?" |
| unresolved | Jerrodd | unresolved speaker | "Entropy, little sweet, is just a word which … |
| merge | Jerrodette II | Jerrodine | "Can't you just put in a new power-unit, … |
| misattribution | Jerrodd | Jerrodette I | "The stars are the power-units. dear. Once they're … |
| split | Jerrodette I | Jerrodd | "Ask the Microvac," |
| misattribution | Jerrodette I | Jerrodine | "Ask him how to turn the stars on … |
| split | MQ-17J | VJ-23X | "I wouldn't consider any other kind of report. … |
| split | MQ-17J | VJ-23X | "A hundred billion is not infinite and it's … |
| split | MQ-17J | VJ-23X | "Very well. Immortality exists and we have to … |
| split | MQ-17J | VJ-23X | "I'm still under two hundred. --But to get … |
| split | MQ-17J | VJ-23X | "Granted, but even with a hundred per cent … |
| misattribution | VJ-23X | MQ-17J | "There may be some way to reverse entropy. … |
| split | MQ-17J | VJ-23X | "Why not?" |
| split | Zee Prime | Dee Sub Wun | "We call it only the Galaxy. And you?" |
| split | Zee Prime | Dee Sub Wun | "True. Since all Galaxies are the same." |
| misattribution | Dee Sub Wun | Zee Prime | "I cannot say. The Universal AC would know." |
| split | Zee Prime | Dee Sub Wun | "Shall we ask him? I am suddenly curious." |
| merge | One man | Zee Prime | "Most of it," |
| merge | One man | Universal AC | "is in hyperspace. In what form it is … |
| split | Zee Prime | Dee Sub Wun | "Yes, of course," |
| split | Zee Prime | Dee Sub Wun | "The stars are dying. The original star is … |
| misattribution | Dee Sub Wun | Zee Prime | "It will take billions of years." |
| misattribution | Man | The Cosmic AC | "Will you keep working on it?" |
| merge | AC | The Cosmic AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | The Cosmic AC | "LET THERE BE LIGHT!" |

### `inclusionai/ling-3.0-tiny` · low

Folder `runs/baseline/inclusionai_ling-3.0-tiny--low` · blocked: New or unresolved speakers in chapter 1: unresolved speaker. They are listed under "unresolved" in characters.json and in the workspace's Cast panel. For each, add the character, or set "resolveAs" to an existing character's name or to "narrator", then run Script again: the attributed text is kept and is not paid for twice.
8 calls · 20,411 prompt + 170,929 completion tokens (165,286 reasoning) · 18m 59s · $0.0079 · 0 retries, 0 invalid replies
Scored from the checkpoint's verified segments (blocked run): 96/144 lines right (66.7%), 62.4% of words.
Cast 12/15; missing One man, Cosmic AC, AC.
- Merged: Alexander Adell + Bertram Lupov → **Alexander Adell**
- Merged: AC + Cosmic AC + Universal AC → **Universal AC**
- Split: **Bertram Lupov** → Alexander Adell + Bertram Lupov
- Split: **VJ-23X** → MQ-17J + VJ-23X
- Split: **MQ-17J** → MQ-17J + VJ-23X
- Split: **Dee Sub Wun** → Dee Sub Wun + Zee Prime
- Unresolved: unresolved speaker
- Narration given to a character: unresolved speaker "ac" (1 words); unresolved speaker "microvac" (1 words)

| Kind | Reference | Run | Line |
|---|---|---|---|
| misattribution | Alexander Adell | Bertram Lupov | "Oh, hell, just about forever. Till the sun … |
| misattribution | Alexander Adell | Bertram Lupov | "All right, then. Billions and billions of years. … |
| misattribution | Alexander Adell | Bertram Lupov | "Well, it will last our time, won't it?" |
| merge | Bertram Lupov | Alexander Adell | "I don't have to ask Multivac. I know … |
| merge | Bertram Lupov | Alexander Adell | "Who says it didn't? What I say is … |
| merge | Bertram Lupov | Alexander Adell | "You're thinking we'll switch to another sun when … |
| merge | Bertram Lupov | Alexander Adell | "Sure you are. You're weak on logic, that's … |
| merge | Bertram Lupov | Alexander Adell | "Then you know everything's got to run down … |
| merge | Bertram Lupov | Alexander Adell | "You did, you poor sap. You said we … |
| merge | Bertram Lupov | Alexander Adell | "Never." |
| merge | Bertram Lupov | Alexander Adell | "Never." |
| merge | Bertram Lupov | Alexander Adell | "You ask Multivac. I dare you. Five dollars … |
| misattribution | Jerrodine | Jerrodd | "So many stars, so many planets," |
| unresolved | Jerrodd | unresolved speaker | "The stars are the power-units. dear. Once they're … |
| unresolved | Jerrodine | unresolved speaker | "Now look what you've done," |
| misattribution | Jerrodd | Jerrodine | "How was I to know it would frighten … |
| misattribution | Jerrodette I | Jerrodd | "Ask the Microvac," |
| split | MQ-17J | VJ-23X | "A hundred billion is not infinite and it's … |
| split | VJ-23X | MQ-17J | "Yet you wouldn't want to abandon life, I … |
| split | MQ-17J | VJ-23X | "I'm still under two hundred. --But to get … |
| split | VJ-23X | MQ-17J | "Most of it's wasted. After all, our own … |
| split | VJ-23X | MQ-17J | "We'll just have to build new stars out … |
| split | VJ-23X | MQ-17J | "There may be some way to reverse entropy. … |
| split | MQ-17J | VJ-23X | "Why not?" |
| split | MQ-17J | VJ-23X | "Do you have trees on your world?" |
| misattribution | Zee Prime | Dee Sub Wun | "And you?" |
| misattribution | Zee Prime | Dee Sub Wun | "We call it only the Galaxy. And you?" |
| split | Dee Sub Wun | Zee Prime | "We call ours the same. All men call … |
| to-narrator | Zee Prime | narrator | "True. Since all Galaxies are the same." |
| split | Dee Sub Wun | Zee Prime | "Not all Galaxies. On one particular Galaxy the … |
| to-narrator | Zee Prime | narrator | "On which one?" |
| split | Dee Sub Wun | Zee Prime | "I cannot say. The Universal AC would know." |
| to-narrator | Zee Prime | narrator | "Shall we ask him? I am suddenly curious." |
| to-narrator | Zee Prime | narrator | "Universal AC! On which Galaxy did mankind originate?" |
| to-narrator | Zee Prime | narrator | "But how can that be all of Universal … |
| to-narrator | One man | narrator | "Most of it," |
| to-narrator | One man | narrator | "is in hyperspace. In what form it is … |
| misattribution | Zee Prime | Dee Sub Wun | "Did the men upon it die?" |
| misattribution | Zee Prime | Dee Sub Wun | "The stars are dying. The original star is … |
| misattribution | Zee Prime | Dee Sub Wun | "But when all energy is gone, our bodies … |
| misattribution | Zee Prime | Dee Sub Wun | "I do not wish it to happen even … |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL DO SO. I HAVE BEEN DOING … |
| merge | Cosmic AC | Universal AC | "NO PROBLEM IS INSOLUBLE IN ALL CONCEIVABLE CIRCUMSTANCES." |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL." |
| merge | AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | AC | Universal AC | "LET THERE BE LIGHT!" |

### `inclusionai/ling-3.0-tiny` · high

Folder `runs/baseline/inclusionai_ling-3.0-tiny--high` · failed: Speaker verification returned missing, duplicate, or unexpected segment ids. Script was not saved; run the script stage again, and finished blocks are kept.
8 calls · 21,710 prompt + 235,179 completion tokens (229,755 reasoning) · 27m 09s · $0.011 · 0 retries, 0 invalid replies
Scored from the checkpoint's finished blocks (stopped before verification): 54/144 lines right (37.5%), 31.2% of words.
Cast 9/15; missing Alexander Adell, Bertram Lupov, Jerrodette I, Jerrodette II, One man, Cosmic AC.
- Merged: MQ-17J + VJ-23X → **VJ-23X**
- Merged: Dee Sub Wun + Zee Prime → **Dee Sub Wun**
- Merged: AC + Cosmic AC + One man + Universal AC → **Universal AC**
- Split: **MQ-17J** → MQ-17J + VJ-23X
- Split: **Zee Prime** → Dee Sub Wun + Zee Prime
- Split: **AC** → AC + Universal AC
- Unresolved: unresolved speaker
- Narration given to a character: Jerrodine "automatic computer" (2 words)

| Kind | Reference | Run | Line |
|---|---|---|---|
| to-narrator | Alexander Adell | narrator | "It's amazing when you think of it," |
| to-narrator | Alexander Adell | narrator | "All the energy we can possibly ever use … |
| to-narrator | Bertram Lupov | narrator | "Not forever," |
| to-narrator | Alexander Adell | narrator | "Oh, hell, just about forever. Till the sun … |
| to-narrator | Bertram Lupov | narrator | "That's not forever." |
| to-narrator | Alexander Adell | narrator | "All right, then. Billions and billions of years. … |
| to-narrator | Bertram Lupov | narrator | "Ten billion years isn't forever." |
| to-narrator | Alexander Adell | narrator | "Well, it will last our time, won't it?" |
| to-narrator | Bertram Lupov | narrator | "So would the coal and uranium." |
| to-narrator | Alexander Adell | narrator | "All right, but now we can hook up … |
| to-narrator | Bertram Lupov | narrator | "I don't have to ask Multivac. I know … |
| to-narrator | Alexander Adell | narrator | "Then stop running down what Multivac's done for … |
| to-narrator | Alexander Adell | narrator | "It did all right." |
| to-narrator | Bertram Lupov | narrator | "Who says it didn't? What I say is … |
| to-narrator | Bertram Lupov | narrator | "And don't say we'll switch to another sun." |
| to-narrator | Bertram Lupov | narrator | "You're thinking we'll switch to another sun when … |
| to-narrator | Alexander Adell | narrator | "I'm not thinking." |
| to-narrator | Bertram Lupov | narrator | "Sure you are. You're weak on logic, that's … |
| to-narrator | Alexander Adell | narrator | "I get it," |
| to-narrator | Alexander Adell | narrator | "Don't shout. When the sun is done, the … |
| to-narrator | Bertram Lupov | narrator | "Darn right they will," |
| to-narrator | Bertram Lupov | narrator | "It all had a beginning in the original … |
| to-narrator | Alexander Adell | narrator | "I know all about entropy," |
| to-narrator | Bertram Lupov | narrator | "The hell you do." |
| to-narrator | Alexander Adell | narrator | "I know as much as you do." |
| to-narrator | Bertram Lupov | narrator | "Then you know everything's got to run down … |
| to-narrator | Alexander Adell | narrator | "All right. Who says they won't?" |
| to-narrator | Bertram Lupov | narrator | "You did, you poor sap. You said we … |
| to-narrator | Alexander Adell | narrator | "Maybe we can build things up again someday," |
| to-narrator | Bertram Lupov | narrator | "Never." |
| to-narrator | Alexander Adell | narrator | "Why not? Someday." |
| to-narrator | Bertram Lupov | narrator | "Never." |
| to-narrator | Alexander Adell | narrator | "Ask Multivac." |
| to-narrator | Bertram Lupov | narrator | "You ask Multivac. I dare you. Five dollars … |
| to-narrator | Bertram Lupov | narrator | "No bet," |
| misattribution | Jerrodette I | Jerrodine | "We've reached X-23 -- we've reached X-23 -- … |
| to-narrator | Jerrodine | narrator | "Are you sure, Jerrodd?" |
| to-narrator | Jerrodd | narrator | "What is there to be but sure?" |
| unresolved | Jerrodine | unresolved speaker | "I can't help it. I feel funny about … |
| unresolved | Jerrodd | unresolved speaker | "Why, for Pete's sake?" |
| unresolved | Jerrodd | unresolved speaker | "We had nothing there. We'll have everything on … |
| unresolved | Jerrodd | unresolved speaker | "I tell you, it's a lucky thing the … |
| unresolved | Jerrodine | unresolved speaker | "I know, I know," |
| unresolved | Jerrodette I | unresolved speaker | "Our Microvac is the best Microvac in the … |
| unresolved | Jerrodd | unresolved speaker | "I think so, too," |
| unresolved | Jerrodine | unresolved speaker | "So many stars, so many planets," |
| unresolved | Jerrodine | unresolved speaker | "I suppose families will be going out to … |
| unresolved | Jerrodd | unresolved speaker | "Not forever," |
| unresolved | Jerrodd | unresolved speaker | "It will all stop someday, but not for … |
| unresolved | Jerrodette II | unresolved speaker | "What's entropy, daddy?" |
| unresolved | Jerrodd | unresolved speaker | "Entropy, little sweet, is just a word which … |
| unresolved | Jerrodette II | unresolved speaker | "Can't you just put in a new power-unit, … |
| unresolved | Jerrodd | unresolved speaker | "The stars are the power-units. dear. Once they're … |
| unresolved | Jerrodette I | unresolved speaker | "Don't let them, daddy. Don't let the stars … |
| unresolved | Jerrodine | unresolved speaker | "Now look what you've done," |
| unresolved | Jerrodd | unresolved speaker | "How was I to know it would frighten … |
| unresolved | Jerrodette I | unresolved speaker | "Ask the Microvac," |
| unresolved | Jerrodette I | unresolved speaker | "Ask him how to turn the stars on … |
| unresolved | Jerrodine | unresolved speaker | "Go ahead," |
| unresolved | Jerrodine | unresolved speaker | "It will quiet them down." |
| unresolved | Jerrodd | unresolved speaker | "Now, now, honeys. I'll ask Microvac. Don't worry, … |
| unresolved | Jerrodd | unresolved speaker | "Print the answer." |
| unresolved | Jerrodd | unresolved speaker | "See now, the Microvac says it will take … |
| unresolved | Jerrodine | unresolved speaker | "And now, children, it's time for bed. We'll … |
| merge | MQ-17J | VJ-23X | "I wouldn't consider any other kind of report. … |
| merge | MQ-17J | VJ-23X | "A hundred billion is not infinite and it's … |
| merge | MQ-17J | VJ-23X | "Very well. Immortality exists and we have to … |
| misattribution | VJ-23X | MQ-17J | "Yet you wouldn't want to abandon life, I … |
| merge | MQ-17J | VJ-23X | "Not yet. I'm by no means old enough. … |
| merge | MQ-17J | VJ-23X | "I'm still under two hundred. --But to get … |
| misattribution | VJ-23X | MQ-17J | "Most of it's wasted. After all, our own … |
| merge | MQ-17J | VJ-23X | "I've half a mind to," |
| merge | MQ-17J | VJ-23X | "It's something the human race will have to … |
| merge | MQ-17J | VJ-23X | "Why not?" |
| merge | Zee Prime | Dee Sub Wun | "We call it only the Galaxy. And you?" |
| merge | Zee Prime | Dee Sub Wun | "True. Since all Galaxies are the same." |
| merge | Zee Prime | Dee Sub Wun | "Shall we ask him? I am suddenly curious." |
| merge | One man | Universal AC | "Most of it," |
| merge | One man | Universal AC | "is in hyperspace. In what form it is … |
| misattribution | Zee Prime | Universal AC | "Did the men upon it die?" |
| merge | Zee Prime | Dee Sub Wun | "Yes, of course," |
| merge | Zee Prime | Dee Sub Wun | "The stars are dying. The original star is … |
| merge | Zee Prime | Dee Sub Wun | "But when all energy is gone, our bodies … |
| merge | Zee Prime | Dee Sub Wun | "I do not wish it to happen even … |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL DO SO. I HAVE BEEN DOING … |
| merge | Cosmic AC | Universal AC | "NO PROBLEM IS INSOLUBLE IN ALL CONCEIVABLE CIRCUMSTANCES." |
| merge | Cosmic AC | Universal AC | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Cosmic AC | Universal AC | "I WILL." |
| merge | AC | Universal AC | "LET THERE BE LIGHT!" |

### `inclusionai/ling-3.0-tiny` · none

Folder `runs/baseline/inclusionai_ling-3.0-tiny--none` · failed: Speaker verification returned missing, duplicate, or unexpected segment ids. Script was not saved; run the script stage again, and finished blocks are kept.
8 calls · 21,597 prompt + 7,075 completion tokens (0 reasoning) · 51s · $0.0006 · 0 retries, 0 invalid replies
Scored from the checkpoint's finished blocks (stopped before verification): 24/144 lines right (16.7%), 13.0% of words.
Cast 7/15; missing VJ-23X, MQ-17J, Zee Prime, Dee Sub Wun, One man, Universal AC, Man, Cosmic AC.
- Merged: Jerrodd + Jerrodette II → **Jerrodd**
- Merged: Jerrodette I + Jerrodine → **Jerrodine**
- Merged: Cosmic AC + Dee Sub Wun + MQ-17J + Man + One man + Universal AC + VJ-23X + Zee Prime → **Alexander Adell**
- Split: **Bertram Lupov** → Adell + Lupov
- Split: **Jerrodette I** → Jerrodette I + Jerrodine
- Split: **Jerrodine** → Jerrodd + Jerrodine
- Split: **Jerrodette II** → Jerrodd + Jerrodette II
- Split: **VJ-23X** → Alexander Adell + Bertram Lupov
- Split: **MQ-17J** → Alexander Adell + Bertram Lupov
- Unresolved: unresolved speaker

| Kind | Reference | Run | Line |
|---|---|---|---|
| misattribution | Alexander Adell | Adell | "It's amazing when you think of it," |
| misattribution | Alexander Adell | Adell | "All the energy we can possibly ever use … |
| split | Bertram Lupov | Lupov | "Not forever," |
| misattribution | Alexander Adell | Lupov | "Oh, hell, just about forever. Till the sun … |
| unresolved | Bertram Lupov | unresolved speaker | "That's not forever." |
| misattribution | Alexander Adell | Lupov | "All right, then. Billions and billions of years. … |
| split | Bertram Lupov | Lupov | "Ten billion years isn't forever." |
| misattribution | Alexander Adell | Lupov | "Well, it will last our time, won't it?" |
| split | Bertram Lupov | Lupov | "So would the coal and uranium." |
| misattribution | Alexander Adell | Adell | "All right, but now we can hook up … |
| split | Bertram Lupov | Adell | "I don't have to ask Multivac. I know … |
| misattribution | Alexander Adell | Adell | "Then stop running down what Multivac's done for … |
| misattribution | Alexander Adell | Adell | "It did all right." |
| split | Bertram Lupov | Adell | "Who says it didn't? What I say is … |
| split | Bertram Lupov | Lupov | "And don't say we'll switch to another sun." |
| split | Bertram Lupov | Adell | "You're thinking we'll switch to another sun when … |
| misattribution | Alexander Adell | Adell | "I'm not thinking." |
| split | Bertram Lupov | Adell | "Sure you are. You're weak on logic, that's … |
| misattribution | Alexander Adell | Adell | "I get it," |
| misattribution | Alexander Adell | Adell | "Don't shout. When the sun is done, the … |
| split | Bertram Lupov | Lupov | "Darn right they will," |
| split | Bertram Lupov | Lupov | "It all had a beginning in the original … |
| misattribution | Alexander Adell | Adell | "I know all about entropy," |
| split | Bertram Lupov | Lupov | "The hell you do." |
| misattribution | Alexander Adell | Adell | "I know as much as you do." |
| split | Bertram Lupov | Adell | "Then you know everything's got to run down … |
| misattribution | Alexander Adell | Adell | "All right. Who says they won't?" |
| split | Bertram Lupov | Adell | "You did, you poor sap. You said we … |
| misattribution | Alexander Adell | Adell | "Maybe we can build things up again someday," |
| split | Bertram Lupov | Lupov | "Never." |
| misattribution | Alexander Adell | Lupov | "Why not? Someday." |
| split | Bertram Lupov | Lupov | "Never." |
| misattribution | Alexander Adell | Adell | "Ask Multivac." |
| split | Bertram Lupov | Adell | "You ask Multivac. I dare you. Five dollars … |
| unresolved | Bertram Lupov | unresolved speaker | "No bet," |
| merge | Jerrodette I | Jerrodine | "We've reached X-23 -- we've reached X-23 -- … |
| split | Jerrodine | Jerrodd | "Are you sure, Jerrodd?" |
| misattribution | Jerrodd | Jerrodine | "I tell you, it's a lucky thing the … |
| merge | Jerrodette I | Jerrodine | "Our Microvac is the best Microvac in the … |
| split | Jerrodine | Jerrodd | "So many stars, so many planets," |
| split | Jerrodine | Jerrodd | "I suppose families will be going out to … |
| merge | Jerrodette II | Jerrodd | "What's entropy, daddy?" |
| misattribution | Jerrodd | Jerrodine | "Entropy, little sweet, is just a word which … |
| merge | Jerrodette I | Jerrodine | "Ask him how to turn the stars on … |
| merge | VJ-23X | Alexander Adell | "Are we ridiculous, I wonder in being so … |
| merge | MQ-17J | Alexander Adell | "I think not. You know the Galaxy will … |
| merge | VJ-23X | Alexander Adell | "Still," |
| merge | VJ-23X | Alexander Adell | "I hesitate to submit a pessimistic report to … |
| split | MQ-17J | Bertram Lupov | "I wouldn't consider any other kind of report. … |
| split | VJ-23X | Bertram Lupov | "Space is infinite. A hundred billion Galaxies are … |
| merge | MQ-17J | Alexander Adell | "A hundred billion is not infinite and it's … |
| merge | VJ-23X | Alexander Adell | "We can thank immortality for that." |
| split | MQ-17J | Bertram Lupov | "Very well. Immortality exists and we have to … |
| merge | VJ-23X | Alexander Adell | "Yet you wouldn't want to abandon life, I … |
| split | MQ-17J | Bertram Lupov | "Not at all," |
| split | MQ-17J | Bertram Lupov | "Not yet. I'm by no means old enough. … |
| merge | VJ-23X | Alexander Adell | "Two hundred twenty-three. And you?" |
| split | MQ-17J | Bertram Lupov | "I'm still under two hundred. --But to get … |
| split | VJ-23X | Bertram Lupov | "As a side issue, there's a problem of … |
| merge | MQ-17J | Alexander Adell | "A very good point. Already, mankind consumes two … |
| split | VJ-23X | Bertram Lupov | "Most of it's wasted. After all, our own … |
| merge | MQ-17J | Alexander Adell | "Granted, but even with a hundred per cent … |
| split | VJ-23X | Bertram Lupov | "We'll just have to build new stars out … |
| merge | MQ-17J | Alexander Adell | "Or out of dissipated heat?" |
| merge | VJ-23X | Alexander Adell | "There may be some way to reverse entropy. … |
| merge | MQ-17J | Alexander Adell | "I've half a mind to," |
| merge | MQ-17J | Alexander Adell | "It's something the human race will have to … |
| merge | MQ-17J | Alexander Adell | "Can entropy ever be reversed?" |
| merge | VJ-23X | Alexander Adell | "Oh, say, I didn't really mean to have … |
| split | MQ-17J | Bertram Lupov | "Why not?" |
| merge | VJ-23X | Alexander Adell | "We both know entropy can't be reversed. You … |
| split | MQ-17J | Bertram Lupov | "Do you have trees on your world?" |
| split | VJ-23X | Bertram Lupov | "See!" |
| merge | Zee Prime | Alexander Adell | "I am Zee Prime," |
| merge | Zee Prime | Alexander Adell | "And you?" |
| merge | Dee Sub Wun | Alexander Adell | "I am Dee Sub Wun. Your Galaxy?" |
| merge | Zee Prime | Alexander Adell | "We call it only the Galaxy. And you?" |
| merge | Dee Sub Wun | Alexander Adell | "We call ours the same. All men call … |
| merge | Zee Prime | Alexander Adell | "True. Since all Galaxies are the same." |
| merge | Dee Sub Wun | Alexander Adell | "Not all Galaxies. On one particular Galaxy the … |
| merge | Zee Prime | Alexander Adell | "On which one?" |
| merge | Dee Sub Wun | Alexander Adell | "I cannot say. The Universal AC would know." |
| merge | Zee Prime | Alexander Adell | "Shall we ask him? I am suddenly curious." |
| merge | Zee Prime | Alexander Adell | "Universal AC! On which Galaxy did mankind originate?" |
| merge | Zee Prime | Alexander Adell | "But how can that be all of Universal … |
| merge | One man | Alexander Adell | "Most of it," |
| merge | One man | Alexander Adell | "is in hyperspace. In what form it is … |
| merge | Universal AC | Alexander Adell | "THIS IS THE ORIGINAL GALAXY OF MAN." |
| merge | Dee Sub Wun | Alexander Adell | "And is one of these stars the original … |
| merge | Universal AC | Alexander Adell | "MAN'S ORIGINAL STAR HAS GONE NOVA. IT IS … |
| merge | Zee Prime | Alexander Adell | "Did the men upon it die?" |
| merge | Universal AC | Alexander Adell | "A NEW WORLD, AS IN SUCH CASES WAS … |
| merge | Zee Prime | Alexander Adell | "Yes, of course," |
| merge | Dee Sub Wun | Alexander Adell | "What is wrong?" |
| merge | Zee Prime | Alexander Adell | "The stars are dying. The original star is … |
| merge | Dee Sub Wun | Alexander Adell | "They must all die. Why not?" |
| merge | Zee Prime | Alexander Adell | "But when all energy is gone, our bodies … |
| merge | Dee Sub Wun | Alexander Adell | "It will take billions of years." |
| merge | Zee Prime | Alexander Adell | "I do not wish it to happen even … |
| merge | Dee Sub Wun | Alexander Adell | "You're asking how entropy might be reversed in … |
| merge | Universal AC | Alexander Adell | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Man | Alexander Adell | "The Universe is dying." |
| merge | Man | Alexander Adell | "Carefully husbanded, as directed by the Cosmic AC, … |
| unresolved | Man | unresolved speaker | "But even so," |
| unresolved | Man | unresolved speaker | "eventually it will all come to an end. … |
| unresolved | Man | unresolved speaker | "Can entropy not be reversed? Let us ask … |
| merge | Man | Alexander Adell | "Cosmic AC," |
| unresolved | Man | unresolved speaker | "how may entropy be reversed?" |
| unresolved | Cosmic AC | unresolved speaker | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Man | Alexander Adell | "Collect additional data." |
| merge | Cosmic AC | Alexander Adell | "I WILL DO SO. I HAVE BEEN DOING … |
| merge | Man | Alexander Adell | "Will there come a time," |
| unresolved | Man | unresolved speaker | "when data will be sufficient or is the … |
| unresolved | Cosmic AC | unresolved speaker | "NO PROBLEM IS INSOLUBLE IN ALL CONCEIVABLE CIRCUMSTANCES." |
| unresolved | Man | unresolved speaker | "When will you have enough data to answer … |
| merge | Cosmic AC | Alexander Adell | "THERE IS AS YET INSUFFICIENT DATA FOR A … |
| merge | Man | Alexander Adell | "Will you keep working on it?" |
| merge | Cosmic AC | Alexander Adell | "I WILL." |
| merge | Man | Alexander Adell | "We shall wait." |
| merge | Man | Alexander Adell | "AC, is this the end? Can this chaos … |

### `anthropic/claude-opus-5.5` · none

Folder `runs/baseline/anthropic_claude-opus-5.5--none` · rejected: OpenRouter LLM request failed (400): Reasoning is mandatory for this endpoint and cannot be disabled.. Diagnostics: {"content":"undefined","errorCode":400}
0 calls · 0 prompt + 0 completion tokens (0 reasoning) · 2s · $0.0000 · 0 retries, 0 invalid replies

No script or checkpoint to score: the run stopped before its first block was saved.

### `anthropic/claude-sonnet-5.5` · none

Folder `runs/baseline/anthropic_claude-sonnet-5.5--none` · rejected: OpenRouter LLM request failed (400): Reasoning is mandatory for this endpoint and cannot be disabled.. Diagnostics: {"content":"undefined","errorCode":400}
0 calls · 0 prompt + 0 completion tokens (0 reasoning) · 1s · $0.0000 · 0 retries, 0 invalid replies

No script or checkpoint to score: the run stopped before its first block was saved.

### `google/gemini-3.8-flash` · none

Folder `runs/baseline/google_gemini-3.8-flash--none` · rejected: OpenRouter LLM request failed (400): Reasoning is mandatory for this endpoint and cannot be disabled.. Diagnostics: {"content":"undefined","errorCode":400}
0 calls · 0 prompt + 0 completion tokens (0 reasoning) · 1s · $0.0000 · 0 retries, 0 invalid replies

No script or checkpoint to score: the run stopped before its first block was saved.

### `google/gemini-4-carbon` · none

Folder `runs/baseline/google_gemini-4-carbon--none` · rejected: OpenRouter LLM request failed (400): Reasoning is mandatory for this endpoint and cannot be disabled.. Diagnostics: {"content":"undefined","errorCode":400}
0 calls · 0 prompt + 0 completion tokens (0 reasoning) · 1s · $0.0000 · 0 retries, 0 invalid replies

No script or checkpoint to score: the run stopped before its first block was saved.

### `meta/muse-ember` · high

Folder `runs/baseline/meta_muse-ember--high` · rejected: OpenRouter LLM request failed (400): Provider returned error ({"error":{"message":"'required' is required to be supplied and to be an array including every key in properties. Missing 'delivery'.","type":"invalid_request_error","param":null,"code":"invalid_request"}}). Diagnostics: {"content":"undefined","errorCode":400,"upstreamError":"{\"error\":{\"message\":\"'required' is required to be supplied and to be an array including every key in properties. Missing 'delivery'.\",\"type\":\"invalid_request_error\",\"param\":null,\"code\":\"invalid_request\"}}"}
0 calls · 0 prompt + 0 completion tokens (0 reasoning) · 2s · $0.0000 · 0 retries, 0 invalid replies

No script or checkpoint to score: the run stopped before its first block was saved.

### `meta/muse-ember` · low

Folder `runs/baseline/meta_muse-ember--low` · rejected: OpenRouter LLM request failed (400): Provider returned error ({"error":{"message":"'required' is required to be supplied and to be an array including every key in properties. Missing 'delivery'.","type":"invalid_request_error","param":null,"code":"invalid_request"}}). Diagnostics: {"content":"undefined","errorCode":400,"upstreamError":"{\"error\":{\"message\":\"'required' is required to be supplied and to be an array including every key in properties. Missing 'delivery'.\",\"type\":\"invalid_request_error\",\"param\":null,\"code\":\"invalid_request\"}}"}
0 calls · 0 prompt + 0 completion tokens (0 reasoning) · 2s · $0.0000 · 0 retries, 0 invalid replies

No script or checkpoint to score: the run stopped before its first block was saved.

### `meta/muse-ember` · medium

Folder `runs/baseline/meta_muse-ember--medium` · rejected: OpenRouter LLM request failed (400): Provider returned error ({"error":{"message":"'required' is required to be supplied and to be an array including every key in properties. Missing 'delivery'.","type":"invalid_request_error","param":null,"code":"invalid_request"}}). Diagnostics: {"content":"undefined","errorCode":400,"upstreamError":"{\"error\":{\"message\":\"'required' is required to be supplied and to be an array including every key in properties. Missing 'delivery'.\",\"type\":\"invalid_request_error\",\"param\":null,\"code\":\"invalid_request\"}}"}
0 calls · 0 prompt + 0 completion tokens (0 reasoning) · 2s · $0.0000 · 0 retries, 0 invalid replies

No script or checkpoint to score: the run stopped before its first block was saved.

### `meta/muse-ember` · none

Folder `runs/baseline/meta_muse-ember--none` · rejected: OpenRouter LLM request failed (400): Reasoning is mandatory for this endpoint and cannot be disabled.. Diagnostics: {"content":"undefined","errorCode":400}
0 calls · 0 prompt + 0 completion tokens (0 reasoning) · 1s · $0.0000 · 0 retries, 0 invalid replies

No script or checkpoint to score: the run stopped before its first block was saved.

### `minimax/minimax-m3.1-flash` · none

Folder `runs/baseline/minimax_minimax-m3.1-flash--none` · rejected: OpenRouter LLM request failed (400): Reasoning is mandatory for this endpoint and cannot be disabled.. Diagnostics: {"content":"undefined","errorCode":400}
0 calls · 0 prompt + 0 completion tokens (0 reasoning) · 1s · $0.0000 · 0 retries, 0 invalid replies

No script or checkpoint to score: the run stopped before its first block was saved.

### `mistralai/mistral-large-4-0` · none

Folder `runs/baseline/mistralai_mistral-large-4-0--none` · rejected: OpenRouter LLM request failed (400): Provider returned error ({"object":"error","message":"reasoning_effort none is not supported for this model, supported values: [<ReasoningEffort.high: 'high'>, <ReasoningEffort.low: 'low'>, <ReasoningEffort.medium: 'medium'>]","type":"invalid_request_invalid_args","param":null,"code":"3051","raw_status_code":400}). Diagnostics: {"content":"undefined","errorCode":400,"upstreamError":"{\"object\":\"error\",\"message\":\"reasoning_effort none is not supported for this model, supported values: [<ReasoningEffort.high: 'high'>, <ReasoningEffort.low: 'low'>, <Reas
0 calls · 0 prompt + 0 completion tokens (0 reasoning) · 5s · $0.0000 · 0 retries, 0 invalid replies

No script or checkpoint to score: the run stopped before its first block was saved.

### `openai/gpt-6.1-sol` · high

Folder `runs/baseline/openai_gpt-6.1-sol--high` · rejected: OpenRouter LLM request failed (400): Provider returned error ({ "error": { "message": "Invalid schema for response_format 'lisen_response': In context=('properties', 'labels', 'items'), 'required' is required to be supplied and to be an array including every key in properties. Missing 'delivery'.", "type": "invalid_request_error", "param": "text.format.schema", "code": "invalid_json_schema" } }). Diagnostics: {"content":"undefined","errorCode":400,"upstreamError":"{\n \"error\": {\n \"message\": \"Invalid schema for response_format 'lisen_response': In context=('properties', 'labels', 'items')
0 calls · 0 prompt + 0 completion tokens (0 reasoning) · 2s · $0.0000 · 0 retries, 0 invalid replies

No script or checkpoint to score: the run stopped before its first block was saved.

### `openai/gpt-6.1-sol` · low

Folder `runs/baseline/openai_gpt-6.1-sol--low` · rejected: OpenRouter LLM request failed (400): Provider returned error ({ "error": { "message": "Invalid schema for response_format 'lisen_response': In context=('properties', 'labels', 'items'), 'required' is required to be supplied and to be an array including every key in properties. Missing 'delivery'.", "type": "invalid_request_error", "param": "text.format.schema", "code": "invalid_json_schema" } }). Diagnostics: {"content":"undefined","errorCode":400,"upstreamError":"{\n \"error\": {\n \"message\": \"Invalid schema for response_format 'lisen_response': In context=('properties', 'labels', 'items')
0 calls · 0 prompt + 0 completion tokens (0 reasoning) · 2s · $0.0000 · 0 retries, 0 invalid replies

No script or checkpoint to score: the run stopped before its first block was saved.

### `openai/gpt-6.1-sol` · none

Folder `runs/baseline/openai_gpt-6.1-sol--none` · rejected: OpenRouter LLM request failed (400): Reasoning is mandatory for this endpoint and cannot be disabled.. Diagnostics: {"content":"undefined","errorCode":400}
0 calls · 0 prompt + 0 completion tokens (0 reasoning) · 2s · $0.0000 · 0 retries, 0 invalid replies

No script or checkpoint to score: the run stopped before its first block was saved.

### `openai/gpt-6.1-terra` · high

Folder `runs/baseline/openai_gpt-6.1-terra--high` · rejected: OpenRouter LLM request failed (400): Provider returned error ({ "error": { "message": "Invalid schema for response_format 'lisen_response': In context=('properties', 'labels', 'items'), 'required' is required to be supplied and to be an array including every key in properties. Missing 'delivery'.", "type": "invalid_request_error", "param": "text.format.schema", "code": "invalid_json_schema" } }). Diagnostics: {"content":"undefined","errorCode":400,"upstreamError":"{\n \"error\": {\n \"message\": \"Invalid schema for response_format 'lisen_response': In context=('properties', 'labels', 'items')
0 calls · 0 prompt + 0 completion tokens (0 reasoning) · 2s · $0.0000 · 0 retries, 0 invalid replies

No script or checkpoint to score: the run stopped before its first block was saved.

### `openai/gpt-6.1-terra` · low

Folder `runs/baseline/openai_gpt-6.1-terra--low` · rejected: OpenRouter LLM request failed (400): Provider returned error ({ "error": { "message": "Invalid schema for response_format 'lisen_response': In context=('properties', 'labels', 'items'), 'required' is required to be supplied and to be an array including every key in properties. Missing 'delivery'.", "type": "invalid_request_error", "param": "text.format.schema", "code": "invalid_json_schema" } }). Diagnostics: {"content":"undefined","errorCode":400,"upstreamError":"{\n \"error\": {\n \"message\": \"Invalid schema for response_format 'lisen_response': In context=('properties', 'labels', 'items')
0 calls · 0 prompt + 0 completion tokens (0 reasoning) · 2s · $0.0000 · 0 retries, 0 invalid replies

No script or checkpoint to score: the run stopped before its first block was saved.

### `openai/gpt-6.1-terra` · none

Folder `runs/baseline/openai_gpt-6.1-terra--none` · rejected: OpenRouter LLM request failed (400): Provider returned error ({ "error": { "message": "Invalid schema for response_format 'lisen_response': In context=('properties', 'labels', 'items'), 'required' is required to be supplied and to be an array including every key in properties. Missing 'delivery'.", "type": "invalid_request_error", "param": "text.format.schema", "code": "invalid_json_schema" } }). Diagnostics: {"content":"undefined","errorCode":400,"upstreamError":"{\n \"error\": {\n \"message\": \"Invalid schema for response_format 'lisen_response': In context=('properties', 'labels', 'items')
0 calls · 0 prompt + 0 completion tokens (0 reasoning) · 1s · $0.0000 · 0 retries, 0 invalid replies

No script or checkpoint to score: the run stopped before its first block was saved.

### `x-ai/grok-4.7` · none

Folder `runs/baseline/x-ai_grok-4.7--none` · rejected: OpenRouter LLM request failed (400): Reasoning is mandatory for this endpoint and cannot be disabled.. Diagnostics: {"content":"undefined","errorCode":400}
0 calls · 0 prompt + 0 completion tokens (0 reasoning) · 2s · $0.0000 · 0 retries, 0 invalid replies

No script or checkpoint to score: the run stopped before its first block was saved.

### `z-ai/glm-5.3` · none

Folder `runs/baseline/z-ai_glm-5.3--none` · rejected: OpenRouter LLM request failed (400): Reasoning is mandatory for this endpoint and cannot be disabled.. Diagnostics: {"content":"undefined","errorCode":400}
0 calls · 0 prompt + 0 completion tokens (0 reasoning) · 1s · $0.0000 · 0 retries, 0 invalid replies

No script or checkpoint to score: the run stopped before its first block was saved.

### `z-ai/glm-5.3-flash` · none

Folder `runs/baseline/z-ai_glm-5.3-flash--none` · rejected: OpenRouter LLM request failed (400): Reasoning is mandatory for this endpoint and cannot be disabled.. Diagnostics: {"content":"undefined","errorCode":400}
0 calls · 0 prompt + 0 completion tokens (0 reasoning) · 1s · $0.0000 (estimated from tokens and listed prices) · 0 retries, 0 invalid replies

No script or checkpoint to score: the run stopped before its first block was saved.

