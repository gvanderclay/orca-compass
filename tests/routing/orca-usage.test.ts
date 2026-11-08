import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readOrcaUsage } from '../../src/routing/orca-usage.js';
import type { Runner, RunResult } from '../../src/system/run.js';

// Synthetic account-list response: no account identities, auth state, or captured usage.
const fixtureText = readFileSync(new URL('../fixtures/orca-account-list.json', import.meta.url), 'utf8');
const fake = (stdout: string, code: number | null = 0): Runner => async () => ({ code, stdout, stderr: '' });
const fixture = () => JSON.parse(fixtureText);
const AGENTS = ['antigravity', 'claude', 'codex', 'cursor', 'grok', 'muse'];

describe('readOrcaUsage', () => {
  it('reads the account list with a 20 second timeout', async () => {
    const calls: unknown[] = [];
    const run: Runner = async (...args) => {
      calls.push(args);
      return { code: 0, stdout: fixtureText, stderr: '' };
    };
    await readOrcaUsage(run);
    expect(calls).toEqual([['orca', ['account', 'list', '--json'], { timeoutMs: 20_000 }]]);
  });

  it('maps Claude pools and retains the update timestamp', async () => {
    const usage = await readOrcaUsage(fake(fixtureText));
    expect(usage.claude).toEqual({
      agent: 'claude', status: 'ok', updatedAt: 1793232000000,
      pools: {
        session: { name: 'session', kind: 'session', usedPercent: 10, windowMinutes: 300, resetsAt: 1793239200000 },
        weekly: { name: 'weekly', kind: 'long', usedPercent: 50, windowMinutes: 10080, resetsAt: 1793282400000 },
        fableWeekly: { name: 'fableWeekly', kind: 'long', usedPercent: 75, windowMinutes: 10080, resetsAt: 1793282400000 },
      },
    });
  });

  it('omits the null Codex session and ignores reset credits', async () => {
    const usage = await readOrcaUsage(fake(fixtureText));
    expect(usage.codex).toEqual({
      agent: 'codex', status: 'ok', updatedAt: 1793232000000,
      pools: { weekly: { name: 'weekly', kind: 'long', usedPercent: 20, windowMinutes: 10080, resetsAt: 1793736000000 } },
    });
  });

  it('includes a non-null Codex session', async () => {
    const data = fixture();
    data.result.rateLimits.codex.session = data.result.rateLimits.claude.session;
    const usage = await readOrcaUsage(fake(JSON.stringify(data)));
    expect(usage.codex.pools.session).toEqual({
      name: 'session', kind: 'session', usedPercent: 10, windowMinutes: 300, resetsAt: 1793239200000,
    });
  });

  it('maps Cursor monthly and every named bucket as long pools', async () => {
    const usage = await readOrcaUsage(fake(fixtureText));
    expect(usage.cursor).toEqual({
      agent: 'cursor', status: 'ok', updatedAt: 1793232000000,
      pools: {
        monthly: { name: 'monthly', kind: 'long', usedPercent: 2.5, windowMinutes: 44640, resetsAt: 1795132800000 },
        'bucket:Cursor Models': { name: 'bucket:Cursor Models', kind: 'long', usedPercent: 1.25, windowMinutes: 44640, resetsAt: 1795132800000 },
        'bucket:Other Models': { name: 'bucket:Other Models', kind: 'long', usedPercent: 6.25, windowMinutes: 44640, resetsAt: 1795132800000 },
      },
    });
    expect(usage.cursor.pools['bucket:Other Models'].usedPercent).toBeCloseTo(6.25, 2);
    expect(Object.keys(usage).sort()).toEqual(AGENTS);
  });

  it('maps the Grok weekly credit window and monthly budget as long pools', async () => {
    const data = fixture();
    Object.assign(data.result.rateLimits.grok, {
      status: 'ok', error: null,
      weekly: { usedPercent: 30, windowMinutes: 10080, resetsAt: 1793500000000, resetDescription: null },
      monthly: { usedPercent: 12.5, windowMinutes: 43200, resetsAt: 1795000000000, resetDescription: null },
    });
    const usage = await readOrcaUsage(fake(JSON.stringify(data)));
    expect(usage.grok).toEqual({
      agent: 'grok', status: 'ok', updatedAt: 1793232000000,
      pools: {
        weekly: { name: 'weekly', kind: 'long', usedPercent: 30, windowMinutes: 10080, resetsAt: 1793500000000 },
        monthly: { name: 'monthly', kind: 'long', usedPercent: 12.5, windowMinutes: 43200, resetsAt: 1795000000000 },
      },
    });
  });

  // Shape of `orca account list --json` for a signed-in agy (Orca 1.4.245, agy 1.4.11); numbers are made up.
  const agyBucket = (group: string, usedPercent: number, windowMinutes: number, resetsAt: number | null, name = group) => ({
    name, group, windowName: windowMinutes === 300 ? '5 Hour Limit Remaining' : 'Weekly Limit Remaining',
    usedPercent, windowMinutes, resetsAt, resetDescription: null,
  });
  const agyUsage = (buckets: unknown[], extra: object = {}) => ({
    provider: 'antigravity', session: null, weekly: { usedPercent: 0, windowMinutes: 10080, resetsAt: 1793800000000, resetDescription: null },
    buckets, updatedAt: 1793232000000, error: null, status: 'ok',
    usageMetadata: { source: 'cli', attemptedSources: ['cli'], lastSuccessfulSource: 'cli', credentialSource: 'antigravity-cli' },
    ...extra,
  });

  it('maps each Antigravity quota group to its own pools, weekly as long and 5-hour as session', async () => {
    const data = fixture();
    data.result.rateLimits.antigravity = agyUsage([
      agyBucket('Gemini Models', 10, 10080, 1793800000000),
      agyBucket('Claude and GPT models', 30, 10080, 1793700000000),
    ]);
    const usage = await readOrcaUsage(fake(JSON.stringify(data)));
    expect(usage.antigravity).toEqual({
      agent: 'antigravity', status: 'ok', updatedAt: 1793232000000,
      pools: {
        'bucket:Gemini Models': { name: 'bucket:Gemini Models', kind: 'long', usedPercent: 10, windowMinutes: 10080, resetsAt: 1793800000000 },
        'bucket:Claude and GPT models': { name: 'bucket:Claude and GPT models', kind: 'long', usedPercent: 30, windowMinutes: 10080, resetsAt: 1793700000000 },
      },
    });

    // A group with both windows: Orca names each bucket "group · window"; the pools key on the group.
    data.result.rateLimits.antigravity = agyUsage([
      agyBucket('Gemini Models', 40, 300, 1793290000000, 'Gemini Models · 5 Hour Limit Remaining'),
      agyBucket('Gemini Models', 10, 10080, 1793800000000, 'Gemini Models · Weekly Limit Remaining'),
      agyBucket('Gemini Models', 15, 10080, 1793800000000, 'Gemini Models · Weekly Limit Remaining'),
      agyBucket('Claude and GPT models', 5, 10080, null),
      { name: 'odd', group: 'Odd', usedPercent: 5, windowMinutes: 0, resetsAt: 1793800000000 },
      null,
    ]);
    const both = await readOrcaUsage(fake(JSON.stringify(data)));
    expect(both.antigravity.pools).toEqual({
      'bucket:Gemini Models 5h': { name: 'bucket:Gemini Models 5h', kind: 'session', usedPercent: 40, windowMinutes: 300, resetsAt: 1793290000000 },
      // The tightest of two buckets in the same group and window.
      'bucket:Gemini Models': { name: 'bucket:Gemini Models', kind: 'long', usedPercent: 15, windowMinutes: 10080, resetsAt: 1793800000000 },
    });
  });

  it('falls back to Orca\'s overall Antigravity windows when it reports no quota groups', async () => {
    const data = fixture();
    const window = (usedPercent: number, windowMinutes: number, resetsAt: number | null) =>
      ({ usedPercent, windowMinutes, resetsAt, resetDescription: null });
    data.result.rateLimits.antigravity = agyUsage([], { session: window(40, 300, 1793290000000), weekly: window(70, 10080, null) });
    const usage = await readOrcaUsage(fake(JSON.stringify(data)));
    expect(usage.antigravity.pools).toEqual({
      session: { name: 'session', kind: 'session', usedPercent: 40, windowMinutes: 300, resetsAt: 1793290000000 },
    });
  });

  it('keeps Orca\'s unavailable Grok and Antigravity, and Muse without any Orca usage as unknown', async () => {
    const usage = await readOrcaUsage(fake(fixtureText));
    expect(usage.grok).toMatchObject({ status: 'unavailable', pools: {}, error: 'Not signed in to Grok — run grok login' });
    expect(usage.antigravity).toMatchObject({ status: 'unavailable', pools: {}, error: expect.stringMatching(/agy/) });
    expect(usage.muse).toEqual({ agent: 'muse', status: 'unknown', pools: {}, error: 'Orca reports no usage for muse' });
  });

  it('skips null pools for every provider', async () => {
    const data = fixture();
    Object.assign(data.result.rateLimits.claude, { session: null, weekly: null, fableWeekly: null });
    data.result.rateLimits.codex.weekly = null;
    Object.assign(data.result.rateLimits.cursor, { monthly: null, buckets: [null] });
    const usage = await readOrcaUsage(fake(JSON.stringify(data)));
    for (const agent of ['claude', 'codex', 'cursor']) expect(usage[agent].pools).toEqual({});
  });

  it('maps provider status unavailable to unavailable with its error', async () => {
    const data = fixture();
    Object.assign(data.result.rateLimits.claude, { status: 'unavailable', error: 'Not signed in' });
    const usage = await readOrcaUsage(fake(JSON.stringify(data)));
    expect(usage.claude).toMatchObject({ status: 'unavailable', error: 'Not signed in', updatedAt: 1793232000000 });
    expect(usage.codex.status).toBe('ok');
  });

  it.each(['error', 'loading', 'stale', undefined])('maps provider status %s to unknown with an error', async (status) => {
    const data = fixture();
    data.result.rateLimits.claude.status = status;
    data.result.rateLimits.claude.error = null;
    const usage = await readOrcaUsage(fake(JSON.stringify(data)));
    expect(usage.claude).toMatchObject({ status: 'unknown', error: expect.stringMatching(/.+/) });
    expect(usage.codex.status).toBe('ok');
  });

  it('maps a missing provider entry to unknown', async () => {
    const data = fixture();
    delete data.result.rateLimits.cursor;
    const usage = await readOrcaUsage(fake(JSON.stringify(data)));
    expect(usage.cursor).toEqual({ agent: 'cursor', status: 'unknown', pools: {}, error: expect.stringMatching(/.+/) });
    expect(usage.claude.status).toBe('ok');
  });

  it('skips pools with non-numeric fields and buckets without a name', async () => {
    const data = fixture();
    const limits = data.result.rateLimits;
    limits.claude.fableWeekly.usedPercent = null;
    limits.claude.weekly.windowMinutes = 'soon';
    limits.claude.session.resetsAt = undefined;
    limits.codex.weekly.usedPercent = Number.NaN;
    limits.cursor.buckets[0].name = undefined;
    limits.cursor.buckets[1].name = 42;
    const usage = await readOrcaUsage(fake(JSON.stringify(data)));
    expect(usage.claude.pools).toEqual({});
    expect(usage.codex.pools).toEqual({});
    expect(Object.keys(usage.cursor.pools)).toEqual(['monthly']);
  });

  it('provides an error when an unavailable provider supplies none', async () => {
    const data = fixture();
    data.result.rateLimits.cursor.status = 'unavailable';
    const usage = await readOrcaUsage(fake(JSON.stringify(data)));
    expect(usage.cursor.status).toBe('unavailable');
    expect(usage.cursor.error).toEqual(expect.any(String));
    expect(usage.cursor.error?.length).toBeGreaterThan(0);
  });

  it.each<[string, RunResult, string]>([
    ['missing executable', { code: null, stdout: '', stderr: '', error: 'ENOENT' }, 'ENOENT'],
    ['timeout', { code: null, stdout: '', stderr: '', error: 'timed out after 20000 ms' }, 'timed out'],
    ['nonzero exit', { code: 1, stdout: fixtureText, stderr: 'runtime offline' }, 'runtime offline'],
    ['runner error despite zero exit', { code: 0, stdout: fixtureText, stderr: '', error: 'read failed' }, 'read failed'],
    ['non-JSON', { code: 0, stdout: 'not json', stderr: '' }, ''],
    ['API failure', { code: 0, stdout: JSON.stringify({ ok: false, error: 'runtime unavailable' }), stderr: '' }, 'runtime unavailable'],
    ['missing rate limits', { code: 0, stdout: JSON.stringify({ ok: true, result: {} }), stderr: '' }, ''],
  ])('returns unknown usage for all agents on %s', async (_name, result, reason) => {
    const usage = await readOrcaUsage(async () => result);
    expect(Object.keys(usage).sort()).toEqual(AGENTS);
    for (const agent of AGENTS) {
      expect(usage[agent]).toEqual({ agent, status: 'unknown', pools: {}, error: expect.stringMatching(/^Orca not reachable: .+/) });
      expect(usage[agent].error).toContain(reason);
    }
  });
});
