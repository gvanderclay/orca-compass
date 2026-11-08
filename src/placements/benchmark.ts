import { compact, normalizeModelId, stripVersion } from './score.js';
import type { Benchmark, Tier } from '../types.js';
import { TIERS } from '../types.js';

// Benchmark placement: a model's Artificial Analysis capability relative to the best model measured,
// nudged by its intelligence per token cost, and cut into tiers at fixed fractions of the top.

/** BENCHMARK_CUTS[i] separates TIERS[i] from TIERS[i + 1], as a fraction of the top capability. */
export const BENCHMARK_CUTS: readonly number[] = [0.55, 0.78, 0.93];
/** Placement shift per tenfold difference from the median points per dollar: dear models up, cheap ones down. */
export const VALUE_WEIGHT = 0.05;

export interface BenchmarkScale {
  /** The highest capability measured, the 1.0 of the scale. */
  top: number;
  /** Median points per dollar over the priced models; undefined when none has a price. */
  medianValue: number | undefined;
  benchmarks: Benchmark[];
}

/** Intelligence and engineering index averaged, or intelligence alone. */
export const capability = (b: Benchmark): number => (b.engineering === undefined ? b.intelligence : (b.intelligence + b.engineering) / 2);

/** USD per million tokens blended 3:1 input to output, Artificial Analysis's own convention. */
export function blendedPrice(b: Benchmark): number | undefined {
  return b.in !== undefined && b.out !== undefined ? (3 * b.in + b.out) / 4 : undefined;
}

/** Capability points per blended dollar: intelligence per token cost. */
export function pointsPerDollar(b: Benchmark): number | undefined {
  const price = blendedPrice(b);
  return price === undefined ? undefined : capability(b) / price;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function benchmarkScale(benchmarks: Benchmark[]): BenchmarkScale | undefined {
  if (benchmarks.length === 0) return undefined;
  const values = benchmarks.map(pointsPerDollar).filter((v): v is number => v !== undefined);
  return { top: Math.max(...benchmarks.map(capability)), medianValue: median(values), benchmarks };
}

const EFFORT_SUFFIX = /-(none|minimal|low|medium|high|xhigh|max|non-reasoning|thinking)$/;
const DATE_SUFFIX = /-\d{8}$/;

function lookup(id: string, benchmarks: Benchmark[]): Benchmark | undefined {
  return (
    benchmarks.find((b) => b.slugs.some((s) => normalizeModelId(s) === id)) ??
    benchmarks.find((b) => b.slugs.some((s) => compact(normalizeModelId(s)) === compact(id)))
  );
}

/** The benchmark of a routed model id: the effort variant's slug counts as the model's. */
export function matchBenchmark(modelId: string, benchmarks: Benchmark[]): Benchmark | undefined {
  const id = normalizeModelId(modelId);
  const candidates = [id, id.replace(DATE_SUFFIX, ''), id.replace(EFFORT_SUFFIX, ''), stripVersion(id)];
  for (const c of new Set(candidates)) {
    const hit = lookup(c, benchmarks);
    if (hit) return hit;
  }
  return undefined;
}

/** capability / top + VALUE_WEIGHT × log10(median value / value); no value term without a price. */
export function placement(scale: BenchmarkScale, b: Benchmark): number {
  const relative = capability(b) / scale.top;
  const value = pointsPerDollar(b);
  if (value === undefined || scale.medianValue === undefined) return relative;
  return relative + VALUE_WEIGHT * Math.log10(scale.medianValue / value);
}

const fixed = (n: number, digits = 2): string => n.toFixed(digits);

/** The tier a placement lands in, with the numbers behind it in one line. */
export function benchmarkTier(scale: BenchmarkScale, b: Benchmark): { tier: Tier; placement: number; detail: string } {
  const p = placement(scale, b);
  const tier = TIERS[BENCHMARK_CUTS.filter((cut) => cut <= p).length];
  const indices = b.engineering === undefined ? `${b.intelligence}` : `${b.intelligence}/${b.engineering}`;
  const value = pointsPerDollar(b);
  const priced = value === undefined || scale.medianValue === undefined
    ? 'no price'
    : `${fixed(value, 1)} points per dollar vs median ${fixed(scale.medianValue, 1)}`;
  const detail = `benchmarks (Artificial Analysis ${indices} = ${fixed(capability(b) / scale.top)} of top, ${priced} → ${fixed(p)}; cuts ${BENCHMARK_CUTS.map((c) => fixed(c)).join('/')})`;
  return { tier, placement: p, detail };
}
