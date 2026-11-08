import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));

import { runCommand, runInteractive } from '../../src/system/run.js';

const child = () => Object.assign(new EventEmitter(), {
  pid: 4242,
  stdout: new PassThrough(),
  stderr: new PassThrough(),
  kill: vi.fn(),
});

// Launch options are what keep a console hidden, so they are checked on every CI platform.
describe('Windows launch options', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

  beforeEach(() => {
    spawn.mockReset();
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    delete process.env.OC_PARENT;
  });

  it('hides the console of a background command', async () => {
    const c = child();
    spawn.mockReturnValue(c);
    const run = runCommand('orca', ['account', 'list', '--json']);
    c.emit('close', 0);
    await run;
    expect(spawn).toHaveBeenCalledOnce();
    const [line, options] = spawn.mock.calls[0];
    expect(line).toBe('orca account list --json');
    expect(options).toMatchObject({ shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  });

  it('hides taskkill when a background command times out', async () => {
    spawn.mockReturnValueOnce(child()).mockReturnValueOnce(child());
    const r = await runCommand('agy', ['models'], { timeoutMs: 1 });
    expect(r.error).toMatch(/timed out/);
    expect(spawn.mock.calls[1][0]).toBe('taskkill');
    expect(spawn.mock.calls[1][1]).toEqual(['/T', '/F', '/PID', '4242']);
    expect(spawn.mock.calls[1][2]).toMatchObject({ windowsHide: true, stdio: 'ignore' });
  });

  it('adds extra environment variables to the inherited environment', async () => {
    process.env.OC_PARENT = 'kept';
    const c = child();
    spawn.mockReturnValue(c);
    const run = runCommand('agy', ['models'], { env: { OC_EXTRA: '1' } });
    c.emit('close', 0);
    await run;
    expect(spawn.mock.calls[0][1].env).toMatchObject({ OC_PARENT: 'kept', OC_EXTRA: '1' });
  });

  it('leaves interactive commands attached to the terminal', async () => {
    const c = child();
    spawn.mockReturnValue(c);
    const run = runInteractive('npx', ['skills', 'add']);
    c.emit('close', 0);
    await run;
    const [line, options] = spawn.mock.calls[0];
    expect(line).toBe('npx skills add');
    expect(options).toMatchObject({ shell: true, stdio: 'inherit' });
    expect(options.windowsHide).toBeUndefined();
  });
});
