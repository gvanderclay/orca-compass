import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findAnchors } from '../../../src/placements/tiers.js';
import { loadRatings, MODEL_INDEX_URL, toRatings } from '../../../src/placements/sources/modelindex.js';
import { cacheDir } from '../../../src/paths.js';

const mini = JSON.parse(readFileSync(new URL('../../fixtures/modelindex-mini.json', import.meta.url), 'utf8'));
const ok = async () => new Response(JSON.stringify(mini));
const offline = async (): Promise<Response> => {
  throw new Error('offline');
};
const HOUR = 3_600_000;

const saved = process.env.ORCACOMPASS_HOME;
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orcacompass-modelindex-'));
  process.env.ORCACOMPASS_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.ORCACOMPASS_HOME;
  else process.env.ORCACOMPASS_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

describe('toRatings', () => {
  it('keeps scored, priced entries trimmed to the fields we use', () => {
    const ratings = toRatings(mini);
    expect(ratings.find((r) => r.id === 'glm-5-2')).toEqual({
      id: 'glm-5-2', name: 'GLM-5.2', date: '2026-06-16', score: 156.4, out: 7, orId: 'z-ai/glm-5.2', hf: 'zai-org/GLM-5.2', open: true,
    });
    expect(ratings.find((r) => r.id === 'muse-wonder')).toEqual({
      id: 'muse-wonder', name: 'Muse Wonder', date: '2026-10-12', score: 180.3, out: 20, orId: 'meta/muse-wonder', open: false,
    });
  });

  it('drops entries without a score or a positive price, and tolerates garbage', () => {
    const ids = toRatings(mini).map((r) => r.id);
    expect(ids).not.toContain('chatgpt');
    expect(ids).not.toContain('unscored');
    expect(ids).not.toContain('free-model');
    expect(toRatings(null)).toEqual([]);
    expect(toRatings({ models: 'nope' })).toEqual([]);
    expect(toRatings({ models: [null, 3, { id: 'x', index: { score: '1' }, api: { out: 1 } }] })).toEqual([]);
  });
});

describe('loadRatings', () => {
  it('fetches the Model Index with a timeout, then serves a stale cache when offline', async () => {
    const now = Date.now();
    const spy = vi.fn(ok);
    const net = await loadRatings({ ttlHours: 24, now, fetchImpl: spy });
    expect(net).toMatchObject({ source: 'network', fetchedAt: now });
    expect(spy.mock.calls[0][0]).toBe(MODEL_INDEX_URL);
    expect(((spy.mock.calls[0] as unknown[])[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);

    const stale = await loadRatings({ ttlHours: 24, now: now + 48 * HOUR, fetchImpl: offline });
    expect(stale).toMatchObject({ source: 'cache', fetchedAt: now });
    expect(stale!.ratings.find((r) => r.id === 'kimi-k3')).toBeDefined();
  });

  it('writes {fetchedAt, ratings} to <cacheDir>/modelindex.json', async () => {
    await loadRatings({ ttlHours: 24, now: 123, fetchImpl: ok });
    const cached = JSON.parse(readFileSync(join(cacheDir(), 'modelindex.json'), 'utf8'));
    expect(cached.fetchedAt).toBe(123);
    expect(cached.ratings.find((r: { id: string }) => r.id === 'grok-4-6').score).toBe(169.7);
  });

  it('uses a fresh cache without fetching, unless refresh is set', async () => {
    const now = Date.now();
    await loadRatings({ ttlHours: 24, now, fetchImpl: ok });
    const spy = vi.fn(ok);
    expect((await loadRatings({ ttlHours: 24, now: now + HOUR, fetchImpl: spy }))?.source).toBe('cache');
    expect(spy).not.toHaveBeenCalled();
    expect((await loadRatings({ ttlHours: 24, now: now + HOUR, fetchImpl: spy, refresh: true }))?.source).toBe('network');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('falls back to the bundled snapshot on HTTP errors, empty data or a malformed cache', async () => {
    expect((await loadRatings({ ttlHours: 24, fetchImpl: offline }))?.source).toBe('snapshot');
    expect((await loadRatings({ ttlHours: 24, fetchImpl: async () => new Response('boom', { status: 500 }) }))?.source).toBe('snapshot');
    expect((await loadRatings({ ttlHours: 24, fetchImpl: async () => new Response('{"models":[]}') }))?.source).toBe('snapshot');
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(join(cacheDir(), 'modelindex.json'), '{not json');
    expect((await loadRatings({ ttlHours: 24, fetchImpl: offline }))?.source).toBe('snapshot');
  });
});

describe('bundled snapshot', () => {
  it('has an anchor for every tier', async () => {
    const r = await loadRatings({ ttlHours: 24, fetchImpl: offline });
    const tiers = new Set(findAnchors(r!.ratings).map((a) => a.tier));
    expect([...tiers].sort()).toEqual(['advanced', 'daily', 'frontier', 'light']);
  });
});
