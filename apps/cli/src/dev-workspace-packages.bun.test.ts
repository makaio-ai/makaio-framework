/**
 * Unit tests for dev-mode workspace package discovery.
 *
 * {@link discoverDevWorkspacePackages} is tested end-to-end against a real
 * temporary directory tree. {@link findWorkspaceRootInfo} is mocked so tests do
 * not depend on the actual workspace layout on disk.
 *
 * {@link applyDevWorkspacePackages} from `runtime-config.ts` is tested for
 * correct merge behaviour without touching the filesystem.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

class WorkspaceRootNotFoundError extends Error {
  public constructor(startDir: string) {
    super(`[boot] Could not find workspace root starting from: ${startDir}`);
    this.name = 'WorkspaceRootNotFoundError';
  }
}

const runtimeNodeMocks = {
  findWorkspaceRootInfo:
    mock<
      (startDir: string) => {
        root: string;
        packageJsonPath: string;
        workspaces: readonly string[];
      }
    >(),
  createMakaioConfigDiscovery: mock((config: unknown) => ({ config })),
  loadMakaioConfig: mock(async () => ({
    configPath: undefined,
    config: {
      launcherCommand: undefined,
      packageConfigDefaults: new Map(),
    },
  })),
  resolveMakaioHome: mock(() => '/tmp/.makaio'),
  WorkspaceRootNotFoundError,
};

mock.module('@makaio/runtime-node', () => runtimeNodeMocks);

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { discoverDevWorkspacePackages } from './dev-workspace-packages.js';
import {
  applyDevWorkspacePackages,
  resolveCliRuntimeConfig,
  shouldApplyDevWorkspacePackages,
} from './runtime-config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write a minimal `package.json` into a directory.
 * @param dir - Directory to write into.
 * @param name - Package name value.
 */
async function writePackageJson(dir: string, name: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }));
}

/**
 * Mock workspace-root discovery for the current temporary workspace.
 * @param root - Workspace root directory.
 * @param workspaces - Workspace globs declared by the root manifest.
 */
function mockWorkspaceRoot(root: string, workspaces: readonly string[]): void {
  runtimeNodeMocks.findWorkspaceRootInfo.mockReturnValue({
    root,
    packageJsonPath: path.join(root, 'package.json'),
    workspaces,
  });
}

/** Reset hoisted runtime-node mocks to the default config-loading behavior. */
function resetRuntimeNodeMocks(): void {
  mock.clearAllMocks();
  runtimeNodeMocks.createMakaioConfigDiscovery.mockImplementation((config: unknown) => ({ config }));
  runtimeNodeMocks.loadMakaioConfig.mockResolvedValue({
    configPath: undefined,
    config: {
      launcherCommand: undefined,
      packageConfigDefaults: new Map(),
    },
  });
  runtimeNodeMocks.resolveMakaioHome.mockReturnValue('/tmp/.makaio');
}

// ---------------------------------------------------------------------------
// Tests: discoverDevWorkspacePackages
// ---------------------------------------------------------------------------

describe('discoverDevWorkspacePackages', () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetRuntimeNodeMocks();
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'makaio-dev-workspace-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined when findWorkspaceRootInfo throws WorkspaceRootNotFoundError', async () => {
    runtimeNodeMocks.findWorkspaceRootInfo.mockImplementation((startDir: string) => {
      throw new WorkspaceRootNotFoundError(startDir);
    });

    await expect(discoverDevWorkspacePackages('/some/production/dir')).resolves.toBeUndefined();
  });

  it('re-throws unexpected errors from findWorkspaceRootInfo', async () => {
    runtimeNodeMocks.findWorkspaceRootInfo.mockImplementation(() => {
      throw new Error('disk error');
    });

    await expect(discoverDevWorkspacePackages('/some/dir')).rejects.toThrow('disk error');
  });

  it('returns an empty map when the workspace root has no workspace globs', async () => {
    mockWorkspaceRoot(tmpDir, []);

    const result = await discoverDevWorkspacePackages(tmpDir);

    expect(result).toBeDefined();
    expect(result?.devPortalPackages.size).toBe(0);
    expect(result?.frameworkPackagePath).toBeUndefined();
  });

  it('discovers packages under workspace globs and builds the portal map', async () => {
    const pkgA = path.join(tmpDir, 'packages', 'pkg-a');
    const pkgB = path.join(tmpDir, 'packages', 'pkg-b');
    await writePackageJson(pkgA, '@acme/pkg-a');
    await writePackageJson(pkgB, '@acme/pkg-b');

    mockWorkspaceRoot(tmpDir, ['packages/*']);

    const result = await discoverDevWorkspacePackages(tmpDir);

    expect(result).toBeDefined();
    expect(result?.devPortalPackages.get('@acme/pkg-a')).toBe(pkgA);
    expect(result?.devPortalPackages.get('@acme/pkg-b')).toBe(pkgB);
  });

  it('resolves frameworkPackagePath from the @makaio/framework entry', async () => {
    const frameworkDir = path.join(tmpDir, 'packages', 'framework');
    await writePackageJson(frameworkDir, '@makaio/framework');

    mockWorkspaceRoot(tmpDir, ['packages/*']);

    const result = await discoverDevWorkspacePackages(tmpDir);

    expect(result?.frameworkPackagePath).toBe(frameworkDir);
  });

  it('ignores packages whose package.json has no name field', async () => {
    const pkgDir = path.join(tmpDir, 'packages', 'unnamed');
    await fs.promises.mkdir(pkgDir, { recursive: true });
    await fs.promises.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ version: '1.0.0' }));

    mockWorkspaceRoot(tmpDir, ['packages/*']);

    const result = await discoverDevWorkspacePackages(tmpDir);

    expect(result?.devPortalPackages.size).toBe(0);
  });

  it('skips directories excluded by negation patterns', async () => {
    const included = path.join(tmpDir, 'packages', 'included');
    const excluded = path.join(tmpDir, 'packages', 'excluded');
    await writePackageJson(included, '@acme/included');
    await writePackageJson(excluded, '@acme/excluded');

    mockWorkspaceRoot(tmpDir, ['packages/*', '!packages/excluded']);

    const result = await discoverDevWorkspacePackages(tmpDir);

    expect(result?.devPortalPackages.has('@acme/included')).toBe(true);
    expect(result?.devPortalPackages.has('@acme/excluded')).toBe(false);
  });

  it('silently skips malformed package.json files', async () => {
    const malformed = path.join(tmpDir, 'packages', 'bad');
    const valid = path.join(tmpDir, 'packages', 'good');
    await fs.promises.mkdir(malformed, { recursive: true });
    await fs.promises.writeFile(path.join(malformed, 'package.json'), '{bad json');
    await writePackageJson(valid, '@acme/good');

    mockWorkspaceRoot(tmpDir, ['packages/*']);

    const result = await discoverDevWorkspacePackages(tmpDir);

    expect(result?.devPortalPackages.has('@acme/good')).toBe(true);
    expect(result?.devPortalPackages.size).toBe(1);
  });
});

