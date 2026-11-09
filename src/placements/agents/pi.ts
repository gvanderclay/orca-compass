import { parseEffort } from '../../routing/effort.js';
import type { AgentDiscovery, Effort, LaunchModel, ModelMeta } from '../../types.js';
import { normalizeModelId } from '../score.js';
import type { AgentDeps, Locator } from './deps.js';
import { billingOf } from './opencode.js';
import { newestOrcaCatalogEntry, orcaCatalogPath, type RawModel } from './orca-catalog.js';

// Pi's thinking levels. Pi reads a model id ending in ":<level>" as a thinking shorthand, not as a model.
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** Whether the id's last `:segment` is a Pi thinking level (`provider/id:high`); `…:free` and similar are real ids. */
export const hasThinkingSuffix = (id: string): boolean => id.includes(':') && THINKING_LEVELS.has(id.slice(id.lastIndexOf(':') + 1));

/** How a Pi model is paid for: Pi signs in to each provider itself, and Orca tracks none of those limits. */
export function piBilling(provider: string, model: string): { text: string; rank: number } {
  const { rank } = billingOf(provider, model);
  if (rank === 0) return { text: `runs on this machine (${provider}) through Pi`, rank };
  return { text: `through Pi's own ${provider} sign-in; Orca does not track its limits`, rank };
}

/**
 * Orca's Pi catalog ids are `provider/id` selectors. Each model is matched to Models.dev as OpenCode's are and
 * kept once: Pi can reach one model through several providers, so the cheapest way to run it wins (on this
 * machine, free, then paid), then the provider name. The other providers are returned to name in the note.
 * Pi's `off` thinking level has no OrcaCompass effort and is dropped; a model left with no efforts launches at
 * Pi's default.
 */
export function toPiModels(raw: RawModel[], deps: Pick<AgentDeps, 'index'>): { models: LaunchModel[]; alsoVia: Map<string, string[]> } {
  const byNorm = new Map<string, ModelMeta>();
  for (const m of Object.values(deps.index)) if (!byNorm.has(normalizeModelId(m.id))) byNorm.set(normalizeModelId(m.id), m);
  const best = new Map<string, { model: LaunchModel; rank: number; provider: string; others: string[] }>();
  for (const { id, efforts } of raw) {
    const slash = id.indexOf('/');
    if (slash <= 0 || slash === id.length - 1 || hasThinkingSuffix(id)) continue;
    const provider = id.slice(0, slash);
    const sub = id.slice(slash + 1);
    const billing = piBilling(provider, sub);
    const base = sub.replace(/[-:]free$/, '');
    const meta = deps.index[base] ?? byNorm.get(normalizeModelId(base));
    const model: LaunchModel = {
      agent: 'pi',
      modelId: meta?.id ?? base,
      ...(meta ? { meta } : {}),
      efforts: [...new Set(efforts.filter((e) => e !== 'off').map(parseEffort).filter((e): e is Effort => e !== undefined))],
      effortSource: 'orca',
      launch: { kind: 'flag', model: id },
      // No usage window: Pi's providers are signed in to through Pi, and Orca reports no usage for them.
      poolNames: [],
      billing: billing.text,
    };
    const cur = best.get(model.modelId);
    const better = !cur || billing.rank < cur.rank || (billing.rank === cur.rank && provider < cur.provider);
    if (!cur) best.set(model.modelId, { model, rank: billing.rank, provider, others: [] });
    else if (better) best.set(model.modelId, { model, rank: billing.rank, provider, others: [...cur.others, cur.provider] });
    else cur.others.push(provider);
  }
  const alsoVia = new Map<string, string[]>();
  for (const [modelId, b] of best) if (b.others.length > 0) alsoVia.set(modelId, [...b.others].sort());
  return { models: [...best.values()].map((b) => b.model), alsoVia };
}

export const locatePi = (deps: Locator): string | undefined => deps.find('pi');

/**
 * Pi has no model list OrcaCompass can use (`pi --list-models` skips the user's model filters and reports no
 * efforts), so its models come from Orca's own Pi catalog: an internal, undocumented file Orca writes when it
 * probes Pi. Whether Orca can start Pi on a chosen model is decided at route time (see orca-version.ts).
 */
export async function discoverPi(deps: AgentDeps): Promise<AgentDiscovery> {
  if (!locatePi(deps)) return { agent: 'pi', installed: false, models: [], note: 'pi not found on PATH' };
  const path = orcaCatalogPath(deps.env);
  const entry = newestOrcaCatalogEntry(deps.readFile(path), 'pi');
  if (!entry || entry.models.length === 0) return { agent: 'pi', installed: true, models: [], note: `no Pi models in Orca's catalog (${path})` };
  const { models, alsoVia } = toPiModels(entry.models, deps);
  const when = entry.at !== undefined ? `, configured ${new Date(entry.at).toISOString()}` : '';
  const via = [...alsoVia].map(([id, others]) => `${id} also via ${others.join(', ')}`);
  const note = `models from Orca's Pi catalog (${path}${when})${via.length ? `; kept once: ${via.join('; ')}` : ''}`;
  return { agent: 'pi', installed: true, models, note };
}
