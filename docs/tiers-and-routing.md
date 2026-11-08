# Tiers and routing

How OrcaCompass turns "a Daily job" into "Claude, `claude-sonnet-5-5`, medium".
Everything on this page lives in `src/placements/` (tier placement) and `src/routing/` (ranking), pure functions with no I/O:
`tiers.ts` and `score.ts` place models, `pace.ts` measures usage,
`router.ts` picks and explains.

## The four tiers

The tier says how capable a model the job needs. It is a property of the work,
never of spare capacity.

| Tier | What it means | Typical signals | Examples | Default effort |
| --- | --- | --- | --- | --- |
| `light` | Mechanical work: the right result is obvious once the worker looks, and a mistake is cheap and easy to see | One file or a few lines; exact instructions; no design choice | Rename a symbol; change a config value; summarize a file; write docstrings; run a command and report the output | `low` |
| `daily` | Ordinary engineering a competent developer does without a written plan: read the nearby code, make sensible local choices, verify | A few files in one area; clear acceptance criteria; tests exist or are easy to add | Add an endpoint with tests; fix a reproducible bug; write a migration; review a small PR | `medium` |
| `advanced` | Work that needs a plan: many interacting parts, an unknown root cause, or decisions that last. Mistakes are costly or subtle | Crosses modules or services; concurrency, security or data integrity; behavior must stay stable | Refactor across subsystems; debug a flaky race; design a schema change and its migration; a security-sensitive change | `medium` |
| `frontier` | The edge of what models can do. Use it when Advanced is likely to fail or already has | Novel algorithm or research; a multi-system failure without leads; an Advanced worker failed on capability | Design a new algorithm; find a cross-system failure after an Advanced worker failed | `high` |

## When placement runs

