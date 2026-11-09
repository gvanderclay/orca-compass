---
name: orcacompass
description: Use when delegating work to Orca workers (orca orchestration worker-start / agent launch) to choose agent, model and effort by task difficulty and current usage limits.
---

# OrcaCompass

Use alongside Orca's orchestration skill. OrcaCompass recommends a route;
the coordinator launches and supervises the worker with Orca's normal commands.
Explicit user instructions about agent or model take precedence over recommendations.

## First-time setup

Run this when the user asks to set up OrcaCompass, or before your first route
in a conversation when `orcacompass setup --json` reports `configExists: false`
(offer it once; if the user declines, run `orcacompass setup --skip`, which
saves the defaults so setup is not offered again, tell the user which agents it
reports as used, and route with the defaults). The user can also run `orcacompass setup` in a
terminal; it asks the same questions.

1. Run `orcacompass setup --json` and keep the document. Ask the questions
   below in plain words, one message each. Every question can be skipped:
   skipping keeps the current setting. Show current settings (`config`) as
   the defaults.
2. **Agents.** List every entry of `agents`: installed, `enabledInOrca`
   (yes / no / unknown), `orcaUsage`, and `models`. Ask which to use; the
   default is the agents with `preselected: true`. Apply only the change:
   `orcacompass agents disable <id>...` for preselected agents the user
   dropped, `orcacompass agents enable <id>...` for agents they added. An
   added agent with `enabledInOrca: "no"` must also be switched on in Orca's
   settings; say so.
