/**
 * Dependency Resolver Tests
 *
 * Verifies the resolution engine installs roots with their transitive descriptor
 * dependencies, handles optional failures gracefully, rolls back on required
 * failures, and enforces inverse-dependency version constraints.
 */
import { describe, expect, it } from 'bun:test';
import type { ExtensionDescriptor } from '@makaio/contracts';
import { DependencyResolver, type DependencyPackageManager } from '../dependency-resolver.js';
import type { IDescriptorNameResolver } from '../descriptor-name-resolver.js';
import type { InstalledExtensionDescriptor } from '../yarn-integration.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid {@link ExtensionDescriptor} for test use.
 * @param name - Descriptor name (used as {@link ExtensionManifest.name}).
 * @param dependencies - Optional dependency declarations.
 * @param version - SemVer version string for the descriptor.
 * @returns A fully-typed extension descriptor.
 */
function descriptor(
  name: string,
  dependencies: ExtensionDescriptor['dependencies'] = [],
  version = '1.0.0',
): ExtensionDescriptor {
  return {
    name,
    displayName: name,
    version,
    makaio: { framework: '>=0.1.0' },
    entrypoints: { server: true },
    dependencies,
  };
}

/** Fake package manager that tracks installs and supports simulated failures. */
class FakePackages implements DependencyPackageManager {
  /** Ordered list of package specs passed to {@link installPackage}, including failed attempts. */
  public readonly installAttempts: string[] = [];
  /** Ordered list of package specs passed to {@link installPackage}. */
  public readonly installed: string[] = [];
  /** Set to `true` when {@link writeManifestAndReinstall} is called. */
  public restored = false;
  /** Snapshot returned by {@link readManifestSnapshot}. */
  public snapshot = { dependencies: {} };

  /**
   * @param descriptors - Descriptor map keyed by npm package name.
   * @param installedDescriptors - Pre-existing installed descriptors returned by {@link listInstalledExtensionDescriptors}.
   * @param failures - npm names whose {@link installPackage} call should throw.
   * @param resolvedVersions - Package specifier to resolved-version overrides.
   * @param restoreFailure - Optional rollback failure to throw from {@link writeManifestAndReinstall}.
   */
  public constructor(
    private readonly descriptors: Map<string, ExtensionDescriptor>,
    private readonly installedDescriptors: InstalledExtensionDescriptor[] = [],
    private readonly failures = new Set<string>(),
    private readonly resolvedVersions = new Map<string, string>(),
    private readonly restoreFailure: Error | null = null,
  ) {}

  /**
   * Throws when the npm name is in {@link failures}; otherwise records the spec and returns the version.
   * @param packageSpec - Yarn-compatible package specifier.
   * @returns Resolved version string.
   */
  public async installPackage(packageSpec: string): Promise<string> {
    // Strip range suffix to get the base npm name.
    const npmName = packageSpec.replace(/@[^@/]+$/, '');
    this.installAttempts.push(packageSpec);
    if (this.failures.has(npmName)) throw new Error(`install failed for ${npmName}`);
    this.installed.push(packageSpec);
    return this.resolvedVersions.get(packageSpec) ?? this.descriptors.get(npmName)?.version ?? '1.0.0';
  }

  /**
   * Returns the descriptor version for the npm name, or `'1.0.0'` as a fallback.
   * @param packageSpec - Yarn-compatible package specifier.
   * @returns Resolved version string.
   */
  public async resolvePackageVersion(packageSpec: string): Promise<string> {
    const npmName = packageSpec.replace(/@[^@/]+$/, '');
    return this.resolvedVersions.get(packageSpec) ?? this.descriptors.get(npmName)?.version ?? '1.0.0';
  }

  /**
   * Returns the descriptor for the npm name from the constructor map, or `null`.
   * @param npmName - npm package name.
   * @returns Validated descriptor or `null`.
   */
  public async readInstalledExtensionDescriptor(npmName: string): Promise<ExtensionDescriptor | null> {
    return this.descriptors.get(npmName) ?? null;
  }

  /** Returns the pre-existing installed descriptors passed to the constructor. */
  public async listInstalledExtensionDescriptors(): Promise<InstalledExtensionDescriptor[]> {
    return this.installedDescriptors;
  }

  /** Returns the current {@link snapshot} value. */
  public async readManifestSnapshot(): Promise<unknown> {
    return this.snapshot;
  }

