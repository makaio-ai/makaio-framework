import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliManifest } from '@makaio/contracts';
import { CliRpcSubjects } from '@makaio/kernel/cli';
import { ExplicitDescriptorDiscovery, MAKAIO_CONFIG_FILE_ENV, MAKAIO_HOME_ENV } from '@makaio/runtime-node';
import { createMockBus } from '@makaio/test-utils';
import { z } from 'zod';
import type { ServeOptions } from './serve.js';

const busClientMocks = vi.hoisted(() => ({
  connectBusClient: vi.fn(),
  isAuthConnectionError: vi.fn(),
  probeHealth: vi.fn(),
  resolveClientAuth: vi.fn(),
  resolveBusUrl: vi.fn().mockReturnValue('ws://127.0.0.1:6252/bus'),
}));
const serveMocks = vi.hoisted(() => ({
  serve: vi.fn<(options: ServeOptions) => Promise<void>>(),
}));
const appLaunchMocks = vi.hoisted(() => ({
  launchAppAndWaitForBus: vi.fn().mockResolvedValue({ health: null, launched: false }),
}));

vi.mock('./bus-client.js', () => busClientMocks);
vi.mock('./serve.js', () => serveMocks);
vi.mock('./app-launch.js', () => appLaunchMocks);

import {
  canInvocationProvideBus,
  createProgram,
  discoverLocalExtensions,
  extractRootConfigArg,
  isDiscoveryFreeBuiltin,
  main,
  toCliModuleImportSpecifier,
  type LocalExtensionRegistration,
} from './main.js';
import { createTestTTYFixture } from './test-tty-fixture.js';

const TEST_FRAMEWORK_RANGE = '>=0.1.0';

describe('extractRootConfigArg', () => {
  it('strips root-level --config before the command and returns the path', () => {
    const result = extractRootConfigArg(['node', 'makaio', '--config', './makaio.config.json', 'serve']);

    expect(result).toEqual({
      argv: ['node', 'makaio', 'serve'],
      configPath: './makaio.config.json',
      debounceFailure: false,
      noFailure: false,
      noLaunch: false,
    });
  });

  it('does not consume --config after a subcommand', () => {
    const argv = ['node', 'makaio', 'account-manager', '--config', './account-manager.json'];

    const result = extractRootConfigArg(argv);

    expect(result).toEqual({ argv, debounceFailure: false, noFailure: false, noLaunch: false });
  });

  it('throws when root-level --config has no path', () => {
    expect(() => extractRootConfigArg(['node', 'makaio', '--config'])).toThrow('--config requires a path');
  });

  it('extracts --debounce-failure before the command name', () => {
    const result = extractRootConfigArg(['node', 'makaio', '--debounce-failure', 'hook', 'received']);

    expect(result).toEqual({
      argv: ['node', 'makaio', 'hook', 'received'],
      debounceFailure: true,
      noFailure: false,
      noLaunch: false,
    });
  });

  it('extracts --no-failure before the command name', () => {
    const result = extractRootConfigArg(['node', 'makaio', '--no-failure', 'hook', 'received']);

    expect(result).toEqual({
      argv: ['node', 'makaio', 'hook', 'received'],
      debounceFailure: false,
      noFailure: true,
      noLaunch: false,
    });
  });

  it('extracts --no-launch before the command name', () => {
    const result = extractRootConfigArg(['node', 'makaio', '--no-launch', 'hook', 'handle']);

    expect(result).toEqual({
      argv: ['node', 'makaio', 'hook', 'handle'],
      debounceFailure: false,
      noFailure: false,
      noLaunch: true,
    });
  });

  it('extracts both --debounce-failure and --config together', () => {
    const result = extractRootConfigArg(['node', 'makaio', '--debounce-failure', '--config', './my.config.ts', 'hook']);

    expect(result).toEqual({
      argv: ['node', 'makaio', 'hook'],
      configPath: './my.config.ts',
      debounceFailure: true,
      noFailure: false,
      noLaunch: false,
    });
  });

  it('does not extract root behavior flags after a subcommand', () => {
    const argv = ['node', 'makaio', 'hook', '--debounce-failure', '--no-launch'];
    const result = extractRootConfigArg(argv);

    expect(result.debounceFailure).toBe(false);
    expect(result.noLaunch).toBe(false);
    expect(result.argv).toEqual(argv);
  });
});

