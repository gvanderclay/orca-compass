import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand, runInteractive, type Interactive, type Runner } from './system/run.js';

/** The `skills` installer (vercel-labs/skills) knows each agent's skills folder; the major version is pinned. */
export const SKILLS_CLI = 'skills@1';

export interface InstallOptions {
  /** Install for the user (every project) instead of the current project. */
  global?: boolean;
  /** Answer the installer's questions with their defaults. */
  yes?: boolean;
  /** Install only for these agents (the installer's agent names, such as claude-code or codex). */
  agents?: string[];
  /** Leave the CLI alone and install only the Skill. */
  skillOnly?: boolean;
}

export interface InstallDeps {
  interactive?: Interactive;
  /** Reads npm registry and global package metadata. */
  run?: Runner;
  /** The folder that holds this package's package.json and skills/. */
  packageRoot?: string;
  log?: (s: string) => void;
}

// A folder URL converts to a path ending in a separator; drop it so the path is a plain argument.
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');

function versionParts(version: string): { core: bigint[]; pre?: string[] } {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match || match[4]?.split('.').some((part) => /^0\d+$/.test(part))) throw new Error(`Invalid package version: ${version}`);
  return { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') };
}

/** SemVer precedence, including numeric prerelease identifiers; build metadata does not affect order. */
function compareVersions(left: string, right: string): number {
  const a = versionParts(left), b = versionParts(right);
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  }
  if (!a.pre || !b.pre) return a.pre ? -1 : b.pre ? 1 : 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (nx !== ny) return nx ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

// npm's global metadata excludes the temporary npx copy and project-local installations.
async function installedVersion(run: Runner): Promise<string | undefined> {
  const result = await run('npm', ['ls', '--global', '--depth=0', '--json', 'orcacompass']);
  if (result.error) throw new Error(result.error);
  const data = JSON.parse(result.stdout);
  // npm returns 1 for an empty filtered list, and ENOENT when the prefix does not exist yet.
  if (data?.error?.code === 'ENOENT') return undefined;
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) throw new Error('Invalid npm package metadata');
  const pkg = data.dependencies?.orcacompass;
  const emptyList = result.code === 1 && pkg === undefined && !data.problems && !result.stderr.trim();
  if (result.code !== 0 && !emptyList) throw new Error(result.stderr.trim() || `npm ls exited with ${result.code}`);
  if (pkg === undefined) return undefined;
  if (typeof pkg?.version !== 'string') throw new Error('Installed OrcaCompass has no version');
  versionParts(pkg.version);
  return pkg.version;
}

/**
 * Installs or updates the global CLI first, then installs this package's matching Skill.
 * An older installer cannot downgrade a newer CLI or replace its Skill.
 * Returns the exit code.
 */
export async function install(opts: InstallOptions, deps: InstallDeps = {}): Promise<number> {
  const interactive = deps.interactive ?? runInteractive;
  const root = deps.packageRoot ?? PACKAGE_ROOT;
  const log = deps.log ?? (() => {});
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };

  if (!opts.skillOnly) {
    let existing: string | undefined;
    try {
      existing = await installedVersion(deps.run ?? runCommand);
      if (existing && compareVersions(existing, version) > 0) {
        log(`The installed CLI ${existing} is newer than this installer (${version}). Run: npx orcacompass@latest install${opts.global ? ' --global' : ''}`);
        return 1;
      }
    } catch (e) {
      log(`Cannot check the installed CLI: ${e instanceof Error ? e.message : String(e)}. Nothing was changed.`);
      return 1;
    }
    if (existing === version) {
      log(`CLI ${version} is already current.`);
    } else {
      log(`${existing ? 'Updating' : 'Installing'} the CLI: npm install -g orcacompass@${version}`);
      const cliCode = await commandResult(interactive, 'npm', ['install', '-g', `orcacompass@${version}`]);
      if (cliCode !== 0) {
        log(`CLI installation failed (npm exited with ${cliCode ?? 'no code'}). The Skill was left unchanged. Run: npx orcacompass@latest install${opts.global ? ' --global' : ''}`);
        return 1;
      }
      log(existing ? `CLI updated from ${existing} to ${version}.` : `CLI ${version} installed.`);
    }
  }

  const skillArgs = ['-y', SKILLS_CLI, 'add', root];
  if (opts.global) skillArgs.push('--global');
  if (opts.yes) skillArgs.push('--yes');
  for (const agent of opts.agents ?? []) skillArgs.push('--agent', agent);
  log(`Installing the OrcaCompass Skill ${version} with npx ${SKILLS_CLI}...`);
  const skillCode = await commandResult(interactive, 'npx', skillArgs);
  if (skillCode !== 0) {
    log(`The Skill was not installed (npx ${SKILLS_CLI} exited with ${skillCode ?? 'no code'}). ${opts.skillOnly ? 'Retry the same command.' : `The CLI is at ${version}; retry: npx orcacompass@latest install${opts.global ? ' --global' : ''}`}`);
    return 1;
  }

  if (opts.skillOnly) {
    log('Skill installed. The CLI was left alone (--skill-only).');
    return 0;
  }
  log('Skill and CLI installed. Ask your orchestrator to set up OrcaCompass, or run: orcacompass setup');
  return 0;
}

