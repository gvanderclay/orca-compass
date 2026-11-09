import { join } from 'node:path';
import { homeDir } from '../../paths.js';
import { orcaUserDataPath } from '../../routing/orca-settings.js';

export interface RawModel {
  id: string;
  efforts: string[];
  defaultEffort?: string;
  /** The provider's one-line description of the model's place in its lineup. */
  description?: string;
}

export const description = (v: unknown): { description: string } | Record<string, never> =>
  typeof v === 'string' && v.trim() !== '' ? { description: v.trim() } : {};

export const parseJson = (text: string | undefined): any => {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Orca's internal (undocumented) catalog; the agent's last entry is the newest probe. */
export function fromOrcaCatalog(text: string | undefined, agent: string): RawModel[] {
  const entries = parseJson(text)?.entries;
  if (!Array.isArray(entries)) return [];
  const models = entries.filter((e) => e?.agent === agent).at(-1)?.discovered?.models;
  if (!Array.isArray(models)) return [];
  return models
    .filter((m) => typeof m?.id === 'string')
    .map((m) => ({
      id: typeof m.resolvedModel === 'string' ? m.resolvedModel : m.id,
      efforts: (m.efforts ?? []).map((e: { value?: unknown }) => String(e?.value)),
      ...description(m.description),
    }));
}

/**
 * The agent's newest catalog entry, by the time Orca configured it (`configured.at`, else `discovered.at`); among
 * entries without either, or with equal times, the later one in the file. Orca keeps one entry per agent
 * configuration (fingerprint), so an agent such as Pi can have several.
 */
export function newestOrcaCatalogEntry(text: string | undefined, agent: string): { models: RawModel[]; at?: number } | undefined {
  const entries = parseJson(text)?.entries;
  if (!Array.isArray(entries)) return undefined;
  const time = (e: any): number | undefined => {
    const at = e?.configured?.at ?? e?.discovered?.at;
    return typeof at === 'number' && Number.isFinite(at) ? at : undefined;
  };
  let newest: any;
  for (const e of entries) {
    if (e?.agent !== agent || !Array.isArray(e?.discovered?.models)) continue;
    if (newest === undefined || (time(e) ?? -Infinity) >= (time(newest) ?? -Infinity)) newest = e;
  }
  if (newest === undefined) return undefined;
  const at = time(newest);
  return { models: toRawModels(newest.discovered.models), ...(at !== undefined ? { at } : {}) };
}

function toRawModels(models: any[]): RawModel[] {
  return models
    .filter((m) => typeof m?.id === 'string')
    .map((m) => ({
      id: typeof m.resolvedModel === 'string' ? m.resolvedModel : m.id,
      efforts: (Array.isArray(m.efforts) ? m.efforts : []).map((e: { value?: unknown }) => String(e?.value)),
      ...description(m.description),
    }));
}

/** The catalog sits in Orca's userData folder; a Windows machine without APPDATA gets the usual location. */
export function orcaCatalogPath(env: NodeJS.ProcessEnv): string {
  const home = homeDir(env);
  return join(orcaUserDataPath(env, process.platform, home) ?? join(home, 'AppData', 'Roaming', 'orca'), 'agent-model-catalog.json');
}
