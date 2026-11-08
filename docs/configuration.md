# Configuration

No config file is required. `orcacompass setup`, `agents`, `prefer` and `ban`
write the common keys for you; the rest are edited by hand. Code:
`src/config.ts`, `src/paths.ts`.

## Where things live

| Platform | Config | Cache |
| --- | --- | --- |
| Windows | `%APPDATA%\orcacompass\config.json` | `%LOCALAPPDATA%\orcacompass\cache` |
| macOS / Linux | `${XDG_CONFIG_HOME:-~/.config}/orcacompass/config.json` | `${XDG_CACHE_HOME:-~/.cache}/orcacompass` |
| `ORCACOMPASS_HOME` set | `$ORCACOMPASS_HOME/config.json` | `$ORCACOMPASS_HOME/cache` |

Other tools' locations follow their own environment variables:
`ORCA_USER_DATA_PATH` (Orca's data folder, for its agent switches and model
catalog), `CLAUDE_CONFIG_DIR` (default `~/.claude`, for Claude Code's model
catalog), `CODEX_HOME` (default `~/.codex`, for `models_cache.json`) and
`GROK_HOME` (default `~/.grok`, for `models_cache.json` and `bin/`).

A variable that is set but empty counts as unset. `~` is `$HOME` on macOS and
Linux and `%USERPROFILE%` on Windows, the folder the agents themselves use.

The cache holds observed state only and is safe to delete:

| File | Content |
| --- | --- |
| `modelsdev.json` | Models.dev catalog, with `fetchedAt` |
| `modelindex.json` | The Model Index ratings, with `fetchedAt` |
| `artificialanalysis.json` | Artificial Analysis benchmarks, with `fetchedAt`; written only with your own key |
| `placements.json` | The placement table: every model's tiers with the numbers behind them, built from every source; reused for `placementsTtlHours` |
| `cursor-models.json`, `grok-models.json`, `antigravity-models.json`, `opencode-models.json` | Last good model listing per agent, used only when the live command fails |
| `rejected-models.json` | Models agents refused at launch, written by `verify` |

The four model-list caches use `schemaVersion: 1`, `agent`, `fetchedAt` (Unix
milliseconds), and `models`: an array of `{ "id": "..." }` objects with an optional
provider `label` (Cursor keeps its labels, including `NO ZDR`). They store provider
observations only. Computed tiers live in `placements.json`, which records the
OrcaCompass version and the placement keys of the configuration
(`tierOverrides`, `cursorAuto`, `scoreWeight`) it was built with, so a change
to any of them rebuilds it. Usage percentages and routing decisions are never
stored; they are derived on each run. User preferences remain in `config.json`.

The listing commands run when the placement table is built, not on every
route (Grok first checks its own native `models_cache.json`). A successful listing
atomically replaces its JSON cache. If the command fails, a valid JSON cache is
preferred; an old `*-models.txt` cache can still be read and converted to JSON,
preserving its original timestamp and leaving the old file intact. Invalid JSON
or unsupported schema versions are ignored. Sign-in failures never use a cached
listing. Running `cursor-agent models` directly does not update OrcaCompass's
cache; OrcaCompass writes it when it invokes that command during discovery.

## How the file is read and written

- A missing file means defaults. An unreadable or invalid file is exit code 2
  with `config error: <path>: <message>`.
- JSON objects deep-merge over the defaults; arrays replace them.
- **Unknown keys are ignored**, silently, so a typo such as `denyAgent` has no
  effect and no warning. Unknown tier keys inside `pins` or `defaultEffort`
  are errors.
- Known keys must have the documented types; numbers must be finite and
  non-negative; `scoreWeight` at most 1.
- Commands that write the file change only their own keys. Every other key
  keeps its value and position, and the file keeps its indentation and line
  endings. The write replaces the file in one step, so a crash never leaves
  half a config. A file that is not a valid config is left untouched.

## Keys and defaults

### Which agents and models

| Key | Default | Purpose | Written by |
| --- | --- | --- | --- |
| `allowAgents` | omitted (all) | Only these agents are eligible | `agents only`, `agents enable` (when the key exists) |
| `denyAgents` | `[]` | These agents are never used, even if allowed | `agents disable`, `agents enable` |
| `pins` | `{}` | Preferred route per tier with optional `model`, e.g. `{ "daily": { "agent": "codex" } }`. An eligible, unblocked favorite wins unless it exceeds `preferRiskLimit` and an unblocked alternative has known usage within the limit | `prefer` |
| `preferRiskLimit` | `100` | Projected usage percentage above which a within-limit alternative replaces the favorite. Retain the favorite when no unblocked alternative has known usage within this limit | `prefer --risk-limit` |
| `banModels` | `[]` | Model ids or Models.dev families never routed | `ban`, `unban` |
| `lastResortAgents` | `["opencode"]` | Agents used only when no other agent can take the job in any allowed tier (or instead of waiting). `--agent <id>` or a preference for the tier lifts it; `[]` makes them ordinary | by hand |
| `tierOverrides` | `{}` | Model id or family to a tier: `{ "gemma4:12b": "light", "grok": "daily" }`. Overrides other placement signals; also makes Cursor `auto` an ordinary candidate (`"auto": "daily"`) | by hand |
| `excludeNoZdr` | `false` | Exclude models marked no-ZDR (zero data retention). Relies on Cursor's `NO ZDR` labels only | by hand |
| `cursorAuto` | `true` | Route Cursor `auto` in Light and Daily ahead of named Cursor models | by hand |

### Usage