/** Fetches the latest installer explicitly, even when invoked through an older global CLI. */
export async function update(opts: InstallOptions, deps: InstallDeps = {}): Promise<number> {
  const log = deps.log ?? (() => {});
  let latest: string;
  let current: string;
  try {
    const result = await (deps.run ?? runCommand)('npm', ['view', 'orcacompass', 'dist-tags.latest', '--json']);
    if (result.error || result.code !== 0) throw new Error(result.error || result.stderr.trim() || `npm view exited with ${result.code}`);
    latest = JSON.parse(result.stdout);
    if (typeof latest !== 'string') throw new Error('The npm latest tag is not a version string');
    versionParts(latest);
    current = JSON.parse(readFileSync(join(deps.packageRoot ?? PACKAGE_ROOT, 'package.json'), 'utf8')).version;
    versionParts(current);
  } catch (e) {
    log(`Cannot resolve the latest installer: ${e instanceof Error ? e.message : String(e)}. Nothing was changed. Retry: orcacompass update${opts.global ? ' --global' : ''}`);
    return 1;
  }
  if (compareVersions(current, latest) > 0) {
    log(`This installer (${current}) is newer than the latest published release (${latest}). Nothing was changed.`);
    return 1;
  }
  if (current === latest) return install(opts, deps);

  const args = ['-y', `orcacompass@${latest}`, 'install'];
  if (opts.global) args.push('--global');
  if (opts.yes) args.push('--yes');
  for (const agent of opts.agents ?? []) args.push('--agent', agent);
  if (opts.skillOnly) args.push('--skill-only');
  log(`Running the latest installer (${latest})...`);
  const code = await commandResult(deps.interactive ?? runInteractive, 'npx', args);
  if (code !== 0) {
    log(`The update did not complete (${code ?? 'no exit code'}). Retry: npx ${args.slice(1).join(' ')}`);
    return 1;
  }
  return 0;
}

/** Removes the selected Skill scope; only a full global removal also removes the shared CLI. */
export async function uninstall(opts: InstallOptions, deps: InstallDeps = {}): Promise<number> {
  const interactive = deps.interactive ?? runInteractive;
  const log = deps.log ?? (() => {});
  const args = ['-y', SKILLS_CLI, 'remove', 'orcacompass'];
  if (opts.global) args.push('--global');
  if (opts.yes) args.push('--yes');
  for (const agent of opts.agents ?? []) args.push('--agent', agent);
  const skillCode = await commandResult(interactive, 'npx', args);
  if (skillCode !== 0) {
    log(`Skill removal did not complete (${skillCode ?? 'no exit code'}). The CLI was left unchanged. Retry: ${['orcacompass', 'uninstall', ...args.slice(4), ...(opts.skillOnly ? ['--skill-only'] : [])].join(' ')}`);
    return 1;
  }
  if (!opts.global || opts.skillOnly || opts.agents?.length) {
    log('Skill removal complete. The shared CLI was retained. User config and cache were preserved.');
    return 0;
  }
  // skills remove can exit zero after cancellation or an individual removal error.
  // Ask its inventory (including legacy agent folders) before removing the shared CLI.
  try {
    const result = await (deps.run ?? runCommand)('npx', ['-y', SKILLS_CLI, 'list', '--global', '--json']);
    if (result.error || result.code !== 0) throw new Error(result.error || result.stderr.trim() || `Skill inventory exited with ${result.code}`);
    const skills: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(skills) || skills.some((skill) => !skill || typeof skill.name !== 'string' || skill.scope !== 'global' || (skill.path !== null && typeof skill.path !== 'string'))) {
      throw new Error('Invalid Skill inventory');
    }
    if (skills.some((skill) => skill.name.toLowerCase() === 'orcacompass' || /(?:^|[\\/])orcacompass[\\/]?$/i.test(skill.path ?? ''))) {
      throw new Error('The global OrcaCompass Skill is still listed; removal may have been cancelled or failed');
    }
  } catch (e) {
    log(`Cannot confirm Skill removal: ${e instanceof Error ? e.message : String(e)}. The CLI was retained. After resolving Skill removal, run: npm uninstall -g orcacompass. User config and cache were preserved.`);
    return 1;
  }
  const cliCode = await commandResult(interactive, 'npm', ['uninstall', '-g', 'orcacompass']);
  if (cliCode !== 0) {
    log(`The Skill was removed, but CLI removal failed (${cliCode ?? 'no exit code'}). Retry: npm uninstall -g orcacompass. User config and cache were preserved.`);
    return 1;
  }
  log('Global Skill and CLI removed. User config and cache were preserved.');
  return 0;
}

async function commandResult(interactive: Interactive, cmd: string, args: string[]): Promise<number | null | string> {
  try {
    return await interactive(cmd, args);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
