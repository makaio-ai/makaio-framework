import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionEntrypoints } from '@makaio/contracts';
import type { KernelMakaioExtension } from '@makaio/kernel';
import { defineCliSubcommand, type CliContribution } from '@makaio/kernel/cli';
import type { DiscoveredExtension } from '../extension-discovery.js';
import { attachExtensionCliContributions, loadExtensions, isWithinDirectory } from '../load-extensions.js';
import { z } from 'zod';
import { AutomationCronSchedulerToken } from '@makaio/services-core/automation-trigger';

const FRAMEWORK_VERSION = '3.0.0';
let fixtureRoot: string | undefined;

/**
 * Minimal valid KernelMakaioExtension fixture.
 * @param name - Package name used as both `name` and `displayName` base.
 */
const makePackage = (name: string): KernelMakaioExtension => ({
  name,
  displayName: `${name} Display`,
  version: '0.1.0',
});

/**
 * Minimal valid CliContribution fixture.
 * @param name - Command name.
 */
const makeCliContribution = (name: string): CliContribution => ({
  name,
  description: `${name} CLI`,
  subcommands: [defineCliSubcommand('doctor', `${name} CLI doctor`, z.object({}), async () => undefined)],
});

/**
 * Minimal valid DiscoveredExtension fixture.
 * @param overrides - Partial overrides merged into the default fixture.
 */
const makeExtension = (
  overrides: Partial<DiscoveredExtension> & {
    descriptorOverrides?: Record<string, unknown>;
  } = {},
): DiscoveredExtension => {
  const { descriptorOverrides, ...rest } = overrides;
  const descriptor = {
    name: 'test-ext',
    displayName: 'Test Extension',
    version: '1.0.0',
    makaio: { framework: '>=2.0.0' },
    entrypoints: { server: true as const },
    ...descriptorOverrides,
  };
  const extensionPath = rest.extensionPath ?? createExtensionRoot(descriptor.name, descriptor.entrypoints ?? {});
  return {
    descriptor,
    extensionPath,
    source: 'local',
    ...rest,
  };
};

/**
 * Create a real extension root with production candidate files for declared
 * convention entrypoints.
 * @param name - Extension name used for the fixture directory.
 * @param entrypoints - Descriptor entrypoint declarations to materialize.
 * @returns Absolute extension fixture root.
 */
function createExtensionRoot(name: string, entrypoints: ExtensionEntrypoints): string {
  if (fixtureRoot === undefined) {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-load-extensions-'));
  }

  const extensionPath = fs.mkdtempSync(path.join(fixtureRoot, `${name}-`));
  for (const [surface, entrypoint] of Object.entries(entrypoints) as Array<
    [keyof ExtensionEntrypoints, true | string | undefined]
  >) {
    if (entrypoint === undefined) continue;
    const stem = entrypoint === true ? surface : entrypoint;
    if (!isSafeFixtureStem(stem)) continue;
    const candidatePath = path.join(extensionPath, 'dist', `${stem}.mjs`);
    fs.mkdirSync(path.dirname(candidatePath), { recursive: true });
    fs.writeFileSync(candidatePath, 'export default {};\n');
  }

  return extensionPath;
}

/**
 * Check whether a test stem can be safely materialized beneath the fixture root.
 * @param stem - Entrypoint stem to inspect.
 * @returns Whether writing the fixture candidate is safe.
 */
