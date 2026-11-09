import { describe, expect, it } from 'vitest';
import type { RunResult } from '../src/system/run.js';
import { verifyWorker, type VerifyDeps } from '../src/verify.js';

const show = (agent: string, model: string) => JSON.stringify({
  ok: true,
  result: {
    dispatch: { id: 'ctx_1', taskId: 'task_1' },
    worker: { startOptions: { agent, launch: { requested: { agent, model }, effective: { agent, model } } } },
  },
});

interface Frame { activity?: string; outcome?: string; liveness?: string; detail?: string; tail?: string[] }
const read = (f: Frame) => JSON.stringify({
  ok: true,
  result: {
    terminal: { status: f.liveness === 'exited' ? 'exited' : 'running', tail: f.tail ?? [] },
    projection: { stage: { activity: f.activity ?? 'unknown', detail: f.detail ?? 'input_accepted' }, outcome: f.outcome ?? 'in_progress', liveness: { verdict: f.liveness ?? 'live' } },
  },
});

/** A fake Orca: worker-show once, then one worker-read frame per poll (the last frame repeats); 1.5s per poll. */
function fake(showOut: string, frames: Frame[]) {
  let t = 0;
  let i = 0;
  const calls: string[][] = [];
  const deps: VerifyDeps = {
    run: async (_cmd, args): Promise<RunResult> => {
      calls.push(args);
      if (args[1] === 'worker-show') return { code: 0, stdout: showOut, stderr: '' };
      const f = frames[Math.min(i++, frames.length - 1)];
      return { code: 0, stdout: read(f), stderr: '' };
    },
    sleep: async (ms) => {
      t += ms;
    },
    clock: () => t,
  };
  return { deps, calls };
}

const PREAMBLE = ['=== TASK ===', 'Probe task.'];
const opts = { waitMs: 45_000 };