  /**
   * Sets {@link restored} to `true` to signal rollback was called.
   * @param _snapshot - Opaque manifest snapshot (unused by the fake).
   */
  public async writeManifestAndReinstall(_snapshot: unknown): Promise<void> {
    if (this.restoreFailure) {
      throw this.restoreFailure;
    }
    this.restored = true;
  }
}

/**
 * Fake name resolver that maps descriptor names to npm names via a fixed map.
 * Falls back to using the descriptor name as-is when no mapping exists.
 */
class FakeNames implements IDescriptorNameResolver {
  /**
   * @param map - Explicit descriptor-name → npm-name mapping.
   */
  public constructor(private readonly map: ReadonlyMap<string, string>) {}

  /**
   * Returns the mapping from the constructor map, or passes the descriptor name through unchanged.
   * @param descriptorName - Descriptor name from `descriptor.json`.
   * @returns Resolved npm package name.
   */
  public async resolveNpmPackageName(descriptorName: string): Promise<string> {
    return this.map.get(descriptorName) ?? descriptorName;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DependencyResolver', () => {
  it('installs roots and transitive descriptor dependencies', async () => {
    const childDescriptor = descriptor('child');
    const rootDescriptor = descriptor('root', [{ type: 'extension', name: 'child', version: '>=1.0.0' }]);

    const packages = new FakePackages(
      new Map([
        ['@makaio/root', rootDescriptor],
        ['@makaio/child', childDescriptor],
      ]),
    );
    const names = new FakeNames(new Map([['child', '@makaio/child']]));
    const resolver = new DependencyResolver(packages, names);

    const result = await resolver.resolve(['@makaio/root']);

    expect(packages.installed).toEqual(['@makaio/root', '@makaio/child@>=1.0.0']);
    expect(result.installed.map((p) => p.npmName)).toEqual(['@makaio/root', '@makaio/child']);
    expect(result.installed.every((p) => p.source === 'new')).toBe(true);
    expect(result.skipped).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('rejects a transitive dependency whose installed descriptor name does not match the declared dependency', async () => {
    const wrongDescriptor = descriptor('wrong-child');
    const rootDescriptor = descriptor('root', [{ type: 'extension', name: 'child', version: '>=1.0.0' }]);

    const packages = new FakePackages(
      new Map([
        ['@makaio/root', rootDescriptor],
        ['@makaio/child', wrongDescriptor],
      ]),
    );
    const names = new FakeNames(new Map([['child', '@makaio/child']]));
    const resolver = new DependencyResolver(packages, names);

    await expect(resolver.resolve(['@makaio/root'])).rejects.toThrow(
      'Installed package @makaio/child declares descriptor name "wrong-child", expected "child"',
    );
    expect(packages.restored).toBe(true);
  });

  it('rejects an unscoped root whose installed descriptor name does not match the requested root', async () => {
    const packages = new FakePackages(new Map([['weather-tools', descriptor('wrong-root')]]));
    const resolver = new DependencyResolver(packages, new FakeNames(new Map()));

    await expect(resolver.resolve(['weather-tools'])).rejects.toThrow(
      'Installed package weather-tools declares descriptor name "wrong-root", expected "weather-tools"',
    );
    expect(packages.restored).toBe(true);
  });

  it('uses installed descriptor versions when checking dependency range satisfaction', async () => {
    const rootDescriptor = descriptor('root', [{ type: 'extension', name: 'shared', version: '>=2.0.0' }]);
    const sharedDescriptor = descriptor('shared', [], '2.0.0');
    const packages = new FakePackages(new Map([['@makaio/root', rootDescriptor]]), [
      { npmName: '@makaio/shared', version: '0.1.0', descriptor: sharedDescriptor },
    ]);
    const names = new FakeNames(new Map([['shared', '@makaio/shared']]));
    const resolver = new DependencyResolver(packages, names);

    const result = await resolver.resolve(['@makaio/root']);

    expect(packages.installed).toEqual(['@makaio/root']);
    expect(result.installed).toEqual([
      { npmName: '@makaio/root', version: '1.0.0', source: 'new' },
      { npmName: '@makaio/shared', version: '0.1.0', source: 'already-present' },
    ]);
  });

  it('skips optional dependencies that fail to install', async () => {
    const optionalDescriptor = descriptor('optional');
    const rootDescriptor = descriptor('root', [
      { type: 'extension', name: 'optional', version: '>=1.0.0', optional: true },
    ]);

    const packages = new FakePackages(
      new Map([
        ['@makaio/root', rootDescriptor],
        ['@makaio/optional', optionalDescriptor],
      ]),
      [],
      new Set(['@makaio/optional']),
    );
    const names = new FakeNames(new Map([['optional', '@makaio/optional']]));
    const resolver = new DependencyResolver(packages, names);

    const result = await resolver.resolve(['@makaio/root']);

    expect(result.installed.map((p) => p.npmName)).toContain('@makaio/root');
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].npmName).toBe('@makaio/optional');
    expect(result.skipped[0].reason).toMatch(/install failed/);
    expect(packages.restored).toBe(false);
  });

  it('rolls back required dependency failures', async () => {
    const requiredDescriptor = descriptor('required');
    const rootDescriptor = descriptor('root', [{ type: 'extension', name: 'required', version: '>=1.0.0' }]);

    const packages = new FakePackages(
      new Map([
        ['@makaio/root', rootDescriptor],
        ['@makaio/required', requiredDescriptor],
      ]),
      [],
      new Set(['@makaio/required']),
    );
    const names = new FakeNames(new Map([['required', '@makaio/required']]));
    const resolver = new DependencyResolver(packages, names);

    await expect(resolver.resolve(['@makaio/root'])).rejects.toThrow('install failed');
    expect(packages.restored).toBe(true);
  });

  it('normalizes root package specifiers before reading installed descriptors', async () => {
    const rootDescriptor = descriptor('root', [], '2.0.0');
    const packages = new FakePackages(new Map([['@makaio/root', rootDescriptor]]));
    const resolver = new DependencyResolver(packages, new FakeNames(new Map()));

    const result = await resolver.resolve(['@makaio/root@2.0.0']);

    expect(packages.installed).toEqual(['@makaio/root@2.0.0']);
    expect(result.installed).toEqual([{ npmName: '@makaio/root', version: '2.0.0', source: 'new' }]);
    expect(packages.restored).toBe(false);
  });

  it('upgrades an already-installed bare root install to the latest candidate', async () => {
    const oldDescriptor = descriptor('root', [], '1.0.0');
    const newDescriptor = descriptor('root', [], '2.0.0');
    const packages = new FakePackages(
      new Map([['@makaio/root', newDescriptor]]),
      [{ npmName: '@makaio/root', version: '1.0.0', descriptor: oldDescriptor }],
      new Set(),
      new Map([['@makaio/root', '2.0.0']]),
    );
    const resolver = new DependencyResolver(packages, new FakeNames(new Map()));

    const result = await resolver.resolve(['@makaio/root']);

    expect(packages.installed).toEqual(['@makaio/root']);
    expect(result.installed).toEqual([{ npmName: '@makaio/root', version: '2.0.0', source: 'upgraded' }]);
  });

  it('uses a satisfying installed dependency and still enqueues its descriptor dependencies', async () => {
    const rootDescriptor = descriptor('root', [{ type: 'extension', name: 'child', version: '>=1.0.0' }]);
    const childDescriptor = descriptor('child', [{ type: 'extension', name: 'grandchild', version: '>=1.0.0' }]);
    const grandchildDescriptor = descriptor('grandchild');
    const packages = new FakePackages(
      new Map([
        ['@makaio/root', rootDescriptor],
        ['@makaio/grandchild', grandchildDescriptor],
      ]),
      [{ npmName: '@makaio/child', version: '1.0.0', descriptor: childDescriptor }],
    );
    const names = new FakeNames(
      new Map([
        ['child', '@makaio/child'],
        ['grandchild', '@makaio/grandchild'],
      ]),
    );
    const resolver = new DependencyResolver(packages, names);

    const result = await resolver.resolve(['@makaio/root']);

    expect(packages.installed).toEqual(['@makaio/root', '@makaio/grandchild@>=1.0.0']);
    expect(result.installed).toEqual([
      { npmName: '@makaio/root', version: '1.0.0', source: 'new' },
      { npmName: '@makaio/child', version: '1.0.0', source: 'already-present' },
      { npmName: '@makaio/grandchild', version: '1.0.0', source: 'new' },
    ]);
  });

  it('rejects incompatible duplicate dependency ranges using descriptor versions', async () => {
    const sharedDescriptor = descriptor('shared', [], '1.5.0');
    const rootADescriptor = descriptor('root-a', [{ type: 'extension', name: 'shared', version: '<2.0.0' }]);
    const rootBDescriptor = descriptor('root-b', [{ type: 'extension', name: 'shared', version: '>=2.0.0' }]);
    const packages = new FakePackages(
      new Map([
        ['@makaio/root-a', rootADescriptor],
        ['@makaio/root-b', rootBDescriptor],
        ['@makaio/shared', sharedDescriptor],
      ]),
      [],
      new Set(),
      new Map([
        ['@makaio/shared@<2.0.0', '1.5.0'],
        ['@makaio/shared@>=2.0.0', '2.0.0'],
      ]),
    );
    const names = new FakeNames(
      new Map([
        ['shared', '@makaio/shared'],
        ['root-a', '@makaio/root-a'],
        ['root-b', '@makaio/root-b'],
      ]),
    );
    const resolver = new DependencyResolver(packages, names);

    await expect(resolver.resolve(['@makaio/root-a', '@makaio/root-b'])).rejects.toThrow(
      '@makaio/root-b requires shared >=2.0.0',
    );
    expect(packages.installed).toEqual(['@makaio/root-a', '@makaio/root-b', '@makaio/shared@<2.0.0']);
    expect(packages.restored).toBe(true);
  });

  it('retries a required duplicate after an optional duplicate fails', async () => {
    const rootADescriptor = descriptor('root-a', [
      { type: 'extension', name: 'shared', version: '>=1.0.0', optional: true },
    ]);
    const rootBDescriptor = descriptor('root-b', [{ type: 'extension', name: 'shared', version: '>=1.0.0' }]);
    const packages = new FakePackages(
      new Map([
        ['@makaio/root-a', rootADescriptor],
        ['@makaio/root-b', rootBDescriptor],
      ]),
      [],
      new Set(['@makaio/shared']),
    );
    const names = new FakeNames(new Map([['shared', '@makaio/shared']]));
    const resolver = new DependencyResolver(packages, names);

    await expect(resolver.resolve(['@makaio/root-a', '@makaio/root-b'])).rejects.toThrow(
      'install failed for @makaio/shared',
    );
    expect(packages.installAttempts).toEqual([
      '@makaio/root-a',
      '@makaio/root-b',
      '@makaio/shared@>=1.0.0',
      '@makaio/shared@>=1.0.0',
    ]);
    expect(packages.restored).toBe(true);
  });

  it('blocks upgrades that violate installed inverse dependencies', async () => {
    // "dependent" is already installed and requires shared <2.0.0.
    // root requires shared >=2.0.0 — upgrading shared to 2.0.0 would break dependent.
    const oldSharedDescriptor = descriptor('shared', [], '1.5.0');
    const candidateSharedDescriptor = descriptor('shared', [], '2.0.0');
    const rootDescriptor = descriptor('root', [{ type: 'extension', name: 'shared', version: '>=2.0.0' }]);
    const dependentDescriptor = descriptor(
      'dependent',
      [{ type: 'extension', name: 'shared', version: '<2.0.0' }],
      '1.0.0',
    );

    const installedDescriptors: InstalledExtensionDescriptor[] = [
      { npmName: '@makaio/dependent', version: '1.0.0', descriptor: dependentDescriptor },
      { npmName: '@makaio/shared', version: '1.5.0', descriptor: oldSharedDescriptor },
    ];

    const packages = new FakePackages(
      new Map([
        ['@makaio/root', rootDescriptor],
        ['@makaio/shared', candidateSharedDescriptor],
      ]),
      installedDescriptors,
    );
    const names = new FakeNames(
      new Map([
        ['shared', '@makaio/shared'],
        ['dependent', '@makaio/dependent'],
      ]),
    );
    const resolver = new DependencyResolver(packages, names);

    await expect(resolver.resolve(['@makaio/root'])).rejects.toThrow(/Cannot install.*@makaio\/shared/);
  });

  it('checks upgrade compatibility against the candidate descriptor version', async () => {
    const oldSharedDescriptor = descriptor('shared', [], '1.0.0');
    const candidateSharedDescriptor = descriptor('shared', [], '1.5.0');
    const rootDescriptor = descriptor('root', [{ type: 'extension', name: 'shared', version: '>=1.5.0' }]);
    const dependentDescriptor = descriptor(
      'dependent',
      [{ type: 'extension', name: 'shared', version: '>=2.0.0' }],
      '1.0.0',
    );

    const installedDescriptors: InstalledExtensionDescriptor[] = [
      { npmName: '@makaio/dependent', version: '1.0.0', descriptor: dependentDescriptor },
      { npmName: '@makaio/shared', version: '1.0.0', descriptor: oldSharedDescriptor },
    ];

    const packages = new FakePackages(
      new Map([
        ['@makaio/root', rootDescriptor],
        ['@makaio/shared', candidateSharedDescriptor],
      ]),
      installedDescriptors,
      new Set(),
      new Map([['@makaio/shared@>=1.5.0', '3.0.0']]),
    );
    const names = new FakeNames(new Map([['shared', '@makaio/shared']]));
    const resolver = new DependencyResolver(packages, names);

    await expect(resolver.resolve(['@makaio/root'])).rejects.toThrow('@makaio/dependent requires shared >=2.0.0');
    expect(packages.restored).toBe(true);
  });

  it('allows inverse dependency violations when force is true', async () => {
    // Same setup as the blocking test, but force:true bypasses the check.
    const oldSharedDescriptor = descriptor('shared', [], '1.5.0');
    const candidateSharedDescriptor = descriptor('shared', [], '2.0.0');
    const rootDescriptor = descriptor('root', [{ type: 'extension', name: 'shared', version: '>=2.0.0' }]);
    const dependentDescriptor = descriptor(
      'dependent',
      [{ type: 'extension', name: 'shared', version: '<2.0.0' }],
      '1.0.0',
    );

    const installedDescriptors: InstalledExtensionDescriptor[] = [
      { npmName: '@makaio/dependent', version: '1.0.0', descriptor: dependentDescriptor },
      { npmName: '@makaio/shared', version: '1.5.0', descriptor: oldSharedDescriptor },
    ];

    const packages = new FakePackages(
      new Map([
        ['@makaio/root', rootDescriptor],
        ['@makaio/shared', candidateSharedDescriptor],
      ]),
      installedDescriptors,
    );
    const names = new FakeNames(
      new Map([
        ['shared', '@makaio/shared'],
        ['dependent', '@makaio/dependent'],
      ]),
    );
    const resolver = new DependencyResolver(packages, names);

    const result = await resolver.resolve(['@makaio/root'], { force: true });

    expect(result.installed.map((p) => p.npmName)).toContain('@makaio/shared');
    expect(result.installed.find((p) => p.npmName === '@makaio/shared')?.source).toBe('upgraded');
  });

  it('detects circular dependencies', async () => {
    const descriptors = new Map([
      ['@makaio/a', descriptor('a', [{ type: 'extension', name: 'b', version: '>=1.0.0' }])],
      ['@makaio/b', descriptor('b', [{ type: 'extension', name: 'a', version: '>=1.0.0' }])],
    ]);
    const packages = new FakePackages(descriptors);
    const names = new FakeNames(
      new Map([
        ['a', '@makaio/a'],
        ['b', '@makaio/b'],
      ]),
    );
    const resolver = new DependencyResolver(packages, names);

    await expect(resolver.resolve(['@makaio/a'])).rejects.toThrow('Circular dependency detected');
    expect(packages.restored).toBe(true);
  });

  it('reports both install and rollback failures when rollback fails', async () => {
    const rootDescriptor = descriptor('root', [{ type: 'extension', name: 'required', version: '>=1.0.0' }]);
    const packages = new FakePackages(
      new Map([['@makaio/root', rootDescriptor]]),
      [],
      new Set(['@makaio/required']),
      new Map(),
      new Error('rollback failed'),
    );
    const resolver = new DependencyResolver(packages, new FakeNames(new Map([['required', '@makaio/required']])));

    let thrown: unknown;
    try {
      await resolver.resolve(['@makaio/root']);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    if (!(thrown instanceof AggregateError)) {
      throw new Error('Expected dependency resolution to throw an AggregateError');
    }
    expect(thrown.message).toBe(
      'Dependency resolution failed and rollback failed: install failed for @makaio/required',
    );
    expect(thrown.errors.map((error) => (error instanceof Error ? error.message : String(error)))).toEqual([
      'install failed for @makaio/required',
      'rollback failed',
    ]);
  });
});
