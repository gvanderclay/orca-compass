import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { compareVersions, LAUNCH_GATES, launchGateReason, PI_LAUNCH_MIN_ORCA, readOrcaVersion } from '../../src/routing/orca-version.js';
import { agentSkipReason, route } from '../../src/routing/router.js';
import type { Runner } from '../../src/system/run.js';
import type { Environment, LaunchModel } from '../../src/types.js';
import { machineEnv, placed, withPool } from '../helpers/env.js';

// Orca starts Pi on a chosen model only from a release that has not shipped yet, so the gate stays closed.

const env = machineEnv();
const metaOf = (id: string) => env.discoveries.flatMap((d) => d.models).find((m) => m.modelId === id)!.meta;
const pi = (id: string, launchId: string): LaunchModel => ({
  agent: 'pi', modelId: id, meta: metaOf(id), efforts: ['low', 'medium', 'high'], effortSource: 'orca',
  launch: { kind: 'flag', model: launchId }, poolNames: [], billing: 'through Pi\'s own anthropic sign-in; Orca does not track its limits',
});
const withPi = (orcaVersion: Environment['orcaVersion']): Environment => placed({
  ...env,
  ...(orcaVersion ? { orcaVersion } : {}),
  discoveries: [...env.discoveries, {
    agent: 'pi', installed: true,
    models: [pi('claude-sonnet-5-5', 'anthropic/claude-sonnet-5-5'), pi('claude-fable-5-1', 'anthropic/claude-fable-5-1')],
  }],
});
const piRow = (e: Environment) => e.discoveries.find((d) => d.agent === 'pi')!;
const CLOSED = 'Orca 1.4.253 cannot start Pi on a chosen model';

describe('Orca version', () => {
  const run = (stdout: string, code: number | null = 0, error?: string): Runner => async () => ({ code, stdout, stderr: '', ...(error ? { error } : {}) });

  it('is read from orca --version, through the injected runner', async () => {
    const calls: string[][] = [];
    const recording: Runner = async (cmd, args) => (calls.push([cmd, ...args]), { code: 0, stdout: '1.4.253\n', stderr: '' });
    expect(await readOrcaVersion(recording)).toEqual({ known: true, version: '1.4.253' });
    expect(calls).toEqual([['orca', '--version']]);
    expect(await readOrcaVersion(run('v1.5.0-rc.1\n'))).toEqual({ known: true, version: '1.5.0-rc.1' });
  });

  it('is unknown when the command fails or prints no version', async () => {
    expect(await readOrcaVersion(run('', null, 'spawn orca ENOENT'))).toEqual({ known: false, reason: 'orca --version failed: spawn orca ENOENT' });
    expect(await readOrcaVersion(run('', 1))).toEqual({ known: false, reason: 'orca --version failed: exit code 1' });
    expect(await readOrcaVersion(run('Could not determine the Orca version\n'))).toEqual({ known: false, reason: 'orca --version printed no version' });
    expect(await readOrcaVersion(async () => { throw new Error('boom'); })).toEqual({ known: false, reason: 'orca --version failed: boom' });
  });

  it('compares releases numerically, a pre-release before its release', () => {
    expect(compareVersions('1.4.253', '1.4.254')).toBeLessThan(0);
    expect(compareVersions('1.10.0', '1.9.99')).toBeGreaterThan(0);
    expect(compareVersions('1.5.0-rc.1', '1.5.0')).toBeLessThan(0);
    expect(compareVersions('1.5.0', '1.5.0')).toBe(0);
  });
});

