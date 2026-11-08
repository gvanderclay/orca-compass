import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AA_URL, fetchBenchmarks, loadBenchmarks, toBenchmarks } from '../../../src/placements/sources/artificialanalysis.js';
import { cacheDir } from '../../../src/paths.js';

// Invented numbers in the API's shape (see the fixture): never real Artificial Analysis data points.
const page = JSON.parse(readFileSync(new URL('../../fixtures/artificialanalysis-mini.json', import.meta.url), 'utf8'));
const HOUR = 3_600_000;

const saved = process.env.ORCACOMPASS_HOME;
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orcacompass-aa-'));
  process.env.ORCACOMPASS_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.ORCACOMPASS_HOME;
  else process.env.ORCACOMPASS_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

describe('toBenchmarks', () => {
  const benchmarks = toBenchmarks([page]);

  it('keeps one entry per model at its strongest effort, with every variant slug', () => {
    expect(benchmarks.find((b) => b.slug === 'claude-opus-5-5')).toEqual({
      slug: 'claude-opus-5-5', slugs: ['claude-opus-5-5', 'claude-opus-5-5-high'], name: 'Claude Opus 5.5', creator: 'Anthropic',
      date: '2026-09-22', intelligence: 58, engineering: 64, costPerTask: 9.8, in: 4, out: 20, tokensPerSecond: 95,
    });
    expect(benchmarks.filter((b) => b.name === 'GPT-6.1 Terra')).toHaveLength(1);
    expect(benchmarks.find((b) => b.name === 'GPT-6.1 Terra')?.slugs).toEqual(['gpt-6-1-terra', 'gpt-6-1-terra-non-reasoning']);
    // "Muse Wonder Full" is its own model, not a variant of "Muse Wonder".
    expect(benchmarks.find((b) => b.slug === 'muse-wonder-full')).toMatchObject({ name: 'Muse Wonder Full', intelligence: 50 });
    expect(benchmarks.find((b) => b.slug === 'muse-wonder-full')).not.toHaveProperty('in');
  });

  it('drops models without an intelligence index and tolerates garbage', () => {
    const slugs = benchmarks.map((b) => b.slug);
    expect(slugs).not.toContain('claude-opus-5');
    expect(slugs).not.toContain('gpt-5-3-codex');
    expect(toBenchmarks([null, 3, { data: 'nope' }, { data: [null, { slug: 'x' }, { slug: 'y', name: 'Y', evaluations: { artificial_analysis_intelligence_index: '5' } }] }])).toEqual([]);
    expect(toBenchmarks([page.data])).toHaveLength(benchmarks.length);
  });
});

describe('fetchBenchmarks', () => {
  it('sends the key in x-api-key and follows the pages', async () => {
    const calls: { url: string; key: string | null }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), key: new Headers(init?.headers).get('x-api-key') });
      const n = Number(new URL(String(url)).searchParams.get('page') ?? '1');
      const body = { ...page, pagination: { page: n, page_size: 200, total_pages: 2, has_more: n < 2 }, data: n === 1 ? page.data.slice(0, 5) : page.data.slice(5) };
      return new Response(JSON.stringify(body));
    });
    const benchmarks = await fetchBenchmarks('aa_test', fetchImpl as typeof fetch);
    expect(calls).toEqual([{ url: `${AA_URL}?page=1`, key: 'aa_test' }, { url: `${AA_URL}?page=2`, key: 'aa_test' }]);
    expect(benchmarks).toHaveLength(toBenchmarks([page]).length);
  });

  it('throws on HTTP errors and on an empty result', async () => {
    const denied = async () => new Response('nope', { status: 401 });
    await expect(fetchBenchmarks('aa_test', denied as typeof fetch)).rejects.toThrow('artificialanalysis.ai: HTTP 401');
    const empty = async () => new Response(JSON.stringify({ pagination: { has_more: false }, data: [] }));
    await expect(fetchBenchmarks('aa_test', empty as typeof fetch)).rejects.toThrow('artificialanalysis.ai: no benchmarked models');
  });
});

describe('loadBenchmarks', () => {
  const ok = vi.fn(async () => new Response(JSON.stringify({ ...page, pagination: { page: 1, page_size: 200, total_pages: 1, has_more: false } })));
  const offline = async (): Promise<Response> => {
    throw new Error('offline');
  };
  const cacheFile = () => join(cacheDir(), 'artificialanalysis.json');
  const seed = (fetchedAt: number) => {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(cacheFile(), JSON.stringify({ fetchedAt, benchmarks: toBenchmarks([page]).slice(0, 3) }));
  };

  it('is unavailable without a key and without a cache: nothing is bundled', async () => {
    expect(await loadBenchmarks({ ttlHours: 24, now: 1000, fetchImpl: ok as typeof fetch })).toBeUndefined();
    expect(ok).not.toHaveBeenCalled();
  });

  it('fetches with the key and caches the trimmed result', async () => {
    const r = await loadBenchmarks({ ttlHours: 24, now: 5000, fetchImpl: ok as typeof fetch, key: 'aa_test' });
    expect(r).toMatchObject({ source: 'network', fetchedAt: 5000 });
    expect(r?.benchmarks.length).toBeGreaterThan(10);
    const stored = JSON.parse(readFileSync(cacheFile(), 'utf8'));
    expect(stored.fetchedAt).toBe(5000);
    expect(stored.benchmarks[0]).not.toHaveProperty('evaluations');
  });

  it('serves a fresh cache without the network, even without a key', async () => {
    seed(5000);
    const fetchImpl = vi.fn(ok);
    expect(await loadBenchmarks({ ttlHours: 24, now: 5000 + HOUR, fetchImpl: fetchImpl as typeof fetch })).toMatchObject({ source: 'cache', fetchedAt: 5000 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls back to a stale cache when the network fails or there is no key', async () => {
    seed(5000);
    expect(await loadBenchmarks({ ttlHours: 24, now: 5000 + 30 * HOUR, fetchImpl: offline, key: 'aa_test' })).toMatchObject({ source: 'cache', fetchedAt: 5000 });
    expect(await loadBenchmarks({ ttlHours: 24, now: 5000 + 30 * HOUR, fetchImpl: offline })).toMatchObject({ source: 'cache', fetchedAt: 5000 });
  });

  it('refresh fetches even when the cache is fresh', async () => {
    seed(5000);
    const fetchImpl = vi.fn(ok);
    expect(await loadBenchmarks({ ttlHours: 24, now: 5000 + HOUR, fetchImpl: fetchImpl as typeof fetch, key: 'aa_test', refresh: true })).toMatchObject({ source: 'network' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