describe('resolveCliRuntimeConfig', () => {
  beforeEach(() => {
    resetRuntimeNodeMocks();
  });

  it('resolves dev workspace packages only for serve invocations', async () => {
    await resolveCliRuntimeConfig(['node', 'makaio', 'open'], undefined, undefined);

    expect(runtimeNodeMocks.findWorkspaceRootInfo).not.toHaveBeenCalled();

    mockWorkspaceRoot('/tmp/makaio-workspace', []);
    await resolveCliRuntimeConfig(['node', 'makaio', 'serve'], undefined, undefined);

    expect(runtimeNodeMocks.findWorkspaceRootInfo).toHaveBeenCalledTimes(1);
  });

  it('classifies only serve as needing dev workspace package overrides', () => {
    expect(shouldApplyDevWorkspacePackages(['node', 'makaio', 'serve'])).toBe(true);
    expect(shouldApplyDevWorkspacePackages(['node', 'makaio', 'open'])).toBe(false);
    expect(shouldApplyDevWorkspacePackages(['node', 'makaio', '--version'])).toBe(false);
    expect(shouldApplyDevWorkspacePackages(['node', 'makaio'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: applyDevWorkspacePackages
// ---------------------------------------------------------------------------

describe('applyDevWorkspacePackages', () => {
  const devMap = new Map([
    ['@acme/ext-a', '/workspace/ext-a'],
    ['@makaio/framework', '/workspace/framework'],
  ]);
  const devWorkspace = {
    devPortalPackages: devMap,
    frameworkPackagePath: '/workspace/framework',
  };

  it('injects devPortalPackages and frameworkPackagePath when absent in boot overrides', () => {
    const result = applyDevWorkspacePackages(undefined, devWorkspace);

    expect(result.boot?.devPortalPackages).toBe(devMap);
    expect(result.boot?.frameworkPackagePath).toBe('/workspace/framework');
  });

  it('preserves existing devPortalPackages when already set in boot overrides', () => {
    const hostMap = new Map([['@host/pkg', '/host/pkg']]);
    const serveConfig = { boot: { devPortalPackages: hostMap } };

    const result = applyDevWorkspacePackages(serveConfig, devWorkspace);

    expect(result.boot?.devPortalPackages).toBe(hostMap);
  });

  it('preserves existing frameworkPackagePath when already set in boot overrides', () => {
    const serveConfig = { boot: { frameworkPackagePath: '/host/framework' } };

    const result = applyDevWorkspacePackages(serveConfig, devWorkspace);

    expect(result.boot?.frameworkPackagePath).toBe('/host/framework');
  });

  it('preserves other boot override fields when injecting workspace data', () => {
    const serveConfig = { boot: { launcherCommand: 'my-makaio', surface: 'headless' as const } };

    const result = applyDevWorkspacePackages(serveConfig, devWorkspace);

    expect(result.boot?.launcherCommand).toBe('my-makaio');
    expect(result.boot?.surface).toBe('headless');
    expect(result.boot?.devPortalPackages).toBe(devMap);
  });

  it('preserves other top-level serve config fields', () => {
    const resolver = mock<(peerId: string) => Promise<CryptoKey | null>>();
    const serveConfig = { peerSigningKeyResolver: resolver };

    const result = applyDevWorkspacePackages(serveConfig, devWorkspace);

    expect(result.peerSigningKeyResolver).toBe(resolver);
  });
});