Placement is part 1 of OrcaCompass and runs only when the placement table is
built: every agent's model list is read, Models.dev, The Model Index and
Artificial Analysis are loaded, the scales below are computed once over the
whole datasets, and every model's tiers are written to `placements.json` in
the cache (`src/placements/build.ts`, `table.ts`). The table is reused for
`placementsTtlHours` (5 hours by default) and rebuilt by the next command when
it is older than that, was built by another OrcaCompass version or with other
`tierOverrides`, `cursorAuto` or `scoreWeight`, when an agent it had marked
not installed is found (on PATH or in its installer's default folder), or on
`orcacompass refresh`. A failed or
signed-out listing waits for the next build. `orcacompass tiers` prints the
table with its age.

Routing is part 2 (`src/routing/`): a route reads the table and `orca account
list`, applies your bans, agent choice, pins and the refused-model list, and
ranks. It never recomputes a placement, so a route takes well under a second
once the table exists.

## How a model gets its tier

For every discovered model, the first rule that applies wins
(`classifyModel` in `src/placements/tiers.ts`):

1. **Your override for the exact model id** (`tierOverrides`, e.g.
   `"gemma4:12b": "light"`).
2. **Your override for the model's Models.dev family** (e.g. `"grok": "daily"`).
3. **Cursor's `auto`**: Light and Daily, when `cursorAuto` is on and you have
   no `tierOverrides.auto`.
4. **The home tier and the benchmark tier, and every tier between them.** The
   home tier is the provider's lineup (below) when the provider describes the
   model, else a built-in model line matched by id (Gemini Argon
   `gemini-<n>-argon…` is Frontier; Grok 4.7 to 4.9 and Grok 5 and later are
   Advanced), else the built-in family ladder (below). The benchmark tier is
   the benchmark placement (below). When they agree, or only one is known, the
   model has that one tier.
5. **The capability score** (below), capped at Advanced, when neither a home
   nor a benchmark tier is known.
6. Otherwise the model is **unclassified** and never routed. `status` lists
   these.

A model placed in two or three tiers is a candidate in each of them. The entry
for its home tier has the source `lineup` or `family` and high confidence; the
other entries have the source `benchmark` and at most medium confidence.
Within one agent, the home model of a tier goes before a model that only
benchmarks into it unless that model has more than 20 points more headroom
(`HOME_TIER_MARGIN`): for a Frontier job on Claude Code, Fable keeps the job
while Opus's pool is at most 20 points roomier, and Opus takes it beyond that
or when Fable's pool is blocked. Between agents, headroom alone decides.

### The provider's lineup

Claude Code's account catalog (`~/.claude/cache/model-catalog/*-cc.json`) and
Codex's model cache (`~/.codex/models_cache.json`) describe each model in a
few words. OrcaCompass reads a tier from them, strongest claim first:

| Tier | Words |
| --- | --- |
| Frontier | frontier, toughest, most demanding, most capable, most intelligent, hardest |
| Light | fast, fastest, quick, affordable, easier, cheapest, lightweight, small |
| Advanced | complex, workhorse, demanding |
| Daily | simpler, everyday, efficient, balanced, straightforward, general |

So "For your toughest challenges" is Frontier, "For complex work and everyday
tasks" is Advanced, "Most efficient for simpler tasks" is Daily, "Fast and
affordable model for easier tasks." is Light, and "GPT-6.1 Terra Codex model."
says nothing (the family ladder applies). Cursor, Antigravity, Grok and
OpenCode listings carry no descriptions.

### Benchmark placement

With your own [Artificial Analysis](https://artificialanalysis.ai) Data API
key in `ARTIFICIAL_ANALYSIS_API_KEY`, `orcacompass refresh` (or any route once
a day) fetches the free-tier model list into your cache; nothing from it ships
with OrcaCompass. Each model is represented by its strongest effort variant.

```text
capability = (intelligence index + engineering index) / 2    (intelligence alone when engineering is missing)
price      = (3 × input + output) / 4                         USD per million tokens, Artificial Analysis's blend
value      = capability / price                               intelligence per token cost
placement  = capability / top + 0.05 × log10(median value / value)
```

- `top` is the highest capability of any benchmarked model, so placements are
  relative to the best model measured and drift down as better models appear.
- The value term moves a model up by 0.05 for every tenfold it is dearer than
  the median points per dollar, and down for every tenfold it is cheaper:
  premium pricing is the vendor's own capability signal, and cheap
  intelligence belongs in the everyday tiers. Models without a price get no
  shift.
- Cuts are fixed at `0.55 / 0.78 / 0.93` of the top (Light/Daily,
  Daily/Advanced, Advanced/Frontier). Unlike the capability score, benchmarks
  can place a model in Frontier.
- The placement is explained in `status` and in `reasons`, e.g.
  `claude-opus-5-5: tier frontier from benchmarks (Artificial Analysis 58/64 =
  0.98 of top, 7.6 points per dollar vs median 13.4 → 1.00; cuts
  0.55/0.78/0.93); the provider's lineup ("For complex work and everyday
  tasks") places it advanced`.

Matching a discovered id to a benchmark normalizes both sides and drops a
trailing date (`claude-haiku-5-5-20261007`), effort (`gemini-3.8-flash-high`)
or `.0` version; an effort variant's slug counts as its model's.

### Built-in family ladder

| Tier | Families (Models.dev family keys) | Lines matched by id |
| --- | --- | --- |
| Light | `claude-haiku`, `gpt-luna`, `gemini-flash-lite` | |
| Daily | `claude-sonnet`, `gpt-terra` | |
| Advanced | `claude-opus`, `gpt-sol` | Grok 4.7 and later (`grok-4-7`, `grok-4-8`, `grok-5`, …) |
| Frontier | `claude-fable`, `gpt-astra` | Gemini Argon (`gemini-4-argon`, …) |

Families are stable across releases, so a new `claude-sonnet-6` is Daily on the
day it appears. A ladder entry does not imply an adapter: Gemini models reach
workers through Antigravity or Cursor, never through a Gemini CLI.

Older Grok releases (4.6, 4.5, 4.3, 4.20), Grok Build, Gemini Flash and Pro, and
every other vendor's model (Meta Muse, Moonshot Kimi, Zhipu GLM, DeepSeek, …)
are placed by the capability score.

### Newest release per family

Within one agent, only the newest release of each family per tier is kept.
`claude-opus-4-8` and `claude-opus-5-5` are both Advanced on Claude Code; only
`claude-opus-5-5` is routable. Older releases are dropped silently: no command
lists them as superseded, and they do not appear under `skipped`. Models without a
release date count as oldest. Score placement can split a family across tiers
(Grok 4.6 Daily, Grok 4.5 Light), in which case each tier keeps its own newest.

Superseded models cannot be preferred back in with `orcacompass prefer`.

### The capability score

Models with neither a home tier nor a benchmark are placed by combining two public numbers from
[The Model Index](https://themodelindex.org): the model's **index score**
(intelligence) and its **OpenRouter output price** in USD per million tokens.
Price acts as a capability proxy (vendors charge more for stronger models),
not as a cost-saving reward.

```text
capability = scoreWeight × unit(index score) + (1 − scoreWeight) × unit(ln(output price))
```

- `unit(x)` is min-max normalization over the **anchors**: the newest rated
  Claude and GPT model of each ladder family (`claude-haiku-5-5`,
  `claude-sonnet-5-5`, `gpt-6-1-sol`, `claude-fable-5-1`, …). The anchors' tiers
  are known from the ladder, so they calibrate the scale.
- `scoreWeight` defaults to 0.4: 40% intelligence, 60% log-price.
- Each **cut** between two neighboring tiers is the midpoint between the
  highest anchor score in the lower tier and the lowest anchor score in the
  upper tier. A model's tier is the number of cuts at or below its score,
  **capped at Advanced**: a score never makes a model Frontier.
- Scores are not clamped to 0..1, and cuts move whenever the ratings or
  `scoreWeight` change. Recent cuts were about `0.34 / 0.72 / 0.90`.
- Score-placed routes are at most **medium confidence** and say so in
  `reasons`, e.g. `grok-4.6: tier daily from capability score (Model Index
  169.8, $6/M → 0.37; cuts 0.34/0.72/0.90)`.

Matching a discovered id to a Model Index entry normalizes both sides
(lowercase, dashes, no provider prefix), tries the entry id and its OpenRouter
id (also without a `-preview` suffix), then Cursor's dashless spellings (`deepseek-v41-flash`), then a trailing
`.0` version stripped (`muse-wonder-1.0` → `muse-wonder`).

Score placement is **disabled** when the Model Index cannot be loaded at all
(`scoreSource: unavailable`), when any tier has no anchor, or when the anchors
do not differ in both score and price. Routing by the ladder, overrides and
Cursor Auto continues.

## Which models are candidates

Before ranking, a model has to survive these filters, applied in order.
Agent filters, bans and refusals appear under `skipped` in the route with their
reason; models dropped by `excludeNoZdr` or as an older release of their family
do not.

1. **Agent filters**, strongest reason first:
   `excluded by config` (`denyAgents`, or not in `allowAgents`),
   `excluded by request` (`--agent`, `--exclude-agent`),
   `not enabled in Orca` (Orca's Settings → Agents),
   `not signed in or unavailable` (Orca reports the account `unavailable`),
   `not installed`, `not signed in` (the model listing asked for a login),
   `no models`.
2. **Last-resort agents** (`lastResortAgents`, OpenCode by default) are left out
   of the first pass; see below.
3. **No-ZDR models** when `excludeNoZdr` is on (currently from Cursor's
   `NO ZDR` labels only).
4. **Banned models** (`banned by you`): an entry in `banModels` matches a
   model's base id (`claude-opus-5-5` also covers Cursor's
   `claude-opus-5-5-high`) or its Models.dev family (`grok` covers Grok 4.5 to
   4.7 but not `grok-build`).
5. **Refused models** (`refused by codex 2h ago: "…"`): an agent refused this
   model at launch within `rejectionTtlHours`. See
   [Verify and rejections](verify-and-rejections.md).
6. **Newest per family** (above).

## Usage: headroom, risk and blocking

Every model draws on named **usage pools** that Orca reports for its agent
(`orca account list --json`):

| Agent | Pools |
| --- | --- |
| Claude Code | `session` (5 h), `weekly`, plus `fableWeekly` for Fable models |
| Codex | `session`, `weekly` |
| Cursor | `monthly`, plus the `Cursor Models` bucket (Cursor-trained `cursor-*` ids, Composer, Auto) or the `Other Models` bucket (everything else). Which bucket a model draws on is inferred, Orca does not say |
| Grok Build | `weekly` (credits), `monthly` (budget) |
| Antigravity | per quota group, `Gemini Models` or `Claude and GPT models`: a 5-hour pool and a long pool; without groups (older Orca) `session` and `weekly` |
| OpenCode | none: pay per use or local. Routes say how the model is paid for |

Pools are `session` (short) or `long` (weekly, monthly, bucket). Each pool has
`usedPercent`, `windowMinutes` and `resetsAt`.

### Blocking

A pool **blocks** its models when `usedPercent` reaches the threshold:
`thresholds.longPercent` (95) for long pools, `thresholds.sessionPercent` (90)
for session pools. A blocked candidate is never chosen while an unblocked one
exists in some allowed tier. Blocking is evaluated even on stale usage: within
a window usage only grows, so a stale "blocked" is a valid lower bound. A pool
whose reset time has passed is **expired**: ignored for blocking and ranking,
and it lowers confidence.

A **hot session** is a session pool within 20 points of its block threshold
(70% or more by default). It is reported, and loses ties after headroom.

### Headroom

Routes rank by **headroom**: the share of a window expected to be left unused
at reset. The estimate (`expectedUse` in `src/routing/pace.ts`):

```text
observed pace = used / max(elapsed, 0.1)
weight        = elapsed / (elapsed + 0.1)
pace          = weight × observed pace + (1 − weight) × 1       (1 = even pace)
expected use  = used + pace × (1 − elapsed)
headroom      = 1 − expected use
```

where `used` and `elapsed` are fractions of the window. The even-pace term is
weighted as a tenth of a window of history: a fresh window is assumed to be
used up evenly until it shows otherwise, and a burst right after a reset (some
windows start on first use) is not extrapolated.

Worked example, the README's `weekly 40% used, 62% of window elapsed`:

```text
observed pace = 0.40 / 0.62 = 0.645
weight        = 0.62 / 0.72 = 0.861
pace          = 0.861 × 0.645 + 0.139 × 1 = 0.694
expected use  = 0.40 + 0.694 × 0.38 = 0.664
headroom      = 0.336  →  "headroom 34%"
```

Negative headroom means the pool is on pace to run out before it resets.

### Which pool ranks a route

A route's ranked pool is the one with the **least headroom** among:

- its long pools (weekly, monthly, bucket), and
- a session pool whose projected use would reach the session block threshold
  before it resets (a *binding* session).

When a route has no long pool at all, its session pool ranks it. A route whose
agent has no usage, or whose pools are missing from Orca's answer, has
`headroom: null` and ranks after every route with known headroom.

### Distant resets count less

Spare capacity that resets within 7 days is capacity that would be lost; spare
capacity resetting in a month is less urgent and less certain. Positive
headroom in a window that resets beyond 7 days is scaled by
`7 days / time to reset` (half at 14 days). The reason says so:
`Other Models headroom 52%, counted as 20% for a reset beyond 7d`.

### Risk (where usage is heading)

Separately from headroom, every route reports its **risk**: the pool projected
to end its window most used at the *current* pace, `used% / elapsed fraction`.
Under 10% into a window the pace is noise, so usage is not extrapolated
(`too early to project`). Text reasons read:

```text
weekly 60% used, 40% of window elapsed (headroom -44%) → on pace for 150% before reset in 2d
```

Risk is what `preferRiskLimit` is checked against, and `setup` shows it per
option as `onPacePercent`.

### Confidence and stale usage

| Confidence | When |
| --- | --- |
| `high` | Ladder-placed model, usage fresh |
| `medium` | Score-placed model, a model placed by `tierOverrides`, Cursor Auto, or usage older than `usageStaleMinutes` (30; the reason notes "usage 45m old") |
| `low` | Usage unknown (Orca unreachable, no matching pool, no usage window), usage older than 4x `usageStaleMinutes` (headroom becomes `null`), or an expired pool |

## Ranking

Within a tier, candidates sort by (`compareRanked`):

1. unblocked before blocked;
2. known headroom before unknown;
3. **more (scaled) headroom first**;
4. no hot session before a hot session;
5. higher confidence;
6. non-fast variants before `-fast` ones;
7. Claude and GPT (the ladder's own vendors) before other vendors;
8. newer release date;
9. agent id, then model id (a total order, so results are deterministic).

### Cursor Auto

Cursor's `auto` lets Cursor choose a cheap model itself (Cost mode). By default
it is placed in Light and Daily only and, when unblocked, becomes Cursor's
representative in those tiers: named Cursor models that out-ranked it move to
just behind it, while other agents are compared with Auto by the usual
ranking. It launches as `--model auto` without effort, is capped at medium
confidence, and draws on the `Cursor Models` bucket and the monthly pool.
`cursorAuto: false` turns the rule off; a `tierOverrides.auto` entry makes Auto
an ordinary candidate in that tier.

## Preferences (pins)

`orcacompass prefer <tier> <agent> [model]` stores your favorite route for a
tier. The favorite must survive every filter and be unblocked. When routing
that tier, its projected usage determines whether to use an alternative.

- Within `preferRiskLimit` (100% by default), or with unknown usage, use the favorite.
- Above the limit, choose the highest-ranked unblocked candidate in the same
  tier whose known projected usage is within the limit.
- If no such candidate exists, retain the favorite. This includes all
  alternatives being over the limit, blocked, absent, or having unknown usage.
  Usage older than four times `usageStaleMinutes` also counts as unknown here.

A warning explains whether the over-limit favorite was skipped or retained.
When a within-limit replacement exists, over-limit preferred candidates are
omitted from alternatives for that tier. Candidates compete by projected
headroom across their session and long pools. A blocked, banned, or unavailable
favorite remains ineligible even when every other candidate is risky.

Warnings include the following.

```text
preferred codex gpt-6.1-terra skipped: weekly on pace for 150% (limit 100%), resets in 2d
preferred codex retained: no unblocked alternative with known usage within the 100% risk limit
preferred codex skipped: blocked (weekly 96% used, resets in 1d)
preferred grok skipped: not available (not enabled in Orca)
preferred cursor auto skipped: does not support effort xhigh
```

Without a model, the agent's best model in the tier is used. A preference
chooses a candidate, not an exact effort variant: effort is resolved normally.
A preference for a tier also lifts a last-resort agent's status for that tier.

## Last-resort agents

`lastResortAgents` (default `["opencode"]`) are agents whose use costs money
per token or this machine's resources. Routing runs first without them, in the
requested tier and every lower tier. Only when that finds no `ok` route does it
run again with them, and the result carries a warning:

```text
opencode is a last-resort agent (lastResortAgents), used as nothing else can take it: pay per use through openrouter
opencode is a last-resort agent (lastResortAgents), used instead of waiting 2d: runs on this machine (ollama)
```

Naming the agent with `--agent`, or preferring it for the requested tier, makes
it an ordinary agent for that route. `"lastResortAgents": []` makes all agents
ordinary; without usage data they still rank after agents that have it.

## Fallbacks: downgrade, upgrade, wait, none

```text
requested tier has an unblocked candidate ──► ok (same tier)
else, unless --no-downgrade:
  nearest lower tier with an unblocked candidate ──► ok, downgraded: true
else, only if the requested tier AND every lower tier have no candidates at all:
  nearest higher tier with an unblocked candidate ──► ok, upgraded: true
else, with --no-downgrade and blocked requested-tier candidates ──► wait (waitUntil)
else ──► none
```

- A **downgrade** keeps the target effort (effort follows the work, not the
  model) and warns: `a daily model is doing advanced work; effort is not raised
  to make up for it: split the job or add stronger checks`.
- An **upgrade** is structural only: it never happens because of usage limits.
- `wait` carries `waitUntil`, the earliest moment at which some blocked
  requested-tier candidate has all of its blocking pools reset.
- `none` says why (`no usable agent`, `all advanced candidates blocked: …`,
  `no unblocked model in any lower tier`) and may still carry `waitUntil`.
- With `--effort`, candidates that cannot apply that exact effort are dropped
  before any of this; if the requested tier has candidates but none can, the
  answer is `none` with the efforts each one offers.

## Reading a route

```text
advanced → claude · claude-opus-5-5 · medium (high confidence)
  claude claude-opus-5-5: weekly 40% used, 62% of window elapsed (headroom 34%) → on pace for 65% before reset in 2d
  effort: medium from moderate reasoning demand (balanced policy), passed as --effort
  next best: cursor claude-opus-5-5-medium (Other Models headroom 52%, counted as 20% for a reset beyond 7d, resets in 18d)
  skipped: muse (no models: no model list available from Orca; not routed), opencode (last resort: used only when no other agent can take the job)
orca orchestration worker-start --spec "<task>" --agent claude --model claude-opus-5-5 --effort medium
```

- Line 1: tier chosen, route, confidence.
- The route's own usage line: the ranked pool, its headroom, and its risk.
- The effort line: what was asked for, why, and how it reaches the agent
  ([Effort](effort.md)).
- `next best`: the first unblocked alternative. `--json` lists up to five
  `alternatives` with `headroom`, `risk`, `blocked` and `reason`.
- `skipped`: excluded agents and banned/refused models in the requested tier.
  Superseded releases and no-ZDR exclusions are omitted. Preference exclusions
  are explained in `warnings`.
