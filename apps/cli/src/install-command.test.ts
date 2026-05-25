import { Command } from 'commander';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionDescriptor } from '@makaio/contracts';
import type { PackageInfo } from '@makaio/services-package-manager/namespace';
import type { InstalledExtensionDescriptor } from '@makaio/services-package-manager';
import { makeTestRepo, writeTestManifest } from './__tests__/manifest-test-helpers.js';
import { registerInstallCommand } from './install-command.js';

const installMockState = vi.hoisted(() => ({
  descriptors: new Map<string, ExtensionDescriptor>(),
  failInstalls: new Set<string>(),
  installAttempts: [] as string[],
  manifestRestores: 0,
}));

vi.mock('@makaio/runtime-node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@makaio/runtime-node')>();
  return {
    ...actual,
    readFrameworkVersion: async () => '0.1.0',
  };
});

vi.mock('@makaio/services-package-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@makaio/services-package-manager')>();
  const fs = await import('node:fs/promises');
  const nodePath = await import('node:path');

  class MockYarnPackageManager {
    public constructor(private readonly makaioHome: string) {}

    public async initialize(): Promise<void> {
      await fs.mkdir(this.makaioHome, { recursive: true });
      await this.writePackageJson(await this.readPackageJson());
    }

    public async ensureFrameworkDependency(dependency: { readonly versionRange: string }): Promise<void> {
      const manifest = await this.readPackageJson();
      await this.writePackageJson({
        ...manifest,
        dependencies: { ...manifest.dependencies, '@makaio/framework': dependency.versionRange },
      });
    }

    public async installPackage(packageSpec: string): Promise<string> {
      const npmName = extractPackageName(packageSpec);
      installMockState.installAttempts.push(packageSpec);
      if (installMockState.failInstalls.has(npmName)) {
        throw new Error(`install failed for ${npmName}`);
      }

      const descriptor = descriptorForPackage(npmName, extractRequestedVersion(packageSpec));
      await writeInstalledPackage(this.makaioHome, npmName, descriptor.version, descriptor);
      return descriptor.version;
    }

    public async listPackages(): Promise<PackageInfo[]> {
      const manifest = await this.readPackageJson();
      const packages = await Promise.all(
        Object.keys(manifest.dependencies).map(async (npmName): Promise<PackageInfo | null> => {
          const descriptor = await this.readInstalledExtensionDescriptor(npmName);
          if (descriptor === null) return null;
          return { name: npmName, version: descriptor.version, hasDescriptor: true };
        }),
      );
      return packages.filter((pkg): pkg is PackageInfo => pkg !== null);
    }

    public async readInstalledExtensionDescriptor(npmName: string): Promise<ExtensionDescriptor | null> {
      try {
        const raw = await fs.readFile(nodePath.join(this.packageRoot(npmName), 'descriptor.json'), 'utf-8');
        return JSON.parse(raw) as ExtensionDescriptor;
      } catch {
        return null;
      }
    }

    public async listInstalledExtensionDescriptors(): Promise<InstalledExtensionDescriptor[]> {
      const manifest = await this.readPackageJson();
      const descriptors = await Promise.all(
        Object.keys(manifest.dependencies).map(async (npmName): Promise<InstalledExtensionDescriptor | null> => {
          const descriptor = await this.readInstalledExtensionDescriptor(npmName);
          if (descriptor === null) return null;
          return { npmName, version: descriptor.version, descriptor };
        }),
      );
      return descriptors.filter((descriptor): descriptor is InstalledExtensionDescriptor => descriptor !== null);
    }

    public async readManifestSnapshot(): Promise<unknown> {
      return this.readPackageJson();
    }

    public async writeManifestAndReinstall(snapshot: unknown): Promise<void> {
      await this.writePackageJson(snapshot as TestPackageJson);
      installMockState.manifestRestores += 1;
    }

    private packageJsonPath(): string {
      return nodePath.join(this.makaioHome, 'package.json');
    }

    private packageRoot(npmName: string): string {
      return nodePath.join(this.makaioHome, 'node_modules', ...npmName.split('/'));
    }

    private async readPackageJson(): Promise<TestPackageJson> {
      try {
        const raw = await fs.readFile(this.packageJsonPath(), 'utf-8');
        return normalizePackageJson(JSON.parse(raw) as Partial<TestPackageJson>);
      } catch {
        return { name: 'makaio-packages', version: '1.0.0', private: true, dependencies: {} };
      }
    }

    private async writePackageJson(manifest: TestPackageJson): Promise<void> {
      await fs.mkdir(this.makaioHome, { recursive: true });
      await fs.writeFile(
        this.packageJsonPath(),
        `${JSON.stringify(normalizePackageJson(manifest), null, 2)}\n`,
        'utf-8',
      );
    }
  }

  class MockRegistryService {
    public async getRegistry() {
      return { $schema: 'makaio/package-registry/v1', updatedAt: '', adapters: [], extensions: [] };
    }
  }

  async function writeInstalledPackage(
    makaioHome: string,
    npmName: string,
    version: string,
    descriptor: ExtensionDescriptor,
  ): Promise<void> {
    const manifest = await readHomePackageJson(makaioHome);
    await fs.mkdir(nodePath.join(makaioHome, 'node_modules', ...npmName.split('/')), { recursive: true });
    await fs.writeFile(
      nodePath.join(makaioHome, 'node_modules', ...npmName.split('/'), 'package.json'),
      `${JSON.stringify({ name: npmName, version }, null, 2)}\n`,
      'utf-8',
    );
    await fs.writeFile(
      nodePath.join(makaioHome, 'node_modules', ...npmName.split('/'), 'descriptor.json'),
      `${JSON.stringify(descriptor, null, 2)}\n`,
      'utf-8',
    );
    await fs.writeFile(
      nodePath.join(makaioHome, 'package.json'),
      `${JSON.stringify(
        normalizePackageJson({ ...manifest, dependencies: { ...manifest.dependencies, [npmName]: version } }),
        null,
        2,
      )}\n`,
      'utf-8',
    );
  }

  async function readHomePackageJson(makaioHome: string): Promise<TestPackageJson> {
    try {
      const raw = await fs.readFile(nodePath.join(makaioHome, 'package.json'), 'utf-8');
      return normalizePackageJson(JSON.parse(raw) as Partial<TestPackageJson>);
    } catch {
      return { name: 'makaio-packages', version: '1.0.0', private: true, dependencies: {} };
    }
  }

  return {
    ...actual,
    YarnPackageManager: MockYarnPackageManager,
    RegistryService: MockRegistryService,
  };
});

