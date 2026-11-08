import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cacheDir, configPath, homeDir } from '../src/paths.js';

const NAMES = ['ORCACOMPASS_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA'];
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
afterEach(() => {
  for (const name of NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe('paths', () => {
  it('puts config and cache under ORCACOMPASS_HOME when set', () => {
    process.env.ORCACOMPASS_HOME = join('x', 'home');
    expect(configPath()).toBe(join('x', 'home', 'config.json'));
    expect(cacheDir()).toBe(join('x', 'home', 'cache'));
  });

  it('falls back to a per-user location', () => {
    delete process.env.ORCACOMPASS_HOME;
    expect(configPath()).toMatch(/orcacompass[\\/]config\.json$/);
    expect(cacheDir()).toMatch(/orcacompass/);
  });

  it('treats an empty location variable as unset, so paths never depend on the working directory', () => {
    delete process.env.ORCACOMPASS_HOME;
    for (const name of NAMES.slice(1)) process.env[name] = '';
    expect(isAbsolute(configPath())).toBe(true);
    expect(isAbsolute(cacheDir())).toBe(true);
  });
});

describe('homeDir', () => {
  it('uses HOME on macOS and Linux', () => {
    expect(homeDir({ HOME: '/h', USERPROFILE: '/other' }, 'linux')).toBe('/h');
    expect(homeDir({ HOME: '/h' }, 'darwin')).toBe('/h');
  });

  it('prefers USERPROFILE on Windows, where agents ignore a HOME set by other tools', () => {
    expect(homeDir({ HOME: '/h', USERPROFILE: '/profile' }, 'win32')).toBe('/profile');
    expect(homeDir({ HOME: '/h' }, 'win32')).toBe('/h');
  });

  it('falls back to the system home when the variable is empty or missing', () => {
    expect(homeDir({ HOME: '' }, 'linux')).toBe(homedir());
    expect(homeDir({}, 'linux')).toBe(homedir());
    expect(homeDir({ USERPROFILE: '' }, 'win32')).toBe(homedir());
  });
});
