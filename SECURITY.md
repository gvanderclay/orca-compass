# Security policy

## Supported versions

OrcaCompass is currently an early `0.1.x` project, developed on GitHub and
packaged for npm as `orcacompass`. Security fixes target the current
default-branch version and the latest npm release, when one exists. Older commits
are not maintained as separate security branches; update to the latest revision
before checking whether an issue still reproduces.

## Report a vulnerability privately

Use GitHub's **Security → Report a vulnerability** for this repository:
[submit a private vulnerability report](https://github.com/manomilano/orca-compass/security/advisories/new).
Do not publish exploit details in a public issue or pull request.

Include the affected commit/version, operating system, Node.js version,
reproduction steps using synthetic data, expected versus actual behavior,
and the potential impact. Remove credentials, personal paths, account details,
and real task content. A minimal proof of concept is helpful; do not access
anyone else's accounts or data to demonstrate the issue.

If GitHub does not show the private reporting option, ask in a public issue
for private vulnerability reporting to be enabled, without disclosing the
vulnerability itself. Private reporting is a repository setting and is not
enabled by this file alone.

## What happens next

Responses are best effort. You can
expect an acknowledgment in the private report, a discussion of impact and a
fix there, and then a published GitHub security advisory with the fixed
version. Reporters are credited in the advisory unless they prefer otherwise.
Please give a reasonable time to fix the issue before disclosing it publicly.

## Scope and trust boundaries

| Surface | What to report |
| --- | --- |
| Configuration and local caches | Unsafe parsing, validation bypasses, unexpected file access, or malicious data handling |
| Process execution and discovery | Argument injection, executable resolution issues, or unsafe handling of spawned CLI output, timeouts, and Windows command shims |
| Models.dev fetch | Unsafe handling of `GET https://models.dev/api.json` responses, caching, and offline fallback |
| The Model Index fetch | Unsafe handling of `GET https://themodelindex.org/data/models.json` responses, caching, and offline fallback |
| Artificial Analysis fetch | Unsafe handling of `GET https://artificialanalysis.ai/api/v2/language/models/free` responses, caching, and offline fallback, or disclosure of the API key sent with it |
| Recommendation output | Unsafe launch arguments or unintended disclosure through diagnostics |

OrcaCompass runs local discovery commands: `orca account list`, the model
listings of Cursor (`cursor-agent models`), Antigravity (`agy models`), OpenCode
(`opencode models`) and Grok (`grok models`, when its cache file is empty). It
locates the Claude and Codex executables and reads local files: Claude Code's
cached account model catalog, Codex's and Grok's model caches, Orca's agent model
catalog, and Orca's profile database (read-only) or `orca-data.json` for its
agent switches. It does not launch workers. `orcacompass verify` reads a
dispatched worker's state and recent terminal output through
`orca orchestration`. `orcacompass install` runs the `skills` installer through
`npx`. If that succeeds, it runs `npm install -g orcacompass@<version>` only
when `--skill-only` is not set and no installed CLI is found. Agent CLIs, Orca,
npm, and executables on your PATH or, on macOS and Linux, in the tool folders
searched after it (such as `~/bin` and `~/.local/bin`) remain part of your local
trust boundary. Their own network behavior and security policies are separate from OrcaCompass's three
metadata fetches.

## Data handling

OrcaCompass does not collect task prompts, conversation history, or repository
source code for routing. It does not call AI models, implement telemetry, or
upload local usage, configuration, or model-cache contents to the metadata
services. Those services receive ordinary metadata GET requests, including
normal connection information such as the requesting IP address.

The Artificial Analysis fetch runs only when `ARTIFICIAL_ANALYSIS_API_KEY` is
set. The key goes to artificialanalysis.ai in an `x-api-key` request header and
is not written to the cache.

It reads local configuration, model catalogs, executable locations, and Orca
usage data to make recommendations. Cached data includes public metadata, trimmed
benchmarks, agent model listings, the placement table, and rejected-model
records. Terminal diagnostics and the placement table's notes can expose local
paths, account-based file names, or usage details, and `orcacompass verify` can
print worker terminal output, so sanitize output before sharing it.
