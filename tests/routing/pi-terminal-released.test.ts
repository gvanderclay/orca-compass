import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { PI_TERMINAL_WARNING } from '../../src/routing/pi-terminal.js';
import { route } from '../../src/routing/router.js';
import type { Config, Environment, LaunchModel } from '../../src/types.js';
import { machineEnv, placed } from '../helpers/env.js';

// Fork-only: once an Orca release starts Pi on a chosen model (synthetic 1.5.0 here), terminal mode stays out of the way.
vi.mock('../../src/routing/orca-version.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/routing/orca-version.js')>();
  const gates = { pi: { name: 'Pi', minOrca: '1.5.0' } };
  type Orca = Parameters<typeof real.launchGateReason>[1];
  return {
    ...real,
    belowGate: (agent: string, orca: Orca) => real.belowGate(agent, orca, gates),
    launchGateReason: (agent: string, orca: Orca) => real.launchGateReason(agent, orca, gates),
  };
});

const env = machineEnv();
const meta = env.discoveries.flatMap((d) => d.models).find((m) => m.modelId === 'claude-sonnet-5-5')!.meta;
const sonnet: LaunchModel = {
  agent: 'pi', modelId: 'claude-sonnet-5-5', meta, efforts: ['low', 'medium', 'high'], effortSource: 'orca',
  launch: { kind: 'flag', model: 'anthropic/claude-sonnet-5-5' }, poolNames: [], billing: 'through Pi\'s own anthropic sign-in; Orca does not track its limits',
};
const withPi = (version: string): Environment => placed({
  ...env, orcaVersion: { known: true, version }, discoveries: [...env.discoveries, { agent: 'pi', installed: true, models: [sonnet] }],
});
const TERMINAL: Config = { ...DEFAULT_CONFIG, piModelLaunch: 'terminal' };
const hasWarning = (w: string[]) => w.some((x) => x.startsWith(PI_TERMINAL_WARNING));

describe('piModelLaunch: terminal on an Orca that starts Pi itself (fork-only)', () => {
  it('routes Pi with runnable launchArgs and no terminal warning', () => {
    const d = route({ tier: 'daily', agents: ['pi'] }, withPi('1.5.0'), TERMINAL);
    expect(d.route).toEqual({ agent: 'pi', model: 'anthropic/claude-sonnet-5-5', effort: 'medium' });
    expect(hasWarning(d.warnings)).toBe(false);
  });

  it('still adds the warning below that release', () => {
    const d = route({ tier: 'daily', agents: ['pi'] }, withPi('1.4.253'), TERMINAL);
    expect(d.status).toBe('ok');
    expect(hasWarning(d.warnings)).toBe(true);
  });
});
