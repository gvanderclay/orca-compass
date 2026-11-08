import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homeDir } from '../paths.js';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Runs a command and resolves with its output. Never rejects. */
export type Runner = (cmd: string, args: string[], opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<RunResult>;

// cmd.exe has no escape for `"` inside a quoted argument, and it expands `%NAME%` even inside
// quotes (which could leak an environment variable's value), so refuse both rather than mangle them.
export const quote = (s: string): string => {
  if (s.includes('"')) throw new Error(`cannot pass an argument containing a double quote through cmd.exe: ${s}`);
  if (s.includes('%')) throw new Error(`cannot pass an argument containing % through cmd.exe: ${s}`);
  if (/^[\w\-.:\\/=@]+$/.test(s)) return s;
  // Backslashes right before the closing quote would escape it, so double them.
  return `"${s.replace(/(\\+)$/, '$1$1')}"`;
};

// The folders Orca adds to its own PATH on macOS and Linux, which is where installers and package managers
// put CLIs. A launcher or non-login shell can leave them out of ours, and Orca could then run an agent (or
// its own `orca`, in ~/.local/bin or /usr/local/bin) that OrcaCompass reports as missing.
function unixToolDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const home = homeDir(env, platform);
  return [
    '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin',
    ...(platform === 'linux' ? ['/snap/bin', '/home/linuxbrew/.linuxbrew/bin'] : []),
    '/nix/var/nix/profiles/default/bin',
    ...['bin', '.local/bin', '.nix-profile/bin', '.opencode/bin', '.vite-plus/bin', '.grok/bin'].map((dir) => join(home, dir)),
    ...(platform === 'darwin' ? ['/opt/local/bin', '/opt/local/sbin'] : []),
  ];
}

/** PATH followed by those folders, so the user's own order wins. Windows installers update PATH themselves. */
export function searchPath(path = process.env.PATH, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const current = path ?? '';
  if (platform === 'win32') return current;
  const known = new Set(current.split(delimiter));
  return [current, ...unixToolDirs(env, platform).filter((dir) => !known.has(dir))].filter(Boolean).join(delimiter);
}

export const runCommand: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    let line: string | undefined;
    if (process.platform === 'win32') {
      try {
        line = [cmd, ...args].map(quote).join(' ');
      } catch (e) {
        resolve({ code: null, stdout: '', stderr: '', error: e instanceof Error ? e.message : String(e) });
        return;
      }
    }
    let stdout = '';
    let stderr = '';
    let error: string | undefined;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ...(error ? { error } : {}) });
    };
    // Windows .cmd shims (orca, cursor-agent) only run through a shell.
    // stdin is ignored so a login prompt sees EOF instead of waiting forever.
    const stdio: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe'];
    const env = { ...process.env, ...opts.env };
    // Node looks a bare command up on this PATH. Windows keeps its own "Path" spelling, so it is left alone.
    if (process.platform !== 'win32') env.PATH = searchPath(env.PATH, env);
    const child =
      line !== undefined ? spawn(line, { shell: true, windowsHide: true, stdio, env }) : spawn(cmd, args, { stdio, env });
    const kill = () => {
      if (line === undefined || child.pid === undefined) {
        child.kill();
        return;
      }
      // child is cmd.exe; /T needs it alive to find the real process, which would otherwise
      // keep our stdout/stderr pipes (and so the event loop) open.
      const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => child.kill());
      killer.on('close', () => child.kill());
    };
    timer = setTimeout(() => {
      error = `timed out after ${timeoutMs} ms`;
      kill();
      child.stdout.destroy();
      child.stderr.destroy();
      finish(null);
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      error = e.message;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });

/** Runs a command attached to this terminal (its prompts and output reach the user) and resolves with its exit code. */
export type Interactive = (cmd: string, args: string[]) => Promise<number | null>;

export const runInteractive: Interactive = (cmd, args) =>
  new Promise((resolve, reject) => {
    // npx and npm are .cmd shims on Windows, which only run through a shell.
    const child =
      process.platform === 'win32'
        ? spawn([cmd, ...args].map(quote).join(' '), { shell: true, stdio: 'inherit' })
        : spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });

/** A file this user can run; on Windows the X_OK check only asks whether it exists. */
function isRunnable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Looks for an executable in extraPaths, on PATH (with PATHEXT on Windows) and in the usual tool folders. */
export function findExecutable(name: string, extraPaths: string[] = [], pathVar = process.env.PATH): string | undefined {
  const dirs = [...extraPaths, ...searchPath(pathVar).split(delimiter)].filter(Boolean);
  const exts =
    process.platform === 'win32'
      ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())]
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (isRunnable(p)) return p;
    }
  }
  return undefined;
}
