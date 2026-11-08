# Getting started

This page covers installing OrcaCompass, what happens the first time it runs
(setup), and what every later call does under the hood.

## Requirements

- Node.js 20 or later. Reading Orca's agent switches needs Node 22.5 or later
  (`node:sqlite`); older Node reports them as `unknown`. Building from source
  also needs Node.js 24 and npm.
- [Orca IDE](https://github.com/stablyai/orca) running, for live usage data
  (`orca account list --json`). Without Orca, routing still works with usage
  unknown and low confidence.
- The agent CLIs you want to route to, installed and signed in: `claude`,
  `codex`, `cursor-agent`, `grok`, `agy` (Antigravity), `opencode`. An agent
  that is not installed is simply skipped.

## Install

```sh
npx orcacompass install --global
```

`npx` fetches the published package and runs its installer. It first installs
the Skill through the [`skills`](https://github.com/vercel-labs/skills)
installer, pointed at the package's own copy so the Skill always matches the
CLI version, then installs the CLI globally (`npm install -g orcacompass`)
unless `orcacompass` is already on PATH. It needs network access and asks
which agents should receive the Skill. `--global` installs the Skill for your
user, so it is available across projects. To install it only for one project,
change to that project directory and run `npx orcacompass install` there. The
CLI goes to npm's global folder either way; that prefix must be writable.

| Option | Effect |
| --- | --- |
| `-g`, `--global` | Install the Skill for your user instead of the current project |
| `-y`, `--yes` | Accept the installer's defaults; needed without a terminal |
| `-a`, `--agent <name>` | Select an installer agent name, such as `claude-code` or `codex`; repeatable |
| `--skill-only` | Install only the Skill, without attempting a registry CLI install |

For example, install for both agents across projects with:

```sh
npx orcacompass install --global --agent claude-code --agent codex
```

Keep Orca's own orchestration skill installed alongside it: OrcaCompass only
recommends a route, Orca's skill explains how to launch and supervise workers.

### From source

To run the current `main` instead of the published package, build it with
Node.js 24 and npm, then install the Skill from that checkout:

```sh
git clone https://github.com/manomilano/orca-compass.git
cd orca-compass
npm ci
npm install -g .
orcacompass install --skill-only --global
```

`npm ci` installs the build tools and compiles the CLI. `--skill-only` installs
the Skill from the checkout and leaves the CLI you just installed alone.

## First-time setup

No config file is required. Setup exists so you can say which agents to use,
pick favorite routes and ban models once, instead of repeating it per job.
There are three ways to run it.

### In a terminal

```sh
orcacompass setup
```

The wizard asks three questions, then shows a summary and saves on
confirmation. Press Enter to keep the answer shown in brackets; running it
again starts from your current settings. Ctrl+C saves nothing.

1. **Agents.** Every known agent is listed with: installed, enabled in Orca
   (`yes`, `no`, `unknown`), Orca usage status and model count. The default is
   the agents that are installed, have models, are enabled in Orca and are not
   switched off in your config. Your answer is written as `allowAgents` /
   `denyAgents`, through the same edits as `orcacompass agents`.
2. **Favorites (optional).** For each tier the current pick and its
   alternatives are shown with their on-pace percentage. Choose one as the
   favorite, or 0 for none. An available, unblocked favorite is used. Above
   the risk limit (default 100%), a known within-limit alternative replaces it.
   If none exists, the favorite is retained with a warning. The
   wizard asks for that limit when you set at least one favorite. Written as `pins` and `preferRiskLimit`.
3. **Bans (optional).** The model families found (and their models) are listed;
   name families or model ids never to use. Written as `banModels`. An agent id
   is refused here: to stop using a whole agent, leave it out in question 1.
4. **Summary.** The settings in plain words, one example route per tier (with
   any warning), the config file path, and a yes/no to save. Only what an
   answer changed is written; every other key keeps its value and position.

Without a terminal (stdin or stdout is not a TTY) `setup` exits 1 and points to
the chat setup and the individual commands.

### In chat, through the orchestrator

With the Skill installed you can ask your orchestrator to "set up OrcaCompass".
It runs `orcacompass setup --json`, which prints everything the questions need
(`configPath`, `configExists`, `orcaAgents`, the current `config`, `agents` with
`preselected`, `tiers` with `pick`/`preferred`/`options`, `families`), asks the
same three questions in plain words, and applies the answers with
`orcacompass agents`, `orcacompass prefer` and `orcacompass ban`. It never edits
the file by hand. It finishes with `orcacompass setup --complete --json`,
including when every answer kept its default. The command creates an empty
config if needed. The presence of that file marks setup complete, so later
conversations do not offer setup again. Existing settings are preserved.

The Skill also offers setup once, before the first route in a conversation,
when `setup --json` reports `configExists: false`. If you decline, the
orchestrator runs `orcacompass setup --skip`, which writes an empty config file
so the offer is not repeated; routing then follows Orca's own agent switches.

### Command by command

Everything setup does is also a command:

```sh
orcacompass agents                        # who is used, and why not
orcacompass agents disable grok           # never route to Grok Build
orcacompass prefer daily codex            # Codex first for everyday jobs
orcacompass ban claude-haiku              # never route a Claude Haiku model
```

See [Commands](commands.md).

## What runs on every call

`route`, `status`, `agents` and `setup` all gather the same picture of your
machine first (`src/routing/environment.ts`); `tiers` reads only the table. The work is in two
parts: the **placement table** (every model's tiers, built from every source
and kept for `placementsTtlHours`, 5 hours by default) and the **route**
(the table plus live usage). The optional `--tier-reason` is the
coordinator's short explanation, returned with the decision. The coordinator
classifies the task using the Skill's rubric. OrcaCompass does not call a
model for classification.

1. **Load config** from the platform path (see [Configuration](configuration.md));
   a missing file means defaults, an invalid one is exit code 2.
2. **Read the placement table** from the cache. When it is missing, older
   than `placementsTtlHours`, from another OrcaCompass version, built with
   other `tierOverrides`, `cursorAuto` or `scoreWeight`, or an agent it had
   marked not installed is now found (on PATH or in its installer's default
   folder), it is rebuilt (steps 2a to 2c,
   `src/placements/build.ts`); otherwise steps 2a to 2c are skipped.
   2a. **Load model metadata**, concurrently:
   - **Models.dev** (`https://models.dev/api.json`): names, families, release
     dates, output prices and effort options for Anthropic, OpenAI, Google and
     xAI models. Fresh cache (24 h by default), then network, then stale cache,
     then the bundled snapshot.
   - **The Model Index** (`https://themodelindex.org/data/models.json`):
     capability scores and OpenRouter output prices, same fallback chain. A
     failure here only disables score placement; family-table routing still works.
   2b. **Discover agents** in parallel. For each one: find the executable,
   read its model list, note its effort levels and which usage pools it draws
   on. Live listings (`cursor-agent models`, `agy models`, `opencode models`,
   and `grok models` when `~/.grok/models_cache.json` is empty) run with a
   30 s timeout; a good listing is saved and reused only if the command later
   fails. A listing that asks you to sign in marks the agent `not signed in`.
   `agy models` runs with its background auto-updater off, so listing models
   never updates Antigravity; `agy` still updates itself when you or Orca run it.
   2c. **Place every model**: overrides, the provider's lineup words, the
   built-in ladder, Artificial Analysis benchmarks, then the capability score
   (see [Tiers and routing](tiers-and-routing.md)). The result is written to
   `placements.json`; `orcacompass tiers` prints it.
3. **Read usage** with `orca account list --json` (20 s timeout). Each agent gets
   a status (`ok`, `unavailable`, `unknown`) and its usage pools. A pool with a
   missing number is skipped, never read as 0%. This is the only command a
   route runs when the table is fresh.
4. **Read Orca's agent switches**, read-only, from the active profile's
   `profile-state.db` (or `orca-data.json`). Anything unexpected is `unknown`
   and excludes nobody.
5. **Load rejections**: models an agent refused at launch, saved by `verify`,
   still younger than `rejectionTtlHours`.

Then the pure routing core (`src/routing/router.ts`, no I/O) turns that
environment, your request and your config into a `Decision`. See
[Tiers and routing](tiers-and-routing.md).

A run that builds the table waits for Models.dev before discovery, so it can
take longer than any single timeout (10 s metadata, 20 s usage, 30 s
listings). Every other run reads the table and takes well under a second.

## Check that it works

```sh
orcacompass agents          # each agent: installed, enabled in Orca, usage, chosen, verdict
orcacompass status          # usage pools, the pick per tier, metadata age
orcacompass route --tier daily
```

A healthy `route` prints a line like:

```text
daily → claude · claude-sonnet-5-5 · medium (high confidence)
  claude claude-sonnet-5-5: weekly 20% used, 56% of window elapsed (headroom 60%) → on pace for 36% before reset in 3d
  effort: medium from tier default, passed as --effort
orca orchestration worker-start --spec "<task>" --agent claude --model claude-sonnet-5-5 --effort medium
```

If `status` says the catalog source is `snapshot`, run `orcacompass refresh`
when online. If an agent you expect is `not used`, the verdict says why
(`not installed`, `not enabled in Orca`, `excluded by config`, `not signed in`,
`no models`). [Troubleshooting](troubleshooting.md) covers what to do for each.
