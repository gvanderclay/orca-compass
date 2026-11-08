import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentDeps } from './deps.js';

/** Output of a listing command that asks the user to sign in, e.g. "Please run grok login". */
const SIGNED_OUT = /not (logged|signed) in|(log|sign) ?in (is )?required|please (log|sign) ?in|run [\w-]+ login|\blogin\b.*\bfirst\b|unauthori[sz]ed|unauthenticated/i;

/** Only provider observations are persisted; normalization and routing stay live. */
export interface ListedModel {
  id: string;
  label?: string;
}

type ListingAgent = 'cursor' | 'grok' | 'antigravity' | 'opencode';
interface SavedListing { fetchedAt: number; models: ListedModel[] }

function readSaved(deps: AgentDeps, agent: ListingAgent): SavedListing | undefined {
  try {
    const saved = JSON.parse(deps.readFile(join(deps.cacheDir, `${agent}-models.json`)) ?? 'null');
    if (!saved || saved.schemaVersion !== 1 || saved.agent !== agent ||
        !Number.isSafeInteger(saved.fetchedAt) || saved.fetchedAt < 0 ||
        !Array.isArray(saved.models) || saved.models.length === 0 ||
        !saved.models.every((m: unknown) => {
          if (!m || typeof m !== 'object') return false;
          const entry = m as Record<string, unknown>;
          return typeof entry.id === 'string' && /^\S+$/.test(entry.id) &&
            (entry.label === undefined || typeof entry.label === 'string');
        })) return undefined;
    return { fetchedAt: saved.fetchedAt, models: saved.models.map((m: ListedModel) => ({
      id: m.id, ...(m.label !== undefined ? { label: m.label } : {}),
    })) };
  } catch {
    return undefined;
  }
}

function save(deps: AgentDeps, agent: ListingAgent, models: ListedModel[], fetchedAt = deps.now): void {
  const file = join(deps.cacheDir, `${agent}-models.json`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    mkdirSync(deps.cacheDir, { recursive: true });
    writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, agent, fetchedAt, models }, null, 2) + '\n');
    renameSync(temporary, file);
  } catch {
    // The saved copy is only a fallback for a failed listing.
  } finally {
    try { unlinkSync(temporary); } catch { /* renamed or unavailable */ }
  }
}

const firstLine = (s: string | undefined): string | undefined =>
  s?.split(/\r?\n/).map((l) => l.trim()).find(Boolean);

export type Listing<T> =
  /** `savedAt` is set when the command failed and the last good listing was used instead. */
  | { items: T[]; savedAt?: number; error?: string }
  | { items?: undefined; error: string; signedOut: boolean };

/**
 * Runs an agent's model-listing command on every call, so the route sees what the provider offers now.
 * A good listing is saved; when the command fails for any reason but a sign-in prompt, the saved listing
 * is used instead, with its age. A sign-in prompt is reported as `signedOut` and never falls back.
 */
export async function listModels(
  deps: AgentDeps,
  exe: string,
  args: string[],
  agent: ListingAgent,
  parse: (stdout: string) => ListedModel[],
  env?: NodeJS.ProcessEnv,
): Promise<Listing<ListedModel>> {
  const r = await deps.run(exe, args, { timeoutMs: 30_000, env });
  const items = r.code === 0 ? parse(r.stdout) : [];
  if (items.length > 0) {
    save(deps, agent, items);
    return { items };
  }
  const error = firstLine(r.stderr) ?? r.error ?? firstLine(r.stdout) ?? `exit code ${r.code}`;
  if (SIGNED_OUT.test(`${r.stdout}\n${r.stderr}`)) return { error, signedOut: true };
  const saved = readSaved(deps, agent);
  if (saved) return { items: saved.models, savedAt: saved.fetchedAt, error };
  // Migrate old stdout caches only when needed, retaining the original observation time.
  const legacy = deps.readFile(join(deps.cacheDir, `${agent}-models.txt`));
  const header = legacy && /^fetchedAt (\d+)\r?\n/.exec(legacy);
  if (legacy && header && Number.isSafeInteger(Number(header[1]))) {
    const models = parse(legacy.slice(header[0].length));
    if (models.length > 0) {
      const fetchedAt = Number(header[1]);
      save(deps, agent, models, fetchedAt);
      return { items: models, savedAt: fetchedAt, error };
    }
  }
  return { error, signedOut: false };
}

/** The discovery note for a listing that fell back to its saved copy, e.g. "agy models failed (timed out); using the list from 3h ago". */
export function savedNote(command: string, listing: { savedAt?: number; error?: string }, now: number): string | undefined {
  if (listing.savedAt === undefined) return undefined;
  const hours = Math.floor((now - listing.savedAt) / 3_600_000);
  const age = hours >= 48 ? `${Math.floor(hours / 24)}d` : hours >= 1 ? `${hours}h` : `${Math.max(0, Math.floor((now - listing.savedAt) / 60_000))}m`;
  return `${command} failed (${listing.error}); using the list from ${age} ago`;
}
