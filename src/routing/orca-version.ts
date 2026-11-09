import type { Runner } from '../system/run.js';
import type { AgentId, OrcaVersion } from '../types.js';

/**
 * The first Orca release that starts Pi on a chosen model (`--model provider/id`, with `--effort` passed on as
 * Pi's thinking level). Unset: no Orca release does yet. stablyai/orca#36587 adds it; set this to the release
 * that ships it (or a rival change) and add a fixture test for that version.
 */
export const PI_LAUNCH_MIN_ORCA: string | undefined = undefined;

export type Gates = Readonly<Record<AgentId, { name: string; minOrca: string | undefined }>>;

/**
 * Agents Orca can start on a chosen model only from some release on: their display name and that release
 * (undefined: none yet). OrcaCompass checks it on every call, so an Orca upgrade or downgrade takes effect at once.
 */
export const LAUNCH_GATES: Gates = {
  pi: { name: 'Pi', minOrca: PI_LAUNCH_MIN_ORCA },
};

const gateOf = (agent: AgentId, gates: Gates) => (Object.hasOwn(gates, agent) ? gates[agent] : undefined);

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** `1.4.253` → [1, 4, 253, pre-release?]; undefined when it is not a version. */
function parts(v: string): [number, number, number, string | undefined] | undefined {
  const m = VERSION.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4]] : undefined;
}

/** Compares two versions; a pre-release (1.5.0-rc.1) comes before its release. Unparseable versions are equal. */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] as number) - (pb[i] as number);
  if (pa[3] === pb[3]) return 0;
  return pa[3] === undefined ? 1 : pb[3] === undefined ? -1 : 0;
}

/** Orca's version from `orca --version` (it prints the bare version and needs no running Orca). Never rejects. */
export async function readOrcaVersion(run: Runner): Promise<OrcaVersion> {
  try {
    const result = await run('orca', ['--version'], { timeoutMs: 10_000 });
    if (result.code !== 0 || result.error) {
      return { known: false, reason: `orca --version failed: ${result.error || result.stderr.trim() || `exit code ${result.code}`}` };
    }
    const version = result.stdout.trim().split(/\s+/).find((w) => parts(w) !== undefined);
    return version ? { known: true, version: version.replace(/^v/, '') } : { known: false, reason: 'orca --version printed no version' };
  } catch (e) {
    return { known: false, reason: `orca --version failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Whether the Orca version is below the agent's gate: true for unknown versions and unset minimums. */
export function belowGate(agent: AgentId, orca: OrcaVersion | undefined, gates: Gates = LAUNCH_GATES): boolean {
  const gate = gateOf(agent, gates);
  if (!gate) return false;
  return !orca?.known || gate.minOrca === undefined || compareVersions(orca.version, gate.minOrca) < 0;
}

/**
 * Why Orca cannot start the agent on a chosen model, or undefined when it can (or the agent has no gate).
 * An unknown Orca version keeps the gate closed: a refused launch would be worse than a skipped agent.
 */
export function launchGateReason(agent: AgentId, orca: OrcaVersion | undefined, gates: Gates = LAUNCH_GATES): string | undefined {
  const gate = gateOf(agent, gates);
  if (!gate || !belowGate(agent, orca, gates)) return undefined;
  if (!orca?.known) return `Orca version unknown; ${gate.name} needs an Orca that starts it on a chosen model: ${orca?.reason ?? 'not read'}`;
  const needs = gate.minOrca === undefined ? '' : ` (needs ${gate.minOrca} or later)`;
  return `Orca ${orca.version} cannot start ${gate.name} on a chosen model${needs}`;
}
