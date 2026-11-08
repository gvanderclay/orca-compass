import { readFileSync } from 'node:fs';
import { delimiter, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findExecutable, runInteractive, type Interactive } from './system/run.js';

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
  /** Finds `orcacompass` on PATH; returns undefined when it is not installed. */
  findCli?: () => string | undefined;
  /** The folder that holds this package's package.json and skills/. */
  packageRoot?: string;
  log?: (s: string) => void;
}

// A folder URL converts to a path ending in a separator; drop it so the path is a plain argument.
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');

// npx runs this package from its cache and puts that cache on PATH, so a copy found there
// disappears after the run and does not count as installed.
function findInstalledCli(): string | undefined {
  const marker = `${sep}_npx${sep}`;
  const path = (process.env.PATH ?? '').split(delimiter).filter((d) => !d.includes(marker)).join(delimiter);
  return findExecutable('orcacompass', [], path);
}

/**
 * Installs the Skill through the `skills` installer, pointed at this package's own copy, so the
 * Skill always matches this CLI version. Then installs the CLI globally if it is not on PATH yet.
 * Returns the exit code.
 */
export async function install(opts: InstallOptions, deps: InstallDeps = {}): Promise<number> {
  const interactive = deps.interactive ?? runInteractive;
  const root = deps.packageRoot ?? PACKAGE_ROOT;
  const log = deps.log ?? (() => {});
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };

  const skillArgs = ['-y', SKILLS_CLI, 'add', root];
  if (opts.global) skillArgs.push('--global');
  if (opts.yes) skillArgs.push('--yes');
  for (const agent of opts.agents ?? []) skillArgs.push('--agent', agent);
  log(`Installing the OrcaCompass Skill ${version} with npx ${SKILLS_CLI}...`);
  const skillCode = await interactive('npx', skillArgs);
  if (skillCode !== 0) {
    log(`The Skill was not installed (npx ${SKILLS_CLI} exited with ${skillCode ?? 'no code'}).`);
    return 1;
  }

  if (opts.skillOnly) {
    log('Skill installed. The CLI was left alone (--skill-only).');
    return 0;
  }
  const existing = (deps.findCli ?? findInstalledCli)();
  if (existing) {
    log(`Skill installed. The CLI is already installed: ${existing}`);
    return 0;
  }
  log(`Installing the CLI: npm install -g orcacompass@${version}`);
  const cliCode = await interactive('npm', ['install', '-g', `orcacompass@${version}`]);
  if (cliCode !== 0) {
    log(`The Skill is installed, but the CLI is not (npm exited with ${cliCode ?? 'no code'}). Run: npm install -g orcacompass`);
    return 1;
  }
  log('Skill and CLI installed. Ask your orchestrator to set up OrcaCompass, or run: orcacompass setup');
  return 0;
}