describe('install command', () => {
  let program: InstanceType<typeof Command>;
  let makaioHome: string;

  beforeEach(async () => {
    makaioHome = await mkdtemp(path.join(tmpdir(), 'makaio-install-home-'));
    installMockState.descriptors = new Map([
      ['@makaio/extension-prompt', makeDescriptor('@makaio/extension-prompt', '1.2.3')],
      ['@makaio/extension-workflow', makeDescriptor('@makaio/extension-workflow', '0.1.4')],
    ]);
    installMockState.failInstalls = new Set<string>();
    installMockState.installAttempts = [];
    installMockState.manifestRestores = 0;
    process.exitCode = undefined;
    program = new Command();
    program.exitOverride();
    registerInstallCommand(program, { makaioHome });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(makaioHome, { recursive: true, force: true });
  });

  it('installs exact manifest extensions that are missing', async () => {
    const repo = await makeTestRepo('makaio-install-command-');
    await writeTestManifest(repo, { extensions: ['@makaio/extension-workflow@0.1.4'] });
    vi.spyOn(process, 'cwd').mockReturnValue(repo);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    await program.parseAsync(['node', 'test', 'install']);

    expect(installMockState.installAttempts).toEqual(['@makaio/extension-workflow@0.1.4']);
    expect(await readHomeDependencies(makaioHome)).toEqual({
      '@makaio/framework': '^0.1.0',
      '@makaio/extension-workflow': '0.1.4',
    });
    expect(infoSpy).toHaveBeenCalledWith('Restart makaio to activate.');
  });

  it('skips exact manifest extensions already installed at the requested version', async () => {
    const repo = await makeTestRepo('makaio-install-command-');
    await writeTestManifest(repo, { extensions: ['@makaio/extension-workflow@0.1.4'] });
    await seedInstalledPackage(makaioHome, '@makaio/extension-workflow', '0.1.4');
    vi.spyOn(process, 'cwd').mockReturnValue(repo);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    await program.parseAsync(['node', 'test', 'install']);

    expect(installMockState.installAttempts).toEqual([]);
    expect(await readHomeDependencies(makaioHome)).toEqual({ '@makaio/extension-workflow': '0.1.4' });
    expect(infoSpy).toHaveBeenCalledWith('All project extensions are installed.');
  });

  it('uses an explicit manifest path when provided', async () => {
    const repo = await makeTestRepo('makaio-install-command-');
    const manifestPath = await writeTestManifest(repo, { extensions: ['@makaio/extension-prompt@1.2.3'] });
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    await program.parseAsync(['node', 'test', 'install', manifestPath]);

    expect(installMockState.installAttempts).toEqual(['@makaio/extension-prompt@1.2.3']);
    expect(await readHomeDependencies(makaioHome)).toEqual({
      '@makaio/framework': '^0.1.0',
      '@makaio/extension-prompt': '1.2.3',
    });
    expect(infoSpy).toHaveBeenCalledWith('Restart makaio to activate.');
  });

  it('restores the package manifest when installing a project extension fails', async () => {
    const repo = await makeTestRepo('makaio-install-command-');
    await writeTestManifest(repo, { extensions: ['@makaio/extension-workflow@0.1.4'] });
    installMockState.failInstalls.add('@makaio/extension-workflow');
    vi.spyOn(process, 'cwd').mockReturnValue(repo);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await program.parseAsync(['node', 'test', 'install']);

    expect(installMockState.installAttempts).toEqual(['@makaio/extension-workflow@0.1.4']);
    expect(installMockState.manifestRestores).toBe(1);
    expect(await readHomeDependencies(makaioHome)).toEqual({});
    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith('Install failed: install failed for @makaio/extension-workflow');
  });
});

