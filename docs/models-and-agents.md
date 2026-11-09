# Models and agents

Models and providers change often:
run `orcacompass status` for what your own machine and subscriptions offer
right now. Available models vary by account and agent version.

## Agents

An agent is a coding CLI that Orca can launch as a worker. OrcaCompass only
considers agents whose CLI is installed, that are enabled in Orca, that Orca
does not report as `unavailable`, and that you have not switched off with
`orcacompass agents disable` or `agents only`, so the options differ per user.
`orcacompass agents` shows each agent's verdict and the reason.

| Agent | Orca agent ID | Executable | Model list comes from | Effort levels | Usage data from Orca | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | `claude` | `claude` | its cached account catalog, then Orca's catalog, then Anthropic families in Models.dev | from the same source, else `low` to `max` | session, weekly, Fable weekly | Supported |
| Codex | `codex` | `codex` | `~/.codex/models_cache.json`, then Orca's model catalog, then Models.dev (Codex ladder families only) | per model, from those files | session, weekly | Supported |
| Cursor | `cursor` | `cursor-agent` (also `%LOCALAPPDATA%\cursor-agent`) | `cursor-agent models` | encoded in the model ID (`…-high`) | monthly, plus the `Cursor Models` and `Other Models` buckets | Supported |
| Grok Build (xAI) | `grok` | `grok` (also `$GROK_HOME/bin`, `~/.grok/bin`) | `~/.grok/models_cache.json`, then `grok models` | per model from that cache; else `low` to `xhigh` (Grok 4.5 up to `high`) | weekly credits or monthly budget | Supported; verified on Windows |
| Antigravity (Google) | `antigravity` | `agy` (also `%LOCALAPPDATA%\agy\bin`, `~/.local/bin`) | `agy models` | `low` to `high` | weekly, and 5-hour when reported, per quota group | Supported; verified on Windows |
| OpenCode | `opencode` | `opencode` (also `~/.opencode/bin`) | `opencode models` | none (Orca passes no effort to OpenCode) | none: pay per use or local | Supported; last resort by default |
| Pi | `pi` | `pi` | Orca's Pi catalog (`agent-model-catalog.json`) | per model from that catalog, without Pi's `off` | none: Pi's own provider sign-ins | Detected; routed only on an Orca release that starts Pi on a chosen model (none yet); last resort by default |
| Muse (Meta) | `muse` | `muse` | none (Orca has no Muse model list) | — | none | Detected only, never routed |

