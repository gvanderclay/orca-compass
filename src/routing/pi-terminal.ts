// Fork-only (gvanderclay/local-fixes): `piModelLaunch: "terminal"` routes Pi on an Orca that refuses
// `--agent pi --model`. The coordinator starts Pi on the chosen model in an Orca terminal
// (`orca terminal create --command "pi --model … --thinking …"`) and attaches it with `worker-start --terminal`.
// Upstream OrcaCompass has no such key; keep this file out of upstream pull requests.

import type { AgentId, Config, Effort, OrcaVersion } from '../types.js';
import { belowGate, launchGateReason } from './orca-version.js';

/** Every terminal-mode Pi warning starts with this; the coordinator's skill keys on it. */
export const PI_TERMINAL_WARNING = 'pi: this Orca refuses --model for pi, so launchArgs are not runnable;';

/** The warning for one route, naming the Pi command to start in the terminal. */
export function piTerminalWarning(route: { model: string; effort: Effort | null }): string {
  const thinking = route.effort ? ` --thinking ${route.effort}` : '';
  return `${PI_TERMINAL_WARNING} start "pi --model ${route.model}${thinking}" with orca terminal create --command, then attach it with worker-start --terminal`;
}

/**
 * Whether Pi is routed for a terminal launch: the config asks for it and Orca's version is known and below the
 * Pi launch minimum. An unknown version keeps the gate closed; an Orca that starts Pi itself needs no workaround.
 */
export function piTerminalMode(agent: AgentId, orca: OrcaVersion | undefined, config: Pick<Config, 'piModelLaunch'>): boolean {
  return agent === 'pi' && config.piModelLaunch === 'terminal' && orca?.known === true && belowGate('pi', orca);
}

/** launchGateReason, opened for Pi in terminal mode. */
export function launchGateReasonFor(agent: AgentId, orca: OrcaVersion | undefined, config: Pick<Config, 'piModelLaunch'>): string | undefined {
  return piTerminalMode(agent, orca, config) ? undefined : launchGateReason(agent, orca);
}
