import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_CONFIG, loadConfig } from '../../src/config.js';
import { PI_HELPER_NO_EFFORT, PI_HELPER_WARNING } from '../../src/routing/pi-helper.js';
import { agentSkipReason, route } from '../../src/routing/router.js';
import type { Config, Effort, Environment, LaunchModel } from '../../src/types.js';
import { machineEnv, placed, withPool } from '../helpers/env.js';

// Fork-only: `piModelLaunch: "helper"` routes Pi on an Orca that refuses --model for Pi, for orca-pi-chat.

const env = machineEnv();
const metaOf = (id: string) => env.discoveries.flatMap((d) => d.models).find((m) => m.modelId === id)!.meta;
const pi = (id: string, launchId: string, efforts: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']): LaunchModel => ({
  agent: 'pi', modelId: id, meta: metaOf(id), efforts, effortSource: 'orca',
  launch: { kind: 'flag', model: launchId }, poolNames: [], billing: 'through Pi\'s own anthropic sign-in; Orca does not track its limits',
});
const withPi = (models: LaunchModel[], orcaVersion: Environment['orcaVersion'] = { known: true, version: '1.4.253' }): Environment => placed({
  ...env,
  ...(orcaVersion ? { orcaVersion } : {}),
  discoveries: [...env.discoveries, { agent: 'pi', installed: true, models }],
});
const e = withPi([pi('claude-sonnet-5-5', 'anthropic/claude-sonnet-5-5'), pi('claude-fable-5-1', 'anthropic/claude-fable-5-1')]);
const HELPER: Config = { ...DEFAULT_CONFIG, piModelLaunch: 'helper' };
const piRow = (x: Environment) => x.discoveries.find((d) => d.agent === 'pi')!;

describe('piModelLaunch: helper (fork-only)', () => {
  it('routes Pi on an Orca below the Pi launch minimum, with the fixed helper warning', () => {
    expect(PI_HELPER_WARNING).toBe('pi: launch through orca-pi-chat (this Orca refuses --model for pi); launchArgs are not runnable');
    const d = route({ tier: 'daily', agents: ['pi'] }, e, HELPER);
    expect(d).toMatchObject({ status: 'ok', route: { agent: 'pi', model: 'anthropic/claude-sonnet-5-5', effort: 'medium' } });
    expect(d.warnings).toEqual([PI_HELPER_WARNING]);
    // The arguments stay as they are: this Orca refuses them, which fails safe if they are run anyway.
    expect(d.launchArgs).toEqual(['--agent', 'pi', '--model', 'anthropic/claude-sonnet-5-5', '--effort', 'medium']);
    expect(agentSkipReason(piRow(e), e, HELPER)).toBeUndefined();
  });

  it('keeps the gate closed without the key or with an unknown Orca version', () => {
    expect(route({ tier: 'daily', agents: ['pi'] }, e, DEFAULT_CONFIG).skipped)
      .toContainEqual({ agent: 'pi', reason: 'Orca 1.4.253 cannot start Pi on a chosen model' });
    const unknown = withPi(piRow(e).models, { known: false, reason: 'orca --version failed: exit code 1' });
    const d = route({ tier: 'daily', agents: ['pi'] }, unknown, HELPER);
    expect(d.status).toBe('none');
    expect(d.skipped).toContainEqual({ agent: 'pi', reason: expect.stringMatching(/^Orca version unknown;/) });
  });

  it('keeps Pi a last resort, and adds the helper warning when it takes the job', () => {
    const d = route({ tier: 'daily' }, e, HELPER);
    expect(d.route?.agent).not.toBe('pi');
    expect(d.warnings).not.toContain(PI_HELPER_WARNING);
    expect(d.skipped).toContainEqual({ agent: 'pi', reason: 'last resort: used only when no other agent can take the job' });
    const blocked = withPool(e, 'claude', 'fableWeekly', { usedPercent: 96 });
    const w = route({ tier: 'frontier', excludeAgents: ['codex', 'cursor'], noDowngrade: true }, blocked, HELPER);
    expect(w.route).toMatchObject({ agent: 'pi', model: 'anthropic/claude-fable-5-1' });
    expect(w.warnings).toContain(PI_HELPER_WARNING);
    expect(w.warnings.some((x) => x.startsWith('pi is a last-resort agent'))).toBe(true);
  });

  it('skips Pi models with no effort level, since orca-pi-chat needs one', () => {
    const noEffort = withPi([pi('claude-sonnet-5-5', 'example/off-only', [])]);
    const d = route({ tier: 'daily', agents: ['pi'] }, noEffort, HELPER);
    expect(d.status).toBe('none');
    expect(d.skipped).toContainEqual({ agent: 'pi', model: 'claude-sonnet-5-5', reason: PI_HELPER_NO_EFFORT });
    const mixed = withPi([pi('claude-sonnet-5-5', 'example/off-only', []), pi('claude-fable-5-1', 'anthropic/claude-fable-5-1')]);
    const f = route({ tier: 'frontier', agents: ['pi'] }, mixed, HELPER);
    expect(f.route).toMatchObject({ agent: 'pi', model: 'anthropic/claude-fable-5-1', effort: 'high' });
  });

  it('accepts only "helper" in the config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-pi-helper-'));
    const file = join(dir, 'config.json');
    writeFileSync(file, '{"piModelLaunch":"helper"}');
    expect(loadConfig(file).piModelLaunch).toBe('helper');
    expect(DEFAULT_CONFIG.piModelLaunch).toBeUndefined();
    writeFileSync(file, '{"piModelLaunch":"auto"}');
    expect(() => loadConfig(file)).toThrow(ConfigError);
    expect(() => loadConfig(file)).toThrow(/piModelLaunch must be "helper" \(got "auto"\)/);
  });
});
