import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { HostSubjects } from '@makaio/contracts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const busClientMocks = vi.hoisted(() => ({
  connectBusClient: vi.fn(),
  probeHealth: vi.fn(),
  resolveClientAuth: vi.fn(),
}));

const childProcessMocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock('./bus-client.js', () => busClientMocks);
vi.mock('node:child_process', () => childProcessMocks);

import { registerOpenCommand } from './open-command.js';

describe('registerOpenCommand', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalLocalAppData = process.env['LOCALAPPDATA'];
  const originalMakaioApp = process.env['MAKAIO_APP'];
  const tempPaths: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    while (tempPaths.length > 0) {
      const tempPath = tempPaths.pop();
      if (tempPath) rmSync(tempPath, { recursive: true, force: true });
    }
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
    process.exitCode = undefined;
    if (originalLocalAppData === undefined) {
      delete process.env['LOCALAPPDATA'];
    } else {
      process.env['LOCALAPPDATA'] = originalLocalAppData;
    }
    if (originalMakaioApp === undefined) {
      delete process.env['MAKAIO_APP'];
    } else {
      process.env['MAKAIO_APP'] = originalMakaioApp;
    }
    vi.restoreAllMocks();
  });

  /**
   * Create a temporary fixture path and register it for cleanup.
   * @returns Absolute temp directory path.
   */
  function makeTempRoot(): string {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'makaio-open-'));
    tempPaths.push(tempRoot);
    return tempRoot;
  }

  /**
   * Create an empty executable placeholder file and register it for cleanup.
   * @param filePath - Path to create.
   * @returns The created file path.
   */
  function makeFile(filePath: string): string {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, '');
    tempPaths.push(filePath);
    return filePath;
  }

  /**
   * Create a mock detached child process.
   * @param onOnce - Optional `once()` implementation.
   * @returns Minimal child process shape used by `launchApp()`.
   */
  function makeSpawnChild(onOnce?: (event: string, callback: (error: Error) => void) => void): {
    once: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  } {
    return {
      once: vi.fn(onOnce ?? (() => undefined)),
      unref: vi.fn(),
    };
  }

  /**
   * Run the `open` command through Commander.
   */
  async function runOpen(): Promise<void> {
    const program = new Command();
    registerOpenCommand(program);
    await program.parseAsync(['node', 'makaio', 'open']);
  }

  it('registers an "open" subcommand on the program', () => {
    const program = new Command();
    registerOpenCommand(program);
    const openCmd = program.commands.find((c) => c.name() === 'open');
    expect(openCmd).toBeDefined();
    expect(openCmd!.description()).toContain('desktop app');
  });

  it('focuses a running app over the bus and disconnects the client', async () => {
    const request = vi.fn().mockResolvedValue({ focused: true, windowId: 7 });
    const disconnect = vi.fn();
    busClientMocks.probeHealth.mockResolvedValue({ auth: false });
    busClientMocks.resolveClientAuth.mockReturnValue(undefined);
    busClientMocks.connectBusClient.mockResolvedValue({ request, disconnect });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await runOpen();

    expect(busClientMocks.probeHealth).toHaveBeenCalledOnce();
    expect(busClientMocks.resolveClientAuth).toHaveBeenCalledWith({ auth: false });
    expect(request).toHaveBeenCalledWith(HostSubjects.app.focus, {});
    expect(disconnect).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith('Makaio is now in the foreground.');
  });

  it('sets a failure exit code when the running app cannot be focused', async () => {
    const request = vi.fn().mockResolvedValue({ focused: false, windowId: null });
    const disconnect = vi.fn();
    busClientMocks.probeHealth.mockResolvedValue({ auth: false });
    busClientMocks.connectBusClient.mockResolvedValue({ request, disconnect });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runOpen();

    expect(error).toHaveBeenCalledWith('Failed to focus Makaio.');
    expect(disconnect).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });

  it('does not print a startup message when launch is unsupported', async () => {
    Object.defineProperty(process, 'platform', { value: 'aix' });
    busClientMocks.probeHealth.mockResolvedValue(null);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await runOpen();

    expect(error).toHaveBeenCalledWith('Unsupported platform: aix. Open Makaio.app manually.');
    expect(info).not.toHaveBeenCalledWith('Makaio is starting.');
    expect(process.exitCode).toBe(1);
  });

  it('shows development guidance on Windows when no packaged app path is available', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env['LOCALAPPDATA'];
    delete process.env['MAKAIO_APP'];
    busClientMocks.probeHealth.mockResolvedValue(null);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runOpen();

    expect(error).toHaveBeenCalledWith('Cannot launch Makaio because no packaged app path is available.');
    expect(error).toHaveBeenCalledWith('Packaged launchers provide MAKAIO_APP automatically.');
    expect(error).toHaveBeenCalledWith('In development, start the desktop host first with: yarn dev:desktop');
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('shows development guidance instead of probing host defaults when no packaged app path is available', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    delete process.env['MAKAIO_APP'];
    busClientMocks.probeHealth.mockResolvedValue(null);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runOpen();

    expect(error).toHaveBeenCalledWith('Cannot launch Makaio because no packaged app path is available.');
    expect(error).toHaveBeenCalledWith('Packaged launchers provide MAKAIO_APP automatically.');
    expect(error).toHaveBeenCalledWith('In development, start the desktop host first with: yarn dev:desktop');
    expect(childProcessMocks.spawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('launches Linux when MAKAIO_APP points at an install root', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const appRoot = makeTempRoot();
    const executable = path.join(appRoot, 'bin', 'makaio');
    makeFile(executable);
    process.env['MAKAIO_APP'] = appRoot;
    busClientMocks.probeHealth.mockResolvedValue(null);
    const child = makeSpawnChild();
    childProcessMocks.spawn.mockReturnValue(child);

    await runOpen();

    expect(childProcessMocks.spawn).toHaveBeenCalledWith(executable, [], {
      detached: true,
      stdio: 'ignore',
    });
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('launches Linux when MAKAIO_APP points directly at the executable', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const executable = makeFile(path.join(makeTempRoot(), 'custom-makaio'));
    process.env['MAKAIO_APP'] = executable;
    busClientMocks.probeHealth.mockResolvedValue(null);
    childProcessMocks.spawn.mockReturnValue(makeSpawnChild());

    await runOpen();

    expect(childProcessMocks.spawn).toHaveBeenCalledWith(executable, [], {
      detached: true,
      stdio: 'ignore',
    });
  });

  it('launches Windows when MAKAIO_APP points at an install root', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const appRoot = `makaio-open-win-${Date.now()}`;
    tempPaths.push(appRoot);
    mkdirSync(appRoot, { recursive: true });
    const executable = path.win32.join(appRoot, 'Makaio.exe');
    makeFile(executable);
    process.env['MAKAIO_APP'] = appRoot;
    busClientMocks.probeHealth.mockResolvedValue(null);
    childProcessMocks.spawn.mockReturnValue(makeSpawnChild());

    await runOpen();

    expect(childProcessMocks.spawn).toHaveBeenCalledWith(executable, [], {
      detached: true,
      stdio: 'ignore',
    });
  });

  it('launches Windows when MAKAIO_APP points directly at the executable', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const executable = makeFile(path.join(makeTempRoot(), 'CustomMakaio.exe'));
    process.env['MAKAIO_APP'] = executable;
    busClientMocks.probeHealth.mockResolvedValue(null);
    childProcessMocks.spawn.mockReturnValue(makeSpawnChild());

    await runOpen();

    expect(childProcessMocks.spawn).toHaveBeenCalledWith(executable, [], {
      detached: true,
      stdio: 'ignore',
    });
  });

  it('launches macOS app bundles with open', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const appBundle = path.join(makeTempRoot(), 'Makaio.app');
    mkdirSync(appBundle, { recursive: true });
    process.env['MAKAIO_APP'] = appBundle;
    busClientMocks.probeHealth.mockResolvedValue(null);
    childProcessMocks.spawn.mockReturnValue(makeSpawnChild());

    await runOpen();

    expect(childProcessMocks.spawn).toHaveBeenCalledWith('open', [appBundle], {
      detached: true,
      stdio: 'ignore',
    });
  });

  it('launches macOS direct executable targets without open', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const executable = makeFile(path.join(makeTempRoot(), 'Makaio.app', 'Contents', 'MacOS', 'Makaio'));
    busClientMocks.probeHealth.mockResolvedValue(null);
    process.env['MAKAIO_APP'] = executable;
    childProcessMocks.spawn.mockReturnValue(makeSpawnChild());

    await runOpen();

    expect(childProcessMocks.spawn).toHaveBeenCalledWith(executable, [], {
      detached: true,
      stdio: 'ignore',
    });
  });

  it('sets exit code when detached spawn emits an error', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const executable = makeFile(path.join(makeTempRoot(), 'custom-makaio'));
    process.env['MAKAIO_APP'] = executable;
    busClientMocks.probeHealth.mockResolvedValue(null);
    childProcessMocks.spawn.mockReturnValue(
      makeSpawnChild((event, callback) => {
        if (event === 'error') callback(new Error('spawn failed'));
      }),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runOpen();

    expect(error).toHaveBeenCalledWith('Failed to launch Makaio: spawn failed');
    expect(process.exitCode).toBe(1);
  });
});
