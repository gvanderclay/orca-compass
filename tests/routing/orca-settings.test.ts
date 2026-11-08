import { mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { orcaUserDataPath, readOrcaAgents, readSettingsPayload, type OrcaSettingsDeps } from '../../src/routing/orca-settings.js';

const USER_DATA = join('/fake', 'orca');
const PROFILE = join(USER_DATA, 'profiles', 'local-default');
const DB = join(PROFILE, 'profile-state.db');
const JSON_FILE = join(PROFILE, 'orca-data.json');
const INDEX = JSON.stringify({ schemaVersion: 1, activeProfileId: 'local-default', profiles: [{ id: 'local-default', name: 'Default' }] });

const deps = (files: Record<string, string>, payload?: string | Error, overrides: Partial<OrcaSettingsDeps> = {}): OrcaSettingsDeps => ({
  env: { ORCA_USER_DATA_PATH: USER_DATA },
  platform: 'linux',
  home: '/fake/home',
  readFile: (p) => files[p],
  exists: (p) => p in files || (p === DB && payload !== undefined),
  readSettingsPayload: async () => {
    if (payload instanceof Error) throw payload;
    return payload;
  },
  ...overrides,
});
const indexed = (extra: Record<string, string> = {}) => ({ [join(USER_DATA, 'orca-profile-index.json')]: INDEX, ...extra });

describe('orcaUserDataPath', () => {
  it('follows Orca: ORCA_USER_DATA_PATH, then the per-platform Electron userData folder', () => {
    expect(orcaUserDataPath({ ORCA_USER_DATA_PATH: '/x' }, 'win32', '/h')).toBe('/x');
    expect(orcaUserDataPath({ APPDATA: 'C:/Roaming' }, 'win32', '/h')).toBe(join('C:/Roaming', 'orca'));
    expect(orcaUserDataPath({}, 'win32', '/h')).toBeUndefined();
    expect(orcaUserDataPath({}, 'darwin', '/h')).toBe(join('/h', 'Library', 'Application Support', 'orca'));
    expect(orcaUserDataPath({ XDG_CONFIG_HOME: '/cfg' }, 'linux', '/h')).toBe(join('/cfg', 'orca'));
    expect(orcaUserDataPath({}, 'linux', '/h')).toBe(join('/h', '.config', 'orca'));
  });
});

describe('readOrcaAgents', () => {
  it('reads settings.disabledTuiAgents from the active profile\'s SQLite state', async () => {
    const result = await readOrcaAgents(deps(indexed(), JSON.stringify({ theme: 'dark', disabledTuiAgents: ['grok', 'cursor'] })));
    expect(result).toEqual({ known: true, disabled: ['grok', 'cursor'], source: DB });
    expect(await readOrcaAgents(deps(indexed(), JSON.stringify({ disabledTuiAgents: [] })))).toEqual({ known: true, disabled: [], source: DB });
  });

  it('reads orca-data.json when the profile has no SQLite state', async () => {
    const files = indexed({ [JSON_FILE]: JSON.stringify({ settings: { disabledTuiAgents: ['codex', 7] } }) });
    expect(await readOrcaAgents(deps(files))).toEqual({ known: true, disabled: ['codex'], source: JSON_FILE });
  });

  it('prefers the SQLite state, which Orca treats as the authority, over a leftover orca-data.json', async () => {
    const files = indexed({ [JSON_FILE]: JSON.stringify({ settings: { disabledTuiAgents: ['codex'] } }) });
    expect(await readOrcaAgents(deps(files, JSON.stringify({ disabledTuiAgents: ['grok'] })))).toMatchObject({ disabled: ['grok'] });
    expect(await readOrcaAgents(deps(files, new Error('no node:sqlite')))).toMatchObject({ known: false });
  });

  it('uses the profile the index names, falling back to its .bak copy', async () => {
    const other = JSON.stringify({ activeProfileId: 'work', profiles: [{ id: 'work' }] });
    const files = { [join(USER_DATA, 'orca-profile-index.json.bak')]: other };
    const seen: string[] = [];
    await readOrcaAgents(deps(files, '{}', { exists: () => true, readSettingsPayload: async (p) => (seen.push(p), '{}') }));
    expect(seen).toEqual([join(USER_DATA, 'profiles', 'work', 'profile-state.db')]);
  });

  it.each<[string, Record<string, string>, string | Error | undefined, RegExp]>([
    ['no profile index', {}, undefined, /profile index/],
    ['an unparseable index', { [join(USER_DATA, 'orca-profile-index.json')]: '{' }, undefined, /active Orca profile/],
    ['an active id missing from the profiles', { [join(USER_DATA, 'orca-profile-index.json')]: JSON.stringify({ activeProfileId: 'gone', profiles: [] }) }, undefined, /active Orca profile/],
    ['an unsafe profile id', { [join(USER_DATA, 'orca-profile-index.json')]: JSON.stringify({ activeProfileId: '../x', profiles: [{ id: '../x' }] }) }, undefined, /active Orca profile/],
    ['no settings files', indexed(), undefined, /not found/],
    ['a failing SQLite read', indexed(), new Error('database is locked'), /database is locked/],
    ['no settings row', indexed({ [DB]: '' }), undefined, /no settings/],
    ['unparseable settings', indexed(), '{oops', /settings/],
    ['no disabledTuiAgents field', indexed(), JSON.stringify({ theme: 'dark' }), /disabledTuiAgents/],
    ['a non-array field', indexed(), JSON.stringify({ disabledTuiAgents: 'grok' }), /disabledTuiAgents/],
  ])('is unknown, never "all enabled", with %s', async (_name, files, payload, reason) => {
    const result = await readOrcaAgents(deps(files, payload));
    expect(result.known).toBe(false);
    expect(result.known === false && result.reason).toMatch(reason);
  });

  it('is unknown when the Orca folder cannot be located', async () => {
    const result = await readOrcaAgents(deps({}, undefined, { env: {}, platform: 'win32' }));
    expect(result).toEqual({ known: false, reason: expect.stringMatching(/APPDATA/) });
  });
});

describe('readSettingsPayload', () => {
  it('fails cleanly on a file that is not an Orca profile database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-orca-settings-'));
    await expect(readSettingsPayload(join(dir, 'missing.db'))).rejects.toThrow();
  });
});

