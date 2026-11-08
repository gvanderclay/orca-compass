import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { install, update, uninstall, SKILLS_CLI, type InstallDeps } from '../src/install.js';
import type { Interactive, Runner } from '../src/system/run.js';

let root: string;
let calls: [string, string[]][];
let logs: string[];

const deps = (codes: number[] = [0, 0], version?: string): InstallDeps => ({
  packageRoot: root,
  interactive: async (cmd, args) => {
    calls.push([cmd, args]);
    return codes[calls.length - 1] ?? 0;
  },
  run: async (cmd) => ({ code: 0, stdout: JSON.stringify(cmd === 'npx' ? [] : { dependencies: version ? { orcacompass: { version } } : {} }), stderr: '' }),
  log: (s) => logs.push(s),
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oc-install-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'orcacompass', version: '9.8.7' }));
  calls = [];
  logs = [];
});

afterEach(() => vi.unstubAllGlobals());

describe('Skill subprocess environment', () => {
  it.each(['win32', 'linux', 'darwin'])('isolates the Windows telemetry workaround from npm and the parent on %s', async (platform) => {
    const parentEnv = { ...process.env, DISABLE_TELEMETRY: '0' };
    vi.stubGlobal('process', { ...process, platform, env: parentEnv });
    const interactive = vi.fn<Interactive>(async () => 0);
    const run = vi.fn<Runner>(async (cmd) => ({ code: 0, stdout: cmd === 'npx' ? '[]' : '{"dependencies":{}}', stderr: '' }));
    const options = platform === 'win32' ? { env: { DISABLE_TELEMETRY: '1' } } : undefined;

    expect(await install({ global: true, yes: true }, { packageRoot: root, interactive, run })).toBe(0);
    expect(interactive).toHaveBeenNthCalledWith(1, 'npm', ['install', '-g', 'orcacompass@9.8.7']);
    expect(interactive.mock.calls[1]?.slice(0, 2)).toEqual(['npx', ['-y', SKILLS_CLI, 'add', root, '--global', '--yes']]);
    expect(interactive.mock.calls[1]?.[2]).toEqual(options);
    expect(run).toHaveBeenCalledWith('npm', ['ls', '--global', '--depth=0', '--json', 'orcacompass']);

    interactive.mockClear();
    run.mockClear();
    expect(await uninstall({ global: true, yes: true }, { interactive, run })).toBe(0);
    expect(interactive.mock.calls[0]?.slice(0, 2)).toEqual(['npx', ['-y', SKILLS_CLI, 'remove', 'orcacompass', '--global', '--yes']]);
    expect(interactive.mock.calls[0]?.[2]).toEqual(options);
    expect(run.mock.calls[0]?.slice(0, 2)).toEqual(['npx', ['-y', SKILLS_CLI, 'list', '--global', '--json']]);
    expect(run.mock.calls[0]?.[2]).toEqual(options);
    expect(interactive).toHaveBeenNthCalledWith(2, 'npm', ['uninstall', '-g', 'orcacompass']);
    expect(process.env.DISABLE_TELEMETRY).toBe('0');
  });
});

