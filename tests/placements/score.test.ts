import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildScale, combinedScore, matchRating, normalizeModelId } from '../../src/placements/score.js';
import type { RatedModel } from '../../src/types.js';
import { toRatings } from '../../src/placements/sources/modelindex.js';

const ratings = toRatings(JSON.parse(readFileSync(new URL('../fixtures/modelindex-mini.json', import.meta.url), 'utf8')));
const match = (id: string) => matchRating(id, ratings)?.id;
const rated = (id: string, score: number, out: number): RatedModel => ({ id, name: id, date: '2026-01-01', score, out });

describe('normalizeModelId', () => {
  it('lowercases, drops the provider and unifies separators', () => {
    expect(normalizeModelId('anthropic/claude-opus-5.5')).toBe('claude-opus-5-5');
    expect(normalizeModelId('Kimi_K2.7 Code')).toBe('kimi-k2-7-code');
    expect(normalizeModelId('gpt--6..1-sol')).toBe('gpt-6-1-sol');
  });
});

describe('matchRating', () => {
  it('matches Cursor and Models.dev spellings to index entries', () => {
    expect(match('muse-wonder-1.0')).toBe('muse-wonder');
    expect(match('muse-spark-1.3')).toBe('muse-spark-1-3');
    expect(match('deepseek-v4.1-flash-1017')).toBe('deepseek-v4-1-flash-1017');
    expect(match('kimi-k3')).toBe('kimi-k3');
    expect(match('kimi-k2.7-code')).toBe('kimi-k2-7-code');
    expect(match('glm-5.2')).toBe('glm-5-2');
    expect(match('grok-4.6')).toBe('grok-4-6');
    expect(match('grok-4.7')).toBe('grok-4-7');
    expect(match('gemini-3.1-pro')).toBe('gemini-3-1-pro');
    expect(match('gemini-4-argon')).toBe('gemini-4-argon');
    expect(match('gpt-6.1-sol')).toBe('gpt-6-1-sol');
  });

  it('matches the OpenRouter id, with or without -preview', () => {
    expect(match('google/gemini-3.1-pro-preview')).toBe('gemini-3-1-pro');
    expect(match('gemini-3-flash-preview')).toBe('gemini-3-flash');
  });

  it("matches Cursor's dashless version spelling", () => {
    expect(match('deepseek-v41-flash-1017')).toBe('deepseek-v4-1-flash-1017');
    expect(match('deepseek-v41-flash')).toBe('deepseek-v4-1-flash');
  });

  it('strips only a trailing 1.0 / .0 version, never other numbers', () => {
    expect(match('grok-4-8')).toBeUndefined();
    expect(match('grok-4.8')).toBeUndefined();
    expect(match('grok-4.0')).toBe('grok-4');
    expect(match('grok-4.6.0')).toBe('grok-4-6');
    // 5.2.1.0 is 5.2.1, a different model than 5.2.
    expect(match('glm-5.2.1.0')).toBeUndefined();
  });

  it('has no entry for Cursor-only models', () => {
    expect(match('auto')).toBeUndefined();
    expect(match('composer-2.5')).toBeUndefined();
  });
});

describe('buildScale', () => {
  const anchors = [
    { tier: 'light' as const, rating: rated('l', 160, 1) },
    { tier: 'daily' as const, rating: rated('d', 170, 10) },
    { tier: 'advanced' as const, rating: rated('a', 180, 20) },
    { tier: 'frontier' as const, rating: rated('f', 190, 50) },
  ];

  it('normalizes score and log price over the anchors', () => {
    const scale = buildScale(anchors, 0.5, [])!;
    expect(combinedScore(scale, anchors[0].rating)).toBeCloseTo(0);
    expect(combinedScore(scale, anchors[3].rating)).toBeCloseTo(1);
    expect(combinedScore(scale, rated('x', 175, Math.sqrt(50)))).toBeCloseTo(0.5 * 0.5 + 0.5 * 0.5);
  });

  it('puts each cut midway between neighboring tiers', () => {
    const scale = buildScale(anchors, 0.5, [])!;
    const c = anchors.map((a) => combinedScore(scale, a.rating));
    expect(scale.cuts).toHaveLength(3);
    for (let i = 0; i < 3; i++) expect(scale.cuts[i]).toBeCloseTo((c[i] + c[i + 1]) / 2);
  });

  it('is unavailable without an anchor per tier or without a score spread', () => {
    expect(buildScale(anchors.slice(1), 0.5, [])).toBeUndefined();
    const flat = anchors.map((a) => ({ ...a, rating: { ...a.rating, score: 170 } }));
    expect(buildScale(flat, 0.5, [])).toBeUndefined();
  });
});
