/**
 * Registration tests for the extension install/uninstall/list/update subcommands.
 *
 * These tests verify that {@link registerExtensionCommands} wires the four new
 * subcommands onto the `extension` parent with the correct names and descriptions.
 * They deliberately avoid exercising the I/O-heavy action bodies — those depend on
 * the filesystem, Yarn Berry, and the makaio home directory, which belong in
 * integration tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Command } from 'commander';
import { registerExtensionCommands } from '../extension-commands.js';
import type { PackageInfo } from '@makaio/services-package-manager/namespace';

const yarnMockState = vi.hoisted(() => ({
  packages: [] as PackageInfo[],
  latestVersions: new Map<string, string>(),
  installedPackages: [] as string[],
}));

vi.mock('@makaio/runtime-node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@makaio/runtime-node')>();
  return {
    ...actual,
    resolveMakaioHome: () => '/tmp/makaio-test-home',
  };
});

vi.mock('@makaio/services-package-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@makaio/services-package-manager')>();

  class MockYarnPackageManager {
    public constructor(_makaioHome: string) {}

    public async initialize(): Promise<void> {}

    public async listPackages(): Promise<PackageInfo[]> {
      return yarnMockState.packages;
    }

    public async getLatestVersion(packageName: string): Promise<string> {
      return yarnMockState.latestVersions.get(packageName) ?? 'unknown';
    }

    public async installPackage(packageName: string): Promise<string> {
      yarnMockState.installedPackages.push(packageName);
      return yarnMockState.latestVersions.get(packageName) ?? 'unknown';
    }
  }

  return {
    ...actual,
    YarnPackageManager: MockYarnPackageManager,
  };
});

describe('extension install CLI commands', () => {
  let program: InstanceType<typeof Command>;

  beforeEach(() => {
    yarnMockState.packages = [];
    yarnMockState.latestVersions.clear();
    yarnMockState.installedPackages = [];
    program = new Command();
    program.exitOverride();
    registerExtensionCommands(program);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should register extension install subcommand', () => {
    const ext = program.commands.find((c) => c.name() === 'extension');
    const install = ext?.commands.find((c) => c.name() === 'install');
    expect(install).toBeDefined();
    expect(install?.description()).toBe('Install an extension from npm or a local path');
  });

  it('should register extension uninstall subcommand', () => {
    const ext = program.commands.find((c) => c.name() === 'extension');
    const uninstall = ext?.commands.find((c) => c.name() === 'uninstall');
    expect(uninstall).toBeDefined();
    expect(uninstall?.description()).toBe('Uninstall an extension');
  });

  it('should register extension list subcommand', () => {
    const ext = program.commands.find((c) => c.name() === 'extension');
    const list = ext?.commands.find((c) => c.name() === 'list');
    expect(list).toBeDefined();
    expect(list?.description()).toBe('List installed extensions');
  });

  it('should register extension update subcommand', () => {
    const ext = program.commands.find((c) => c.name() === 'extension');
    const update = ext?.commands.find((c) => c.name() === 'update');
    expect(update).toBeDefined();
    expect(update?.description()).toBe('Update one or all installed extensions');
  });

  it('should skip update when latest version cannot be determined', async () => {
    yarnMockState.packages = [{ name: '@acme/weather-tools', version: '1.0.0', hasDescriptor: true }];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    await program.parseAsync(['node', 'test', 'extension', 'update']);

    expect(warnSpy).toHaveBeenCalledWith('Could not determine latest version for @acme/weather-tools; skipping.');
    expect(infoSpy).not.toHaveBeenCalledWith('@acme/weather-tools@1.0.0 is up to date.');
    expect(yarnMockState.installedPackages).toEqual([]);
  });

  it('should report up to date only when latest version matches installed version', async () => {
    yarnMockState.packages = [{ name: '@acme/weather-tools', version: '1.0.0', hasDescriptor: true }];
    yarnMockState.latestVersions.set('@acme/weather-tools', '1.0.0');
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    await program.parseAsync(['node', 'test', 'extension', 'update']);

    expect(infoSpy).toHaveBeenCalledWith('@acme/weather-tools@1.0.0 is up to date.');
    expect(yarnMockState.installedPackages).toEqual([]);
  });
});