3. **Favorites (optional).** For each tier in `tiers`, show `pick`,
   `preferred`, and `options` (agent, model, `onPacePercent`, `blocked`), and
   ask whether to set a favorite. An available, unblocked favorite is used.
   When it is on pace to exceed `config.preferRiskLimit` percent of a usage
   window (default `defaultPreferRiskLimit`, 100), choose the best unblocked
   alternative in that tier with known usage within the limit. If none exists,
   retain the favorite and report the risk in the route output. Apply with
   `orcacompass prefer <tier> <agent> <model>` (the option's `model`),
   `orcacompass prefer clear <tier>`, and, if the user wants another limit,
   `orcacompass prefer --risk-limit <percent>`.
4. **Bans (optional).** Show `families` (name and a few of their models) and
   the current `config.banModels`. Ask whether any models or families should
   never be used. Apply with `orcacompass ban <model-or-family>...` and
   `orcacompass unban <entry>...`. A whole agent is not a ban; use step 2.
5. **Finish and summarize.** Run `orcacompass setup --complete --json`, even
   when every answer kept the defaults. This creates the config if absent,
   marking setup complete so it is not offered again. Tell the user, in
   plain words, which agents are used, the favorites and limit, and the bans,
   then one example route per tier (`orcacompass route --tier <tier>`; mention
   any warning), and the config file path (`configPath`).

Use the commands above to write the config; never edit the file yourself.

## Which providers to use

- When the user asks which agents or providers are available, run
  `orcacompass agents` and report its table: installed, enabled in Orca,
  Orca usage status, chosen by the user, and the verdict.
- When the user says to use or avoid providers from now on, record it with:
  - `orcacompass agents disable <id>...` to stop using agents,
  - `orcacompass agents enable <id>...` to use them again,
  - `orcacompass agents only <id>...` to use only those agents,
  - `orcacompass agents reset` to go back to all agents.

  These write the user's OrcaCompass config and print the resulting choice;
  repeat it to the user. For a constraint on one job only, use `--agent` or
  `--exclude-agent` on that route call instead of changing the config.
- When the user names a go-to model or agent for a kind of work ("use Codex
  for everyday jobs"), map the work to a tier and run
  `orcacompass prefer <tier> <agent> [model]`; `orcacompass prefer` lists the
  preferences and `orcacompass prefer clear <tier>` removes one.
- When the user says never to use a model or model family, run
  `orcacompass ban <model-or-family>...` (`orcacompass unban` lifts it). For a
  whole agent use `orcacompass agents disable <id>` instead.
- A route's `warnings` may say a preference was skipped, for example
  `preferred codex gpt-6.1-terra skipped: weekly on pace for 150% (limit 100%),
  resets in 2d`. Tell the user that line: their preference would have used more
  than the limit before the window resets, so another route was chosen.
- An agent the user has not enabled in Orca is never routed (`not enabled in
  Orca`). Do not work around it; tell the user to enable it in Orca's settings
  if they want it. If `agents` reports the Orca setting as `unknown`, say so.

## Choose a task tier

Rate the job by what a worker needs to get it right, never by spare capacity:
do not send a Light job to Frontier because Frontier capacity is unused.

| Tier | What it means | Typical signals | Examples | Default effort |
| --- | --- | --- | --- | --- |
| light | Mechanical work: the right result is obvious once the worker looks, and a mistake is cheap and easy to see. | One file or a few lines; exact instructions; no design choice. | Rename a symbol; change a config value; summarize a file; write docstrings; run a command and report the output. | low |
| daily | Ordinary engineering a competent developer does without a written plan: read the nearby code, make sensible local choices, verify. | A few files in one area; clear acceptance criteria; tests exist or are easy to add. | Add an endpoint with tests; fix a reproducible bug; write a migration; review a small PR. | medium |
| advanced | Work that needs a plan: many interacting parts, an unknown root cause, or decisions that last. Mistakes are costly or subtle. | Crosses modules or services; concurrency, security or data integrity; behavior must stay stable. | Refactor across subsystems; debug a flaky race; design a schema change and its migration; a security-sensitive change. | medium |
| frontier | The edge of what models can do. Use it when Advanced is likely to fail or already has. | Novel algorithm or research; a multi-system failure without leads; an Advanced worker failed on capability. | Design a new algorithm; find a cross-system failure after an Advanced worker failed. | high |

Rules of thumb:

- Rate the hardest part of the job, not the average.
- Between two tiers, take the lower one when the result is cheap to check and
  retry, and the higher one when a wrong result is costly or hard to notice.
- Split mixed jobs: a bulk mechanical edit plus one hard decision is a Light
  worker and an Advanced (or Daily) worker, not one Advanced worker.
- Move up one tier only when a worker failed for lack of capability, not for
  missing context; give it the missing context first.

For each worker, pass one short explanation of the chosen tier with
`--tier-reason`, grounded in scope, uncertainty, and the cost of a mistake.
For example, use Daily because the change is local and its acceptance tests
are clear. Keep routine classification and its rationale in the tool exchange.
Explain them in chat only when the user asks. The CLI returns the explanation
as `tierReason` and in `reasons`. The coordinator supplies the classification
using the rubric above. Older callers can omit the flag.

## Rate the reasoning demand separately

The tier picks how capable the model must be; the reasoning demand picks how
much it should think. Rate it from the work, never from the tier or the model:

| Demand | Signals |
| --- | --- |
| low | The steps are known; checking the result is easy. |
| moderate | Some local choices or a little diagnosis. |
| high | Ambiguity, an unknown cause, trade-offs, constraints across components, or a plan to make. |
| exceptional | Several of those at once, with costly failure. |

The amount of work is not the demand: a rename across fifty files is `low`; a
subtle race in one file is `high`. Pass `--demand <d>`; OrcaCompass maps it to
an effort the chosen model supports and reports what it applied. A Light model
can get `high` and a Frontier model `low`. Costly failure calls for tests and
review in the task spec, not only more thinking.

Pass `--effort <e>` only when the user asked for a specific effort. Valid
levels are `none`, `minimal`, `low`, `medium`, `high`, `xhigh` (also spelled
`extra-high`) and `max`; anything else, such as `ultra`, exits 1. It is never
snapped: routes that cannot apply it are left out, and if no route in the tier
can, `status` is `none` with the levels each route offers; ask the user or
route without `--effort`.

## Route, then launch

1. Choose the tier and any user constraints.
2. Make one route call per worker:

   ```sh
   orcacompass route --tier daily --demand moderate --tier-reason "Local endpoint change with clear acceptance tests." --json
   ```

   Add `--demand <low|moderate|high|exceptional>`. Restrict agents with
   repeated `--agent <id>` or `--exclude-agent <id>`. Use `--effort <e>` only
   for an effort the user asked for; `--no-downgrade` prevents fallback to a
   lower tier. Agent ids are `claude`, `codex`, `cursor`,
   `grok`, `antigravity`, `opencode`, `pi`, and `muse` (detected only, never routed: Orca has no
   Muse model list). Pi is routed only on an Orca release that starts it on a
   chosen model; until then routes skip it with `Orca <version> cannot start
   Pi on a chosen model`. An unknown id adds a warning with a likely match
   (`did you mean cursor?`); fix the id and route again.
   OpenCode is a last resort by default (API keys cost per token; local models
   take this machine): it is routed only when no other agent can take the job.
   Pass `--agent opencode` only when the user asks for OpenCode. Pi is a last
   resort too (Orca does not track its provider sign-ins); pass `--agent pi`
   only when the user asks for Pi. An OpenCode
   route needs `--worktree current` or an existing worktree; Orca refuses
   `--model` for OpenCode in a new worktree.
   If the user specifies an exact model, honor that choice directly; the CLI
   has no model selection flag.

3. Parse JSON and inspect `status`, `reasons`, `warnings`, `confidence`,
   `downgraded`, and `upgraded`. Exit code 0 alone does not mean a route exists.
4. For `status: "ok"`, append the returned `launchArgs` array to:

   ```sh
   orca orchestration worker-start --spec "<actual task specification>"
   ```

   Preserve Orca's required worktree and lifecycle flags from its own skill.
   Pass each argument as an argument, using proper shell quoting. The `launch`
   string is a readable template with a `<task>` placeholder, not task content.
   `route` contains agent/model/effort; Cursor effort is encoded in its model id,
   so `route.effort` is null and its `launchArgs` omit `--effort`. The same
   holds for Antigravity Gemini ids such as `gemini-3.8-flash-high`. For Light
   and Daily, Cursor's route is usually `auto` (Cursor picks the underlying
   model itself; at most medium confidence). Auto is placed only in Light and
   Daily, but an Advanced request that falls back to Daily can receive it.
5. Right after `worker-start` returns a `dispatchId`, check that the agent
   accepted the model:

   ```sh
   orcacompass verify --dispatch <dispatchId> --json
   ```

   Orca does not check this: `worker-start` reports the requested model as
   effective even when the agent cannot use it. Codex and Claude then print a
   refusal and idle without `worker_done` (Orca shows them as live, needing
   nothing); Cursor, Grok and Antigravity exit. `verify` reads the worker's
   terminal (60 s total by default and at most, including the initial lookup;
   `--wait <seconds>` can shorten it) and returns as soon as it has a verdict:

   - `started` or `reported`: the model works; wait for `worker_done` as usual.
   - `rejected`: the agent refused the model (`message` has its words). The
     model is now skipped by every route for `rejectionTtlHours` (default a
     week). Run each `cleanup` argv in order (stop then release, or only release when
     the worker already exited), route again
     with the same flags, and start the replacement on the same Task with
     `worker-start --task <taskId> --retry-of <dispatchId>`, the same
     placement and the new `launchArgs`. Tell the user which model was refused
     and what replaced it.
   - `stalled`: the agent ended its turn without `worker_done` and no known
     refusal; read `tail`. If it is an error about its model, account or
     limits, stop it and route again with `--exclude-agent <agent>`; if it
     asks a question, answer it in its terminal.
   - `failed`: the worker ended on its own; read `tail`, release it, and
     replace it as for `rejected`, excluding that agent for this job. Tell
     the user which agent failed to start, why, and how they can fix it,
     for example by finishing its first-time setup. Nothing is remembered,
     so a later route may pick that agent again.
   - `unknown`: no verdict within `--wait` seconds (default and maximum 60).
     Report that verification timed out and continue normal Orca supervision.
     Do not repeatedly call `verify` to extend the startup verification budget.

   Follow the `next` list it returns. Never start the replacement before the
   cleanup succeeded, and never stop a worker `verify` called `started`.

## Handle the result

- `downgraded: true`: mention the downgrade and reason in the worker task spec.
  Effort is not raised to make up for the weaker model; narrow the task or add
  checks, as the warning says.
- `effort`: `applied` says how effort reaches the worker (`flag`, `model-id`,
  or `provider-default` when the agent decides). Never claim an effort was set
  when `applied` is `provider-default`.
- A warning `… is a last-resort agent (lastResortAgents) …`: the route costs
  money per token or runs on this machine; tell the user before launching
  several workers on it.
- `upgraded: true`: surface the warning. This occurs only when the requested
  and all lower tiers have no candidates, never to work around usage limits.
- `status: "wait"`: inspect `waitUntil` (epoch milliseconds); wait until reset
  or retry without `--no-downgrade` if user constraints permit a downgrade.
- `status: "none"`: launch using Orca's normal default without `--model`
  or `--effort`, and state that no recommendation was available. Preserve any
  explicit user model choice instead of using a default.
- Command missing: use the same default fallback and say OrcaCompass was absent.
- Exit 1 means a command usage or runtime error; fix the command or report it. Exit 2 means invalid config;
  report `config error: <path>: <message>` and resolve it before retrying.
- Low confidence: surface that usage is unknown or more than 4x
  `usageStaleMinutes` old. Medium confidence can mean usage is moderately stale;
  the reason then notes its age ("usage 45m old"). Stale usage still blocks.
  Do not invent headroom or percentages. `catalogSource` is `network`, `cache`,
  or `snapshot`.
- `catalogSource: "snapshot"` means model metadata may be old; run `orcacompass refresh` when online.
- Every model's tiers come from a placement table OrcaCompass builds from
  every source and keeps for 5 hours; `placementsBuiltAt` (epoch ms) in the
  route JSON says when it was built. `orcacompass tiers` prints it. When a
  model the user expects is missing or sits in an odd tier, run `orcacompass
  refresh` (it rebuilds the table) before changing the config.
- A model's tier comes from your override, the provider's own description,
  or the built-in family ladder. Models without one of those classifications
  use the Model Index capability rating and output price from the maintained
  repository file. The CLI combines those scores with Models.dev metadata
  and discovered local models; no API key is required. Score-derived routes
  are at most medium confidence and `reasons` shows the calculation.
  `scoreSource` is `network`, `cache`, `snapshot`, or `unavailable`.
  When scores are unavailable, descriptions, family rules, overrides and
  Cursor Auto still apply. `orcacompass refresh` updates data and placements.
- A model listed by the local agent can be routed before either downloaded
  dataset includes it. Use the CLI's provider-description tier and recognized
  family/version handling; do not invent scores or release dates for it.
  Newer numeric releases within a recognized Claude/GPT family take priority
  within the same agent and tier, subject to user settings and usage limits.

Use `orcacompass status --json` to inspect discovery, pools, and skipped agents
(each skipped agent carries its reason, such as `excluded by config` or
`not enabled in Orca`, and banned models show as `banned by you`, models an
agent refused at launch as `refused by <agent> …`; `orcacompass rejected`
lists those and `orcacompass rejected --clear` forgets them);
use `orcacompass refresh` to refetch metadata and rebuild the placement
table, and `orcacompass tiers` to see every model's tiers. Send only the short classification
explanation via `--tier-reason`. Keep the full task specification and repository
contents in the worker launch.

Routing is stateless: back-to-back calls may return the same route. OrcaCompass does
not reserve capacity or account for workers that have just been launched; when
you launch several workers at once, consider spreading them over the returned
route and its `alternatives`. Skip alternatives with `blocked: true`.
Alternatives carry no `launchArgs`: route again with `--agent <agent>` for the
one you pick and launch with that route's `launchArgs`.