interface TestPackageJson {
  readonly name: string;
  readonly version: string;
  readonly private: boolean;
  readonly dependencies: Record<string, string>;
}

function normalizePackageJson(manifest: Partial<TestPackageJson>): TestPackageJson {
  return {
    name: manifest.name ?? 'makaio-packages',
    version: manifest.version ?? '1.0.0',
    private: manifest.private ?? true,
    dependencies: manifest.dependencies ?? {},
  };
}

function makeDescriptor(name: string, version: string): ExtensionDescriptor {
  return {
    name,
    displayName: name,
    version,
    makaio: { framework: '>=0.1.0' },
    entrypoints: { server: true },
  };
}

function descriptorForPackage(npmName: string, requestedVersion: string | undefined): ExtensionDescriptor {
  const descriptor = installMockState.descriptors.get(npmName) ?? makeDescriptor(npmName, requestedVersion ?? '1.0.0');
  if (requestedVersion === undefined || descriptor.version === requestedVersion) {
    return descriptor;
  }
  return { ...descriptor, version: requestedVersion };
}

function extractPackageName(packageSpec: string): string {
  if (packageSpec.startsWith('@')) {
    const scopeSeparator = packageSpec.indexOf('/');
    const versionSeparator = packageSpec.indexOf('@', scopeSeparator + 1);
    return versionSeparator === -1 ? packageSpec : packageSpec.slice(0, versionSeparator);
  }
  const versionSeparator = packageSpec.indexOf('@');
  return versionSeparator === -1 ? packageSpec : packageSpec.slice(0, versionSeparator);
}

function extractRequestedVersion(packageSpec: string): string | undefined {
  const packageName = extractPackageName(packageSpec);
  return packageName.length === packageSpec.length ? undefined : packageSpec.slice(packageName.length + 1);
}

async function seedInstalledPackage(makaioHome: string, npmName: string, version: string): Promise<void> {
  const packageRoot = path.join(makaioHome, 'node_modules', ...npmName.split('/'));
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify({ name: npmName, version }, null, 2)}\n`,
    'utf-8',
  );
  await writeFile(
    path.join(packageRoot, 'descriptor.json'),
    `${JSON.stringify(makeDescriptor(npmName, version), null, 2)}\n`,
    'utf-8',
  );
  await writeFile(
    path.join(makaioHome, 'package.json'),
    `${JSON.stringify(
      normalizePackageJson({ dependencies: { ...(await readHomeDependencies(makaioHome)), [npmName]: version } }),
      null,
      2,
    )}\n`,
    'utf-8',
  );
}

async function readHomeDependencies(makaioHome: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(path.join(makaioHome, 'package.json'), 'utf-8');
    return normalizePackageJson(JSON.parse(raw) as Partial<TestPackageJson>).dependencies;
  } catch {
    return {};
  }
}
