import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DataSource, RatedModel } from '../../types.js';
import { cacheDir } from '../../paths.js';

// The Model Index (themodelindex.org), CC BY 4.0: capability scores and OpenRouter prices.
export const MODEL_INDEX_URL = 'https://themodelindex.org/data/models.json';

export interface Ratings {
  ratings: RatedModel[];
  source: DataSource;
  fetchedAt: number;
}

interface Stored {
  fetchedAt: number;
  ratings: RatedModel[];
}

const FETCH_TIMEOUT_MS = 10_000;
// Same relative path from src/placements/sources/ (Vitest) and dist/placements/sources/ (built).
const SNAPSHOT_URL = new URL('../../../data/modelindex-snapshot.json', import.meta.url);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function toRating(raw: Record<string, unknown>): RatedModel | undefined {
  const id = str(raw.id);
  const score = isObject(raw.index) ? finite(raw.index.score) : undefined;
  const api = isObject(raw.api) ? raw.api : {};
  const out = finite(api.out);
  if (!id || score === undefined || out === undefined || out <= 0) return undefined;
  const r: RatedModel = { id, name: str(raw.name) ?? id, date: str(raw.date) ?? '', score, out };
  const orId = str(api.or_id);
  if (orId) r.orId = orId;
  const hf = str(api.hf);
  if (hf) r.hf = hf;
  if (typeof raw.open === 'boolean') r.open = raw.open;
  return r;
}

/** Trims a Model Index models.json payload to scored entries with a positive output price. */
export function toRatings(raw: unknown): RatedModel[] {
  if (!isObject(raw) || !Array.isArray(raw.models)) return [];
  return raw.models.flatMap((m) => (isObject(m) ? (toRating(m) ?? []) : []));
}

/** Fetches and trims the Model Index; throws on network/HTTP errors or an empty result. */
export async function fetchRatings(fetchImpl: typeof fetch = fetch): Promise<RatedModel[]> {
  const res = await fetchImpl(MODEL_INDEX_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`themodelindex.org: HTTP ${res.status}`);
  const ratings = toRatings(await res.json());
  if (ratings.length === 0) throw new Error('themodelindex.org: no rated models');
  return ratings;
}

async function readStored(path: string | URL): Promise<Stored | undefined> {
  try {
    const data: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (isObject(data) && typeof data.fetchedAt === 'number' && Array.isArray(data.ratings)) {
      return { fetchedAt: data.fetchedAt, ratings: data.ratings as RatedModel[] };
    }
  } catch {
    // missing or unreadable: treated as absent
  }
  return undefined;
}

/** Fresh cache → network (then cache it) → stale cache → bundled snapshot; undefined when all fail. */
export async function loadRatings(opts: {
  ttlHours: number;
  now?: number;
  fetchImpl?: typeof fetch;
  refresh?: boolean;
}): Promise<Ratings | undefined> {
  const now = opts.now ?? Date.now();
  const cacheFile = join(cacheDir(), 'modelindex.json');
  const cached = await readStored(cacheFile);
  if (cached && !opts.refresh && now - cached.fetchedAt < opts.ttlHours * 3_600_000) {
    return { ...cached, source: 'cache' };
  }

  try {
    const ratings = await fetchRatings(opts.fetchImpl);
    try {
      await mkdir(cacheDir(), { recursive: true });
      await writeFile(cacheFile, JSON.stringify({ fetchedAt: now, ratings } satisfies Stored));
    } catch {
      // an unwritable cache only costs a refetch next time
    }
    return { ratings, source: 'network', fetchedAt: now };
  } catch {
    if (cached) return { ...cached, source: 'cache' };
  }

  // No scores only disables score placement; routing by the family table still works.
  const snapshot = await readStored(SNAPSHOT_URL);
  return snapshot && { ...snapshot, source: 'snapshot' };
}
