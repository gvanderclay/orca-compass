import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

// An empty location variable counts as unset throughout: joining onto "" gives a path relative to the
// working directory, so the config would change with the folder a command runs in.

/**
 * The user's home folder, where agents keep their files. On Windows they follow USERPROFILE, not a HOME
 * set by Git Bash or other tools. os.homedir() returns an empty HOME as is, hence the account's own record.
 */
export function homeDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return (platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME) || homedir() || userInfo().homedir;
}

// ORCACOMPASS_HOME holds both config and cache when set (used by tests).

export function configPath(): string {
  const home = process.env.ORCACOMPASS_HOME;
  if (home) return join(home, 'config.json');
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homeDir(), 'AppData', 'Roaming'), 'orcacompass', 'config.json');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homeDir(), '.config'), 'orcacompass', 'config.json');
}

export function cacheDir(): string {
  const home = process.env.ORCACOMPASS_HOME;
  if (home) return join(home, 'cache');
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homeDir(), 'AppData', 'Local'), 'orcacompass', 'cache');
  }
  return join(process.env.XDG_CACHE_HOME || join(homeDir(), '.cache'), 'orcacompass');
}
