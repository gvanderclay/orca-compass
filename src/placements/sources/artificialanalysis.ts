import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Benchmark, DataSource } from '../../types.js';
import { cacheDir } from '../../paths.js';

// Artificial Analysis Data API, free tier (artificialanalysis.ai). The data is licensed to the key's
// owner for internal use only, so it lives in the user's cache and is never bundled with the package.
export const AA_URL = 'https://artificialanalysis.ai/api/v2/language/models/free';
export const AA_KEY_ENV = 'ARTIFICIAL_ANALYSIS_API_KEY';

export interface Benchmarks {
  benchmarks: Benchmark[];
  source: DataSource;
  fetchedAt: number;
}

interface Stored {
  fetchedAt: number;
  benchmarks: Benchmark[];
}

const FETCH_TIMEOUT_MS = 15_000;
// The free tier lists about 700 models in 4 pages; the guard only stops a runaway has_more.
const MAX_PAGES = 10;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const positive = (v: unknown): number | undefined => {
  const n = finite(v);
  return n !== undefined && n > 0 ? n : undefined;
};

interface Row {
  slug: string;
  name: string;
  base: string;
  creator: string;
  date: string;
  intelligence?: number;
  engineering?: number;
  costPerTask?: number;
  in?: number;
  out?: number;
  tokensPerSecond?: number;
}

/** "Claude Opus 5.5 (Max, Default Fallback)" → "Claude Opus 5.5": the effort lives in the parenthesis. */
const baseName = (name: string): string => name.replace(/\s*\(.*$/, '').trim();

function toRow(raw: Record<string, unknown>): Row | undefined {
  const slug = str(raw.slug);
  const name = str(raw.name);
  if (!slug || !name) return undefined;
  const evals = isObject(raw.evaluations) ? raw.evaluations : {};
  const cost = isObject(raw.artificial_analysis_intelligence_index_cost) ? raw.artificial_analysis_intelligence_index_cost : {};
  const perTask = isObject(cost.cost_per_task) ? cost.cost_per_task : {};
  const pricing = isObject(raw.pricing) ? raw.pricing : {};
  const perf = isObject(raw.performance) ? raw.performance : {};
  const creator = isObject(raw.model_creator) ? str(raw.model_creator.name) : undefined;
  return {
    slug, name, base: baseName(name), creator: creator ?? '', date: str(raw.release_date) ?? '',
    intelligence: finite(evals.artificial_analysis_intelligence_index),
    engineering: finite(evals.artificial_analysis_engineering_index),
    costPerTask: positive(perTask.total_cost),
    in: positive(pricing.price_1m_input_tokens),
    out: positive(pricing.price_1m_output_tokens),
    tokensPerSecond: positive(perf.median_output_tokens_per_second),
  };
}

const rowCapability = (r: Row): number => (r.engineering === undefined ? r.intelligence! : (r.intelligence! + r.engineering) / 2);

/**
 * Trims API pages (or their `data` arrays) to one Benchmark per model: the effort variant with the highest
 * capability represents the model, and every variant's slug is kept for matching. Unscored models are dropped.
 */
export function toBenchmarks(pages: unknown[]): Benchmark[] {
  const groups = new Map<string, Row[]>();
  for (const page of pages) {
    const data = Array.isArray(page) ? page : isObject(page) && Array.isArray(page.data) ? page.data : [];
    for (const raw of data) {
      const row = isObject(raw) ? toRow(raw) : undefined;
      if (!row) continue;
      const key = `${row.creator}\u0000${row.base}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
  }
  const benchmarks: Benchmark[] = [];
  for (const rows of groups.values()) {
    const scored = rows.filter((r) => r.intelligence !== undefined);
    if (scored.length === 0) continue;
    const best = scored.sort((a, b) => rowCapability(b) - rowCapability(a))[0];
    const b: Benchmark = { slug: best.slug, slugs: rows.map((r) => r.slug), name: best.base, creator: best.creator, date: best.date, intelligence: best.intelligence! };
    if (best.engineering !== undefined) b.engineering = best.engineering;
    if (best.costPerTask !== undefined) b.costPerTask = best.costPerTask;
    if (best.in !== undefined) b.in = best.in;
    if (best.out !== undefined) b.out = best.out;
    if (best.tokensPerSecond !== undefined) b.tokensPerSecond = best.tokensPerSecond;
    benchmarks.push(b);
  }
  return benchmarks;
}

/** Fetches every page with the user's key and trims it; throws on HTTP errors or an empty result. */
export async function fetchBenchmarks(key: string, fetchImpl: typeof fetch = fetch): Promise<Benchmark[]> {
  const pages: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetchImpl(`${AA_URL}?page=${page}`, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`artificialanalysis.ai: HTTP ${res.status}`);
    const body: unknown = await res.json();
    pages.push(body);
    if (!(isObject(body) && isObject(body.pagination) && body.pagination.has_more === true)) break;
  }
  const benchmarks = toBenchmarks(pages);
  if (benchmarks.length === 0) throw new Error('artificialanalysis.ai: no benchmarked models');
  return benchmarks;
}

async function readStored(path: string): Promise<Stored | undefined> {
  try {
    const data: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (isObject(data) && typeof data.fetchedAt === 'number' && Array.isArray(data.benchmarks)) {
      return { fetchedAt: data.fetchedAt, benchmarks: data.benchmarks as Benchmark[] };
    }
  } catch {
    // missing or unreadable: treated as absent
  }
  return undefined;
}

/** Fresh cache → network with the key (then cache it) → stale cache; undefined without a key and a cache. */
export async function loadBenchmarks(opts: {
  ttlHours: number;
  now?: number;
  fetchImpl?: typeof fetch;
  refresh?: boolean;
  key?: string;
}): Promise<Benchmarks | undefined> {
  const now = opts.now ?? Date.now();
  const cacheFile = join(cacheDir(), 'artificialanalysis.json');
  const cached = await readStored(cacheFile);
  if (cached && !opts.refresh && now - cached.fetchedAt < opts.ttlHours * 3_600_000) {
    return { ...cached, source: 'cache' };
  }
  if (opts.key) {
    try {
      const benchmarks = await fetchBenchmarks(opts.key, opts.fetchImpl);
      try {
        await mkdir(cacheDir(), { recursive: true });
        await writeFile(cacheFile, JSON.stringify({ fetchedAt: now, benchmarks } satisfies Stored));
      } catch {
        // an unwritable cache only costs a refetch next time
      }
      return { benchmarks, source: 'network', fetchedAt: now };
    } catch {
      // fall through to the stale cache
    }
  }
  return cached && { ...cached, source: 'cache' };
}
