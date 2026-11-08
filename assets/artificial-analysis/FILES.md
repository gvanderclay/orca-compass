# Artificial Analysis exports (local only)

Files pulled from the Artificial Analysis Data API, free tier, endpoint
`GET https://artificialanalysis.ai/api/v2/language/models/free` (4 pages).
They are the key owner's licensed copy: the Data Platform Terms (section 2.4)
forbid redistributing raw data files, so this folder's `.gitignore` keeps the
`.csv` and `.json` out of git and nothing from them is bundled with the
package. To refresh, set `ARTIFICIAL_ANALYSIS_API_KEY` and run
`orcacompass refresh`; the trimmed result lands in the OrcaCompass cache
(`artificialanalysis.json`), not here.

| File | What it is |
| --- | --- |
| `artificial-analysis_llm-models-raw-api-response_free-tier_<date>.json` | The API's `data` arrays, all pages merged into one list, untouched. One entry per model and effort variant: `slug`, `name`, `release_date`, `model_creator`, `evaluations` (intelligence, engineering and other indices), `artificial_analysis_intelligence_index_cost`, `pricing`, `performance`. |
| `artificial-analysis_llm-metrics-summary_free-tier_<date>.csv` | One row per entry with the columns OrcaCompass and people read: identity, `intelligence_index`, `engineering_index`, `strategy_and_ops_index`, cost per task, token prices, speed and latency, plus a computed `intelligence_per_usd_per_task`. Sorted by intelligence, highest first. UTF-8 with BOM for Excel. An empty cell means not measured, never zero. |

OrcaCompass reads only: intelligence index, engineering index, cost per task,
input and output price per million tokens, output tokens per second. See
`docs/tiers-and-routing.md`, "Benchmark placement", for the formula.

Source: Artificial Analysis (artificialanalysis.ai).
