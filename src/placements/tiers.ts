import { benchmarkTier, matchBenchmark, type BenchmarkScale } from './benchmark.js';
import { buildScale, combinedScore, matchRating, normalizeModelId, scoreTier, type Anchor, type ScoreScale } from './score.js';
import type { Classification, Config, LaunchModel, ModelMeta, RatedModel, Tier } from '../types.js';
import { TIERS } from '../types.js';

// Families are stable across releases, so new versions get a tier automatically.
export const FAMILY_TIERS: Record<string, Tier> = {
  'claude-haiku': 'light',
  'claude-sonnet': 'daily',
  'claude-opus': 'advanced',
  'claude-fable': 'frontier',
  'gpt-luna': 'light',
  'gpt-terra': 'daily',
  'gpt-sol': 'advanced',
  'gpt-astra': 'frontier',
  'gemini-flash-lite': 'light',
};

/** Model lines matched by id, where the family is too broad: Models.dev files Gemini Argon under `gemini` and every Grok under `grok`. */
export const MODEL_LINE_TIERS: readonly { pattern: RegExp; tier: Tier }[] = [
  { pattern: /^gemini(-\d+)+-argon(-|$)/, tier: 'frontier' },
  // Grok 4.7 to 4.9 and 5+; older releases (4.20 is from early 2026) and Grok Build stay on the score.
  { pattern: /^grok-(4-[7-9]|[5-9]|\d{2,})(-\d+)*$/, tier: 'advanced' },
];

export type { Classification } from '../types.js';

/** Scales the placements draw on: The Model Index (score) and Artificial Analysis (benchmark); either may be missing. */
export interface Scales {
  score?: ScoreScale;
  benchmark?: BenchmarkScale;
}

/** Model Index ids of a table family: claude-opus-5-5 for claude-opus, gpt-6-1-sol for gpt-sol. */
function familyPattern(family: string): RegExp | undefined {
  const m = /^(claude|gpt)-([a-z]+)$/.exec(family);
  if (!m) return undefined;
  return m[1] === 'claude' ? new RegExp(`^claude-${m[2]}(-\\d+)+$`) : new RegExp(`^gpt(-\\d+)+-${m[2]}$`);
}

/** Claude and GPT families: the ladder's own vendors, preferred over other vendors when usage ties. */
export function isLadderVendor(family: string | undefined): boolean {
  return family !== undefined && familyPattern(family) !== undefined;
}

/** The newest Model Index entry of each Claude/GPT table family, with the family's tier. */
export function findAnchors(ratings: RatedModel[]): Anchor[] {
  const anchors: Anchor[] = [];
  for (const [family, tier] of Object.entries(FAMILY_TIERS)) {
    const pattern = familyPattern(family);
    const newest = pattern && ratings.filter((r) => pattern.test(r.id)).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    if (newest) anchors.push({ tier, rating: newest });
  }
  return anchors;
}

/** The score scale calibrated on the family table, or undefined when the data cannot support one. */
export function scoreScale(ratings: RatedModel[] | undefined, weight: number): ScoreScale | undefined {
  return ratings ? buildScale(findAnchors(ratings), weight, ratings) : undefined;
}

const fixed = (n: number): string => n.toFixed(2);

function byScore(modelId: string, scale: ScoreScale): Classification | undefined {
  const r = matchRating(modelId, scale.ratings);
  if (!r) return undefined;
  const c = combinedScore(scale, r);
  const detail = `capability score (Model Index ${r.score}, $${r.out}/M → ${fixed(c)}; cuts ${scale.cuts.map(fixed).join('/')})`;
  return { tier: scoreTier(scale, c), source: 'score', detail };
}

function byOverride(modelId: string, meta: ModelMeta | undefined, config: Config): Classification | undefined {
  const { tierOverrides } = config;
  if (Object.hasOwn(tierOverrides, modelId)) return { tier: tierOverrides[modelId], source: 'override' };
  const family = meta?.family;
  if (family !== undefined && Object.hasOwn(tierOverrides, family)) return { tier: tierOverrides[family], source: 'override' };
  return undefined;
}

