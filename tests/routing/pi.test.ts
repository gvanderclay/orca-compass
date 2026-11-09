import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { route } from '../../src/routing/router.js';
import type { Effort, Environment, LaunchModel } from '../../src/types.js';
import { machineEnv, placed, withPool } from '../helpers/env.js';

// Routing Pi once Orca can start it on a chosen model: this file opens the gate at a synthetic release
// (1.5.0); the shipped constant stays unset until Orca releases Pi launch support.
vi.mock('../../src/routing/orca-version.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/routing/orca-version.js')>();
  const gates = { pi: { name: 'Pi', minOrca: '1.5.0' } };
  return { ...real, launchGateReason: (agent: string, orca: Parameters<typeof real.launchGateReason>[1]) => real.launchGateReason(agent, orca, gates) };
});

const env = machineEnv();
const metaOf = (id: string) => env.discoveries.flatMap((d) => d.models).find((m) => m.modelId === id)!.meta;
const pi = (id: string, launchId: string, efforts: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']): LaunchModel => ({
  agent: 'pi', modelId: id, meta: metaOf(id), efforts, effortSource: 'orca',
  launch: { kind: 'flag', model: launchId }, poolNames: [], billing: 'through Pi\'s own anthropic sign-in; Orca does not track its limits',
});
const withPi = (models: LaunchModel[], version = '1.5.0'): Environment => placed({
  ...env,
  orcaVersion: { known: true, version },
  discoveries: [...env.discoveries, { agent: 'pi', installed: true, models }],
});
const sonnet = pi('claude-sonnet-5-5', 'anthropic/claude-sonnet-5-5');
const fable = pi('claude-fable-5-1', 'anthropic/claude-fable-5-1');
const e = withPi([sonnet, fable]);
const LAST = 'last resort: used only when no other agent can take the job';

describe('Pi on an Orca that starts it on a chosen model', () => {
  it('routes --agent pi with the provider/id selector and --effort', () => {
    const d = route({ tier: 'daily', agents: ['pi'] }, e, DEFAULT_CONFIG);
    expect(d).toMatchObject({ status: 'ok', route: { agent: 'pi', model: 'anthropic/claude-sonnet-5-5', effort: 'medium' }, confidence: 'low' });
    expect(d.launchArgs).toEqual(['--agent', 'pi', '--model', 'anthropic/claude-sonnet-5-5', '--effort', 'medium']);
    expect(d.reasons[0]).toBe('pi anthropic/claude-sonnet-5-5: no usage window: through Pi\'s own anthropic sign-in; Orca does not track its limits');
    expect(d.warnings).toEqual([]);
  });

  it('stays closed on an older Orca', () => {
    const old = withPi([sonnet], '1.4.253');
    const d = route({ tier: 'daily', agents: ['pi'] }, old, DEFAULT_CONFIG);
    expect(d.status).toBe('none');
    expect(d.skipped).toContainEqual({ agent: 'pi', reason: 'Orca 1.4.253 cannot start Pi on a chosen model (needs 1.5.0 or later)' });
  });

  it('is a last resort by default: never a silent overflow from a blocked Claude', () => {
    const d = route({ tier: 'daily' }, e, DEFAULT_CONFIG);
    expect(d.route?.agent).not.toBe('pi');
    expect(d.skipped).toContainEqual({ agent: 'pi', reason: LAST });
    const blocked = withPool(e, 'claude', 'fableWeekly', { usedPercent: 96 });
    const w = route({ tier: 'frontier', excludeAgents: ['codex', 'cursor'], noDowngrade: true }, blocked, DEFAULT_CONFIG);
    expect(w.route).toMatchObject({ agent: 'pi', model: 'anthropic/claude-fable-5-1' });
    expect(w.warnings.some((x) => /^pi is a last-resort agent \(lastResortAgents\), used instead of waiting \d+[mhd]: through Pi's own anthropic sign-in/.test(x))).toBe(true);
  });

  it('leaves the native agent ahead on a tie, and a pin or --agent makes Pi ordinary', () => {
    const plain = route({ tier: 'daily' }, e, { ...DEFAULT_CONFIG, lastResortAgents: [] });
    expect(plain.route?.agent).not.toBe('pi');
    const pinned = route({ tier: 'daily' }, e, { ...DEFAULT_CONFIG, pins: { daily: { agent: 'pi' } } });
    expect(pinned.route?.agent).toBe('pi');
    expect(pinned.warnings.some((w) => w.includes('last-resort'))).toBe(false);
  });

  it('drops Pi\'s off level: --effort none excludes Pi, [off, high] snaps low up to high, [off] launches at Pi\'s default', () => {
    expect(route({ tier: 'daily', agents: ['pi'], effort: 'none' }, e, DEFAULT_CONFIG).status).toBe('none');
    const snap = withPi([pi('claude-sonnet-5-5', 'example/snap-high', ['high'])]);
    const up = route({ tier: 'daily', agents: ['pi'], demand: 'low' }, snap, DEFAULT_CONFIG);
    expect(up.route).toEqual({ agent: 'pi', model: 'example/snap-high', effort: 'high' });
    expect(up.effort).toMatchObject({ target: 'low', resolved: 'high', applied: 'flag', adjusted: true, supportSource: 'orca' });
    const offOnly = withPi([pi('claude-sonnet-5-5', 'example/off-only', [])]);
    const def = route({ tier: 'daily', agents: ['pi'] }, offOnly, DEFAULT_CONFIG);
    expect(def.route).toEqual({ agent: 'pi', model: 'example/off-only', effort: null });
    expect(def.effort).toMatchObject({ applied: 'provider-default', resolved: null });
    expect(def.launchArgs).toEqual(['--agent', 'pi', '--model', 'example/off-only']);
  });

  it('skips a model Pi refused without hiding Claude\'s copy, and the other way round', () => {
    const at = env.now - 3_600_000;
    const piRefused: Environment = { ...e, rejections: [{ agent: 'pi', model: 'anthropic/claude-sonnet-5-5', message: 'Model "anthropic/claude-sonnet-5-5" not found. Use --list-models to see available models.', at }] };
    const named = route({ tier: 'daily', agents: ['pi', 'claude'] }, piRefused, DEFAULT_CONFIG);
    expect(named.skipped).toContainEqual(expect.objectContaining({ agent: 'pi', model: 'claude-sonnet-5-5' }));
    expect(named.route).toMatchObject({ agent: 'claude', model: 'claude-sonnet-5-5' });
    expect(named.skipped.some((x) => x.agent === 'claude')).toBe(false);
    const claudeRefused: Environment = { ...e, rejections: [{ agent: 'claude', model: 'claude-sonnet-5-5', message: 'There\'s an issue with the selected model (claude-sonnet-5-5).', at }] };
    const viaPi = route({ tier: 'daily', agents: ['pi', 'claude'] }, claudeRefused, DEFAULT_CONFIG);
    expect(viaPi.skipped).toContainEqual(expect.objectContaining({ agent: 'claude', model: 'claude-sonnet-5-5' }));
    expect(viaPi.route).toMatchObject({ agent: 'pi', model: 'anthropic/claude-sonnet-5-5' });
  });

  it('drops Pi\'s copies of a banned family too', () => {
    const d = route({ tier: 'daily', agents: ['pi'] }, e, { ...DEFAULT_CONFIG, banModels: ['claude-sonnet'] });
    expect(d.skipped).toContainEqual({ agent: 'pi', model: 'claude-sonnet-5-5', reason: 'banned by you' });
  });
});
