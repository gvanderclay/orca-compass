import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_CUTS, benchmarkScale, benchmarkTier, blendedPrice, capability, matchBenchmark, placement, pointsPerDollar,
} from '../../src/placements/benchmark.js';
import type { Benchmark } from '../../src/types.js';
import { toBenchmarks } from '../../src/placements/sources/artificialanalysis.js';

// Invented numbers in the API's shape; the top model is Gemini 4 Carbon at capability 62.
const benchmarks = toBenchmarks([JSON.parse(readFileSync(new URL('../fixtures/artificialanalysis-mini.json', import.meta.url), 'utf8'))]);
const scale = benchmarkScale(benchmarks)!;
const by = (slug: string): Benchmark => benchmarks.find((b) => b.slug === slug)!;
const tierOf = (slug: string) => benchmarkTier(scale, by(slug)).tier;

describe('capability, price and value', () => {
  it('averages intelligence and engineering, or uses intelligence alone', () => {
    expect(capability(by('claude-opus-5-5'))).toBe(61);
    expect(capability({ ...by('claude-opus-5-5'), engineering: undefined })).toBe(58);
  });

  it('blends token prices 3:1 input to output and divides capability by it', () => {
    expect(blendedPrice(by('claude-opus-5-5'))).toBe(8);
    expect(blendedPrice(by('muse-wonder-full'))).toBeUndefined();
    expect(pointsPerDollar(by('claude-opus-5-5'))).toBeCloseTo(7.625, 3);
    expect(pointsPerDollar(by('claude-haiku-5-5'))).toBe(195);
    expect(pointsPerDollar(by('muse-wonder-full'))).toBeUndefined();
  });
});

describe('benchmarkScale', () => {
  it('takes the top capability and the median value over the priced models', () => {
    expect(scale.top).toBe(62);
    expect(scale.medianValue).toBeCloseTo(13.417, 2);
    expect(benchmarkScale([])).toBeUndefined();
    expect(benchmarkScale([by('muse-wonder-full')])?.medianValue).toBeUndefined();
  });
});

describe('matchBenchmark', () => {
  const slugOf = (id: string) => matchBenchmark(id, benchmarks)?.slug;

  it('matches ids with dots, provider prefixes, date, effort and variant suffixes', () => {
    expect(slugOf('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(slugOf('anthropic/claude-opus-5.5')).toBe('claude-opus-5-5');
    expect(slugOf('claude-haiku-5-5-20261007')).toBe('claude-haiku-5-5');
    expect(slugOf('gpt-6.1-sol')).toBe('gpt-6-1-sol');
    expect(slugOf('gpt-5.3-codex-high')).toBeUndefined();
    expect(slugOf('gemini-3.8-flash-high')).toBe('gemini-3-8-flash');
    expect(slugOf('claude-fable-5-1-xhigh')).toBe('claude-fable-5-1');
    expect(slugOf('gpt-6.1-terra-non-reasoning')).toBe('gpt-6-1-terra');
    expect(slugOf('grok-4.7')).toBe('grok-4-7');
    expect(slugOf('deepseek-v41-flash-1017')).toBe('deepseek-v4-1-flash-1017');
    expect(slugOf('muse-wonder-1.0')).toBe('muse-wonder');
    expect(slugOf('muse-wonder-full')).toBe('muse-wonder-full');
    expect(slugOf('auto')).toBeUndefined();
    expect(slugOf('claude-opus-5')).toBeUndefined();
  });
});

describe('benchmarkTier', () => {
  it('cuts the placement at 0.55, 0.78 and 0.93 of the top', () => {
    expect(BENCHMARK_CUTS).toEqual([0.55, 0.78, 0.93]);
    expect(tierOf('gemini-4-carbon')).toBe('frontier');
    expect(tierOf('claude-opus-5-5')).toBe('frontier');
    expect(tierOf('gpt-6-astra')).toBe('frontier');
    expect(tierOf('gpt-6-1-sol')).toBe('advanced');
    expect(tierOf('claude-sonnet-5-5')).toBe('advanced');
    expect(tierOf('claude-fable-5-1')).toBe('advanced');
    expect(tierOf('gpt-6-1-terra')).toBe('advanced');
    expect(tierOf('gemini-4-argon')).toBe('advanced');
    expect(tierOf('muse-wonder-full')).toBe('advanced');
    expect(tierOf('claude-haiku-5-5')).toBe('daily');
    expect(tierOf('grok-4-7')).toBe('daily');
    expect(tierOf('gemini-3-8-flash')).toBe('light');
    expect(tierOf('gpt-6-luna')).toBe('light');
    expect(tierOf('gemini-3-5-flash-lite')).toBe('light');
  });

  it('shifts the placement by 0.05 per tenfold difference from the median points per dollar', () => {
    const base = { ...by('kimi-k3-1-pro'), intelligence: 48, engineering: 48 };
    expect(placement(scale, { ...base, in: undefined, out: undefined })).toBeCloseTo(48 / 62, 4);
    const cheap = { ...base, in: 0.1, out: 0.5 };
    const dear = { ...base, in: 40, out: 200 };
    expect(placement(scale, cheap)).toBeCloseTo(48 / 62 + 0.05 * Math.log10(scale.medianValue! / 240), 4);
    expect(benchmarkTier(scale, cheap).tier).toBe('daily');
    expect(benchmarkTier(scale, dear).tier).toBe('advanced');
  });

  it('explains the placement in one readable line', () => {
    expect(benchmarkTier(scale, by('claude-opus-5-5'))).toEqual({
      tier: 'frontier',
      placement: expect.closeTo(0.996, 2),
      detail: 'benchmarks (Artificial Analysis 58/64 = 0.98 of top, 7.6 points per dollar vs median 13.4 → 1.00; cuts 0.55/0.78/0.93)',
    });
    expect(benchmarkTier(scale, by('muse-wonder-full')).detail).toBe('benchmarks (Artificial Analysis 50/55 = 0.85 of top, no price → 0.85; cuts 0.55/0.78/0.93)');
    expect(benchmarkTier(scale, { ...by('claude-opus-5-5'), engineering: undefined }).detail).toMatch(/^benchmarks \(Artificial Analysis 58 = 0\.94 of top/);
  });
});