// These exercise Orca's real storage format; all files belong to this test.
// A wrong SQL query, a write during the read, or an unclosed connection must fail.
describe('readSettingsPayload with SQLite', () => {
  it('reads the settings domain without changing the database and closes it', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const dir = mkdtempSync(join(tmpdir(), 'oc-sqlite-'));
    const path = join(dir, 'profile-state.db');
    try {
      const db = new DatabaseSync(path);
      const payload = JSON.stringify({ disabledTuiAgents: ['codex', 'cursor'] });
      try {
        db.exec('CREATE TABLE profile_state_documents (domain TEXT PRIMARY KEY, payload TEXT)');
        const insert = db.prepare('INSERT INTO profile_state_documents VALUES (?, ?)');
        insert.run('other', JSON.stringify({ disabledTuiAgents: ['grok'] }));
        insert.run('settings', payload);
      } finally {
        db.close();
      }
      const before = readFileSync(path);
      expect(await readSettingsPayload(path)).toBe(payload);
      expect(readFileSync(path)).toEqual(before);
      // Windows refuses renaming an open SQLite file.
      renameSync(path, join(dir, 'closed.db'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined when the settings domain is absent', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const dir = mkdtempSync(join(tmpdir(), 'oc-sqlite-'));
    try {
      const path = join(dir, 'profile-state.db');
      const db = new DatabaseSync(path);
      try {
        db.exec('CREATE TABLE profile_state_documents (domain TEXT PRIMARY KEY, payload TEXT)');
      } finally {
        db.close();
      }
      expect(await readSettingsPayload(path)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