describe('verifyWorker', () => {
  it('includes worker-show and slow reads in the total deadline', async () => {
    let elapsed = 0;
    const deps: VerifyDeps = {
      clock: () => elapsed,
      sleep: async (ms) => { elapsed += ms; },
      run: async (_cmd, args, options) => {
        const duration = Math.min(20_000, options?.timeoutMs ?? 20_000);
        elapsed += duration;
        return { code: 0, stderr: '', stdout: args[1] === 'worker-show' ? show('codex', 'gpt-6-luna') : read({}) };
      },
    };
    expect((await verifyWorker('ctx_1', deps, { waitMs: 25_000 })).status).toBe('unknown');
    expect(elapsed).toBe(25_000);
  });

  it('caps the total wait at sixty seconds and trims the final polling delay', async () => {
    const { deps } = fake(show('codex', 'gpt-6-luna'), [{}]);
    expect((await verifyWorker('ctx_1', deps, { waitMs: 90_000 })).status).toBe('unknown');
    expect(deps.clock()).toBe(60_000);
    const short = fake(show('codex', 'gpt-6-luna'), [{}]);
    expect((await verifyWorker('ctx_1', short.deps, { waitMs: 1_000 })).status).toBe('unknown');
    expect(short.deps.clock()).toBe(1_000);
  });

  it('returns immediately for a zero wait without calling Orca', async () => {
    const { deps, calls } = fake(show('codex', 'gpt-6-luna'), [{}]);
    expect((await verifyWorker('ctx_1', deps, { waitMs: 0 })).status).toBe('unknown');
    expect(calls).toEqual([]);
  });
  it('codex refusing a Claude model: rejected while live, stop then release', async () => {
    const { deps, calls } = fake(show('codex', 'claude-opus-5-5'), [
      { activity: 'working', tail: PREAMBLE },
      { activity: 'done', tail: [...PREAMBLE, '■ The \'claude-opus-5-5\' model is not supported when using Codex with a ChatGPT account.', '› Ask Codex to do anything'] },
    ]);
    const v = await verifyWorker('ctx_1', deps, opts);
    expect(v).toMatchObject({
      status: 'rejected', dispatchId: 'ctx_1', taskId: 'task_1', agent: 'codex', model: 'claude-opus-5-5',
      message: 'The \'claude-opus-5-5\' model is not supported when using Codex with a ChatGPT account.',
    });
    expect(v.cleanup).toEqual([
      ['orca', 'orchestration', 'worker-stop', '--dispatch', 'ctx_1', '--json'],
      ['orca', 'orchestration', 'worker-release', '--dispatch', 'ctx_1', '--json'],
    ]);
    expect(calls[1]).toEqual(['orchestration', 'worker-read', '--source', 'terminal', '--limit', '80', '--dispatch', 'ctx_1', '--json']);
  });

  it('cursor exiting on an unknown model: rejected after Orca failed the start, release only', async () => {
    const { deps } = fake(show('cursor', 'claude-opus-9-9'), [
      { outcome: 'failed', liveness: 'unverifiable', detail: 'agent_readiness', tail: ['Cannot use this model: claude-opus-9-9. Available models: auto, gpt-5.3-codex-low', '❯'] },
    ]);
    const v = await verifyWorker('ctx_1', deps, opts);
    expect(v).toMatchObject({ status: 'rejected', message: 'Cannot use this model: claude-opus-9-9.' });
    expect(v.cleanup).toEqual([['orca', 'orchestration', 'worker-release', '--dispatch', 'ctx_1', '--json']]);
  });

  it('remembers the refusal when the exited terminal comes back empty', async () => {
    const { deps } = fake(show('grok', 'grok-9-fake'), [
      { activity: 'done', tail: ['Error: Couldn\'t set model \'grok-9-fake\': Invalid params: "unknown model id".'] },
      { outcome: 'failed', liveness: 'exited', tail: [] },
    ]);
    expect(await verifyWorker('ctx_1', deps, opts)).toMatchObject({ status: 'rejected' });
  });

  it('an agent working for 8s with no refusal has started', async () => {
    const { deps } = fake(show('claude', 'claude-haiku-5-5'), [{ activity: 'working', tail: PREAMBLE }]);
    const v = await verifyWorker('ctx_1', deps, opts);
    expect(v).toMatchObject({ status: 'started', cleanup: [] });
    expect(v.detail).toMatch(/^working for 9s with no refusal$/);
  });

  it('a quick worker that already reported is fine', async () => {
    const { deps } = fake(show('claude', 'claude-haiku-5-5'), [{ activity: 'working' }, { activity: 'working', outcome: 'succeeded', detail: 'settled' }]);
    expect(await verifyWorker('ctx_1', deps, opts)).toMatchObject({ status: 'reported' });
  });

  it('a turn that ends without worker_done or a known refusal is stalled, with the tail', async () => {
    const { deps } = fake(show('codex', 'gpt-6-luna'), [{ activity: 'done', tail: [...PREAMBLE, '■ You have hit your usage limit.', ''] }]);
    const v = await verifyWorker('ctx_1', deps, opts);
    expect(v).toMatchObject({ status: 'stalled', cleanup: [] });
    expect(v.tail).toEqual(['=== TASK ===', 'Probe task.', '■ You have hit your usage limit.']);
  });

  it('an exit without a known refusal is failed', async () => {
    const { deps } = fake(show('antigravity', 'gemini-3.8-flash-high'), [{ outcome: 'failed', liveness: 'exited', detail: 'process_exited', tail: ['panic'] }]);
    expect(await verifyWorker('ctx_1', deps, opts)).toMatchObject({ status: 'failed', detail: 'the worker ended without worker_done (process exited)', tail: ['panic'] });
  });

  it('gives up as unknown after the wait', async () => {
    const { deps } = fake(show('codex', 'gpt-6-luna'), [{ activity: 'unknown' }]);
    expect(await verifyWorker('ctx_1', deps, { waitMs: 6_000 })).toMatchObject({ status: 'unknown', detail: 'no verdict within 6s' });
  });

  it('reports a worker-show failure as unknown', async () => {
    const { deps } = fake(JSON.stringify({ ok: false, error: { code: 'dispatch_not_found', message: 'no such dispatch' } }), []);
    expect(await verifyWorker('ctx_9', deps, opts)).toEqual({ status: 'unknown', dispatchId: 'ctx_9', detail: 'orca worker-show failed: no such dispatch', cleanup: [] });
  });
});

