import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { PI_HELPER_WARNING } from '../../src/routing/pi-helper.js';
import { route } from '../../src/routing/router.js';
import type { Config, Environment, LaunchModel } from '../../src/types.js';
import { machineEnv, placed } from '../helpers/env.js';

// Fork-only: once an Orca release starts Pi on a chosen model (synthetic 1.5.0 here), helper mode stays out of the way.
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
  agent: 'pi', modelId: 'claude-sonnet-5-5', meta, efforts: [], effortSource: 'orca',
  launch: { kind: 'flag', model: 'anthropic/claude-sonnet-5-5' }, poolNames: [], billing: 'through Pi\'s own anthropic sign-in; Orca does not track its limits',
};
const withPi = (version: string): Environment => placed({
  ...env, orcaVersion: { known: true, version }, discoveries: [...env.discoveries, { agent: 'pi', installed: true, models: [sonnet] }],
});
const HELPER: Config = { ...DEFAULT_CONFIG, piModelLaunch: 'helper' };

describe('piModelLaunch: helper on an Orca that starts Pi itself (fork-only)', () => {
  it('routes Pi without the helper warning and keeps models without efforts', () => {
    const d = route({ tier: 'daily', agents: ['pi'] }, withPi('1.5.0'), HELPER);
    expect(d.route).toEqual({ agent: 'pi', model: 'anthropic/claude-sonnet-5-5', effort: null });
    expect(d.warnings).not.toContain(PI_HELPER_WARNING);
  });

  it('still opens the gate below that release', () => {
    const d = route({ tier: 'daily', agents: ['pi'] }, withPi('1.4.253'), HELPER);
    expect(d.status).toBe('none');
    expect(d.skipped).toContainEqual({ agent: 'pi', model: 'claude-sonnet-5-5', reason: 'no effort level to pass; orca-pi-chat needs one' });
  });
});
