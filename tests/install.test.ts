import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { install, SKILLS_CLI, type InstallDeps } from '../src/install.js';

let root: string;
let calls: [string, string[]][];
let logs: string[];

const deps = (codes: number[] = [0, 0], cli?: string): InstallDeps => ({
  packageRoot: root,
  interactive: async (cmd, args) => {
    calls.push([cmd, args]);
    return codes[calls.length - 1] ?? 0;
  },
  findCli: () => cli,
  log: (s) => logs.push(s),
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oc-install-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'orcacompass', version: '9.8.7' }));
  calls = [];
  logs = [];
});

describe('install', () => {
  it('installs the Skill from this package, then the same CLI version when it is missing', async () => {
    expect(await install({}, deps())).toBe(0);
    expect(calls).toEqual([
      ['npx', ['-y', SKILLS_CLI, 'add', root]],
      ['npm', ['install', '-g', 'orcacompass@9.8.7']],
    ]);
    expect(logs.at(-1)).toMatch(/Skill and CLI installed/);
  });

  it('passes the scope, answer and agent choices to the skills installer', async () => {
    await install({ global: true, yes: true, agents: ['claude-code', 'codex'], skillOnly: true }, deps());
    expect(calls).toEqual([
      ['npx', ['-y', SKILLS_CLI, 'add', root, '--global', '--yes', '--agent', 'claude-code', '--agent', 'codex']],
    ]);
  });

  it('leaves an installed CLI alone', async () => {
    expect(await install({}, deps([0], '/usr/local/bin/orcacompass'))).toBe(0);
    expect(calls).toHaveLength(1);
    expect(logs.at(-1)).toMatch(/already installed: \/usr\/local\/bin\/orcacompass/);
  });

  it('stops when the Skill install fails', async () => {
    expect(await install({}, deps([1]))).toBe(1);
    expect(calls).toHaveLength(1);
    expect(logs.at(-1)).toMatch(/Skill was not installed/);
  });

  it('says how to finish when only the CLI install fails', async () => {
    expect(await install({}, deps([0, 243]))).toBe(1);
    expect(logs.at(-1)).toMatch(/Skill is installed, but the CLI is not .*npm install -g orcacompass/);
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
});
