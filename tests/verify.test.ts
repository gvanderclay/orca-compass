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
