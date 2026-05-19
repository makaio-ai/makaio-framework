/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Command } from 'commander';
import { HostSubjects } from '@makaio/contracts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any imports that load the mocked modules.
// ---------------------------------------------------------------------------

const connectBusClient = mock();
const probeHealth = mock();
const resolveClientAuth = mock();

mock.module('./bus-client.js', () => ({
  connectBusClient,
  probeHealth,
  resolveClientAuth,
}));

const spawnMock = mock();

mock.module('node:child_process', () => ({
  spawn: spawnMock,
}));

// Import the module under test after mocks are set up.
import { registerOpenCommand } from './open-command.js';

describe('registerOpenCommand', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalLocalAppData = process.env['LOCALAPPDATA'];
  const originalMakaioApp = process.env['MAKAIO_APP'];
  const tempPaths: string[] = [];

  beforeEach(() => {
    mock.restore();
    connectBusClient.mockReset();
    probeHealth.mockReset();
    resolveClientAuth.mockReset();
    spawnMock.mockReset();
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
    once: ReturnType<typeof mock>;
    unref: ReturnType<typeof mock>;
  } {
    return {
      once: mock(onOnce ?? (() => undefined)),
      unref: mock(),
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
    const request = mock().mockResolvedValue({ focused: true, windowId: 7 });
    const disconnect = mock();
    probeHealth.mockResolvedValue({ auth: false });
    resolveClientAuth.mockReturnValue(undefined);
    connectBusClient.mockResolvedValue({ request, disconnect });
    const info = spyOn(console, 'info').mockImplementation(() => undefined);

    await runOpen();

    expect(probeHealth).toHaveBeenCalledTimes(1);
    expect(resolveClientAuth).toHaveBeenCalledWith({ auth: false });
    expect(request).toHaveBeenCalledWith(HostSubjects.app.focus, {});
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('Makaio is now in the foreground.');
  });

  it('sets a failure exit code when the running app cannot be focused', async () => {
    const request = mock().mockResolvedValue({ focused: false, windowId: null });
    const disconnect = mock();
    probeHealth.mockResolvedValue({ auth: false });
    connectBusClient.mockResolvedValue({ request, disconnect });
    const error = spyOn(console, 'error').mockImplementation(() => undefined);

    await runOpen();

    expect(error).toHaveBeenCalledWith('Failed to focus Makaio.');
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it('does not print a startup message when launch is unsupported', async () => {
    Object.defineProperty(process, 'platform', { value: 'aix' });
    probeHealth.mockResolvedValue(null);
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    const info = spyOn(console, 'info').mockImplementation(() => undefined);

    await runOpen();

    expect(error).toHaveBeenCalledWith('Unsupported platform: aix. Open Makaio.app manually.');
    expect(info).not.toHaveBeenCalledWith('Makaio is starting.');
    expect(process.exitCode).toBe(1);
  });

  it('shows development guidance on Windows when no packaged app path is available', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env['LOCALAPPDATA'];
    delete process.env['MAKAIO_APP'];
    probeHealth.mockResolvedValue(null);
    const error = spyOn(console, 'error').mockImplementation(() => undefined);

    await runOpen();

    expect(error).toHaveBeenCalledWith('Cannot launch Makaio because no packaged app path is available.');
    expect(error).toHaveBeenCalledWith('Packaged launchers provide MAKAIO_APP automatically.');
    expect(error).toHaveBeenCalledWith('In development, start the desktop host first with: yarn dev:desktop');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('shows development guidance instead of probing host defaults when no packaged app path is available', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    delete process.env['MAKAIO_APP'];
    probeHealth.mockResolvedValue(null);
    const error = spyOn(console, 'error').mockImplementation(() => undefined);

    await runOpen();

    expect(error).toHaveBeenCalledWith('Cannot launch Makaio because no packaged app path is available.');
    expect(error).toHaveBeenCalledWith('Packaged launchers provide MAKAIO_APP automatically.');
    expect(error).toHaveBeenCalledWith('In development, start the desktop host first with: yarn dev:desktop');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('launches Linux when MAKAIO_APP points at an install root', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const appRoot = makeTempRoot();
    const executable = path.join(appRoot, 'bin', 'makaio');
    makeFile(executable);
    process.env['MAKAIO_APP'] = appRoot;
    probeHealth.mockResolvedValue(null);
    const child = makeSpawnChild();
    spawnMock.mockReturnValue(child);

    await runOpen();

    expect(spawnMock).toHaveBeenCalledWith(executable, [], {
      detached: true,
      stdio: 'ignore',
    });
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it('launches Linux when MAKAIO_APP points directly at the executable', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const executable = makeFile(path.join(makeTempRoot(), 'custom-makaio'));
    process.env['MAKAIO_APP'] = executable;
    probeHealth.mockResolvedValue(null);
    spawnMock.mockReturnValue(makeSpawnChild());

    await runOpen();

    expect(spawnMock).toHaveBeenCalledWith(executable, [], {
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
    probeHealth.mockResolvedValue(null);
    spawnMock.mockReturnValue(makeSpawnChild());

    await runOpen();

    expect(spawnMock).toHaveBeenCalledWith(executable, [], {
      detached: true,
      stdio: 'ignore',
    });
  });

  it('launches Windows when MAKAIO_APP points directly at the executable', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const executable = makeFile(path.join(makeTempRoot(), 'CustomMakaio.exe'));
    process.env['MAKAIO_APP'] = executable;
    probeHealth.mockResolvedValue(null);
    spawnMock.mockReturnValue(makeSpawnChild());

    await runOpen();

    expect(spawnMock).toHaveBeenCalledWith(executable, [], {
      detached: true,
      stdio: 'ignore',
    });
  });

  it('launches macOS app bundles with open', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const appBundle = path.join(makeTempRoot(), 'Makaio.app');
    mkdirSync(appBundle, { recursive: true });
    process.env['MAKAIO_APP'] = appBundle;
    probeHealth.mockResolvedValue(null);
    spawnMock.mockReturnValue(makeSpawnChild());

    await runOpen();

    expect(spawnMock).toHaveBeenCalledWith('open', [appBundle], {
      detached: true,
      stdio: 'ignore',
    });
  });

  it('launches macOS direct executable targets without open', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const executable = makeFile(path.join(makeTempRoot(), 'Makaio.app', 'Contents', 'MacOS', 'Makaio'));
    probeHealth.mockResolvedValue(null);
    process.env['MAKAIO_APP'] = executable;
    spawnMock.mockReturnValue(makeSpawnChild());

    await runOpen();

    expect(spawnMock).toHaveBeenCalledWith(executable, [], {
      detached: true,
      stdio: 'ignore',
    });
  });

  it('sets exit code when detached spawn emits an error', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const executable = makeFile(path.join(makeTempRoot(), 'custom-makaio'));
    process.env['MAKAIO_APP'] = executable;
    probeHealth.mockResolvedValue(null);
    spawnMock.mockReturnValue(
      makeSpawnChild((event, callback) => {
        if (event === 'error') callback(new Error('spawn failed'));
      }),
    );
    const error = spyOn(console, 'error').mockImplementation(() => undefined);

    await runOpen();

    expect(error).toHaveBeenCalledWith('Failed to launch Makaio: spawn failed');
    expect(process.exitCode).toBe(1);
  });
});
