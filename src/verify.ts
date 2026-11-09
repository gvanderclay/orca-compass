import type { Runner } from './system/run.js';
import { findRejection } from './routing/rejection.js';

// Watches a worker Orca just started and says whether its agent accepted the model. Orca does not check:
// worker-start reports the requested model as effective, and an agent that refuses it either exits (cursor,
// grok, antigravity) or prints the refusal and idles at its prompt without worker_done (codex, claude),
// which Orca shows as a live worker with nothing to do.
//
// A structured (chat) worker has no terminal to read. For those, verification only follows the lifecycle that
// `worker-show --full` reports: it can see success or failure, never whether the agent accepted the model.

export type VerifyStatus = 'started' | 'reported' | 'rejected' | 'stalled' | 'failed' | 'unknown';

export interface Verdict {
  status: VerifyStatus;
  dispatchId: string;
  taskId?: string;
  agent?: string;
  model?: string;
  /** The agent's refusal, with `rejected`. */
  message?: string;
  /** `structured` when verification could only follow the worker's lifecycle (no terminal to read). */
  mode?: 'structured';
  /** What was seen, in one line. */
  detail: string;
  /** The last lines of the worker's terminal, with `stalled`, `failed` and `unknown`. */
  tail?: string[];
  /** Orca commands that clean up the worker before a replacement starts, in order. */
  cleanup: string[][];
}

export interface VerifyOptions {
  /** Give up after this long, ms. */
  waitMs: number;
  /** An agent working this long without a refusal has accepted the model, ms. */
  workingMs?: number;
  pollMs?: number;
}

export interface VerifyDeps {
  run: Runner;
  sleep: (ms: number) => Promise<void>;
  clock: () => number;
}

interface Observation {
  activity?: string;
  outcome?: string;
  liveness?: string;
  stage?: string;
  tail: string[];
}

/** What `worker-show` says about how the worker ended. `conflict`: fields disagree or are malformed. */
interface Lifecycle {
  verdict: 'succeeded' | 'failed' | 'pending' | 'conflict';
  /** The worker's state as Orca names it, when it did. */
  state?: string;
  /** Why the verdict is `conflict`. */
  note?: string;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string; code?: string };

function orcaResult(stdout: string, code: number | null, error?: string): Parsed<any> {
  try {
    const data = JSON.parse(stdout);
    if (data?.ok === true) return { ok: true, value: data.result ?? {} };
    const e = data?.error;
    return { ok: false, error: typeof e === 'string' ? e : e?.message ?? e?.code ?? 'orca reported an error', ...(typeof e?.code === 'string' ? { code: e.code } : {}) };
  } catch {
    return { ok: false, error: error ?? (code === 0 ? 'orca printed no JSON' : `orca exited with code ${code}`) };
  }
}

/**
 * Success and failure as Orca names them. Orca derives `projection.stage.worker` from `worker.state` and `projection.outcome` from
 * the accepted worker report, else `worker.state`, so these three fields describe one lifecycle. A verdict needs every field that is
 * present to say the same thing; a missing or null field is skipped. Anything else that disagrees (ready or stopped beside a settled
 * outcome, `finished_unverified` or `in_progress` beside a settled state, succeeded beside failed) establishes nothing. Other values
 * (ready, stopped, abandoned, finished_unverified ...) alone say nothing about success or failure. Release-stage metadata
 * (`worker.stage`, `projection.stage.detail`) is not read: a settled worker is normally released.
 */
function lifecycleOf(result: any): Lifecycle {
  const isObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);
  const unreadable: string[] = [];
  const object = (name: string, v: unknown): any => {
    if (v === undefined || v === null) return {};
    if (isObject(v)) return v;
    unreadable.push(name);
    return {};
  };
  const fields: Array<[string, string]> = [];
  const add = (name: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (typeof v === 'string') fields.push([name, v]);
    else unreadable.push(name);
  };
  const worker = object('worker', result.worker);
  const projection = object('projection', result.projection);
  const stage = object('projection.stage', projection.stage);
  add('worker.state', worker.state);
  add('projection.outcome', projection.outcome);
  add('projection.stage.worker', stage.worker);
  if (unreadable.length > 0) return { verdict: 'conflict', note: `${unreadable.join(', ')} not readable` };
  const state = fields.find(([n]) => n === 'worker.state')?.[1] ?? fields[0]?.[1];
  for (const verdict of ['succeeded', 'failed'] as const) {
    if (!fields.some(([, v]) => v === verdict)) continue;
    if (fields.every(([, v]) => v === verdict)) return { verdict, state };
    return { verdict: 'conflict', note: fields.map(([n, v]) => `${n}=${v}`).join(', ') };
  }
  return { verdict: 'pending', ...(state ? { state } : {}) };
}

