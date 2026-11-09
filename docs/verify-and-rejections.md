# Verify and rejections

Discovery is an estimate. A model an agent *lists* can still be one this account
cannot use (a cached Claude catalog can be stale, or discovery may fall back to
Models.dev; a Codex model may be enterprise-only; a Cursor model may be off in
the account).
Orca does not check: `orca orchestration worker-start` reports the requested
model as effective even when the agent cannot use it. `orcacompass verify`
closes that gap. Code: `src/verify.ts`, `src/routing/rejection.ts`,
`src/routing/rejections.ts`.

## What goes wrong without it

| Agent | When launched with a model it cannot use |
| --- | --- |
| Codex | Prints the refusal and idles at its prompt; no `worker_done`. Orca shows a live worker needing nothing |
| Claude Code | Same: prints the refusal and idles |
| Cursor | `cursor-agent` exits 1; Orca fails the start after its 60 s readiness wait |
| Grok Build | Exits 1 |
| Antigravity | Exits 1 |
| OpenCode | Prints `Error: Model unavailable: …` |

## How `verify` works

```sh
orcacompass verify --dispatch <dispatchId> [--wait 60] --json
```

1. `orca orchestration worker-show --dispatch <id> --full --json`: the
   effective agent and model, and the Task id. The concise output has no
   model, so without `--full` a refusal cannot be matched. If Orca rejects
   `--full` with `invalid_argument`, `verify` retries once without it inside
   the same time budget; other errors are not retried.
2. With 1.5 s between polls, `orca orchestration worker-read --dispatch <id> --source
   terminal --limit 80 --json`: Orca's fleet projection (activity, outcome,
   liveness) and the terminal tail.
3. Decide:

| Verdict | Rule |
| --- | --- |
| `rejected` | A terminal line **names the model** and matches one of the known refusal phrases (below). Soft warnings that still run the model do not count |
| `reported` | Orca's outcome is `succeeded`: the worker already sent `worker_done` |
| `failed` | The terminal exited or the outcome is `failed`, with no recognized refusal |
| `started` | Activity has been `working` for 8 s (`workingMs`) with no refusal |
| `stalled` | Activity is `done` while the outcome is still `in_progress` for 3 s: the agent ended its turn without `worker_done` (an unrecognized refusal, another error, or a question in its own prompt) |
| `unknown` | No verdict within `--wait` seconds (default and maximum 60), or Orca's commands kept failing |

The total timeout includes `worker-show`, reads, and polling delays. Each
command uses at most 20 s and is shortened to the time remaining. Verification
returns immediately when a verdict is available. `--wait` accepts 0–60 s;
0 returns `unknown` immediately. After a timeout, report it and continue normal
Orca supervision instead of repeating startup verification.

`verify` reads worker state and records detected refusals in its local cache
(terminal workers only).
It returns the
`cleanup` argv lists for the orchestrator to run: `worker-stop` then
`worker-release`, or `worker-release` alone when the worker already exited.

## Structured workers

A structured (chat) worker has no terminal. When `worker-show --full` reports
`startOptions.mode.mode` as `structured`, `verify` does not call `worker-read`.
It reuses that first `worker-show` and polls `worker-show --full` every 1.5 s
inside the same 60 s budget, following only how the worker ended. The preferred
mode alone does not count, and a worker with an absent or unrecognized mode
keeps the terminal behavior above. The verdict carries `"mode": "structured"`.