describe('Pi launch gate', () => {
  it('has no minimum Orca release yet (stablyai/orca#36587), so every Orca version is refused', () => {
    expect(PI_LAUNCH_MIN_ORCA).toBeUndefined();
    expect(LAUNCH_GATES.pi).toEqual({ name: 'Pi', minOrca: undefined });
    expect(launchGateReason('pi', { known: true, version: '1.4.253' })).toBe(CLOSED);
    expect(launchGateReason('pi', { known: true, version: '99.0.0' })).toBe('Orca 99.0.0 cannot start Pi on a chosen model');
    expect(launchGateReason('pi', { known: false, reason: 'orca --version failed: exit code 1' }))
      .toBe('Orca version unknown; Pi needs an Orca that starts it on a chosen model: orca --version failed: exit code 1');
    expect(launchGateReason('pi', undefined)).toBe('Orca version unknown; Pi needs an Orca that starts it on a chosen model: not read');
    for (const agent of ['claude', 'codex', 'opencode', 'muse', 'constructor']) expect(launchGateReason(agent, undefined)).toBeUndefined();
  });

  it('opens from the minimum release once one is set', () => {
    const gates = { pi: { name: 'Pi', minOrca: '1.5.0' } };
    expect(launchGateReason('pi', { known: true, version: '1.5.0' }, gates)).toBeUndefined();
    expect(launchGateReason('pi', { known: true, version: '1.6.2' }, gates)).toBeUndefined();
    expect(launchGateReason('pi', { known: true, version: '1.4.253' }, gates)).toBe('Orca 1.4.253 cannot start Pi on a chosen model (needs 1.5.0 or later)');
    expect(launchGateReason('pi', { known: true, version: '1.5.0-rc.1' }, gates)).toBe('Orca 1.5.0-rc.1 cannot start Pi on a chosen model (needs 1.5.0 or later)');
    expect(launchGateReason('pi', { known: false, reason: 'x' }, gates)).toMatch(/^Orca version unknown;/);
  });

  it('lists Pi but never routes it, naming the Orca version', () => {
    const e = withPi({ known: true, version: '1.4.253' });
    expect(agentSkipReason(piRow(e), e, DEFAULT_CONFIG)).toBe(CLOSED);
    const named = route({ tier: 'daily', agents: ['pi'] }, e, DEFAULT_CONFIG);
    expect(named).toMatchObject({ status: 'none' });
    expect(named.skipped).toContainEqual({ agent: 'pi', reason: CLOSED });
    const d = route({ tier: 'daily' }, e, DEFAULT_CONFIG);
    expect(d.route?.agent).not.toBe('pi');
    expect(d.skipped).toContainEqual({ agent: 'pi', reason: CLOSED });
    const unknown = withPi(undefined);
    expect(agentSkipReason(piRow(unknown), unknown, DEFAULT_CONFIG)).toMatch(/^Orca version unknown;/);
  });

  it('keeps the stronger reasons first: the user\'s choice, Orca\'s switch, not installed, no models', () => {
    const e = withPi({ known: true, version: '1.4.253' });
    expect(agentSkipReason(piRow(e), e, { ...DEFAULT_CONFIG, denyAgents: ['pi'] })).toBe('excluded by config');
    expect(agentSkipReason(piRow(e), { ...e, orcaAgents: { known: true, disabled: ['pi'], source: '/fake/db' } }, DEFAULT_CONFIG)).toBe('not enabled in Orca');
    expect(agentSkipReason({ ...piRow(e), models: [], note: 'no Pi models' }, e, DEFAULT_CONFIG)).toBe('no models: no Pi models');
    expect(agentSkipReason({ ...piRow(e), installed: false, models: [] }, e, DEFAULT_CONFIG)).toBe('not installed');
  });

  it('keeps a blocked tier waiting instead of moving it to Pi', () => {
    const e = withPool(withPi({ known: true, version: '1.4.253' }), 'claude', 'fableWeekly', { usedPercent: 96 });
    const d = route({ tier: 'frontier', excludeAgents: ['codex', 'cursor'], noDowngrade: true }, e, DEFAULT_CONFIG);
    expect(d.status).toBe('wait');
    expect(d.skipped).toContainEqual({ agent: 'pi', reason: CLOSED });
  });
});
