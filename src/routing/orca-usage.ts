import type { AgentId, AgentUsage, UsagePool } from '../types.js';
import type { Runner } from '../system/run.js';

// Orca has no usage entry for Muse; listing it reports that instead of "not reachable".
const agents = ['claude', 'codex', 'cursor', 'grok', 'antigravity', 'muse'] as const;

interface OrcaPool {
  name?: unknown;
  group?: unknown;
  usedPercent?: unknown;
  windowMinutes?: unknown;
  resetsAt?: unknown;
}

const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

interface OrcaUsage {
  status?: string;
  error?: string | null;
  updatedAt?: number;
  session?: OrcaPool | null;
  weekly?: OrcaPool | null;
  fableWeekly?: OrcaPool | null;
  monthly?: OrcaPool | null;
  buckets?: (OrcaPool | null)[] | null;
}

export async function readOrcaUsage(run: Runner): Promise<Record<AgentId, AgentUsage>> {
  try {
    const result = await run('orca', ['account', 'list', '--json'], { timeoutMs: 20_000 });
    if (result.code !== 0 || result.error) {
      throw new Error(result.error || result.stderr.trim() || `command exited with code ${result.code}`);
    }
    const data = JSON.parse(result.stdout);
    if (data?.ok !== true) {
      const error = data?.error;
      throw new Error(typeof error === 'string' ? error : error?.message || 'account list failed');
    }
    const rateLimits = data.result?.rateLimits;
    if (!rateLimits || typeof rateLimits !== 'object' || Array.isArray(rateLimits)) {
      throw new Error('account list response has no rate limits');
    }
    return Object.fromEntries(agents.map((agent) => {
      const source: OrcaUsage = rateLimits[agent] ?? {};
      const pools: Record<string, UsagePool> = {};
      // A pool with a missing number is skipped rather than read as 0 % used.
      const addPool = (name: string, pool: OrcaPool | null | undefined, kind: UsagePool['kind'] = name === 'session' ? 'session' : 'long') => {
        if (pool == null) return;
        const { usedPercent, windowMinutes, resetsAt } = pool;
        if (!isNumber(usedPercent) || !isNumber(windowMinutes) || !isNumber(resetsAt)) return;
        // Two buckets under one name (an agy group with two weekly limits) keep the tighter one.
        if (pools[name] && pools[name].usedPercent >= usedPercent) return;
        pools[name] = { name, kind, usedPercent, windowMinutes, resetsAt };
      };
      if (agent === 'cursor') {
        addPool('monthly', source.monthly);
        for (const bucket of source.buckets ?? []) {
          if (typeof bucket?.name === 'string') addPool(`bucket:${bucket.name}`, bucket);
        }
      } else if (agent === 'grok') {
        addPool('weekly', source.weekly);
        addPool('monthly', source.monthly);
      } else if (agent === 'antigravity' && (source.buckets ?? []).some((b) => typeof b?.group === 'string')) {
        // agy bills each quota group ("Gemini Models", "Claude and GPT models") separately, so each group gets
        // its own pools; Orca's session and weekly are only the tightest across groups.
        for (const bucket of source.buckets ?? []) {
          if (typeof bucket?.group !== 'string') continue;
          if (bucket.windowMinutes === 300) addPool(`bucket:${bucket.group} 5h`, bucket, 'session');
          else if (isNumber(bucket.windowMinutes) && bucket.windowMinutes > 0) addPool(`bucket:${bucket.group}`, bucket, 'long');
        }
      } else {
        // Without quota groups (older Orca), Antigravity falls back to Orca's tightest session and weekly.
        addPool('session', source.session);
        addPool('weekly', source.weekly);
        if (agent === 'claude') addPool('fableWeekly', source.fableWeekly);
      }
      // Only an explicit 'unavailable' (signed out / CLI missing) excludes the agent;
      // a transient or unrecognised status keeps it as a low-confidence candidate.
      const status = source.status === 'ok' || source.status === 'unavailable' ? source.status : 'unknown';
      const usage: AgentUsage = {
        agent,
        status,
        pools,
        ...(source.updatedAt !== undefined ? { updatedAt: source.updatedAt } : {}),
        ...(status !== 'ok'
          ? { error: source.error || (rateLimits[agent] ? `Orca usage ${source.status ?? 'status missing'}` : `Orca reports no usage for ${agent}`) }
          : {}),
      };
      return [agent, usage];
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Object.fromEntries(agents.map((agent) => [agent, {
      agent, status: 'unknown', pools: {}, error: `Orca not reachable: ${message}`,
    }]));
  }
}