| Verdict | Rule |
| --- | --- |
| `reported` | Every lifecycle field Orca returned says `succeeded` (`worker.state`, the projection's `outcome` and `stage.worker`) |
| `failed` | Every one of those fields says `failed`. `cleanup` is `worker-release` alone. No `tail` |
| `unknown` | Everything else: ready or live, `exited`, `stopped`, `abandoned`, `finished_unverified`, fields that disagree (for example `ready` or `stopped` beside an `outcome` of `failed`, or `failed` beside `finished_unverified`), a non-string field or a non-object `worker`, `projection` or `projection.stage`, a failed read, or no answer within `--wait` |

Orca derives `stage.worker` from `worker.state` and `outcome` from the accepted
worker report, else `worker.state`, so one lifecycle shows in all three. A
missing or null field is skipped, and release metadata (`worker.stage`,
`stage.detail`) is not read, because a settled worker is normally released.

When the projection is `null`, `worker.state` alone decides. An ended worker
(state `stopped` or `abandoned`, outcome `finished_unverified`, or liveness
`exited`) with no explicit success or failure is `unknown`: it can be an intentional cancel, so it never
implies the agent failed. A live worker is `unknown` too, because Orca exposes
no signal that the agent accepted the model. `verify` therefore cannot detect a
model refusal for a structured worker, never returns `rejected`, `started` or
`stalled` for one, and never writes `rejected-models.json`. `next` points at
`orca orchestration worker-read --dispatch <id> --source auto --json` to read
the transcript.

A structured `failed` can be a failed task as well as a failed start. `next`
reads the transcript first, then releases the worker, and asks for a replacement
and `--exclude-agent` only if the transcript shows the agent failing to start;
for a failed task it tells the coordinator to keep the agent available and
report the failure.

Tested against Orca 1.4.253 with synthetic fixtures and live captures of structured
workers; no minimum Orca version is established.

## Refusal phrases recognized

Seen in November 2026 with Codex 0.166, Claude Code, cursor-agent, grok 1.0.70,
agy 1.4.11 and opencode, launched with an unknown or unavailable model:

| Agent | Refusal (must be on a line that names the model) |
| --- | --- |
| Codex | `The 'claude-opus-5-5' model is not supported when using Codex with a ChatGPT account.` |
| Claude Code | `There's an issue with the selected model (gpt-6-terra). It may not exist or you may not have access to it.` |
| Cursor | `Cannot use this model: claude-opus-9-9. Available models: …` |
| Grok Build | `Couldn't set model 'grok-9-fake': Invalid params: "unknown model id".` |
| Antigravity | `invalid model selection (--model "gemini-9-fake" …): model gemini-9-fake is not recognized as a known model …` |
| OpenCode | `Error: Model unavailable: openrouter/fake/nonexistent-9` |

Matching is case-insensitive on these fragments: `model is not supported`,
`issue with the selected model`, `cannot use this model`, `couldn't set model`,
`unknown model id`, `invalid model selection`, `not recognized as a known
model`, `model unavailable`. Long lines wrap in a terminal, so each line is
also tried joined with the next. The saved message drops the agent's
decoration (`■`, `ERROR:`), Cursor's list of available models, and a sentence
cut off by wrapping; it is capped at 240 characters.

Not refusals: Codex's ``Model metadata for `x` not found`` and Claude Code's
`doesn't recognize the model "x"`, which still run the model. A changed wording
in a newer agent version shows up as `stalled` or `failed` with the terminal
tail instead of `rejected`.

## What a rejection does

A `rejected` verdict is saved to `rejected-models.json` in the cache: agent,
model (the launch id), the agent's words, and when. For `rejectionTtlHours`
(168 hours, a week, by default):

- every `route` skips that agent and model, in any tier, listing it under
  `skipped` as `refused by codex 2h ago: "The 'claude-opus-5-5' model is not
  supported when using Codex with a ChatGPT account."`;
- `status` shows the same;
- a rejection matches any of the model's launch ids, so Cursor's
  `claude-opus-5-5-high` and `claude-opus-5-5-low` are both skipped after one
  of them was refused;
- a new refusal of the same agent and model replaces the older entry.

```sh
orcacompass rejected           # what is skipped, with the agent's words and age
orcacompass rejected --clear   # forget everything (for example after upgrading a plan)
```

## The replacement flow

After `rejected`, the orchestrator:

1. runs each `cleanup` argv in order and checks it succeeded;
2. routes again with the same flags (the refused model is now skipped, so the
   route differs);
3. starts the replacement on the same Task:
   `orca orchestration worker-start --task <taskId> --retry-of <dispatchId> …`
   with the same placement and the new `launchArgs`;
4. tells the user which model was refused and what replaced it.

For `failed`, the same, with `--exclude-agent <agent>` on the new route for
this job. For `stalled`, read `tail` first: a model, account or limit error is
treated like `failed`; a question is answered in the worker's terminal.

## Example

```sh
$ orcacompass verify --dispatch d-7f3a --json
{
  "status": "rejected",
  "dispatchId": "d-7f3a",
  "taskId": "t-19",
  "agent": "codex",
  "model": "claude-opus-5-5",
  "message": "The 'claude-opus-5-5' model is not supported when using Codex with a ChatGPT account.",
  "detail": "codex refused claude-opus-5-5",
  "cleanup": [
    ["orca", "orchestration", "worker-stop", "--dispatch", "d-7f3a", "--json"],
    ["orca", "orchestration", "worker-release", "--dispatch", "d-7f3a", "--json"]
  ],
  "skippedForHours": 168,
  "next": [
    "clean up: orca orchestration worker-stop --dispatch d-7f3a --json, then orca orchestration worker-release --dispatch d-7f3a --json",
    "route again with the same flags; codex claude-opus-5-5 is skipped for 168h",
    "start the replacement on the same Task: orca orchestration worker-start --task t-19 --retry-of d-7f3a --worktree <same placement> <new launchArgs> --json"
  ]
}
```

Text output has the same content: the verdict line, `agent said: …`, the
terminal tail prefixed with `|`, then a numbered `next:` list.