**OpenCode** lists every model it can reach: providers with an API key
(OpenRouter and others, pay per token), OpenCode's own models, and local
servers such as Ollama (this machine's resources). It has no usage window, so
its routes are low confidence and say how they are paid for (`runs on this
machine (ollama)`, `free model through openrouter`, `pay per use through
openrouter`). Because it costs money or local resources, it is in
`lastResortAgents` by default: routing first tries every other agent,
including a lower tier, and uses OpenCode only when nothing else can take the
job (or instead of waiting under `--no-downgrade`), with a warning. `--agent
opencode`, a preference for the tier (`orcacompass prefer daily opencode
[model]`) or `"lastResortAgents": []` makes it an ordinary agent; without usage
data it still ranks after agents that have it. OpenRouter's `~vendor/x-latest`
aliases are skipped, a model listed twice is kept from its cheapest source, and
a `-free` copy is rated as the model it copies. Local models usually have no
capability score: give them a tier with `tierOverrides` (for example
`"gemma4:12b": "light"`). Orca accepts `--model` for OpenCode only in an
existing worktree (`--worktree current` or a selector), not a new one.

**Pi** reaches models through providers it signs in to itself (Anthropic,
OpenAI, OpenRouter and others, by subscription or API key). Its models come
from Orca's own Pi catalog, the newest Pi entry of Orca's internal
`agent-model-catalog.json` (not a supported Orca interface), and the agent's
note names the file and when Orca configured that entry. Ids are Pi's
`provider/id` selectors; an id ending in a Pi thinking level
(`…:high`) is skipped, while ids such as `…:free` are kept. A model reachable
through several providers is kept once, from the cheapest (as for OpenCode),
then by provider name, and the note lists the other providers. Orca does not
track the limits of Pi's sign-ins, so Pi is a last-resort agent by default:
a Claude or Codex model that is blocked does not move silently onto Pi, which
may draw on the same subscription. To keep a family on its native agent but
not on Pi, use `orcacompass agents disable pi`; a ban (`banModels`) drops the
family from Pi too.

No released Orca starts Pi on a chosen model yet (stablyai/orca#36587 adds
it), so OrcaCompass reads `orca --version` on every call and lists Pi with
the reason `Orca <version> cannot start Pi on a chosen model` until a release
with that support is out; `setup` does not preselect it. An Orca upgrade
takes effect on the next call, without a table rebuild.

Model lists are read when the placement table is built: every
`placementsTtlHours` (5 hours by default), on `orcacompass refresh`, or when
your tier settings change (see [Tiers and
routing](tiers-and-routing.md#when-placement-runs)). Cursor, Antigravity and
OpenCode lists come from live commands; Grok first reads its native model cache.
For live listings, the last good list is used only when the command fails;
a sign-in prompt skips the agent as `not signed in`.
Claude's list is the catalog Claude Code caches under
`~/.claude/cache/model-catalog` for your account, then Orca's catalog, then
Models.dev. Model makers reachable today: Anthropic
and OpenAI (directly and through Cursor); Google, xAI, Meta, Moonshot, Zhipu,
and DeepSeek through Cursor; xAI through Grok Build; Google, Anthropic and
OpenAI through Antigravity; and Cursor's own Auto. Gemini models route through
Antigravity or Cursor; the Gemini CLI is not an agent here.

## How a model gets its tier

These rules run when the placement table is built, and `orcacompass tiers`
prints their result. The first rule that applies wins:

1. Cursor's `auto`: Light and Daily when `cursorAuto` is on and there is no
   exact `tierOverrides.auto` entry.
2. Your `tierOverrides` for the exact model ID.
3. Your `tierOverrides` for the model's family (from metadata, or inferred
   from a recognized Claude/GPT versioned ID).
4. The provider's own description ("For your toughest challenges" is Frontier,
   "Fastest for quick answers" is Light; Claude Code's account catalog and
   Codex's model cache carry these words).
5. The built-in model-line and family rules below.
6. The capability score: the repository's Model Index rating and output price,
   weighted 40/60 after normalizing the rating and logarithm of price against
   reference models. This fallback is capped at Advanced.
7. Otherwise the model is unclassified and never routed.

A model normally serves one tier; Cursor Auto serves Light and Daily.
Score-based placement is at most medium confidence. The words and numbers
behind every placement appear in `orcacompass status` and route `reasons`.

Within an agent, only the newest release of each family per tier is kept;
recognized Claude/GPT family IDs can be compared by numeric version before
the metadata sources catch up. Provider descriptions also classify newly named
models missing from those sources. Older releases are dropped silently.
After headroom, hot-session status, confidence and fast-variant checks,
ties favor Claude/GPT families, then newer release dates. See
[Ranking](tiers-and-routing.md#ranking) for the full order.

### Built-in family ladder

| Tier | Families |
| --- | --- |
| Light | `claude-haiku`, `gpt-luna`, `gemini-flash-lite` |
| Daily | `claude-sonnet`, `gpt-terra` |
| Advanced | `claude-opus`, `gpt-sol`, Grok 4.7 and later (`grok-<version>`) |
| Frontier | `claude-fable`, `gpt-astra`, Gemini Argon (`gemini-<version>-argon`) |

Models.dev files Gemini Argon under the broad `gemini` family and every Grok
under `grok`, so those two lines are matched by model ID. Older Grok releases
(4.6, 4.5, 4.3, 4.20) and Grok Build are placed by the capability score, as is
every other Google model (Flash, Pro). Cursor's Grok 4.7 Fast variants are the
same model as Grok 4.7; like other `-fast` variants they are not routed
separately.

Effort is chosen from the job's reasoning demand (`--demand`), not from the
tier; without one, the tier default applies: Light `low`, Daily `medium`,
Advanced `medium`, Frontier `high`.

## Inspect available models

Run `orcacompass status` to see the models discovered for your installed agents,
their tiers, and any exclusions. Availability depends on your account, agent
version, and current provider catalog. Model IDs in this guide are examples,
not a guarantee of access.

Cursor maps Cursor-trained models (`cursor-` IDs), Composer and Auto to the
`Cursor Models` bucket, and other models to `Other Models`. This mapping is
inferred because Orca does not report it directly.

Antigravity keeps provider launch IDs while normalizing them for classification:
for example, `claude-opus-4-6-thinking` is classified as `claude-opus-4-6`.
Its Gemini and Claude/GPT quota groups are evaluated separately.

## Your preferences and bans

`orcacompass prefer <tier> <agent> [model]` stores a preferred route per tier
in `pins`. It must survive every exclusion (your agent choice, request flags,
Orca's switches, availability, bans) and be unblocked. When projected usage
exceeds `preferRiskLimit` (100% by default), the best unblocked alternative
with known usage within that limit is chosen. If every alternative is risky,
unavailable, blocked, or has unknown usage, the favorite is retained.
Projection is `used% / elapsed fraction`, with no extrapolation under 10%
into a window. The route explains a switch, for example `preferred codex
gpt-6.1-terra skipped: weekly on pace for 150% (limit 100%), resets in 2d`.
It also explains when an over-limit favorite is retained.

`orcacompass ban <model-or-family>` stores entries in `banModels`. An entry
matches a model's base ID, so `claude-opus-5-5` also covers Cursor's
`claude-opus-5-5-high`, or its Models.dev family, so `grok` covers Grok 4.5 to 4.7
but not Grok Build (`grok-build`). Banned models are never chosen or shown as
alternatives and are listed as `banned by you`.

## Models an agent refuses at launch

A listed model can still be one the account cannot use, and Orca starts the
worker anyway, reporting the requested model as effective. `orcacompass verify
--dispatch <id>` reads the new worker's terminal and recognizes each agent's
refusal (seen November 2026, with an unknown or unavailable model):

| Agent | In an Orca worker | Refusal |
| --- | --- | --- |
| Codex | idles at its prompt, no `worker_done` | `The 'claude-opus-5-5' model is not supported when using Codex with a ChatGPT account.` |
| Claude Code | idles at its prompt, no `worker_done` | `There's an issue with the selected model (gpt-6-terra). It may not exist or you may not have access to it.` |
| Cursor | `cursor-agent` exits 1; Orca fails the start after its 60 s readiness wait | `Cannot use this model: claude-opus-9-9. Available models: …` |
| Grok Build | exits 1 | `Couldn't set model 'grok-9-fake': Invalid params: "unknown model id".` |
| Antigravity | exits 1 | `invalid model selection (--model "gemini-9-fake" …): model gemini-9-fake is not recognized as a known model …` |

A refusal counts only on a line that names the model. Soft warnings that
still run the model (Codex's ``Model metadata for `x` not found``, Claude
Code's `doesn't recognize the model "x"`) do not count. A refused agent and
model is skipped for `rejectionTtlHours` (a week by default) and listed as
`refused by <agent> …`; `orcacompass rejected --clear` forgets them.

## Agents you enabled in Orca (experimental)

Orca keeps its agent switches (Settings → Agents) in
`settings.disabledTuiAgents`, a list of disabled agent IDs (empty means every
detected agent is enabled). No Orca command exposes it, so OrcaCompass reads it
read-only from the active profile's `profile-state.db`, or `orca-data.json` for
a profile without a database. A disabled agent is skipped with the reason
`not enabled in Orca`. If the setting cannot be read, or the field is missing or
not a list, it is reported as `unknown` and no agent is excluded for it.
