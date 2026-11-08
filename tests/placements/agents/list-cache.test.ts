import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { listModels } from '../../../src/placements/agents/list-cache.js';
import { readTextFile, type AgentDeps } from '../../../src/placements/agents/deps.js';

const at = 1793232000000;
const parse = (text: string) => text.trim() ? text.trim().split('\n').map((id) => ({ id })) : [];
function deps(stdout = '', stderr = 'offline'): AgentDeps {
  return { index: {}, env: {}, find: () => undefined, readFile: readTextFile,
    cacheDir: mkdtempSync(join(tmpdir(), 'oc-list-')), now: at,
    run: async () => ({ code: stderr ? 1 : 0, stdout, stderr }) };
}
const list = (d: AgentDeps) => listModels(d, 'grok', ['models'], 'grok', parse);

it('saves provider observations as versioned JSON and reuses them offline', async () => {
  const d = deps('grok-example', '');
  await list(d);
  expect(JSON.parse(readFileSync(join(d.cacheDir, 'grok-models.json'), 'utf8'))).toEqual({
    schemaVersion: 1, agent: 'grok', fetchedAt: at, models: [{ id: 'grok-example' }],
  });
  expect(await list({ ...d, now: at + 60000, run: deps().run })).toMatchObject({
    items: [{ id: 'grok-example' }], savedAt: at,
  });
});

it('migrates a legacy fallback without resetting its age or deleting the old file', async () => {
  const d = deps();
  const legacy = `fetchedAt ${at - 60000}\ngrok-legacy`;
  writeFileSync(join(d.cacheDir, 'grok-models.txt'), legacy);
  expect(await list(d)).toMatchObject({ items: [{ id: 'grok-legacy' }], savedAt: at - 60000 });
  expect(JSON.parse(readFileSync(join(d.cacheDir, 'grok-models.json'), 'utf8')).fetchedAt).toBe(at - 60000);
  expect(readTextFile(join(d.cacheDir, 'grok-models.txt'))).toBe(legacy);
});

it.each([
  '{broken',
  JSON.stringify({ schemaVersion: 2, agent: 'grok', fetchedAt: at, models: [{ id: 'x' }] }),
  JSON.stringify({ schemaVersion: 1, agent: 'cursor', fetchedAt: at, models: [{ id: 'x' }] }),
  JSON.stringify({ schemaVersion: 1, agent: 'grok', fetchedAt: 'yesterday', models: [{ id: 'x' }] }),
  JSON.stringify({ schemaVersion: 1, agent: 'grok', fetchedAt: at, models: [{ id: 5 }] }),
  JSON.stringify({ schemaVersion: 1, agent: 'grok', fetchedAt: at, models: [{ id: 'x', label: false }] }),
])('ignores invalid JSON cache: %s', async (contents) => {
  const d = deps();
  writeFileSync(join(d.cacheDir, 'grok-models.json'), contents);
  expect(await list(d)).toEqual({ error: 'offline', signedOut: false });
});

it('never uses or migrates a fallback after a sign-in failure', async () => {
  const d = deps('', 'Please run grok login');
  writeFileSync(join(d.cacheDir, 'grok-models.txt'), `fetchedAt ${at}\ngrok-legacy`);
  expect(await list(d)).toMatchObject({ signedOut: true });
  expect(readTextFile(join(d.cacheDir, 'grok-models.json'))).toBeUndefined();
});

it('prefers valid JSON over a legacy listing and replaces it after live discovery', async () => {
  const d = deps('grok-current', '');
  await list(d);
  writeFileSync(join(d.cacheDir, 'grok-models.txt'), `fetchedAt ${at}\ngrok-obsolete`);
  expect(await list({ ...d, run: deps().run })).toMatchObject({ items: [{ id: 'grok-current' }] });
  await list({ ...d, now: at + 60000, run: deps('grok-new', '').run });
  expect(await list({ ...d, run: deps().run })).toMatchObject({ items: [{ id: 'grok-new' }], savedAt: at + 60000 });
});

it('still returns live models when the cache directory is unwritable', async () => {
  const d = deps('grok-current', '');
  const file = join(d.cacheDir, 'file');
  writeFileSync(file, 'not a directory');
  expect(await list({ ...d, cacheDir: file })).toEqual({ items: [{ id: 'grok-current' }] });
});