describe('install', () => {
  it('installs the matching CLI before the Skill when it is missing', async () => {
    expect(await install({}, deps())).toBe(0);
    expect(calls).toEqual([
      ['npm', ['install', '-g', 'orcacompass@9.8.7']],
      ['npx', ['-y', SKILLS_CLI, 'add', root]],
    ]);
    expect(logs.at(-1)).toMatch(/Skill and CLI installed/);
  });

  it('passes the scope, answer and agent choices to the skills installer', async () => {
    await install({ global: true, yes: true, agents: ['claude-code', 'codex'], skillOnly: true }, deps());
    expect(calls).toEqual([
      ['npx', ['-y', SKILLS_CLI, 'add', root, '--global', '--yes', '--agent', 'claude-code', '--agent', 'codex']],
    ]);
  });

  it('updates an older CLI before installing the matching Skill', async () => {
    expect(await install({}, deps([0, 0], '9.8.6'))).toBe(0);
    expect(calls).toEqual([
      ['npm', ['install', '-g', 'orcacompass@9.8.7']],
      ['npx', ['-y', SKILLS_CLI, 'add', root]],
    ]);
    expect(logs.join('\n')).toMatch(/updated.*9\.8\.6.*9\.8\.7/i);
  });

  it('refreshes the Skill without reinstalling an already current CLI', async () => {
    expect(await install({}, deps([0], '9.8.7'))).toBe(0);
    expect(calls).toEqual([['npx', ['-y', SKILLS_CLI, 'add', root]]]);
    expect(logs.join('\n')).toMatch(/already current/);
  });

  it.each(['9.9.0', '10.0.0', '9.8.8-beta.1'])('does not downgrade a newer CLI (%s) or replace its Skill', async (version) => {
    expect(await install({}, deps([], version))).toBe(1);
    expect(calls).toHaveLength(0);
    expect(logs.join('\n')).toMatch(/orcacompass@latest install/);
  });

  it('updates a prerelease to the matching stable release', async () => {
    expect(await install({}, deps([0, 0], '9.8.7-beta.2'))).toBe(0);
    expect(calls[0]).toEqual(['npm', ['install', '-g', 'orcacompass@9.8.7']]);
  });

  it('leaves the Skill alone when the CLI update fails', async () => {
    expect(await install({}, deps([243], '9.8.6'))).toBe(1);
    expect(calls).toEqual([['npm', ['install', '-g', 'orcacompass@9.8.7']]]);
    expect(logs.at(-1)).toMatch(/Skill was left unchanged/);
  });

  it('does not install anything if npm cannot inspect the global package', async () => {
    expect(await install({}, { ...deps(), run: async () => ({ code: 1, stdout: '', stderr: 'permission denied' }) })).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it.each([
    { code: 1, stdout: '{"name":"empty-prefix"}', stderr: '' },
    { code: -4058, stdout: '{"error":{"code":"ENOENT"}}', stderr: 'npm error enoent missing prefix' },
  ])('installs when npm reports an empty or missing global prefix', async (result) => {
    expect(await install({}, { ...deps(), run: async () => result })).toBe(0);
    expect(calls[0]).toEqual(['npm', ['install', '-g', 'orcacompass@9.8.7']]);
  });

  it.each(['9.8.7-beta.10', '9.8.7-rc.1'])('compares prerelease identifiers when avoiding a downgrade from %s', async (version) => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'orcacompass', version: '9.8.7-beta.2' }));
    expect(await install({}, deps([], version))).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it.each(['not json', '{"dependencies":{"orcacompass":{}}}', '{"dependencies":{"orcacompass":{"version":"invalid"}}}'])('does not treat malformed npm metadata as a missing installation', async (stdout) => {
    expect(await install({}, { ...deps(), run: async () => ({ code: 0, stdout, stderr: '' }) })).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('does not inspect or change the global CLI with --skill-only', async () => {
    expect(await install({ skillOnly: true }, { ...deps(), run: async () => { throw new Error('Must not inspect npm'); } })).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('reports partial success and a retry when the Skill install fails after a CLI upgrade', async () => {
    expect(await install({}, deps([0, 1], '9.8.6'))).toBe(1);
    expect(calls).toHaveLength(2);
    expect(logs.at(-1)).toMatch(/Skill was not installed/);
    expect(logs.at(-1)).toMatch(/orcacompass@latest install/);
  });

  it('reports process launch failure before any Skill changes', async () => {
    expect(await install({}, { ...deps(), interactive: async () => { throw new Error('npm missing'); } })).toBe(1);
    expect(logs.join('\n')).toMatch(/npm missing.*Skill was left unchanged/);
  });
});

describe('update', () => {
  const updateDeps = (latest = '9.8.8', installed?: string): InstallDeps => {
    const base = deps([], installed);
    return { ...base, run: async (cmd, args) => {
      if (args[0] === 'view') {
        expect([cmd, args]).toEqual(['npm', ['view', 'orcacompass', 'dist-tags.latest', '--json']]);
        return { code: 0, stdout: JSON.stringify(latest), stderr: '' };
      }
      return base.run!(cmd, args);
    } };
  };

  it('dispatches the exact latest installer from an older running CLI without recursion', async () => {
    expect(await update({ global: true, yes: true, agents: ['codex', 'claude-code'], skillOnly: true }, updateDeps())).toBe(0);
    expect(calls).toEqual([['npx', ['-y', 'orcacompass@9.8.8', 'install', '--global', '--yes', '--agent', 'codex', '--agent', 'claude-code', '--skill-only']]]);
  });

  it('keeps default project scope when forwarding to the new installer', async () => {
    expect(await update({ yes: true }, updateDeps())).toBe(0);
    expect(calls).toEqual([['npx', ['-y', 'orcacompass@9.8.8', 'install', '--yes']]]);
  });

  it('runs install directly when the running installer is latest', async () => {
    expect(await update({ yes: true }, updateDeps('9.8.7', '9.8.7'))).toBe(0);
    expect(calls).toEqual([['npx', ['-y', SKILLS_CLI, 'add', root, '--yes']]]);
  });

  it.each(['9.8.6', '9.8.7-beta.1'])('does not replace a running installer with an older latest release %s', async (latest) => {
    expect(await update({}, updateDeps(latest))).toBe(1);
    expect(calls).toHaveLength(0);
    expect(logs.join('\n')).toMatch(/newer/);
  });

  it.each(['latest', '9.8.8 && echo unsafe', '9.8.8_unsafe', '9.8.8-01', '9.8.8+'])('rejects an invalid registry version %s before invoking npx', async (version) => {
    expect(await update({}, updateDeps(version))).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('reports registry failures without changing anything', async () => {
    expect(await update({}, { ...deps(), run: async () => ({ code: 1, stdout: '', stderr: 'registry offline' }) })).toBe(1);
    expect(calls).toHaveLength(0);
    expect(logs.join('\n')).toMatch(/registry offline.*Nothing was changed/);
  });

  it('reports a failed delegated installer with a usable retry', async () => {
    expect(await update({ global: true }, { ...updateDeps(), interactive: async () => 1 })).toBe(1);
    expect(logs.join('\n')).toMatch(/npx orcacompass@9.8.8 install --global/);
  });

  it('retains targeted options in the retry after a delegated process launch failure', async () => {
    expect(await update({ global: true, agents: ['codex'], skillOnly: true }, { ...updateDeps(), interactive: async () => { throw new Error('npx missing'); } })).toBe(1);
    expect(logs.join('\n')).toMatch(/npx missing/);
    expect(logs.at(-1)).toContain('npx orcacompass@9.8.8 install --global --agent codex --skill-only');
  });
});

describe('uninstall', () => {
  it('removes only the project Skill by default and retains the shared CLI', async () => {
    expect(await uninstall({ yes: true }, deps())).toBe(0);
    expect(calls).toEqual([['npx', ['-y', SKILLS_CLI, 'remove', 'orcacompass', '--yes']]]);
    expect(logs.join('\n')).toMatch(/CLI.*retained/);
  });

  it('removes the global Skill before uninstalling the shared CLI', async () => {
    expect(await uninstall({ global: true, yes: true }, deps())).toBe(0);
    expect(calls).toEqual([
      ['npx', ['-y', SKILLS_CLI, 'remove', 'orcacompass', '--global', '--yes']],
      ['npm', ['uninstall', '-g', 'orcacompass']],
    ]);
    expect(logs.join('\n')).toMatch(/config.*cache.*preserved/i);
  });

  it.each([{ skillOnly: true }, { agents: ['codex', 'claude-code'] }])('retains the CLI for a partial global removal %j', async (opts) => {
    expect(await uninstall({ ...opts, global: true, yes: true }, deps())).toBe(0);
    expect(calls).toHaveLength(1);
    if ('agents' in opts) expect(calls[0][1]).toEqual(['-y', SKILLS_CLI, 'remove', 'orcacompass', '--global', '--yes', '--agent', 'codex', '--agent', 'claude-code']);
  });

  it('keeps the CLI when Skill removal fails', async () => {
    expect(await uninstall({ global: true }, deps([1]))).toBe(1);
    expect(calls).toHaveLength(1);
    expect(logs.join('\n')).toMatch(/CLI.*left unchanged/);
  });

  it('reports a failed CLI removal after the Skill was removed', async () => {
    expect(await uninstall({ global: true, yes: true }, deps([0, 1]))).toBe(1);
    expect(logs.join('\n')).toMatch(/npm uninstall -g orcacompass/);
  });

  it('reports a process launch failure and retains the CLI', async () => {
    expect(await uninstall({ global: true }, { ...deps(), interactive: async () => { throw new Error('npx missing'); } })).toBe(1);
    expect(logs.join('\n')).toMatch(/npx missing.*CLI.*left unchanged/);
  });

  it('retains targeted options in the removal retry', async () => {
    expect(await uninstall({ global: true, agents: ['codex'], skillOnly: true }, deps([1]))).toBe(1);
    expect(logs.at(-1)).toContain('orcacompass uninstall --global --agent codex --skill-only');
  });

  it('checks owning-tool inventory after Skill removal and before deleting the CLI', async () => {
    let inspected = false;
    expect(await uninstall({ global: true, yes: true }, { ...deps(), run: async (cmd, args) => {
      inspected = true;
      expect([cmd, args]).toEqual(['npx', ['-y', SKILLS_CLI, 'list', '--global', '--json']]);
      expect(calls).toHaveLength(1);
      return { code: 0, stdout: '[]', stderr: '' };
    } })).toBe(0);
    expect(inspected).toBe(true);
    expect(calls.at(-1)).toEqual(['npm', ['uninstall', '-g', 'orcacompass']]);
  });

  it.each([
    '[{"name":"orcacompass","path":"/home/test/.agents/skills/orcacompass","scope":"global","agents":["Codex"],"status":"untracked"}]',
    '[{"name":"renamed-skill","path":"/home/test/.claude/skills/orcacompass","scope":"global","agents":["Claude Code"],"status":"untracked"}]',
    'not json', '{}', '[{}]',
  ])('retains the CLI when removal reports zero but inventory cannot confirm absence: %s', async (stdout) => {
    expect(await uninstall({ global: true }, { ...deps(), run: async () => ({ code: 0, stdout, stderr: '' }) })).toBe(1);
    expect(calls).toHaveLength(1);
    expect(logs.join('\n')).toMatch(/CLI.*retained/);
  });

  it('retains the CLI when removal verification fails', async () => {
    expect(await uninstall({ global: true, yes: true }, { ...deps(), run: async () => ({ code: 1, stdout: '', stderr: 'inventory unavailable' }) })).toBe(1);
    expect(calls).toHaveLength(1);
    expect(logs.at(-1)).toMatch(/inventory unavailable/);
    expect(logs.at(-1)).toMatch(/npm uninstall -g orcacompass/);
  });
});

describe('orcacompass install', () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  };

  it('refuses to ask questions without a terminal unless --yes is given', async () => {
    const o = io();
    expect(await main(['install'], o.io, { install: deps() })).toBe(1);
    expect(o.err.join('\n')).toMatch(/not one.*--yes/);
    expect(calls).toHaveLength(0);
  });

  it('reads the short flags', async () => {
    const o = io();
    expect(await main(['install', '-g', '-y', '-a', 'codex', '--skill-only'], o.io, { install: deps() })).toBe(0);
    expect(calls).toEqual([['npx', ['-y', SKILLS_CLI, 'add', root, '--global', '--yes', '--agent', 'codex']]]);
  });

  it.each(['install', 'update', 'uninstall'])('rejects conflicting scopes for %s', async (command) => {
    const o = io();
    expect(await main([command, '--global', '--local', '--yes'], o.io, { install: deps() })).toBe(1);
    expect(o.err.join('\n')).toMatch(/--global.*--local|--local.*--global/);
    expect(calls).toHaveLength(0);
  });

  it('accepts explicit project scope', async () => {
    const o = io();
    expect(await main(['install', '--local', '--yes', '--skill-only'], o.io, { install: deps() })).toBe(0);
    expect(calls).toEqual([['npx', ['-y', SKILLS_CLI, 'add', root, '--yes']]]);
  });

  it('dispatches uninstall with explicit project scope', async () => {
    const o = io();
    expect(await main(['uninstall', '-l', '-y'], o.io, { install: deps() })).toBe(0);
    expect(calls).toEqual([['npx', ['-y', SKILLS_CLI, 'remove', 'orcacompass', '--yes']]]);
  });

  it('dispatches update from the CLI through the latest registry version', async () => {
    const o = io();
    expect(await main(['update', '--local', '--yes'], o.io, { install: { ...deps(), run: async () => ({ code: 0, stdout: '"9.8.8"', stderr: '' }) } })).toBe(0);
    expect(calls).toEqual([['npx', ['-y', 'orcacompass@9.8.8', 'install', '--yes']]]);
  });
});