/** The built-in model lines, then the family table. */
function byTable(modelId: string, meta: ModelMeta | undefined): Classification | undefined {
  const line = MODEL_LINE_TIERS.find((l) => l.pattern.test(normalizeModelId(modelId)));
  if (line) return { tier: line.tier, source: 'family' };
  const family = meta?.family;
  if (family !== undefined && Object.hasOwn(FAMILY_TIERS, family)) return { tier: FAMILY_TIERS[family], source: 'family' };
  return undefined;
}

/** Override by id, override by family, built-in model line, built-in family map, then capability score. Undefined when nothing applies. */
export function classifyModel(modelId: string, meta: ModelMeta | undefined, config: Config, scale?: ScoreScale): Classification | undefined {
  return byOverride(modelId, meta, config) ?? byTable(modelId, meta) ?? (scale ? byScore(modelId, scale) : undefined);
}

// Providers describe each model's place in their lineup in a few words; the strongest claim wins.
const LINEUP_WORDS: readonly [Tier, RegExp][] = [
  ['frontier', /frontier|toughest|most demanding|most capable|most intelligent|hardest/],
  ['light', /\bfast(est)?\b|quick|affordable|easier|cheapest|lightweight|\bsmall/],
  ['advanced', /complex|workhorse|demanding/],
  ['daily', /simpler|everyday|efficient|balanced|straightforward|general/],
];

/** The tier a provider's own description places a model in, or undefined when it says nothing usable. */
export function lineupTier(description: string | undefined): Tier | undefined {
  const text = description?.toLowerCase() ?? '';
  return LINEUP_WORDS.find(([, words]) => words.test(text))?.[0];
}

/** Tiers of Cursor's `auto` (Cost mode): Cursor picks a cheap model, so never Advanced or Frontier. */
export const CURSOR_AUTO_TIERS: readonly Tier[] = ['light', 'daily'];

/** Cursor's `auto`, routed by the cursorAuto rule rather than a user override. */
export function isCursorAuto(model: LaunchModel, config: Config): boolean {
  return config.cursorAuto && model.agent === 'cursor' && model.modelId === 'auto' && !Object.hasOwn(config.tierOverrides, 'auto');
}

const quoted = (s: string): string => `the provider's lineup ("${s}")`;

/**
 * Every tier a discovered model is routed in. Overrides and Cursor Auto win; then the model's home tier (the
 * provider's lineup words, else the family table) and its benchmark tier span a range, and it is routed in
 * every tier between them. One signal alone places it in one tier; with neither, the capability score does.
 */
export function classifyLaunch(model: LaunchModel, config: Config, scales: Scales = {}): Classification[] {
  if (isCursorAuto(model, config)) return CURSOR_AUTO_TIERS.map((tier) => ({ tier, source: 'auto' }));
  const override = byOverride(model.modelId, model.meta, config);
  if (override) return [override];

  const lineup = lineupTier(model.lineup);
  const home: Classification | undefined = lineup
    ? { tier: lineup, source: 'lineup', detail: quoted(model.lineup!) }
    : byTable(model.modelId, model.meta);
  const matched = scales.benchmark && matchBenchmark(model.modelId, scales.benchmark.benchmarks);
  const bench = matched && scales.benchmark ? benchmarkTier(scales.benchmark, matched) : undefined;

  if (!bench) {
    if (home) return [home];
    const score = scales.score && byScore(model.modelId, scales.score);
    return score ? [score] : [];
  }
  if (!home) return [{ tier: bench.tier, source: 'benchmark', detail: bench.detail }];

  const homeWords = home.source === 'lineup' ? quoted(model.lineup!) : 'the family table';
  if (home.tier === bench.tier) return [{ ...home, detail: `${homeWords}, confirmed by ${bench.detail}` }];
  const lo = Math.min(TIERS.indexOf(home.tier), TIERS.indexOf(bench.tier));
  const hi = Math.max(TIERS.indexOf(home.tier), TIERS.indexOf(bench.tier));
  return TIERS.slice(lo, hi + 1).map((tier) => {
    if (tier === home.tier) return { tier, source: home.source, detail: `${homeWords}; benchmarks place it ${bench.tier} (${bench.detail.slice('benchmarks ('.length)}` };
    if (tier === bench.tier) return { tier, source: 'benchmark', detail: `${bench.detail}; ${homeWords} places it ${home.tier}` };
    return { tier, source: 'benchmark', detail: `between ${homeWords.replace(/ \(".*"\)$/, '')} (${home.tier}) and benchmarks (${bench.tier})` };
  });
}