describe('isDiscoveryFreeBuiltin', () => {
  it('skips discovery for serve', () => {
    expect(isDiscoveryFreeBuiltin(['node', 'makaio', 'serve'])).toBe(true);
  });

  it('skips discovery for open', () => {
    expect(isDiscoveryFreeBuiltin(['node', 'makaio', 'open'])).toBe(true);
  });

  it('skips discovery for version flags', () => {
    expect(isDiscoveryFreeBuiltin(['node', 'makaio', '--version'])).toBe(true);
    expect(isDiscoveryFreeBuiltin(['node', 'makaio', '-V'])).toBe(true);
  });

  it('skips discovery for local extension authoring commands', () => {
    expect(isDiscoveryFreeBuiltin(['node', 'makaio', 'extension', 'init'])).toBe(true);
    expect(isDiscoveryFreeBuiltin(['node', 'makaio', 'extension', '--help'])).toBe(true);
  });

  it('skips discovery for built-in auto-launch commands', () => {
    expect(isDiscoveryFreeBuiltin(['node', 'makaio', 'auto-launch', 'status'])).toBe(true);
  });

  it('skips discovery for the install command', () => {
    expect(isDiscoveryFreeBuiltin(['node', 'makaio', 'install'])).toBe(true);
  });

  it('does not skip discovery for global help', () => {
    expect(isDiscoveryFreeBuiltin(['node', 'makaio', '--help'])).toBe(false);
    expect(isDiscoveryFreeBuiltin(['node', 'makaio', '-h'])).toBe(false);
  });

  it('does not skip discovery for remote command help', () => {
    expect(isDiscoveryFreeBuiltin(['node', 'makaio', 'account-manager', '--help'])).toBe(false);
  });

  it('does not skip discovery for bare invocation', () => {
    expect(isDiscoveryFreeBuiltin(['node', 'makaio'])).toBe(false);
  });

  it('setup command is not discovery-free', () => {
    expect(isDiscoveryFreeBuiltin(['node', 'makaio', 'setup'])).toBe(false);
  });
});

/** Empty discovery — no local extensions found. */
const emptyDiscovery = new ExplicitDescriptorDiscovery([]);

