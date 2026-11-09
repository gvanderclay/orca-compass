// Fork-only (gvanderclay/local-fixes): `piModelLaunch: "helper"` routes Pi on an Orca that refuses
// `--agent pi --model`, for a coordinator that starts the chosen model through the orca-pi-chat helper instead
// of `worker-start`. Upstream OrcaCompass has no such key; keep this file out of upstream pull requests.

import type { AgentId, Config, LaunchModel, OrcaVersion } from '../types.js';
import { belowGate, launchGateReason } from './orca-version.js';

/** Added to every Pi route in helper mode; the coordinator's skill keys on it. */
export const PI_HELPER_WARNING = 'pi: launch through orca-pi-chat (this Orca refuses --model for pi); launchArgs are not runnable';

/** Why a helper-mode Pi model is left out: orca-pi-chat needs an effort, and the model offers none. */
export const PI_HELPER_NO_EFFORT = 'no effort level to pass; orca-pi-chat needs one';

/**
 * Whether Pi is routed for the helper: the config asks for it and Orca's version is known and below the Pi
 * launch minimum. An unknown version keeps the gate closed; an Orca that starts Pi itself needs no helper.
 */
export function piHelperMode(agent: AgentId, orca: OrcaVersion | undefined, config: Pick<Config, 'piModelLaunch'>): boolean {
  return agent === 'pi' && config.piModelLaunch === 'helper' && orca?.known === true && belowGate('pi', orca);
}

/** launchGateReason, opened for Pi in helper mode. */
export function launchGateReasonFor(agent: AgentId, orca: OrcaVersion | undefined, config: Pick<Config, 'piModelLaunch'>): string | undefined {
  return piHelperMode(agent, orca, config) ? undefined : launchGateReason(agent, orca);
}

/** Why a model is left out in helper mode, if it is. */
export function piHelperSkip(model: LaunchModel, orca: OrcaVersion | undefined, config: Pick<Config, 'piModelLaunch'>): string | undefined {
  return piHelperMode(model.agent, orca, config) && model.efforts.length === 0 ? PI_HELPER_NO_EFFORT : undefined;
}
