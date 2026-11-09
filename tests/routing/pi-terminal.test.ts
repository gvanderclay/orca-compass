import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_CONFIG, loadConfig } from '../../src/config.js';
import { PI_TERMINAL_WARNING, piTerminalWarning } from '../../src/routing/pi-terminal.js';
import { agentSkipReason, route } from '../../src/routing/router.js';
import type { Config, Effort, Environment, LaunchModel } from '../../src/types.js';
import { machineEnv, placed, withPool } from '../helpers/env.js';

// Fork-only: `piModelLaunch: "terminal"` routes Pi on an Orca that refuses --model for Pi; the coordinator starts
// Pi on the chosen model in an Orca terminal and attaches it with worker-start --terminal.

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
const TERMINAL: Config = { ...DEFAULT_CONFIG, piModelLaunch: 'terminal' };
const piRow = (x: Environment) => x.discoveries.find((d) => d.agent === 'pi')!;

describe('piModelLaunch: terminal (fork-only)', () => {
  it('routes Pi on an Orca below the Pi launch minimum, with a warning naming the pi command', () => {
    const d = route({ tier: 'daily', agents: ['pi'] }, e, TERMINAL);
    expect(d).toMatchObject({ status: 'ok', route: { agent: 'pi', model: 'anthropic/claude-sonnet-5-5', effort: 'medium' } });
    expect(d.warnings).toEqual([
      'pi: this Orca refuses --model for pi, so launchArgs are not runnable; start "pi --model anthropic/claude-sonnet-5-5 --thinking medium" with orca terminal create --command, then attach it with worker-start --terminal',
    ]);
    expect(d.warnings[0]!.startsWith(PI_TERMINAL_WARNING)).toBe(true);
    // The arguments stay as they are: this Orca refuses them, which fails safe if they are run anyway.
    expect(d.launchArgs).toEqual(['--agent', 'pi', '--model', 'anthropic/claude-sonnet-5-5', '--effort', 'medium']);
    expect(agentSkipReason(piRow(e), e, TERMINAL)).toBeUndefined();
  });

  it('omits --thinking for a model with no effort level', () => {
    expect(piTerminalWarning({ model: 'example/off-only', effort: null }))
      .toBe(`${PI_TERMINAL_WARNING} start "pi --model example/off-only" with orca terminal create --command, then attach it with worker-start --terminal`);
    const d = route({ tier: 'daily', agents: ['pi'] }, withPi([pi('claude-sonnet-5-5', 'example/off-only', [])]), TERMINAL);
    expect(d.route).toEqual({ agent: 'pi', model: 'example/off-only', effort: null });
    expect(d.warnings[0]).toContain('"pi --model example/off-only"');
  });

  it('keeps the gate closed without the key or with an unknown Orca version', () => {
    expect(route({ tier: 'daily', agents: ['pi'] }, e, DEFAULT_CONFIG).skipped)
      .toContainEqual({ agent: 'pi', reason: 'Orca 1.4.253 cannot start Pi on a chosen model' });
    const unknown = withPi(piRow(e).models, { known: false, reason: 'orca --version failed: exit code 1' });
    const d = route({ tier: 'daily', agents: ['pi'] }, unknown, TERMINAL);
    expect(d.status).toBe('none');
    expect(d.skipped).toContainEqual({ agent: 'pi', reason: expect.stringMatching(/^Orca version unknown;/) });
  });

  it('keeps Pi a last resort, and adds the warning when it takes the job', () => {
    const d = route({ tier: 'daily' }, e, TERMINAL);
    expect(d.route?.agent).not.toBe('pi');
    expect(d.warnings.some((x) => x.startsWith(PI_TERMINAL_WARNING))).toBe(false);
    expect(d.skipped).toContainEqual({ agent: 'pi', reason: 'last resort: used only when no other agent can take the job' });
    const blocked = withPool(e, 'claude', 'fableWeekly', { usedPercent: 96 });
    const w = route({ tier: 'frontier', excludeAgents: ['codex', 'cursor'], noDowngrade: true }, blocked, TERMINAL);
    expect(w.route).toMatchObject({ agent: 'pi', model: 'anthropic/claude-fable-5-1' });
    expect(w.warnings.some((x) => x.startsWith(PI_TERMINAL_WARNING))).toBe(true);
    expect(w.warnings.some((x) => x.startsWith('pi is a last-resort agent'))).toBe(true);
  });

  it('accepts only "terminal" in the config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-pi-terminal-'));
    const file = join(dir, 'config.json');
    writeFileSync(file, '{"piModelLaunch":"terminal"}');
    expect(loadConfig(file).piModelLaunch).toBe('terminal');
    expect(DEFAULT_CONFIG.piModelLaunch).toBeUndefined();
    writeFileSync(file, '{"piModelLaunch":"helper"}');
    expect(() => loadConfig(file)).toThrow(ConfigError);
    expect(() => loadConfig(file)).toThrow(/piModelLaunch must be "terminal" \(got "helper"\)/);
  });
});