| Key | Default | Purpose |
| --- | --- | --- |
| `thresholds.longPercent` | `95` | A weekly, monthly or bucket pool blocks its models at or above this usage |
| `thresholds.sessionPercent` | `90` | A session (5-hour) pool blocks at or above this; "hot" from 20 points below |
| `usageStaleMinutes` | `30` | Usage older than this caps confidence at medium; beyond 4x this, headroom becomes unknown and confidence low. Stale usage still blocks |

### Effort

| Key | Default | Purpose |
| --- | --- | --- |
| `defaultEffort` | `{ "light": "low", "daily": "medium", "advanced": "medium", "frontier": "high" }` | Effort per requested tier when a route has neither `--demand` nor `--effort` |
| `effortPolicy` | `"balanced"` | How `--demand` maps to effort: `efficient` (low, low, medium, high), `balanced` (low, medium, high, high), `quality` (low, medium, high, xhigh) for low, moderate, high, exceptional. None maps to `max` |

Efforts are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; the
config requires the spelling `xhigh`.

### Metadata and memory

| Key | Default | Purpose |
| --- | --- | --- |
| `scoreWeight` | `0.4` | Intelligence weight of the capability score, 0 to 1; log-price gets the rest |
| `modelsDevTtlHours` | `24` | Cache lifetime for Models.dev, The Model Index and Artificial Analysis |
| `placementsTtlHours` | `5` | How long the placement table (every model's tiers) is reused before every source is read again; `0` rebuilds on every command. A change to `tierOverrides`, `cursorAuto` or `scoreWeight`, an OrcaCompass update, or an agent newly found (on PATH or in its installer's default folder) rebuilds it at once; `orcacompass refresh` always does |
| `rejectionTtlHours` | `168` | How long a model an agent refused at launch (found by `verify`) is skipped |

## Example

[`config.example.json`](https://github.com/manomilano/orca-compass/blob/main/config.example.json) shows a typical setup rather than the defaults: it limits routing to Claude,
Codex and Cursor (`allowAgents`), pins Claude Sonnet for Daily and adds one tier
override (`grok-4.7` is already Advanced built in, so that line only shows the
syntax). Remove those three to keep automatic selection; the other keys it
lists are at their defaults, and keys it omits (`effortPolicy`,
`rejectionTtlHours`, `lastResortAgents`) keep theirs.

```json
{
  "denyAgents": ["grok"],
  "pins": { "daily": { "agent": "codex" } },
  "preferRiskLimit": 120,
  "banModels": ["claude-haiku"],
  "tierOverrides": { "gemma4:12b": "light" },
  "effortPolicy": "quality"
}
```

This user never routes to Grok Build, prefers Codex for everyday jobs unless it
is on pace for more than 120% of a window and a within-limit alternative is
available, never uses a Haiku model, treats a
local Gemma model as Light, and lets exceptional demand reach `xhigh`.

## Data sources

Usage is read on every call. Every other source is read when the placement
table is built (see `placementsTtlHours`).

| Source | Used for | How |
| --- | --- | --- |
| `orca account list --json` | Usage and limits per agent | Run on every call, 20 s timeout |
| [Models.dev](https://models.dev) (`/api.json`) | Model names, families, release dates, output prices, effort options for Anthropic, OpenAI, Google, xAI | Cache (24 h) → network (10 s) → stale cache → bundled snapshot `data/models-snapshot.json` |
| [The Model Index](https://themodelindex.org) (`/data/models.json`, CC BY 4.0) | Capability scores and OpenRouter output prices for placing models outside the ladder | Same chain; snapshot `data/modelindex-snapshot.json`. Failure only disables score placement |
| [Artificial Analysis](https://artificialanalysis.ai) Data API (`/api/v2/language/models/free`) | Intelligence and engineering indices, token prices and cost per task for the benchmark tier | Fetches require your own key in `ARTIFICIAL_ANALYSIS_API_KEY` (free tier: 100 requests a day; a fetch uses 4). Cache (24 h) → network (15 s) → stale cache. No snapshot: the data is licensed to you, so nothing is bundled and you must not commit the cache. Without a key, a previously saved benchmark cache can still be used; otherwise placement uses the lineup, ladder and score |
| `~/.codex/models_cache.json`, then Orca's `agent-model-catalog.json`, then Models.dev | Codex models, effort levels and lineup words | Read as files; the Models.dev fallback keeps only the Codex ladder families (`gpt-luna`, `gpt-terra`, `gpt-sol`, `gpt-astra`) and no `-latest` alias |
| `cursor-agent models` | Cursor model variants and `NO ZDR` labels | At table build, 30 s, saved copy on failure |
| `~/.grok/models_cache.json`, then `grok models` | Grok Build models, efforts, default | At table build: file, then live |
| `agy models` | Antigravity models (`id<TAB>label`) | At table build |
| `opencode models` | OpenCode models (`provider/model`) | At table build |
| Orca's profile state (`profile-state.db` or `orca-data.json`), read-only | Which agents you enabled in Orca (`settings.disabledTuiAgents`) | Experimental; anything unexpected is `unknown` |
| `orca orchestration worker-show` / `worker-read` | `verify` only | Read-only |

Regenerate the bundled snapshots with `npm run snapshot` after `npm run build`
(`scripts/make-snapshot.mjs`).

## Privacy

OrcaCompass fetches public metadata from Models.dev and The Model Index. When
you provide an Artificial Analysis API key, it can also make authenticated
requests to that service, sending the key in a request header. The optional
`--tier-reason` argument carries a short classification explanation supplied
by the coordinator and is returned in command output; it is not sent in these
metadata requests. Discovery reads machine metadata. Usage and configuration
stay local. OrcaCompass collects no telemetry and calls no AI model. Child
commands run with stdin closed and bounded timeouts. The agent CLIs and Orca
have their own network and privacy behavior. Diagnostics (`status --json`,
`agents --json`) include local paths and usage details; sanitize them before
sharing.
