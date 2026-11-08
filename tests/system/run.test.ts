import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findExecutable, quote, runCommand, searchPath } from '../../src/system/run.js';

const IS_WINDOWS = process.platform === 'win32';

/** Writes a tiny runnable tool that prints "ok" and returns the file's path. */
function writeTool(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, IS_WINDOWS ? `${name}.cmd` : name);
  writeFileSync(file, IS_WINDOWS ? '@echo ok\r\n' : '#!/bin/sh\necho ok\n', { mode: 0o755 });
  return file;
}

const savedHome = process.env.HOME;
const savedPath = process.env.PATH;
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  process.env.PATH = savedPath;
});

describe('quote', () => {
  it('quotes for cmd.exe without letting a trailing backslash escape the closing quote', () => {
    expect(quote(String.raw`C:\pkg\orcacompass\ `.trimEnd())).toBe(String.raw`C:\pkg\orcacompass\ `.trimEnd());
    expect(quote(String.raw`C:\John Smith\pkg\ `.trimEnd())).toBe(String.raw`"C:\John Smith\pkg\\"`);
    expect(quote('a & b')).toBe('"a & b"');
  });

  it('refuses % and ", which cmd.exe expands or cannot escape', () => {
    expect(() => quote('%SECRET%')).toThrow(/%/);
    expect(() => quote('say "hi"')).toThrow(/double quote/);
  });
});

// Node >= 22.13; the subprocess test needs run.ts as plain JS and TypeScript 7 has no JS API.
const stripTypes = (nodeModule as { stripTypeScriptTypes?: (code: string) => string }).stripTypeScriptTypes;

describe('runCommand', () => {
  it('captures stdout and exit code', async () => {
    const r = await runCommand(process.execPath, ['-e', "process.stdout.write('hi')"]);
    expect(r).toMatchObject({ code: 0, stdout: 'hi' });
  });

  it('never rejects for a missing command', async () => {
    const r = await runCommand('definitely-not-a-command-xyz', []);
    expect(r.code === null || r.code !== 0).toBe(true);
  });

  it('reports a timeout as an error', async () => {
    const r = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 200 });
    expect(r.error).toMatch(/timed out/);
  });

  it('gives the child a closed stdin so prompts see EOF', async () => {
    const script = "process.stdin.on('end', () => process.stdout.write('eof')); process.stdin.resume()";
    const r = await runCommand(process.execPath, ['-e', script], { timeoutMs: 5_000 });
    expect(r).toMatchObject({ code: 0, stdout: 'eof' });
  });

  it.skipIf(!stripTypes)('does not keep the process alive after a timeout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-run-'));
    const stripped = (file: string) => stripTypes!(readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8'));
    mkdirSync(join(dir, 'system'));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(dir, 'paths.js'), stripped('paths.ts'));
    writeFileSync(join(dir, 'system', 'run.js'), stripped('system/run.ts'));
    writeFileSync(
      join(dir, 'main.mjs'),
      [
        "import { runCommand } from './system/run.js';",
        "const r = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 500 });",
        'process.stdout.write(JSON.stringify(r));',
      ].join('\n'),
    );
    const start = Date.now();
    const outer = spawnSync(process.execPath, [join(dir, 'main.mjs')], { encoding: 'utf8', timeout: 9_000, windowsHide: true });
    const elapsed = Date.now() - start;
    expect(outer.stderr).toBe('');
    expect(JSON.parse(outer.stdout).error).toMatch(/timed out after 500 ms/);
    expect(elapsed).toBeLessThan(5_000);
  }, 15_000);

  it.runIf(process.platform === 'win32')('rejects double quotes, which cmd.exe cannot escape', async () => {
    const r = await runCommand(process.execPath, ['-e', 'process.stdout.write("hi")']);
    expect(r).toMatchObject({ code: null, stdout: '' });
    expect(r.error).toMatch(/double quote/);
  });
});

describe('findExecutable', () => {
  it('finds a file in extra paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-find-'));
    const name = process.platform === 'win32' ? 'fake-tool.cmd' : 'fake-tool';
    writeFileSync(join(dir, name), '', { mode: 0o755 });
    expect(findExecutable('fake-tool', [dir])).toBe(join(dir, name));
    expect(findExecutable('no-such-tool-xyz', [dir])).toBeUndefined();
  });

  it.skipIf(IS_WINDOWS)('skips a file that is not executable, as a shell does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-find-'));
    writeFileSync(join(dir, 'notes'), 'not a program', { mode: 0o644 });
    const real = writeTool(join(dir, 'bin'), 'notes');
    expect(findExecutable('notes', [dir, join(dir, 'bin')])).toBe(real);
  });

  it.skipIf(IS_WINDOWS)('finds a tool in ~/.local/bin when that folder is not on PATH', () => {
    const home = mkdtempSync(join(tmpdir(), 'oc-home-'));
    process.env.HOME = home;
    const tool = writeTool(join(home, '.local', 'bin'), 'oc-off-path-tool');
    expect(findExecutable('oc-off-path-tool', [], '/usr/bin')).toBe(tool);
  });
});

describe('searchPath', () => {
  const env = { HOME: '/h' };
  const dirsOf = (path: string, platform: NodeJS.Platform) => searchPath(path, env, platform).split(delimiter);

  it('keeps PATH first, so the user\'s own order wins', () => {
    const path = ['/first', '/second'].join(delimiter);
    expect(dirsOf(path, 'linux').slice(0, 2)).toEqual(['/first', '/second']);
  });

  it('adds the folders Orca adds on Linux', () => {
    expect(dirsOf('/usr/bin', 'linux')).toEqual(expect.arrayContaining([
      '/usr/local/bin', '/snap/bin', '/home/linuxbrew/.linuxbrew/bin', '/nix/var/nix/profiles/default/bin',
      join('/h', '.local', 'bin'), join('/h', '.opencode', 'bin'),
    ]));
  });

  it('adds Homebrew and MacPorts on macOS, and no Linux-only folder', () => {
    const dirs = dirsOf('/usr/bin', 'darwin');
    expect(dirs).toEqual(expect.arrayContaining(['/opt/homebrew/bin', '/opt/local/bin']));
    expect(dirs).not.toContain('/snap/bin');
  });

  it('does not repeat a folder already on PATH', () => {
    expect(dirsOf('/usr/local/bin', 'linux').filter((d) => d === '/usr/local/bin')).toHaveLength(1);
  });

  it('leaves PATH alone on Windows', () => {
    expect(searchPath('C:\\tools', env, 'win32')).toBe('C:\\tools');
  });
});

describe('runCommand and real folders', () => {
  it('runs a tool from a folder with spaces, accents and shell characters', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'oc-run-')), 'Jöhn Doe (x) & co');
    const r = await runCommand(writeTool(dir, 'tool'), ['an argument']);
    expect(r).toMatchObject({ code: 0 });
    expect(r.stdout.trim()).toBe('ok');
  });

  it.skipIf(IS_WINDOWS)('runs a bare command from ~/.local/bin when that folder is not on PATH', async () => {
    const home = mkdtempSync(join(tmpdir(), 'oc-home-'));
    process.env.HOME = home;
    process.env.PATH = '/usr/bin:/bin';
    writeTool(join(home, '.local', 'bin'), 'oc-off-path-tool');
    const r = await runCommand('oc-off-path-tool', []);
    expect(r).toMatchObject({ code: 0 });
    expect(r.stdout.trim()).toBe('ok');
  });
});
