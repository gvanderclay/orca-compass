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

/** The catalog sits in Orca's userData folder; a Windows machine without APPDATA gets the usual location. */
export function orcaCatalogPath(env: NodeJS.ProcessEnv): string {
  const home = homeDir(env);
  return join(orcaUserDataPath(env, process.platform, home) ?? join(home, 'AppData', 'Roaming', 'orca'), 'agent-model-catalog.json');
}