function isSafeFixtureStem(stem: string): boolean {
  if (stem.includes('\\') || stem.startsWith('.') || stem.startsWith('/')) return false;
  return stem.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Stub import that always resolves successfully — replaced per-test as needed. */
const mockImport = async () => ({ default: makePackage('test-ext') });

describe('isWithinDirectory', () => {
  it('accepts a path inside the base directory', () => {
    expect(isWithinDirectory('/ext/dist/server.js', '/ext')).toBe(true);
  });

  it('accepts a nested path', () => {
    expect(isWithinDirectory('/ext/src/deep/nested/file.js', '/ext')).toBe(true);
  });

  it('rejects a path that escapes via ../', () => {
    expect(isWithinDirectory('/ext/../etc/passwd', '/ext')).toBe(false);
  });

  it('rejects an absolute path outside the base', () => {
    expect(isWithinDirectory('/other/malicious.js', '/ext')).toBe(false);
  });

  it('rejects the base directory itself (must be a descendant)', () => {
    expect(isWithinDirectory('/ext', '/ext')).toBe(false);
  });

  // fs.symlinkSync may require elevated privileges on Windows.
  const symlinkTest = process.platform === 'win32' ? it.skip : it;

  symlinkTest('rejects a symlink that escapes the base directory', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-runtime-node-'));
    const extensionRoot = path.join(tempRoot, 'extension');
    const outsideRoot = path.join(tempRoot, 'outside');
    const symlinkPath = path.join(extensionRoot, 'dist', 'server.js');

    try {
      fs.mkdirSync(path.dirname(symlinkPath), { recursive: true });
      fs.mkdirSync(outsideRoot, { recursive: true });
      fs.writeFileSync(path.join(outsideRoot, 'server.js'), 'export default {};');
      fs.symlinkSync(path.join(outsideRoot, 'server.js'), symlinkPath);

      expect(isWithinDirectory(symlinkPath, extensionRoot)).toBe(false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('loadExtensions', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-load-extensions-'));
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    if (fixtureRoot !== undefined) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = undefined;
    }
  });

  it('returns empty packages when given no extensions', async () => {
    const result = await loadExtensions([], {
      frameworkVersion: FRAMEWORK_VERSION,
    });
    expect(result.packages).toStrictEqual([]);
    expect(result.configDefaults.size).toBe(0);
  });

  it('returns a MakaioExtension for a valid extension with server entrypoint', async () => {
    const pkg = makePackage('test-ext');
    const ext = makeExtension();

    const result = await loadExtensions([ext], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => ({ default: pkg }),
    });

    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]).toMatchObject(pkg);
  });

  it('preserves the server package version when descriptor version differs', async () => {
    const pkg = makePackage('test-ext');
    const ext = makeExtension({
      descriptorOverrides: { version: '1.2.3' },
    });

    const result = await loadExtensions([ext], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => ({ default: pkg }),
    });

    expect(result.packages[0]).toMatchObject({ name: 'test-ext', version: '0.1.0' });
  });

  it('skips extension when CLI default export only looks like a manifest', async () => {
    const ext = makeExtension({
      descriptorOverrides: {
        entrypoints: { cli: true as const },
      },
    });

    const result = await attachExtensionCliContributions([ext], [], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => ({
        default: {
          name: 'test-ext',
          description: 'test-ext CLI',
          subcommands: [],
        },
      }),
    });

    expect(result.packages).toHaveLength(0);
    // consoleSpy is fresh per test (beforeEach/afterEach), so toHaveBeenCalledOnce()
    // is precise: it verifies exactly one warning fires for this single skip path.
    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it('skips extension when CLI subcommands are not executable', async () => {
    const ext = makeExtension({
      descriptorOverrides: {
        entrypoints: { cli: true as const },
      },
    });

    const result = await attachExtensionCliContributions([ext], [], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => ({
        default: {
          name: 'test-ext',
          description: 'test-ext CLI',
          subcommands: [{ name: 'doctor', description: 'broken' }],
        },
      }),
    });

    expect(result.packages).toHaveLength(0);
    // consoleSpy is fresh per test (beforeEach/afterEach) — same rationale as above.
    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it('skips CLI-only synthesis when framework range excludes current framework version', async () => {
    const ext = makeExtension({
      descriptorOverrides: {
        entrypoints: { cli: true as const },
        makaio: { framework: '>=4.0.0' },
      },
    });

    const result = await attachExtensionCliContributions([ext], [], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => ({ default: makeCliContribution('test-ext') }),
    });

    expect(result.packages).toStrictEqual([]);
    expect(result.configDefaults.size).toBe(0);
  });

  it('passes the resolved absolute entry path to importModule', async () => {
    const capturedPaths: string[] = [];
    const pkg = makePackage('test-ext');
    const ext = makeExtension({
      descriptorOverrides: { entrypoints: { server: true as const } },
    });

    await loadExtensions([ext], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async (p) => {
        capturedPaths.push(p);
        return { default: pkg };
      },
    });

    expect(capturedPaths).toHaveLength(1);
    expect(capturedPaths[0]).toBe(path.join(ext.extensionPath, 'dist/server.mjs'));
  });

  it('skips extension when descriptor root is not an absolute filesystem path', async () => {
    const ext = makeExtension({
      extensionPath: '',
      descriptorOverrides: { entrypoints: { server: true as const } },
    });

    const result = await loadExtensions([ext], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => {
        throw new Error('import should not be used');
      },
    });

    expect(result.packages).toHaveLength(0);
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy.mock.calls[0]?.[0]).toContain('could not be resolved within extension directory');
  });

  it('skips extension when framework range excludes current framework version', async () => {
    const ext = makeExtension({
      descriptorOverrides: { makaio: { framework: '>=99.0.0' } },
    });

    const result = await loadExtensions([ext], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: mockImport,
    });

    expect(result.packages).toHaveLength(0);
    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it('accepts pre-release framework version that satisfies framework range', async () => {
    // Pre-release version 2.0.0-alpha.1 should satisfy >=1.0.0
    const extensions = [makeExtension({ descriptorOverrides: { makaio: { framework: '>=1.0.0' } } })];
    const result = await loadExtensions(extensions, {
      frameworkVersion: '2.0.0-alpha.1',
      importModule: mockImport,
    });
    expect(result.packages).toHaveLength(1);
  });

  it('loads extension with explicit execution: embedded', async () => {
    const pkg = makePackage('embedded-ext');
    const ext = makeExtension({
      descriptorOverrides: {
        name: 'embedded-ext',
        displayName: 'Embedded Ext',
        execution: 'embedded',
      },
    });

    const result = await loadExtensions([ext], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => ({ default: pkg }),
    });

    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]).toMatchObject(pkg);
  });

  it('skips extension with no server entrypoint', async () => {
    const ext = makeExtension({
      descriptorOverrides: { entrypoints: {} },
    });

    const result = await loadExtensions([ext], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: mockImport,
    });

    expect(result.packages).toHaveLength(0);
    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it('skips extension when importModule throws (e.g. file not found)', async () => {
    const ext = makeExtension();

    const result = await loadExtensions([ext], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => {
        throw new Error('Cannot find module');
      },
    });

    expect(result.packages).toHaveLength(0);
    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it('skips extension when default export is missing name', async () => {
    const ext = makeExtension();

    const result = await loadExtensions([ext], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => ({
        default: { displayName: 'No Name Field' },
      }),
    });

    expect(result.packages).toHaveLength(0);
    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it('skips extension when default export is missing displayName', async () => {
    const ext = makeExtension();

    const result = await loadExtensions([ext], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => ({
        default: { name: 'no-display-name' },
      }),
    });

    expect(result.packages).toHaveLength(0);
    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it('synthesizes a managed package for extension with execution: detached', async () => {
    const importModule = vi.fn(mockImport);
    const ext = makeExtension({
      descriptorOverrides: {
        entrypoints: undefined,
        execution: 'detached',
        transport: { type: 'bus-stdio', command: 'node', args: ['ext.js'] },
      },
    });

    const result = await loadExtensions([ext], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule,
    });

    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]?.name).toBe('test-ext');
    expect(importModule).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('skips a detached extension whose package synthesis fails and continues loading others', async () => {
    const brokenDescriptor = {
      name: 'broken-detached',
      displayName: 'Broken Detached',
      version: '1.0.0',
      makaio: { framework: '>=1.0.0' },
      execution: 'detached',
      transport: { type: 'bus-stdio', command: 'node', args: ['ext.js'] },
    } satisfies DiscoveredExtension['descriptor'];
    Object.defineProperty(brokenDescriptor, 'displayName', {
      get: () => {
        throw new Error('descriptor display name unavailable');
      },
    });
    const validExt = makeExtension({
      descriptorOverrides: {
        name: 'valid-ext',
        displayName: 'Valid Extension',
      },
    });

    const result = await loadExtensions(
      [
        {
          descriptor: brokenDescriptor,
          extensionPath: createExtensionRoot('broken-detached', {}),
          source: 'local',
        },
        validExt,
      ],
      {
        frameworkVersion: FRAMEWORK_VERSION,
        importModule: async () => ({ default: makePackage('valid-ext') }),
      },
    );

    expect(result.packages.map((pkg) => pkg.name)).toStrictEqual(['valid-ext']);
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy.mock.calls[0]?.[0]).toContain('failed to synthesize detached extension package');
  });

  it('skips detached extension when framework range excludes current framework version', async () => {
    const importModule = vi.fn(mockImport);
    const ext = makeExtension({
      descriptorOverrides: {
        entrypoints: undefined,
        makaio: { framework: '>=99.0.0' },
        execution: 'detached',
        transport: { type: 'bus-stdio', command: 'node', args: ['ext.js'] },
      },
    });

    const result = await loadExtensions([ext], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule,
    });

    expect(result.packages).toHaveLength(0);
    expect(importModule).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it('skips extension when framework range is not a valid semver range', async () => {
    const ext = makeExtension({
      descriptorOverrides: { makaio: { framework: 'not-a-range' } },
    });

    const result = await loadExtensions([ext], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: mockImport,
    });

    expect(result.packages).toHaveLength(0);
    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it('skips extension when imported package name does not match descriptor name', async () => {
    const ext = makeExtension(); // descriptor.name = 'test-ext'

    const result = await loadExtensions([ext], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => ({
        default: { name: 'wrong-name', displayName: 'Wrong', version: '0.1.0' },
      }),
    });

    expect(result.packages).toHaveLength(0);
    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it('accepts an extension package array when names stay under the descriptor namespace', async () => {
    const ext = makeExtension();

    const result = await loadExtensions([ext], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => ({
        default: [makePackage('test-ext'), makePackage('test-ext.secondary-package')],
      }),
    });

    expect(result.packages.map((pkg) => pkg.name)).toEqual(['test-ext', 'test-ext.secondary-package']);
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('skips an extension package array when a child package is outside the descriptor namespace', async () => {
    const ext = makeExtension();

    const result = await loadExtensions([ext], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => ({
        default: [makePackage('test-ext'), makePackage('secondary-package')],
      }),
    });

    expect(result.packages).toHaveLength(0);
    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it('skips a package array with duplicate package names', async () => {
    const ext = makeExtension();

    const result = await loadExtensions([ext], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => ({
        default: [makePackage('test-ext'), makePackage('test-ext')],
      }),
    });

    expect(result.packages).toHaveLength(0);
    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it('rejects local extension package arrays with unscoped package names', async () => {
    const ext = makeExtension({
      source: 'local',
    });

    const result = await loadExtensions([ext], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => ({
        default: [makePackage('test-ext'), makePackage('credential')],
      }),
    });

    expect(result.packages).toHaveLength(0);
    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it('skips a package array when no package matches the descriptor name', async () => {
    const ext = makeExtension();

    const result = await loadExtensions([ext], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => ({
        default: [makePackage('secondary-package')],
      }),
    });

    expect(result.packages).toHaveLength(0);
    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it('skips extension when server entrypoint escapes extension directory', async () => {
    const ext = makeExtension({
      descriptorOverrides: { entrypoints: { server: '../../../etc/malicious.js' } },
    });

    const result = await loadExtensions([ext], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: mockImport,
    });

    expect(result.packages).toHaveLength(0);
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy.mock.calls[0]?.[0]).toContain('could not be resolved within extension directory');
  });

  it('loads valid extensions and skips invalid ones in a mixed list', async () => {
    const validPkg = makePackage('valid-ext');

    const extensions = [
      makeExtension({
        descriptorOverrides: {
          name: 'valid-ext',
          displayName: 'Valid Ext',
          entrypoints: { server: true as const },
        },
      }),
      makeExtension({
        descriptorOverrides: {
          name: 'version-gated',
          displayName: 'Version Gated',
          makaio: { framework: '>=99.0.0' },
        },
      }),
      makeExtension({
        descriptorOverrides: {
          name: 'no-entry',
          displayName: 'No Entry',
          entrypoints: {},
        },
      }),
    ];

    const result = await loadExtensions(extensions, {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => ({ default: validPkg }),
    });

    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]).toMatchObject(validPkg);
    expect(consoleSpy).toHaveBeenCalledTimes(2);
  });

  it('populates configDefaults when descriptor has config.defaults', async () => {
    const ext = makeExtension({
      descriptorOverrides: { config: { defaults: { timeout: 30, retries: 3 } } },
    });

    const result = await loadExtensions([ext], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => ({ default: makePackage('test-ext') }),
    });

    expect(result.configDefaults.size).toBe(1);
    expect(result.configDefaults.get('test-ext')).toStrictEqual({ timeout: 30, retries: 3 });
  });

  it('leaves configDefaults empty when descriptor has no config.defaults', async () => {
    const ext = makeExtension();

    const result = await loadExtensions([ext], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => ({ default: makePackage('test-ext') }),
    });

    expect(result.configDefaults.size).toBe(0);
  });

  it('extracts an owner-anchored cron scheduler policy outside the descriptor package namespace', async () => {
    const schedulerPackage = makePackage(AutomationCronSchedulerToken.name);
    const result = await loadExtensions([makeExtension()], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => ({
        default: [makePackage('test-ext'), makePackage('test-ext.worker')],
        automationCronSchedulerHostPolicy: {
          ownerPackageName: 'test-ext.worker',
          package: schedulerPackage,
        },
      }),
    });

    expect(result.packages.map(({ name }) => name)).toEqual(['test-ext', 'test-ext.worker']);
    expect(result.automationCronSchedulerHostPolicies).toHaveLength(1);
    expect(result.automationCronSchedulerHostPolicies[0]).toMatchObject({ package: schedulerPackage });
    expect(result.automationCronSchedulerHostPolicies[0]?.ownerPackage).toBe(result.packages[1]);
  });

  it('rejects a malformed host cron scheduler policy export', async () => {
    await expect(
      loadExtensions([makeExtension()], {
        frameworkVersion: FRAMEWORK_VERSION,
        importModule: async () => ({
          default: makePackage('test-ext'),
          automationCronSchedulerHostPolicy: { ownerPackageName: 'test-ext' },
        }),
      }),
    ).rejects.toThrow(
      "named export 'automationCronSchedulerHostPolicy' is not a valid owner-anchored scheduler policy",
    );
  });

  it('rejects a scheduler policy whose owner is absent from the normalized default export', async () => {
    await expect(
      loadExtensions([makeExtension()], {
        frameworkVersion: FRAMEWORK_VERSION,
        importModule: async () => ({
          default: makePackage('test-ext'),
          automationCronSchedulerHostPolicy: {
            ownerPackageName: 'test-ext.missing',
            package: makePackage(AutomationCronSchedulerToken.name),
          },
        }),
      }),
    ).rejects.toThrow("owner 'test-ext.missing' is not a normalized descriptor default package");
  });

  it('rejects a scheduler policy package registered under the wrong token', async () => {
    await expect(
      loadExtensions([makeExtension()], {
        frameworkVersion: FRAMEWORK_VERSION,
        importModule: async () => ({
          default: makePackage('test-ext'),
          automationCronSchedulerHostPolicy: {
            ownerPackageName: 'test-ext',
            package: makePackage('test-ext.scheduler'),
          },
        }),
      }),
    ).rejects.toThrow("policy package 'test-ext.scheduler' must be named 'automation-cron-scheduler'");
  });
});

describe('attachExtensionCliContributions', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'makaio-load-extensions-'));
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    if (fixtureRoot !== undefined) {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
      fixtureRoot = undefined;
    }
  });

  it('attaches descriptor CLI entry to an already loaded package', async () => {
    const basePackage = makePackage('test-ext');
    const ext = makeExtension({
      descriptorOverrides: {
        entrypoints: { server: true as const, cli: true as const },
      },
    });

    const result = await attachExtensionCliContributions([ext], [basePackage], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async (entryPath) => ({
        default: entryPath.endsWith('/dist/cli.mjs') ? makeCliContribution('test-ext') : basePackage,
      }),
    });

    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]?.cli).toMatchObject({
      name: 'test-ext',
      subcommands: [expect.objectContaining({ name: 'doctor', description: 'test-ext CLI doctor' })],
    });
  });

  it('allows descriptor CLI command name to differ from extension package name', async () => {
    const basePackage = makePackage('client-hooks');
    const ext = makeExtension({
      descriptorOverrides: {
        name: 'client-hooks',
        displayName: 'Client Hook Bridge',
        entrypoints: { server: true as const, cli: true as const },
        cli: { name: 'hook', description: 'Bridge client hook events to the bus' },
      },
    });

    const result = await attachExtensionCliContributions([ext], [basePackage], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => ({ default: makeCliContribution('hook') }),
    });

    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]?.cli).toMatchObject({ name: 'hook' });
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('synthesizes a CLI-only package when no server entry exists', async () => {
    const ext = makeExtension({
      descriptorOverrides: {
        entrypoints: { cli: true as const },
      },
    });

    const result = await attachExtensionCliContributions([ext], [], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => ({ default: makeCliContribution('test-ext') }),
    });

    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]).toMatchObject({
      name: 'test-ext',
      displayName: 'Test Extension',
      cli: {
        name: 'test-ext',
        subcommands: [expect.objectContaining({ name: 'doctor', description: 'test-ext CLI doctor' })],
      },
    });
  });

  it('does not synthesize CLI-only package when a server entry exists but no package loaded', async () => {
    const ext = makeExtension({
      descriptorOverrides: {
        entrypoints: { server: true as const, cli: true as const },
      },
    });

    const result = await attachExtensionCliContributions([ext], [], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => ({ default: makeCliContribution('test-ext') }),
    });

    expect(result.packages).toStrictEqual([]);
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy.mock.calls[0]?.[0]).toContain('server or browser entry is present');
  });

  it('skips CLI attachment when the CLI entrypoint escapes the extension directory', async () => {
    const ext = makeExtension({
      descriptorOverrides: {
        entrypoints: { cli: '../../../etc/passwd' },
      },
    });

    const result = await attachExtensionCliContributions([ext], [], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => ({ default: makeCliContribution('test-ext') }),
    });

    expect(result.packages).toStrictEqual([]);
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy.mock.calls[0]?.[0]).toContain(
      'cli entrypoint has no resolvable candidate within extension directory',
    );
  });

  it('uses filesystem import for CLI descriptors', async () => {
    const ext = makeExtension({
      descriptorOverrides: {
        entrypoints: { cli: true as const },
      },
    });
    const capturedPaths: string[] = [];

    const result = await attachExtensionCliContributions([ext], [], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async (entryPath) => {
        capturedPaths.push(entryPath);
        return { default: makeCliContribution('test-ext') };
      },
    });

    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]?.cli).toMatchObject({ name: 'test-ext' });
    expect(capturedPaths).toStrictEqual([path.join(ext.extensionPath, 'dist/cli.mjs')]);
  });

  it('returns empty configDefaults when no extension has config.defaults', async () => {
    const ext = makeExtension({
      descriptorOverrides: {
        entrypoints: { cli: true as const },
      },
    });

    const result = await attachExtensionCliContributions([ext], [], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => ({ default: makeCliContribution('test-ext') }),
    });

    expect(result.configDefaults.size).toBe(0);
  });

  it('populates configDefaults for a synthesized CLI-only package with config.defaults', async () => {
    const ext = makeExtension({
      descriptorOverrides: {
        entrypoints: { cli: true as const },
        config: { defaults: { theme: 'dark', retries: 5 } },
      },
    });

    const result = await attachExtensionCliContributions([ext], [], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async () => ({ default: makeCliContribution('test-ext') }),
    });

    expect(result.configDefaults.size).toBe(1);
    expect(result.configDefaults.get('test-ext')).toStrictEqual({ theme: 'dark', retries: 5 });
  });

  it('does not populate configDefaults when augmenting an existing package', async () => {
    // configDefaults are only collected for CLI-only synthesized packages.
    // When attaching CLI to an already-loaded server package, the server
    // package's configDefaults were already collected by loadExtensions.
    const basePackage = makePackage('test-ext');
    const ext = makeExtension({
      descriptorOverrides: {
        entrypoints: { server: true as const, cli: true as const },
        config: { defaults: { theme: 'dark' } },
      },
    });

    const result = await attachExtensionCliContributions([ext], [basePackage], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule: async (entryPath) => ({
        default: entryPath.endsWith('/dist/cli.mjs') ? makeCliContribution('test-ext') : basePackage,
      }),
    });

    expect(result.packages).toHaveLength(1);
    expect(result.configDefaults.size).toBe(0);
  });

  it('does not import a CLI entrypoint when the package already declares its own CLI contribution', async () => {
    const basePackage = {
      ...makePackage('test-ext'),
      cli: makeCliContribution('claude'),
    };
    const ext = makeExtension({
      descriptorOverrides: {
        entrypoints: { server: true as const, cli: true as const },
      },
    });
    const importModule = vi.fn(async () => ({ default: makeCliContribution('test-ext') }));

    const result = await attachExtensionCliContributions([ext], [basePackage], {
      frameworkVersion: FRAMEWORK_VERSION,
      importModule,
    });

    expect(result.packages).toEqual([basePackage]);
    expect(importModule).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
  });
});