/** `orca orchestration worker-show --full --json`: the effective launch (agent, model), the Task, the execution mode and the lifecycle. The concise output has no launch, so it yields no model. */
export function parseWorkerShow(stdout: string, code: number | null = 0, error?: string): Parsed<{ agent?: string; model?: string; taskId?: string; mode?: 'structured' | 'terminal'; lifecycle: Lifecycle }> {
  const r = orcaResult(stdout, code, error);
  if (!r.ok) return r;
  const launch = r.value.worker?.startOptions?.launch ?? {};
  const effective = launch.effective ?? launch.requested ?? {};
  const str = (x: unknown) => (typeof x === 'string' && x !== '' ? x : undefined);
  const mode = r.value.worker?.startOptions?.mode?.mode;
  return {
    ok: true,
    value: {
      agent: str(effective.agent) ?? str(r.value.worker?.startOptions?.agent),
      model: str(effective.model),
      taskId: str(r.value.dispatch?.taskId) ?? str(r.value.dispatch?.task_id) ?? str(r.value.taskId),
      ...(mode === 'structured' || mode === 'terminal' ? { mode } : {}),
      lifecycle: lifecycleOf(r.value),
    },
  };
}

/** `orca orchestration worker-read --source terminal --json`: the fleet projection and the terminal tail. */
export function parseWorkerRead(stdout: string, code: number | null = 0, error?: string): Parsed<Observation> {
  const r = orcaResult(stdout, code, error);
  if (!r.ok) return r;
  const p = r.value.projection ?? {};
  const tail = Array.isArray(r.value.terminal?.tail) ? r.value.terminal.tail.filter((l: unknown): l is string => typeof l === 'string') : [];
  return {
    ok: true,
    value: { activity: p.stage?.activity, outcome: p.outcome, liveness: p.liveness?.verdict, stage: p.stage?.detail, tail },
  };
}

const lastLines = (tail: string[], n = 12): string[] => tail.map((l) => l.trimEnd()).filter((l) => l.trim() !== '').slice(-n);