describe('verifyWorker worker-show metadata', () => {
  const refusal = ["There's an issue with the selected model (gpt-6-luna). It may not exist or you may not have access to it."];
  const bad = (code: string) => JSON.stringify({ ok: false, error: { code, message: `${code} message` } });
  const concise = JSON.stringify({ ok: true, result: { taskId: 'task_9', worker: { handle: 'h' } } });

  /** A fake Orca whose worker-show answers by argv; every call is recorded and costs `cost` ms. */
  function scripted(showFor: (args: string[]) => string, cost = 0) {
    let t = 0;
    const calls: string[][] = [];
    const deps: VerifyDeps = {
      run: async (_cmd, args, options) => {
        calls.push(args);
        t += Math.min(cost, options?.timeoutMs ?? cost);
        return { code: 0, stderr: '', stdout: args[1] === 'worker-show' ? showFor(args) : read({ outcome: 'succeeded', tail: refusal }) };
      },
      sleep: async (ms) => { t += ms; },
      clock: () => t,
    };
    return { deps, calls };
  }

  it('requests the full worker-show output', async () => {
    const { deps, calls } = scripted(() => show('codex', 'gpt-6-luna'));
    await verifyWorker('ctx_1', deps, opts);
    expect(calls[0]).toEqual(['orchestration', 'worker-show', '--dispatch', 'ctx_1', '--full', '--json']);
    expect(calls.filter((a) => a[1] === 'worker-show')).toHaveLength(1);
  });

  it('retries once without --full when Orca rejects the flag, and still finds the model', async () => {
    const { deps, calls } = scripted((args) => (args.includes('--full') ? bad('invalid_argument') : show('codex', 'gpt-6-luna')));
    const v = await verifyWorker('ctx_1', deps, opts);
    expect(calls.filter((a) => a[1] === 'worker-show')).toEqual([
      ['orchestration', 'worker-show', '--dispatch', 'ctx_1', '--full', '--json'],
      ['orchestration', 'worker-show', '--dispatch', 'ctx_1', '--json'],
    ]);
    expect(v).toMatchObject({ status: 'rejected', agent: 'codex', model: 'gpt-6-luna', taskId: 'task_1' });
  });

  it('does not retry on any other error', async () => {
    for (const code of ['dispatch_not_found', 'runtime_unavailable', 'unknown_flag']) {
      const { deps, calls } = scripted(() => bad(code));
      expect(await verifyWorker('ctx_1', deps, opts)).toMatchObject({ status: 'unknown', detail: `orca worker-show failed: ${code} message` });
      expect(calls).toHaveLength(1);
    }
  });

  it('reports the retry failure as unknown, with no second retry', async () => {
    const { deps, calls } = scripted((args) => (args.includes('--full') ? bad('invalid_argument') : bad('dispatch_not_found')));
    expect(await verifyWorker('ctx_1', deps, opts)).toMatchObject({ status: 'unknown', detail: 'orca worker-show failed: dispatch_not_found message' });
    expect(calls).toHaveLength(2);
  });

  it('keeps one budget across both worker-show calls and makes no retry once it is spent', async () => {
    const spent = scripted((args) => (args.includes('--full') ? bad('invalid_argument') : show('codex', 'gpt-6-luna')), 20_000);
    expect(await verifyWorker('ctx_1', spent.deps, { waitMs: 20_000 })).toMatchObject({ status: 'unknown', detail: 'orca worker-show failed: invalid_argument message' });
    expect(spent.calls).toHaveLength(1);

    const shared = scripted((args) => (args.includes('--full') ? bad('invalid_argument') : show('codex', 'gpt-6-luna')), 12_000);
    await verifyWorker('ctx_1', shared.deps, { waitMs: 20_000 });
    expect(shared.calls.filter((a) => a[1] === 'worker-show')).toHaveLength(2);
    expect(shared.deps.clock()).toBeLessThanOrEqual(20_000);
  });

  it('takes the Task id from the concise top level, and never invents a model from it', async () => {
    const { deps } = scripted(() => concise);
    const v = await verifyWorker('ctx_1', deps, opts);
    expect(v).toMatchObject({ status: 'reported', taskId: 'task_9' });
    expect(v).not.toHaveProperty('model');
    expect(v).not.toHaveProperty('agent');
  });

  it('never reports a refusal without a model', async () => {
    const { deps } = scripted(() => concise);
    expect((await verifyWorker('ctx_1', deps, opts)).status).not.toBe('rejected');
  });
});