describe('main — remote manifest behavior', () => {
  beforeEach(() => {
    process.exitCode = undefined;
    vi.clearAllMocks();
    vi.mocked(busClientMocks.isAuthConnectionError).mockImplementation((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return /\b(401|403|auth|unauthori[sz]ed|forbidden|credential|secret)\b/i.test(message);
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('registers open as a built-in command during program creation', () => {
    const program = createProgram();

    const openCommand = program.commands.find((command) => command.name() === 'open');

    expect(openCommand).toBeDefined();
    expect(openCommand!.description()).toContain('desktop app');
  });

  it('runs extension init locally without probing the server first', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-cli-extension-'));
    const targetDir = path.join(tempRoot, 'local-ext');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    try {
      await main(['node', 'makaio', 'extension', 'init', 'local-ext', '--out-dir', targetDir]);

      expect(busClientMocks.probeHealth).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(`Created extension scaffold at ${targetDir}`);
    } finally {
      infoSpy.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('passes config-derived discovery, base runner default, launcher command, and package defaults to serve', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-cli-config-'));
    const extensionRoot = path.join(tempRoot, 'extensions', 'config-cli-extension');
    const configPath = path.join(tempRoot, 'makaio.config.json');

    try {
      await mkdir(extensionRoot, { recursive: true });
      await writeFile(
        path.join(extensionRoot, 'descriptor.json'),
        JSON.stringify({
          name: 'config-cli-extension',
          displayName: 'Config CLI Extension',
          version: '1.0.0',
          makaio: { framework: TEST_FRAMEWORK_RANGE },
          entrypoints: { server: true },
        }),
        'utf-8',
      );
      await writeFile(
        configPath,
        JSON.stringify({
          extensions: {
            discoveryPaths: ['extensions'],
            include: ['config-cli-extension'],
          },
          launcherCommand: 'makaio-from-config',
          packageConfigDefaults: {
            'account-manager': { makaioCommand: 'makaio-from-config' },
          },
        }),
        'utf-8',
      );

      await main(['node', 'makaio', '--config', configPath, 'serve'], [], emptyDiscovery);

      const serveCall = vi.mocked(serveMocks.serve).mock.calls[0];
      if (serveCall === undefined) {
        throw new Error('Expected serve to be called');
      }
      const [serveOptions] = serveCall;
      const discovery = serveOptions.boot?.discovery;
      if (discovery === undefined) {
        throw new Error('Expected config-derived discovery to be forwarded to serve');
      }

      await expect(discovery.discover()).resolves.toMatchObject([
        {
          descriptor: { name: 'config-cli-extension' },
          extensionPath: extensionRoot,
          source: 'local',
        },
      ]);
      expect(serveOptions.boot?.workflowRunner).toEqual({ mode: 'piscina' });
      expect(serveOptions.boot?.launcherCommand).toBe('makaio-from-config');
      expect(serveOptions.boot?.packageConfigDefaults?.get('account-manager')).toEqual({
        makaioCommand: 'makaio-from-config',
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses env-selected config to discover local source-tree commands', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-cli-env-config-'));
    const extensionRoot = path.join(tempRoot, 'extensions', 'account-manager');
    const configPath = path.join(tempRoot, 'makaio.config.json');
    const entryPath = path.join(extensionRoot, 'dist', 'cli.mjs');
    const originalConfigFile = process.env[MAKAIO_CONFIG_FILE_ENV];
    const originalMakaioHome = process.env[MAKAIO_HOME_ENV];
    const stdout: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });

    try {
      await mkdir(extensionRoot, { recursive: true });
      await mkdir(path.dirname(entryPath), { recursive: true });
      await writeFile(
        path.join(extensionRoot, 'descriptor.json'),
        JSON.stringify({
          name: 'account-manager',
          displayName: 'Account Manager',
          version: '0.1.0',
          makaio: { framework: TEST_FRAMEWORK_RANGE },
          entrypoints: { cli: true },
          cli: {
            name: 'account-manager',
            description: 'Manage credentials',
            hasInteractive: true,
            subcommands: [],
          },
        }),
        'utf-8',
      );
      await writeFile(
        entryPath,
        [
          'export default {',
          "  name: 'account-manager',",
          "  description: 'Manage credentials',",
          '  subcommands: [],',
          '};',
        ].join('\n'),
        'utf-8',
      );
      await writeFile(configPath, JSON.stringify({ extensions: { discoveryPaths: ['extensions'] } }), 'utf-8');
      process.env[MAKAIO_CONFIG_FILE_ENV] = configPath;
      process.env[MAKAIO_HOME_ENV] = path.join(tempRoot, '.makaio-dev');
      vi.mocked(busClientMocks.probeHealth).mockResolvedValue(null);

      try {
        await main(['node', 'makaio', 'account-manager', '--help'], [], emptyDiscovery);
      } catch {
        // Commander may throw for help display in the test harness.
      }

      expect(stdout.join('')).toContain('Manage credentials');
      expect(busClientMocks.probeHealth).toHaveBeenCalledOnce();
    } finally {
      stdoutSpy.mockRestore();
      if (originalConfigFile === undefined) {
        delete process.env[MAKAIO_CONFIG_FILE_ENV];
      } else {
        process.env[MAKAIO_CONFIG_FILE_ENV] = originalConfigFile;
      }
      if (originalMakaioHome === undefined) {
        delete process.env[MAKAIO_HOME_ENV];
      } else {
        process.env[MAKAIO_HOME_ENV] = originalMakaioHome;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('fails clearly when a remote-only command only supports interactive execution', async () => {
    const manifest: CliManifest = {
      name: 'remote-only-tui',
      description: 'Remote TUI command',
      hasInteractive: true,
      subcommands: [],
    };
    const { bus } = createMockBus();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    vi.mocked(busClientMocks.probeHealth).mockResolvedValue({ auth: false });
    vi.mocked(busClientMocks.resolveClientAuth).mockReturnValue(undefined);
    vi.mocked(busClientMocks.connectBusClient).mockResolvedValue(bus);
    vi.mocked(bus.request).mockImplementation(async (subject) => {
      if (subject === CliRpcSubjects.listContributions) {
        return { contributions: [manifest] };
      }
      throw new Error(`Unexpected subject: ${String(subject)}`);
    });

    try {
      await main(['node', 'makaio', 'remote-only-tui'], [], emptyDiscovery);

      expect(process.exitCode).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('requires an interactive entry point'));
      expect(bus.disconnect).toHaveBeenCalledOnce();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('skips RPC registration when local discovery already registered the command', async () => {
    const manifest: CliManifest = {
      name: 'account-manager',
      description: 'Manage credentials (remote)',
      hasInteractive: true,
      subcommands: [{ name: 'list', description: 'List accounts' }],
    };
    const { bus } = createMockBus();

    vi.mocked(busClientMocks.probeHealth).mockResolvedValue({ auth: false });
    vi.mocked(busClientMocks.resolveClientAuth).mockReturnValue(undefined);
    vi.mocked(busClientMocks.connectBusClient).mockResolvedValue(bus);
    vi.mocked(bus.request).mockImplementation(async (subject) => {
      if (subject === CliRpcSubjects.listContributions) {
        return { contributions: [manifest] };
      }
      // If cli.execute is called, the remote path was used — fail the test
      if (subject === CliRpcSubjects.execute) {
        throw new Error('Remote RPC execution should not be used for locally-discovered extensions');
      }
      throw new Error(`Unexpected subject: ${String(subject)}`);
    });

    // The local discovery finds account-manager with a CLI entrypoint.
    // registerManifestCommand will register it with a lazy-import action.
    // When the RPC discovery runs, it should skip account-manager because
    // the name is already registered.
    const extRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-cli-local-rpc-dedup-'));
    const cliEntry = path.join(extRoot, 'dist', 'cli.mjs');
    await mkdir(path.dirname(cliEntry), { recursive: true });
    await writeFile(
      cliEntry,
      "export default { name: 'account-manager', description: 'Manage credentials', subcommands: [] };\n",
    );

    const localDiscovery = new ExplicitDescriptorDiscovery([
      {
        descriptor: {
          name: 'account-manager',
          displayName: 'Account Manager',
          version: '0.1.0',
          makaio: { framework: TEST_FRAMEWORK_RANGE },
          entrypoints: { cli: true as const },
          cli: {
            name: 'account-manager',
            description: 'Manage credentials',
            hasInteractive: true,
            subcommands: [{ name: 'list', description: 'List accounts' }],
          },
        },
        extensionPath: extRoot,
        source: 'local',
      },
    ]);

    const output: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });
    try {
      await main(['node', 'makaio', 'account-manager', '--help'], [], localDiscovery);
    } catch {
      // Commander may throw for --help via exitOverride; that's fine
    } finally {
      stdoutSpy.mockRestore();
      await rm(extRoot, { recursive: true, force: true });
    }

    const renderedHelp = output.join('');
    expect(renderedHelp).toContain('Manage credentials');
    expect(renderedHelp).not.toContain('Manage credentials (remote)');
  });

  it('skips local discoveries whose cli entrypoint escapes the extension root', async () => {
    const program = createProgram();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const discovery = new ExplicitDescriptorDiscovery([
      {
        descriptor: {
          name: 'escaping-cli',
          displayName: 'Escaping CLI',
          version: '0.1.0',
          makaio: { framework: TEST_FRAMEWORK_RANGE },
          entrypoints: { cli: true as const },
          cli: {
            name: 'escaping-cli',
            description: 'Should be skipped',
            hasInteractive: true,
            subcommands: [],
          },
        },
        extensionPath: '/safe/root',
        source: 'local',
      },
    ]);

    try {
      const registrations = await discoverLocalExtensions(program, discovery, new Set());

      expect(registrations).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        "[cli] Skipping extension 'escaping-cli': cli entrypoint has no resolvable candidate within extension directory.",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('surfaces an auth-specific connection error when the auth handshake fails for a local interactive command', async () => {
    const localDiscovery = new ExplicitDescriptorDiscovery([]);
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-auth-fallback-'));
    const entryPath = path.join(tempRoot, 'dist', 'cli.mjs');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ttyFixture = createTestTTYFixture();
    ttyFixture.snapshot();
    ttyFixture.set({ stdoutIsTTY: true, stdinIsTTY: true });

    await mkdir(path.dirname(entryPath), { recursive: true });
    await writeFile(
      entryPath,
      [
        'export default {',
        "  name: 'local-url-test',",
        "  description: 'Local URL import test',",
        '  subcommands: [],',
        '  interactive: async () => {',
        "    process.stdout.write('should not execute\\n');",
        '  },',
        '};',
      ].join('\n'),
    );

    localDiscovery.discover = vi.fn().mockResolvedValue([
      {
        descriptor: {
          name: 'local-url-test',
          displayName: 'Local URL Test',
          version: '0.1.0',
          makaio: { framework: TEST_FRAMEWORK_RANGE },
          entrypoints: { cli: true as const },
          cli: {
            name: 'local-url-test',
            description: 'Local URL import test',
            hasInteractive: true,
            subcommands: [],
          },
        },
        extensionPath: tempRoot,
        source: 'local',
      },
    ]);

    vi.mocked(busClientMocks.probeHealth).mockResolvedValue({ auth: true });
    vi.mocked(busClientMocks.resolveClientAuth).mockReturnValue({ token: 'secret' });
    vi.mocked(busClientMocks.connectBusClient).mockRejectedValue(new Error('auth handshake failed'));

    try {
      await main(['node', 'makaio', 'local-url-test'], [], localDiscovery);

      expect(warnSpy).toHaveBeenCalledWith('[cli] Bus connection failed:', 'auth handshake failed');
      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('auth handshake failed'));
      expect(busClientMocks.probeHealth).toHaveBeenCalledOnce();
      expect(busClientMocks.connectBusClient).toHaveBeenCalledOnce();
    } finally {
      ttyFixture.restore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('suppresses connection warnings for help-only local flows while still probing and attempting discovery', async () => {
    const localDiscovery = new ExplicitDescriptorDiscovery([]);
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-help-fallback-'));
    const entryPath = path.join(tempRoot, 'dist', 'cli.mjs');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stdout: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });

    await mkdir(path.dirname(entryPath), { recursive: true });
    await writeFile(
      entryPath,
      [
        'export default {',
        "  name: 'local-help-test',",
        "  description: 'Local help test',",
        '  subcommands: [],',
        '};',
      ].join('\n'),
    );

    localDiscovery.discover = vi.fn().mockResolvedValue([
      {
        descriptor: {
          name: 'local-help-test',
          displayName: 'Local Help Test',
          version: '0.1.0',
          makaio: { framework: TEST_FRAMEWORK_RANGE },
          entrypoints: { cli: true as const },
          cli: {
            name: 'local-help-test',
            description: 'Local help test',
            hasInteractive: true,
            subcommands: [],
          },
        },
        extensionPath: tempRoot,
        source: 'local',
      },
    ]);

    vi.mocked(busClientMocks.probeHealth).mockResolvedValue({ auth: true });
    vi.mocked(busClientMocks.resolveClientAuth).mockReturnValue({ token: 'secret' });
    vi.mocked(busClientMocks.connectBusClient).mockRejectedValue(new Error('auth handshake failed'));

    try {
      try {
        await main(['node', 'makaio', 'local-help-test', '--help'], [], localDiscovery);
      } catch {
        // Commander may still terminate help rendering through its normal
        // exit path in this test harness; the contract here is the absence of
        // connection warnings, not the exact help exit mechanism.
      }

      expect(stdout.join('')).toContain('Local help test');
      expect(stdout.join('')).toContain('auth handshake failed');
      expect(stdout.join('')).not.toContain('Server not running');
      expect(warnSpy).not.toHaveBeenCalled();
      expect(busClientMocks.probeHealth).toHaveBeenCalledOnce();
      expect(busClientMocks.connectBusClient).toHaveBeenCalledOnce();
    } finally {
      stdoutSpy.mockRestore();
      warnSpy.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('reports the nested unknown subcommand instead of the top-level command when discovery is unavailable', async () => {
    const stderr: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });

    vi.mocked(busClientMocks.probeHealth).mockResolvedValue(null);

    try {
      try {
        await main(
          ['node', 'makaio', 'project', 'missing-subcommand'],
          [
            {
              name: 'project',
              description: 'Project command',
              subcommands: [
                {
                  name: 'list',
                  description: 'List projects',
                  schema: z.object({}),
                  handler: vi.fn(() => Promise.resolve()),
                },
              ],
            },
          ],
          emptyDiscovery,
        );
      } catch {
        // Commander still exits this nested-subcommand path in the test harness.
      }

      expect(stderr.join('')).toContain("unknown command 'missing-subcommand'");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('reports a background launch timeout instead of the generic server-start hint', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    vi.mocked(busClientMocks.probeHealth).mockResolvedValue(null);
    vi.mocked(appLaunchMocks.launchAppAndWaitForBus).mockResolvedValue({ health: null, launched: true });

    try {
      await main(['node', 'makaio', 'missing-remote-command'], [], emptyDiscovery);

      expect(process.exitCode).toBe(1);
      expect(appLaunchMocks.launchAppAndWaitForBus).toHaveBeenCalledWith('ws://127.0.0.1:6252/bus');
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Unknown command "missing-remote-command". Makaio server did not become reachable after starting the desktop app in background mode.',
        ),
      );
      expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('Start with: makaio serve'));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('reports the specific auth connection failure for unknown commands after a successful health probe', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    vi.mocked(busClientMocks.probeHealth).mockResolvedValue({ auth: true });
    vi.mocked(busClientMocks.resolveClientAuth).mockReturnValue({ token: 'secret' });
    vi.mocked(busClientMocks.connectBusClient).mockRejectedValue(new Error('auth handshake failed'));

    try {
      await main(['node', 'makaio', 'missing-remote-command'], [], emptyDiscovery);

      expect(process.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Unknown command "missing-remote-command". Bus authentication failed: auth handshake failed',
        ),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('keeps generic connection wording when auth is enabled but the failure is not auth-related', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    vi.mocked(busClientMocks.probeHealth).mockResolvedValue({ auth: true });
    vi.mocked(busClientMocks.resolveClientAuth).mockReturnValue({ token: 'secret' });
    vi.mocked(busClientMocks.connectBusClient).mockRejectedValue(new Error('socket closed'));

    try {
      await main(['node', 'makaio', 'missing-remote-command'], [], emptyDiscovery);

      expect(process.exitCode).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith('[cli] Could not connect to server:', 'socket closed');
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Unknown command "missing-remote-command". Could not connect to Makaio server: socket closed',
        ),
      );
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe('discoverLocalExtensions', () => {
  it('derives subcommand args from the live Zod schema even when the descriptor omits them', async () => {
    const fixtureRoot = path.resolve(import.meta.dirname, '__tests__/fixtures/test-extension');

    const localDiscovery = new ExplicitDescriptorDiscovery([
      {
        descriptor: {
          name: 'test-ext-live-schema',
          displayName: 'Test Extension (live schema)',
          version: '1.0.0',
          makaio: { framework: TEST_FRAMEWORK_RANGE },
          entrypoints: { cli: 'cli/index' },
          cli: {
            name: 'test-ext-live-schema',
            description: 'A test extension',
            subcommands: [{ name: 'greet', description: 'Say hello' }],
          },
        },
        extensionPath: fixtureRoot,
        source: 'local',
      },
    ]);

    const program = createProgram();
    const registrations = await discoverLocalExtensions(program, localDiscovery, new Set());

    expect(registrations).toHaveLength(1);
    const greetSub = registrations[0].manifest.subcommands?.find((s) => s.name === 'greet');
    expect(greetSub).toBeDefined();
    expect(greetSub!.args).toBeDefined();
    expect(greetSub!.args!.some((a) => a.name === 'name' && a.positional)).toBe(true);
  });

  it('skips duplicate local command names within the same discovery batch', async () => {
    const firstRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-cli-local-dup-first-'));
    const secondRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-cli-local-dup-second-'));
    const firstEntry = path.join(firstRoot, 'dist', 'cli.mjs');
    const secondEntry = path.join(secondRoot, 'dist', 'cli.mjs');
    const program = createProgram();

    try {
      await Promise.all([
        mkdir(path.dirname(firstEntry), { recursive: true }),
        mkdir(path.dirname(secondEntry), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          firstEntry,
          [
            'export default {',
            "  name: 'duplicate-local-cli',",
            "  description: 'first local command',",
            '  subcommands: [],',
            '};',
          ].join('\n'),
        ),
        writeFile(
          secondEntry,
          [
            'export default {',
            "  name: 'duplicate-local-cli',",
            "  description: 'second local command',",
            '  subcommands: [],',
            '};',
          ].join('\n'),
        ),
      ]);

      const localDiscovery = new ExplicitDescriptorDiscovery([
        {
          descriptor: {
            name: 'duplicate-local-first',
            displayName: 'Duplicate Local First',
            version: '0.1.0',
            makaio: { framework: TEST_FRAMEWORK_RANGE },
            entrypoints: { cli: true as const },
            cli: {
              name: 'duplicate-local-cli',
              description: 'first local command',
              hasInteractive: true,
              subcommands: [],
            },
          },
          extensionPath: firstRoot,
          source: 'local',
        },
        {
          descriptor: {
            name: 'duplicate-local-second',
            displayName: 'Duplicate Local Second',
            version: '0.1.0',
            makaio: { framework: TEST_FRAMEWORK_RANGE },
            entrypoints: { cli: true as const },
            cli: {
              name: 'duplicate-local-cli',
              description: 'second local command',
              hasInteractive: true,
              subcommands: [],
            },
          },
          extensionPath: secondRoot,
          source: 'local',
        },
      ]);

      const registrations = await discoverLocalExtensions(program, localDiscovery, new Set());

      expect(registrations).toHaveLength(1);
      expect(registrations[0].manifest.description).toBe('first local command');
      expect(registrations[0].cliEntryPath).toBe(firstEntry);
    } finally {
      await rm(firstRoot, { recursive: true, force: true });
      await rm(secondRoot, { recursive: true, force: true });
    }
  });

  it('does not register a local command that collides with an existing builtin name', async () => {
    const extRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-cli-serve-collision-'));
    const cliEntry = path.join(extRoot, 'dist', 'cli.mjs');
    const program = createProgram();

    try {
      await mkdir(path.dirname(cliEntry), { recursive: true });
      await writeFile(cliEntry, "export default { name: 'serve', description: 'collision', subcommands: [] };\n");

      const localDiscovery = new ExplicitDescriptorDiscovery([
        {
          descriptor: {
            name: 'serve-collision',
            displayName: 'Serve Collision',
            version: '0.1.0',
            makaio: { framework: TEST_FRAMEWORK_RANGE },
            entrypoints: { cli: true as const },
            cli: {
              name: 'serve',
              description: 'Should not override builtin serve',
              hasInteractive: true,
              subcommands: [],
            },
          },
          extensionPath: extRoot,
          source: 'local',
        },
      ]);

      const registrations = await discoverLocalExtensions(program, localDiscovery, new Set());

      expect(registrations).toHaveLength(0);
    } finally {
      await rm(extRoot, { recursive: true, force: true });
    }
  });

  it('skips injected contribution names before manifest registration', async () => {
    const extRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-cli-injected-hook-'));
    const cliEntry = path.join(extRoot, 'dist', 'cli.mjs');
    const program = createProgram();

    try {
      await mkdir(path.dirname(cliEntry), { recursive: true });
      await writeFile(cliEntry, "export default { name: 'hook', description: 'placeholder', subcommands: [] };\n");

      const localDiscovery = new ExplicitDescriptorDiscovery([
        {
          descriptor: {
            name: 'client-hooks',
            displayName: 'Client Hooks',
            version: '0.1.0',
            makaio: { framework: TEST_FRAMEWORK_RANGE },
            entrypoints: { cli: true as const },
            cli: {
              name: 'hook',
              description: 'Manifest placeholder for hooks',
              subcommands: [{ name: 'handle', description: 'Placeholder handler' }],
            },
          },
          extensionPath: extRoot,
          source: 'local',
        },
      ]);

      const registrations = await discoverLocalExtensions(program, localDiscovery, new Set(['hook']));

      expect(registrations).toHaveLength(0);
      expect(program.commands.some((command) => command.name() === 'hook')).toBe(false);
    } finally {
      await rm(extRoot, { recursive: true, force: true });
    }
  });
});

describe('canInvocationProvideBus', () => {
  /**
   * Build a minimal {@link LocalExtensionRegistration} with the given manifest.
   * @param name - CLI command name for the manifest.
   * @param canProvideBus - Whether the extension declares bus provisioning capability.
   */
  function makeLocalExt(name: string, canProvideBus?: boolean): LocalExtensionRegistration {
    return {
      manifest: {
        name,
        description: `${name} command`,
        subcommands: [],
        canProvideBus,
      },
      cliEntryPath: `/fake/${name}/cli.mjs`,
      hasInteractive: false,
      importModule: vi.fn(),
    };
  }

  it('returns true when argv[2] matches a local extension with canProvideBus: true', () => {
    const localExtensions = [makeLocalExt('workflow', true)];

    expect(canInvocationProvideBus(['node', 'makaio', 'workflow'], localExtensions)).toBe(true);
  });

  it('returns false when argv[2] matches a local extension with canProvideBus: false', () => {
    const localExtensions = [makeLocalExt('workflow', false)];

    expect(canInvocationProvideBus(['node', 'makaio', 'workflow'], localExtensions)).toBe(false);
  });

  it('returns false when argv[2] matches a local extension with canProvideBus omitted', () => {
    const localExtensions = [makeLocalExt('workflow')];

    expect(canInvocationProvideBus(['node', 'makaio', 'workflow'], localExtensions)).toBe(false);
  });

  it('returns false when argv[2] does not match any local extension', () => {
    const localExtensions = [makeLocalExt('workflow', true)];

    expect(canInvocationProvideBus(['node', 'makaio', 'account-manager'], localExtensions)).toBe(false);
  });

  it('returns false when localExtensions is empty', () => {
    expect(canInvocationProvideBus(['node', 'makaio', 'workflow'], [])).toBe(false);
  });

  it('returns false when argv has no command (bare invocation)', () => {
    const localExtensions = [makeLocalExt('workflow', true)];

    expect(canInvocationProvideBus(['node', 'makaio'], localExtensions)).toBe(false);
  });
});

describe('main — canProvideBus skips desktop auto-launch', () => {
  beforeEach(() => {
    process.exitCode = undefined;
    vi.clearAllMocks();
    vi.mocked(busClientMocks.isAuthConnectionError).mockImplementation((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return /\b(401|403|auth|unauthori[sz]ed|forbidden|credential|secret)\b/i.test(message);
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('skips launchAppAndWaitForBus when targeted local extension has canProvideBus: true and health returns null', async () => {
    vi.mocked(busClientMocks.probeHealth).mockResolvedValue(null);

    // A local discovery that returns an extension with canProvideBus: true.
    const extRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-cli-canprovidebustest-'));
    const cliEntry = path.join(extRoot, 'dist', 'cli.mjs');
    await mkdir(path.dirname(cliEntry), { recursive: true });
    await writeFile(
      cliEntry,
      [
        'export default {',
        "  name: 'workflow',",
        "  description: 'Workflow commands',",
        '  subcommands: [],',
        '  async beforeRun() { return { proceed: true }; },',
        '};',
      ].join('\n'),
    );

    const localDiscovery = new ExplicitDescriptorDiscovery([
      {
        descriptor: {
          name: 'workflow-ext',
          displayName: 'Workflow Extension',
          version: '0.1.0',
          makaio: { framework: TEST_FRAMEWORK_RANGE },
          entrypoints: { cli: true as const },
          cli: {
            name: 'workflow',
            description: 'Workflow commands',
            canProvideBus: true,
            subcommands: [],
          },
        },
        extensionPath: extRoot,
        source: 'local',
      },
    ]);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await main(['node', 'makaio', 'workflow'], [], localDiscovery);

      expect(busClientMocks.probeHealth).toHaveBeenCalledOnce();
      expect(appLaunchMocks.launchAppAndWaitForBus).not.toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
      await rm(extRoot, { recursive: true, force: true });
    }
  });

  it('renders help for canProvideBus command without launching desktop or booting embedded bus', async () => {
    vi.mocked(busClientMocks.probeHealth).mockResolvedValue(null);

    const extRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-cli-canprovidebus-help-'));
    const cliEntry = path.join(extRoot, 'dist', 'cli.mjs');
    const stdout: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });

    await mkdir(path.dirname(cliEntry), { recursive: true });
    await writeFile(
      cliEntry,
      [
        'export default {',
        "  name: 'workflow',",
        "  description: 'Workflow commands',",
        "  provideBus() { throw new Error('embedded bus should not boot for help'); },",
        '  subcommands: [],',
        '};',
      ].join('\n'),
    );

    const localDiscovery = new ExplicitDescriptorDiscovery([
      {
        descriptor: {
          name: 'workflow-ext',
          displayName: 'Workflow Extension',
          version: '0.1.0',
          makaio: { framework: TEST_FRAMEWORK_RANGE },
          entrypoints: { cli: true as const },
          cli: {
            name: 'workflow',
            description: 'Workflow commands',
            canProvideBus: true,
            subcommands: [],
          },
        },
        extensionPath: extRoot,
        source: 'local',
      },
    ]);

    try {
      try {
        await main(['node', 'makaio', 'workflow', '--help'], [], localDiscovery);
      } catch {
        // Commander may throw for help display in the test harness.
      }

      expect(stdout.join('')).toContain('Workflow commands');
      expect(busClientMocks.probeHealth).toHaveBeenCalledOnce();
      expect(appLaunchMocks.launchAppAndWaitForBus).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
      await rm(extRoot, { recursive: true, force: true });
    }
  });

  it('uses external bus when probeHealth succeeds even for canProvideBus extension', async () => {
    const { bus } = createMockBus();

    vi.mocked(busClientMocks.probeHealth).mockResolvedValue({ auth: false });
    vi.mocked(busClientMocks.resolveClientAuth).mockReturnValue(undefined);
    vi.mocked(busClientMocks.connectBusClient).mockResolvedValue(bus);
    vi.mocked(bus.request).mockResolvedValue({ contributions: [] });

    const extRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-cli-canprovidebus-extbus-'));
    const cliEntry = path.join(extRoot, 'dist', 'cli.mjs');
    await mkdir(path.dirname(cliEntry), { recursive: true });
    await writeFile(
      cliEntry,
      [
        'export default {',
        "  name: 'workflow',",
        "  description: 'Workflow commands',",
        '  subcommands: [],',
        '  async beforeRun() { return { proceed: true }; },',
        '};',
      ].join('\n'),
    );

    const localDiscovery = new ExplicitDescriptorDiscovery([
      {
        descriptor: {
          name: 'workflow-ext',
          displayName: 'Workflow Extension',
          version: '0.1.0',
          makaio: { framework: TEST_FRAMEWORK_RANGE },
          entrypoints: { cli: true as const },
          cli: {
            name: 'workflow',
            description: 'Workflow commands',
            canProvideBus: true,
            subcommands: [],
          },
        },
        extensionPath: extRoot,
        source: 'local',
      },
    ]);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await main(['node', 'makaio', 'workflow'], [], localDiscovery);

      expect(busClientMocks.probeHealth).toHaveBeenCalledOnce();
      expect(appLaunchMocks.launchAppAndWaitForBus).not.toHaveBeenCalled();
      expect(busClientMocks.connectBusClient).toHaveBeenCalledOnce();
    } finally {
      consoleErrorSpy.mockRestore();
      await rm(extRoot, { recursive: true, force: true });
    }
  });

  it('preserves existing launch attempt for commands WITHOUT canProvideBus', async () => {
    vi.mocked(busClientMocks.probeHealth).mockResolvedValue(null);
    vi.mocked(appLaunchMocks.launchAppAndWaitForBus).mockResolvedValue({ health: null, launched: false });

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await main(['node', 'makaio', 'account-manager'], [], emptyDiscovery);

      expect(busClientMocks.probeHealth).toHaveBeenCalledOnce();
      expect(appLaunchMocks.launchAppAndWaitForBus).toHaveBeenCalledOnce();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('skips launchAppAndWaitForBus when root --no-launch is set', async () => {
    vi.mocked(busClientMocks.probeHealth).mockResolvedValue(null);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await main(['node', 'makaio', '--no-launch', 'account-manager'], [], emptyDiscovery);

      expect(busClientMocks.probeHealth).toHaveBeenCalledOnce();
      expect(appLaunchMocks.launchAppAndWaitForBus).not.toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('keeps the built-in hook handler when an installed client-hooks descriptor is discovered', async () => {
    vi.mocked(busClientMocks.probeHealth).mockResolvedValue(null);

    const extRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-cli-client-hooks-shadow-'));
    const cliEntry = path.join(extRoot, 'dist', 'cli.mjs');
    const stderr: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });
    const originalStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

    await mkdir(path.dirname(cliEntry), { recursive: true });
    await writeFile(cliEntry, "throw new Error('installed hook descriptor should not be imported');\n");
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    const localDiscovery = new ExplicitDescriptorDiscovery([
      {
        descriptor: {
          name: 'client-hooks',
          displayName: 'Client Hooks',
          version: '0.1.0',
          makaio: { framework: TEST_FRAMEWORK_RANGE },
          entrypoints: { cli: true as const },
          cli: {
            name: 'hook',
            description: 'Manifest placeholder for hooks',
            subcommands: [{ name: 'handle', description: 'Placeholder handler' }],
          },
        },
        extensionPath: extRoot,
        source: 'local',
      },
    ]);

    try {
      await main(
        ['node', 'makaio', '--no-launch', 'hook', 'handle', 'cursor', 'preToolUse', '--fail-close'],
        [],
        localDiscovery,
      );

      expect(appLaunchMocks.launchAppAndWaitForBus).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(stderr.join('')).toContain('[hook handle] error: Makaio bus is unavailable.');
    } finally {
      stderrSpy.mockRestore();
      if (originalStdinIsTTY) {
        Object.defineProperty(process.stdin, 'isTTY', originalStdinIsTTY);
      } else {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      }
      await rm(extRoot, { recursive: true, force: true });
    }
  });
});

describe('toCliModuleImportSpecifier', () => {
  it('converts an absolute filesystem path to a file URL specifier', () => {
    const specifier = toCliModuleImportSpecifier(path.resolve(process.cwd(), 'extension-cli.mjs'));

    expect(specifier.startsWith('file://')).toBe(true);
  });

  it('supports local extension execution through the generated file URL', async () => {
    vi.clearAllMocks();
    const { bus } = createMockBus();
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'makaio-cli-local-import-'));
    const entryPath = path.join(tempRoot, 'dist', 'cli.mjs');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const originalStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    await mkdir(path.dirname(entryPath), { recursive: true });
    await writeFile(
      entryPath,
      [
        'export default {',
        "  name: 'local-url-test',",
        "  description: 'Local URL import test',",
        '  subcommands: [],',
        '  interactive: async () => {',
        "    process.stdout.write('local extension executed\\n');",
        '  },',
        '};',
      ].join('\n'),
    );

    const localDiscovery = new ExplicitDescriptorDiscovery([
      {
        descriptor: {
          name: 'local-url-test',
          displayName: 'Local URL Test',
          version: '0.1.0',
          makaio: { framework: TEST_FRAMEWORK_RANGE },
          entrypoints: { cli: true as const },
          cli: {
            name: 'local-url-test',
            description: 'Local URL import test',
            hasInteractive: true,
            subcommands: [],
          },
        },
        extensionPath: tempRoot,
        source: 'local',
      },
    ]);

    vi.mocked(busClientMocks.probeHealth).mockResolvedValue({ auth: false });
    vi.mocked(busClientMocks.resolveClientAuth).mockReturnValue(undefined);
    vi.mocked(busClientMocks.connectBusClient).mockResolvedValue(bus);

    try {
      await main(['node', 'makaio', 'local-url-test'], [], localDiscovery);

      expect(stdoutSpy).toHaveBeenCalledWith('local extension executed\n');
      expect(busClientMocks.connectBusClient).toHaveBeenCalledOnce();
      expect(busClientMocks.connectBusClient).toHaveBeenCalledWith(undefined, {
        auth: undefined,
        autoReconnect: true,
      });
      expect(bus.disconnect).toHaveBeenCalledOnce();
    } finally {
      if (originalStdoutIsTTY) {
        Object.defineProperty(process.stdout, 'isTTY', originalStdoutIsTTY);
      } else {
        delete (process.stdout as { isTTY?: boolean }).isTTY;
      }
      if (originalStdinIsTTY) {
        Object.defineProperty(process.stdin, 'isTTY', originalStdinIsTTY);
      } else {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      }
      stdoutSpy.mockRestore();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