export async function verifyWorker(dispatchId: string, deps: VerifyDeps, opts: VerifyOptions): Promise<Verdict> {
  const waitMs = Math.min(60_000, Math.max(0, opts.waitMs));
  const deadline = deps.clock() + waitMs;
  const remaining = () => Math.max(0, deadline - deps.clock());
  const timeoutDetail = `no verdict within ${waitMs / 1000}s`;
  if (waitMs === 0) return { status: 'unknown', dispatchId, detail: timeoutDetail, cleanup: [] };
  const workingMs = opts.workingMs ?? 8_000;
  const pollMs = opts.pollMs ?? 1_500;
  const orca = (args: string[], extra: string[] = []) => deps.run('orca', ['orchestration', ...args, '--dispatch', dispatchId, ...extra, '--json'], { timeoutMs: Math.min(20_000, remaining()) });
  const stop = ['orca', 'orchestration', 'worker-stop', '--dispatch', dispatchId, '--json'];
  const release = ['orca', 'orchestration', 'worker-release', '--dispatch', dispatchId, '--json'];

  // Only --full carries the launch (agent, model) and the execution mode. If this Orca rejects the flag, retry once without it in the time left,
  // and keep leaving it off for later lookups.
  let full = true;
  const show = async () => {
    const r = await orca(['worker-show'], full ? ['--full'] : []);
    return parseWorkerShow(r.stdout, r.code, r.error);
  };
  let launch = await show();
  if (!launch.ok && launch.code === 'invalid_argument' && remaining() > 0) {
    full = false;
    launch = await show();
  }
  if (!launch.ok) return { status: 'unknown', dispatchId, detail: `orca worker-show failed: ${launch.error}`, cleanup: [] };
  const { agent, model, taskId, mode } = launch.value;
  const base = { dispatchId, ...(taskId ? { taskId } : {}), ...(agent ? { agent } : {}), ...(model ? { model } : {}) };

  if (mode === 'structured') {
    // No terminal to read: follow only what worker-show says about how the worker ended.
    const lifecycle = { ...base, mode: 'structured' as const };
    let seen = launch.value.lifecycle;
    let showError: string | undefined;
    for (;;) {
      if (seen.verdict === 'succeeded') return { ...lifecycle, status: 'reported', detail: 'the worker already reported worker_done', cleanup: [] };
      if (seen.verdict === 'failed') return { ...lifecycle, status: 'failed', detail: `Orca marked the structured worker failed${seen.state ? ` (${seen.state})` : ''}`, cleanup: [release] };
      if (remaining() === 0) {
        const detail = showError
          ? `orca worker-show failed: ${showError}`
          : seen.verdict === 'conflict'
            ? `Orca's lifecycle fields disagree or cannot be read (${seen.note}), so no outcome is established`
            : `Orca shows the structured worker as ${seen.state ?? 'in an unknown state'}; it exposes no signal that the agent accepted the model, so verify cannot tell`;
        return { ...lifecycle, status: 'unknown', detail, cleanup: [] };
      }
      await deps.sleep(Math.min(pollMs, remaining()));
      if (remaining() === 0) continue;
      const next = await show();
      if (next.ok) {
        showError = undefined;
        seen = next.value.lifecycle;
      } else {
        showError = next.error;
        seen = { verdict: 'pending' };
      }
    }
  }

  let tail: string[] = [];
  let workingSince: number | undefined;
  let doneSince: number | undefined;
  let lastError: string | undefined;
  for (;;) {
    if (remaining() === 0) {
      const detail = lastError ? `orca worker-read failed: ${lastError}` : timeoutDetail;
      return { ...base, status: 'unknown', detail, ...(tail.length ? { tail: lastLines(tail) } : {}), cleanup: [] };
    }
    const read = await orca(['worker-read', '--source', 'terminal', '--limit', '80']);
    const obs = parseWorkerRead(read.stdout, read.code, read.error);
    const now = deps.clock();
    if (!obs.ok) {
      lastError = obs.error;
    } else {
      lastError = undefined;
      const o = obs.value;
      // An exited terminal can come back empty: keep the last output that was seen.
      if (o.tail.length > 0) tail = o.tail;
      const settled = o.liveness === 'exited' || o.outcome === 'failed';
      const message = model ? findRejection(model, tail) : undefined;
      if (message) {
        return { ...base, status: 'rejected', message, detail: `${agent ?? 'the agent'} refused ${model}`, cleanup: settled ? [release] : [stop, release] };
      }
      if (o.outcome === 'succeeded') return { ...base, status: 'reported', detail: 'the worker already reported worker_done', cleanup: [] };
      if (settled) {
        const why = o.stage ? ` (${o.stage.replace(/_/g, ' ')})` : '';
        return { ...base, status: 'failed', detail: `the worker ended without worker_done${why}`, tail: lastLines(tail), cleanup: [release] };
      }
      workingSince = o.activity === 'working' ? (workingSince ?? now) : undefined;
      if (workingSince !== undefined && now - workingSince >= workingMs) {
        return { ...base, status: 'started', detail: `working for ${Math.round((now - workingSince) / 1000)}s with no refusal`, cleanup: [] };
      }
      // The agent's turn ended without worker_done: a refusal not recognized, an error, or a question in its own prompt.
      doneSince = o.activity === 'done' && o.outcome === 'in_progress' ? (doneSince ?? now) : undefined;
      if (doneSince !== undefined && now - doneSince >= 3_000) {
        return { ...base, status: 'stalled', detail: 'the agent stopped without worker_done', tail: lastLines(tail), cleanup: [] };
      }
    }
    await deps.sleep(Math.min(pollMs, remaining()));
  }
}