describe('verifyWorker structured workers', () => {
  interface Shape { mode?: unknown; preferred?: string; state?: unknown; projection?: unknown; omitProjection?: boolean }
  const live = { outcome: 'in_progress', stage: { worker: 'ready', dispatch: 'dispatched' }, liveness: { verdict: 'unverifiable' } };
  const frame = (s: Shape = {}) => JSON.stringify({
    ok: true,
    result: {
      dispatch: { id: 'ctx_1', taskId: 'task_1', status: 'dispatched' },
      worker: {
        state: 'state' in s ? s.state : 'ready',
        startOptions: { agent: 'claude', mode: { mode: 'mode' in s ? s.mode : 'structured', preferred: s.preferred ?? 'structured' }, launch: { effective: { agent: 'claude', model: 'claude-sonnet-5-5' } } },
      },
      ...(s.omitProjection ? {} : { projection: 'projection' in s ? s.projection : live }),
    },
  });
  const done = (outcome: string, worker = outcome) => ({ outcome, stage: { worker }, liveness: { verdict: 'exited' } });
  const bad = (code: string, message = `${code} message`) => JSON.stringify({ ok: false, error: { code, message } });

  /** A fake Orca answering each worker-show with the next frame (the last repeats); every call costs `cost` ms. */
  function orca(frames: string[], cost = 0) {
    let t = 0;
    let i = 0;
    const calls: string[][] = [];
    const deps: VerifyDeps = {
      run: async (_cmd, args, options) => {
        calls.push(args);
        t += Math.min(cost, options?.timeoutMs ?? cost);
        return { code: 0, stderr: '', stdout: frames[Math.min(i++, frames.length - 1)] };
      },
      sleep: async (ms) => { t += ms; },
      clock: () => t,
    };
    return { deps, calls };
  }
  const full = ['orchestration', 'worker-show', '--dispatch', 'ctx_1', '--full', '--json'];
  const release = ['orca', 'orchestration', 'worker-release', '--dispatch', 'ctx_1', '--json'];

  it('uses worker-show only, with no transcript read, and reuses the first observation', async () => {
    const { deps, calls } = orca([frame({ state: 'succeeded', projection: done('succeeded') })]);
    expect(await verifyWorker('ctx_1', deps, opts)).toMatchObject({ status: 'reported', mode: 'structured', taskId: 'task_1', agent: 'claude', model: 'claude-sonnet-5-5', cleanup: [] });
    expect(calls).toEqual([full]);
  });

  it('follows the lifecycle across polls: live, then succeeded', async () => {
    const { deps, calls } = orca([frame(), frame(), frame({ state: 'succeeded', projection: done('succeeded') })]);
    expect(await verifyWorker('ctx_1', deps, opts)).toMatchObject({ status: 'reported', mode: 'structured' });
    expect(calls).toEqual([full, full, full]);
    expect(deps.clock()).toBe(3_000);
  });

  it('follows the lifecycle across polls: live, then explicitly failed, release only', async () => {
    const { deps } = orca([frame(), frame({ state: 'failed', projection: done('failed') })]);
    const v = await verifyWorker('ctx_1', deps, opts);
    expect(v).toMatchObject({ status: 'failed', mode: 'structured', cleanup: [release], detail: 'Orca marked the structured worker failed (failed)' });
    expect(v).not.toHaveProperty('tail');
  });

  it('a live worker ends unknown at the deadline and does not claim that no failure happened', async () => {
    const { deps, calls } = orca([frame()]);
    const v = await verifyWorker('ctx_1', deps, { waitMs: 6_000 });
    expect(v).toMatchObject({ status: 'unknown', mode: 'structured', cleanup: [] });
    expect(v.detail).toBe('Orca shows the structured worker as ready; it exposes no signal that the agent accepted the model, so verify cannot tell');
    expect(calls.every((a) => a[1] === 'worker-show')).toBe(true);
    expect(calls).toHaveLength(4);
    expect(deps.clock()).toBe(6_000);
  });

  it.each(['exited', 'stopped', 'abandoned', 'finished_unverified', 'exited_unverified'])('%s alone is never a failure', async (state) => {
    const projection = { outcome: 'in_progress', stage: { worker: state }, liveness: { verdict: state === 'exited' ? 'exited' : 'unverifiable' } };
    const { deps } = orca([frame({ state, projection })]);
    const v = await verifyWorker('ctx_1', deps, { waitMs: 3_000 });
    expect(v).toMatchObject({ status: 'unknown', cleanup: [] });
    expect(v.detail).toContain(state);
  });

  it('uses worker.state when the projection is null or missing', async () => {
    for (const shape of [{ projection: null }, { omitProjection: true }] as Shape[]) {
      expect(await verifyWorker('ctx_1', orca([frame({ ...shape, state: 'succeeded' })]).deps, opts)).toMatchObject({ status: 'reported' });
      expect(await verifyWorker('ctx_1', orca([frame({ ...shape, state: 'failed' })]).deps, opts)).toMatchObject({ status: 'failed', cleanup: [release] });
      expect(await verifyWorker('ctx_1', orca([frame({ ...shape, state: 'ready' })]).deps, { waitMs: 2_000 })).toMatchObject({ status: 'unknown', cleanup: [] });
    }
  });

  it('uses the projection when worker.state says nothing', async () => {
    expect(await verifyWorker('ctx_1', orca([frame({ state: undefined, projection: done('succeeded') })]).deps, opts)).toMatchObject({ status: 'reported' });
    expect(await verifyWorker('ctx_1', orca([frame({ state: null, projection: done('failed') })]).deps, opts)).toMatchObject({ status: 'failed', cleanup: [release] });
  });

  it('missing lifecycle fields stay unknown', async () => {
    const v = await verifyWorker('ctx_1', orca([frame({ state: undefined, omitProjection: true })]).deps, { waitMs: 2_000 });
    expect(v).toMatchObject({ status: 'unknown', cleanup: [] });
    expect(v.detail).toContain('in an unknown state');
  });

  it.each([
    ['success against failure', { state: 'succeeded', projection: done('failed') }],
    ['failure against success', { state: 'failed', projection: done('succeeded') }],
    ['stage against outcome', { state: 'ready', projection: { outcome: 'succeeded', stage: { worker: 'failed' } } }],
    ['success while the outcome is in progress', { state: 'succeeded', projection: live }],
    ['failure while the outcome is in progress', { state: 'failed', projection: live }],
    ['a non-string state', { state: 7, projection: done('succeeded') }],
    ['a non-string outcome', { state: 'succeeded', projection: { outcome: { value: 'succeeded' } } }],
    ['a projection that is not an object', { state: 'succeeded', projection: 'succeeded' }],
    ['a projection stage that is a string', { state: 'failed', projection: { outcome: 'failed', stage: 'failed' } }],
    ['a projection stage that is an array', { state: 'succeeded', projection: { outcome: 'succeeded', stage: ['succeeded'] } }],
    ['a non-string stage worker', { state: 'succeeded', projection: { outcome: 'succeeded', stage: { worker: false } } }],
    ['ready beside a failed outcome', { state: 'ready', projection: { outcome: 'failed', stage: { worker: 'ready' } } }],
    ['ready beside a succeeded outcome', { state: 'ready', projection: { outcome: 'succeeded', stage: { worker: 'ready' } } }],
    ['stopped beside a succeeded outcome', { state: 'stopped', projection: { outcome: 'succeeded', stage: { worker: 'stopped' } } }],
    ['stopped beside a failed outcome', { state: 'stopped', projection: { outcome: 'failed', stage: { worker: 'stopped' } } }],
    ['abandoned beside a failed outcome', { state: 'abandoned', projection: { outcome: 'failed', stage: { worker: 'abandoned' } } }],
    ['abandoned beside a succeeded outcome', { state: 'abandoned', projection: { outcome: 'succeeded', stage: { worker: 'abandoned' } } }],
    ['failed beside finished_unverified', { state: 'failed', projection: { outcome: 'finished_unverified', stage: { worker: 'failed' } } }],
    ['succeeded beside finished_unverified', { state: 'succeeded', projection: { outcome: 'finished_unverified', stage: { worker: 'succeeded' } } }],
    ['failed beside outcome_unknown', { state: 'failed', projection: { outcome: 'outcome_unknown', stage: { worker: 'failed' } } }],
    ['a stage that lags the state', { state: 'succeeded', projection: { outcome: 'succeeded', stage: { worker: 'ready' } } }],
    ['a state that lags the stage', { state: 'ready', projection: { outcome: 'in_progress', stage: { worker: 'failed' } } }],
  ] as Array<[string, Shape]>)('contradictory or malformed fields (%s) are unknown, with no cleanup', async (_name, shape) => {
    const v = await verifyWorker('ctx_1', orca([frame(shape)]).deps, { waitMs: 3_000 });
    expect(v).toMatchObject({ status: 'unknown', mode: 'structured', cleanup: [] });
    expect(v.detail).toMatch(/^Orca's lifecycle fields disagree or cannot be read \(/);
  });

  it('a conflicting settled outcome never produces cleanup, whichever side is terminal', async () => {
    for (const [state, outcome] of [['ready', 'failed'], ['stopped', 'failed'], ['abandoned', 'failed'], ['failed', 'finished_unverified']] as const) {
      const v = await verifyWorker('ctx_1', orca([frame({ state, projection: { outcome, stage: { worker: state } } })]).deps, { waitMs: 1_000 });
      expect(v).toMatchObject({ status: 'unknown', cleanup: [] });
    }
  });

  it('agreeing fields with a null, missing or empty stage still decide', async () => {
    for (const projection of [{ outcome: 'succeeded', stage: null }, { outcome: 'succeeded' }, { outcome: 'succeeded', stage: {} }, { outcome: null, stage: { worker: 'succeeded' } }]) {
      expect(await verifyWorker('ctx_1', orca([frame({ state: 'succeeded', projection })]).deps, opts)).toMatchObject({ status: 'reported' });
    }
    expect(await verifyWorker('ctx_1', orca([frame({ state: 'failed', projection: { outcome: 'failed', stage: null } })]).deps, opts)).toMatchObject({ status: 'failed', cleanup: [release] });
  });

  it('does not read release-stage metadata: a settled, released worker is still reported or failed', async () => {
    for (const [state, verdict] of [['succeeded', 'reported'], ['failed', 'failed']] as const) {
      const shown = JSON.parse(frame({ state, projection: { outcome: state, stage: { worker: state, dispatch: 'completed', detail: 'released' } } }));
      shown.result.worker.stage = 'released';
      expect(await verifyWorker('ctx_1', orca([JSON.stringify(shown)]).deps, opts)).toMatchObject({ status: verdict });
    }
  });

  it('a contradiction that clears on the next poll resolves normally', async () => {
    const { deps } = orca([frame({ state: 'succeeded', projection: live }), frame({ state: 'succeeded', projection: done('succeeded') })]);
    expect(await verifyWorker('ctx_1', deps, opts)).toMatchObject({ status: 'reported' });
  });

  it('a failed read is neither success nor failure, and a later success still counts', async () => {
    const { deps, calls } = orca([frame(), bad('runtime_unavailable'), frame({ state: 'succeeded', projection: done('succeeded') })]);
    expect(await verifyWorker('ctx_1', deps, opts)).toMatchObject({ status: 'reported' });
    expect(calls).toHaveLength(3);

    const failing = orca([frame(), bad('runtime_unavailable', 'no runtime')]);
    expect(await verifyWorker('ctx_1', failing.deps, { waitMs: 4_000 })).toMatchObject({ status: 'unknown', detail: 'orca worker-show failed: no runtime', cleanup: [] });

    const garbage = orca([frame(), 'not json']);
    expect((await verifyWorker('ctx_1', garbage.deps, { waitMs: 4_000 })).status).toBe('unknown');
  });

  it('keeps the terminal path when the mode is terminal, absent or unrecognized, whatever the preference says', async () => {
    for (const shape of [{ mode: 'terminal' }, { mode: undefined }, { mode: 'hologram' }, { mode: 'terminal', preferred: 'structured' }] as Shape[]) {
      const { deps, calls } = orca([frame(shape)]);
      const v = await verifyWorker('ctx_1', deps, { waitMs: 3_000 });
      expect(calls[1]?.slice(0, 3)).toEqual(['orchestration', 'worker-read', '--source']);
      expect(v).not.toHaveProperty('mode');
    }
  });

  it('a terminal worker with a failed lifecycle is still judged by its terminal', async () => {
    const { deps } = orca([frame({ mode: 'terminal', state: 'failed', projection: done('failed') })]);
    expect(await verifyWorker('ctx_1', deps, { waitMs: 3_000 })).not.toHaveProperty('mode');
  });

  it('returns immediately for a zero wait without calling Orca', async () => {
    const { deps, calls } = orca([frame()]);
    expect(await verifyWorker('ctx_1', deps, { waitMs: 0 })).toMatchObject({ status: 'unknown', cleanup: [] });
    expect(calls).toEqual([]);
  });

  it('keeps one sixty-second budget across the lookup, a compatibility retry and every poll', async () => {
    const { deps, calls } = orca([bad('invalid_argument'), frame()], 7_000);
    const v = await verifyWorker('ctx_1', deps, { waitMs: 90_000 });
    expect(v).toMatchObject({ status: 'unknown', mode: 'structured' });
    expect(deps.clock()).toBe(60_000);
    expect(calls.every((a) => a[1] === 'worker-show')).toBe(true);
    const spent = orca([frame()], 20_000);
    await verifyWorker('ctx_1', spent.deps, { waitMs: 20_000 });
    expect(spent.calls).toHaveLength(1);
    expect(spent.deps.clock()).toBe(20_000);
  });

  it('after the one-time --full compatibility retry, later polls stay without --full', async () => {
    const legacy = [
      bad('invalid_argument'),
      frame(),
      frame(),
      frame({ state: 'succeeded', projection: done('succeeded') }),
    ];
    const { deps, calls } = orca(legacy);
    expect(await verifyWorker('ctx_1', deps, opts)).toMatchObject({ status: 'reported', mode: 'structured' });
    expect(calls.map((a) => a.includes('--full'))).toEqual([true, false, false, false]);
  });
});
