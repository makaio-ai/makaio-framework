/**
 * Dependency Resolver
 *
 * Resolves and installs a root set of extension packages together with their
 * transitive descriptor-declared dependencies. Resolution is breadth-first with
 * cycle detection. On any required-dependency failure the pre-install manifest
 * snapshot is restored; optional dependency failures are collected and skipped
 * without triggering a rollback.
 * @packageDocumentation
 */
import { versionSatisfies } from '@makaio/contracts';
import type { ExtensionDescriptor } from '@makaio/contracts';
import type { IDescriptorNameResolver } from './descriptor-name-resolver.js';
import { packageSpecWithRange, type InstalledExtensionDescriptor } from './yarn-integration.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/**
 * Subset of {@link YarnPackageManager} consumed by the resolver.
 *
 * Narrowed to a structural interface so tests can supply lightweight fakes
 * without depending on the real Yarn stack.
 */
export interface DependencyPackageManager {
  /**
   * Install a package (or upgrade an existing one) and return the resolved version.
   * @param packageSpec - Yarn-compatible specifier (e.g. `@acme/pkg` or `@acme/pkg@>=1.0.0`).
   * @returns Resolved version string.
   */
  installPackage: (packageSpec: string) => Promise<string>;
  /**
   * Read and validate the `descriptor.json` for an installed package.
   * @param npmName - npm package name (e.g. `@acme/weather-tools`).
   * @returns Validated descriptor or `null` when absent or invalid.
   */
  readInstalledExtensionDescriptor: (npmName: string) => Promise<ExtensionDescriptor | null>;
  /**
   * List all packages in `node_modules` that ship a valid descriptor.
   * @returns Array of installed extension descriptor records.
   */
  listInstalledExtensionDescriptors: () => Promise<InstalledExtensionDescriptor[]>;
  /**
   * Snapshot the current `package.json` for later restoration.
   * @returns Opaque snapshot token.
   */
  readManifestSnapshot: () => Promise<unknown>;
  /**
   * Write a snapshot back to `package.json` and run `yarn install` to reconcile.
   * @param snapshot - Opaque snapshot obtained from {@link readManifestSnapshot}.
   */
  writeManifestAndReinstall: (snapshot: unknown) => Promise<void>;
}

/**
 * A single successfully installed or already-present package.
 */
export interface ResolvedPackage {
  /** npm package name. */
  readonly npmName: string;
  /** Installed or pre-existing version string. */
  readonly version: string;
  /**
   * Installation outcome.
   *
   * - `'new'` — the package was not present before this resolution.
   * - `'upgraded'` — the package existed but a newer version was installed.
   * - `'already-present'` — the existing version already satisfies the requested range.
   */
  readonly source: 'new' | 'upgraded' | 'already-present';
}

/**
 * A package that was skipped because it is optional and its installation failed.
 */
export interface SkippedPackage {
  /** npm package name. */
  readonly npmName: string;
  /** Human-readable reason the installation was skipped. */
  readonly reason: string;
}

/**
 * Aggregate result returned by {@link DependencyResolver.resolve}.
 */
export interface ResolutionResult {
  /** All packages installed or confirmed already-present during resolution. */
  readonly installed: readonly ResolvedPackage[];
  /** Optional dependencies that failed and were skipped. */
  readonly skipped: readonly SkippedPackage[];
  /** Non-fatal diagnostic messages produced during resolution. */
  readonly warnings: readonly string[];
}

/**
 * Options for a single resolution run.
 */
export interface ResolutionOptions {
  /**
   * When `true`, inverse-dependency version checks are bypassed and existing
   * installed packages that depend on the upgraded package may break.
   */
  readonly force?: boolean;

  /**
   * Pre-captured manifest snapshot for rollback.
   *
   * When provided, the resolver uses this snapshot instead of capturing its own.
   * This avoids a redundant `readManifestSnapshot` + `writeManifestAndReinstall`
   * cycle when the caller already owns the rollback lifecycle (e.g. the service
   * layer wrapping `ensureFrameworkPeer` before calling `resolve`).
   *
   * Pass `null` to disable the resolver's internal rollback entirely — the
   * caller is responsible for restoring state on failure.
   */
  readonly snapshot?: unknown | null;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A single entry in the BFS resolution queue. */
interface QueueEntry {
  /** npm package name to resolve. */
  readonly npmName: string;
  /** Descriptor identity expected after install or lookup, when known. */
  readonly expectedDescriptorName?: string;
  /** Semver range required by the declaring dependency, if any. */
  readonly requiredRange?: string;
  /** Whether a failure to install this entry should be skipped rather than thrown. */
  readonly optional: boolean;
  /** Ancestor chain used for cycle detection. */
  readonly path: readonly string[];
  /** Whether this entry came directly from the user-requested root set. */
  readonly root: boolean;
}

/** Parsed package root input. */
interface ParsedRoot {
  /** npm package name without a version/range suffix. */
  readonly npmName: string;
  /** Optional version or semver range requested by the root specifier. */
  readonly requiredRange?: string;
}

/** Mutable in-memory index of currently-installed extension packages. */
interface InstalledIndex {
  byNpmName: Map<string, InstalledExtensionDescriptor>;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolves a root set of extension npm packages together with their transitive
 * descriptor-declared dependencies.
 *
 * Resolution strategy:
 * 1. Snapshot the manifest for rollback.
 * 2. BFS queue starting from the root npm names.
 * 3. For each entry — skip if already visited; use existing installed version
 *    when it satisfies the required range; otherwise install/upgrade.
 * 4. After each install, read the installed `descriptor.json` to discover the
 *    next wave of dependencies and enqueue them.
 * 5. On any required-dependency failure, restore the manifest snapshot.
 * 6. On an optional-dependency failure, collect the skip reason and continue.
 */
export class DependencyResolver {
  /**
   * @param packages - Package manager providing install, resolve, and rollback operations.
   * @param names - Name resolver that maps descriptor names to npm package names.
   */
  public constructor(
    private readonly packages: DependencyPackageManager,
    private readonly names: IDescriptorNameResolver,
  ) {}

  /**
   * Resolve and install root packages with all transitive descriptor dependencies.
   *
   * On failure of a required dependency the pre-install manifest snapshot is
   * restored before the error is re-thrown.
   * @param roots - Ordered list of root npm package names to install.
   * @param options - Optional resolution control flags.
   * @returns Aggregate resolution result.
   */
  public async resolve(roots: readonly string[], options: ResolutionOptions = {}): Promise<ResolutionResult> {
    const ownsRollback = options.snapshot !== null;
    const snapshot = ownsRollback
      ? options.snapshot !== undefined
        ? options.snapshot
        : await this.packages.readManifestSnapshot()
      : null;

    try {
      return await this.runBfs(roots, options.force === true);
    } catch (error) {
      if (ownsRollback) {
        try {
          await this.packages.writeManifestAndReinstall(snapshot);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `Dependency resolution failed and rollback failed: ${formatErrorMessage(error)}`,
          );
        }
      }
      throw error;
    }
  }

  /**
   * Execute the BFS resolution loop over the root set and their transitive deps.
   * @param roots - Root package specifiers.
   * @param force - Whether to bypass inverse-dependency checks.
   * @returns Aggregate resolution result.
   */
  private async runBfs(roots: readonly string[], force: boolean): Promise<ResolutionResult> {
    const installedIndex = await this.readInstalledIndex();
    const queue: QueueEntry[] = roots.map((root) => {
      const parsed = parseRootPackageSpec(root);
      const expectedDescriptorName = expectedRootDescriptorName(parsed.npmName);
      return {
        npmName: parsed.npmName,
        ...(expectedDescriptorName ? { expectedDescriptorName } : {}),
        ...(parsed.requiredRange ? { requiredRange: parsed.requiredRange } : {}),
        optional: false,
        path: [parsed.npmName],
        root: true,
      };
    });
    const processedNpmNames = new Set<string>();
    const installed: ResolvedPackage[] = [];
    const skipped: SkippedPackage[] = [];
    const warnings: string[] = [];

    while (queue.length > 0) {
      const entry = queue.shift()!;
      const alreadyProcessed = processedNpmNames.has(entry.npmName);
      let current = installedIndex.byNpmName.get(entry.npmName);

      if (alreadyProcessed) {
        if (current) {
          this.assertDescriptorMatches(entry, current.descriptor);
        }
        if (current && this.descriptorRangeSatisfied(current.descriptor, entry.requiredRange)) {
          continue;
        }
        if (!current) {
          throw new Error(`Package ${entry.npmName} was resolved but is missing from the installed index`);
        }
      }

      if (current) {
        this.assertDescriptorMatches(entry, current.descriptor);
      }
      if (current && this.shouldUseCurrentDescriptor(current.descriptor, entry)) {
        installed.push({ npmName: entry.npmName, version: current.version, source: 'already-present' });
        await this.enqueueDependencies(queue, entry, current.descriptor);
        processedNpmNames.add(entry.npmName);
        continue;
      }

      const packageSpec = packageSpecWithRange(entry.npmName, entry.requiredRange);

      let version: string;
      let installedDescriptor: ExtensionDescriptor;
      try {
        version = await this.packages.installPackage(packageSpec);

        const descriptor = await this.packages.readInstalledExtensionDescriptor(entry.npmName);
        if (!descriptor) {
          throw new Error(`Installed package ${entry.npmName} does not contain a valid descriptor.json`);
        }
        this.assertDescriptorMatches(entry, descriptor);
        this.assertDescriptorVersionSatisfies(entry, descriptor);
        await this.assertDependentsCompatible(entry.npmName, descriptor.version, installedIndex, force);
        installedDescriptor = descriptor;
      } catch (error) {
        if (entry.optional) {
          skipped.push({ npmName: entry.npmName, reason: error instanceof Error ? error.message : String(error) });
          continue;
        }
        throw error;
      }

      installed.push({ npmName: entry.npmName, version, source: current ? 'upgraded' : 'new' });
      current = { npmName: entry.npmName, version, descriptor: installedDescriptor };
      installedIndex.byNpmName.set(entry.npmName, current);
      await this.enqueueDependencies(queue, entry, installedDescriptor);
      processedNpmNames.add(entry.npmName);
    }

    return { installed, skipped, warnings };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Build the initial installed index from all currently-installed descriptors.
   * @returns Dual-keyed index of installed extension records.
   */
  private async readInstalledIndex(): Promise<InstalledIndex> {
    const entries = await this.packages.listInstalledExtensionDescriptors();
    return {
      byNpmName: new Map(entries.map((entry) => [entry.npmName, entry])),
    };
  }

  /**
   * Check whether an installed version satisfies the requested semver range.
   * @param descriptor - Installed extension descriptor.
   * @param range - Required semver range, or `undefined` if none was requested.
   * @returns `true` when the version satisfies the range or no range is required.
   */
  private descriptorRangeSatisfied(descriptor: ExtensionDescriptor, range: string | undefined): boolean {
    return range === undefined || versionSatisfies(descriptor.version, range);
  }

  /**
   * Decide whether an installed descriptor should satisfy a queue entry without
   * invoking Yarn.
   *
   * Bare root installs preserve legacy update semantics: `install @scope/pkg`
   * asks Yarn for the latest version even when an older copy is already present.
   * Transitive dependencies with no version range can use any installed version.
   * @param descriptor - Installed extension descriptor.
   * @param entry - Queue entry currently being resolved.
   * @returns `true` when the current package should be reused.
   */
  private shouldUseCurrentDescriptor(descriptor: ExtensionDescriptor, entry: QueueEntry): boolean {
    if (entry.root && entry.requiredRange === undefined) {
      return false;
    }
    return this.descriptorRangeSatisfied(descriptor, entry.requiredRange);
  }

  /**
   * Assert that the descriptor identity matches the queue entry expectation.
   * @param entry - Queue entry currently being resolved.
   * @param descriptor - Installed extension descriptor.
   */
  private assertDescriptorMatches(entry: QueueEntry, descriptor: ExtensionDescriptor): void {
    if (entry.expectedDescriptorName === undefined || descriptor.name === entry.expectedDescriptorName) {
      return;
    }

    throw new Error(
      `Installed package ${entry.npmName} declares descriptor name "${descriptor.name}", expected "${entry.expectedDescriptorName}"`,
    );
  }

  /**
   * Assert that the descriptor version satisfies the queue entry's requested range.
   * @param entry - Queue entry currently being resolved.
   * @param descriptor - Installed extension descriptor.
   */
  private assertDescriptorVersionSatisfies(entry: QueueEntry, descriptor: ExtensionDescriptor): void {
    if (this.descriptorRangeSatisfied(descriptor, entry.requiredRange)) {
      return;
    }

    throw new Error(
      `Installed package ${entry.npmName} descriptor version ${descriptor.version} does not satisfy ${descriptor.name} ${entry.requiredRange}`,
    );
  }

  /**
   * Assert that installing a package at a descriptor version would not violate any
   * existing installed package's dependency range for that package.
   *
   * Iterates all installed descriptors and checks every dependency entry that
   * names the package being upgraded. Throws when at least one installed package
   * would see its range violated unless `force` is `true`.
   * @param npmName - npm name of the package being upgraded.
   * @param candidateDescriptorVersion - Descriptor version that would be installed.
   * @param installedIndex - Current installed index.
   * @param force - When `true`, violations are ignored.
   */
  private async assertDependentsCompatible(
    npmName: string,
    candidateDescriptorVersion: string,
    installedIndex: Pick<InstalledIndex, 'byNpmName'>,
    force: boolean,
  ): Promise<void> {
    if (force) return;

    const violations: string[] = [];
    for (const entry of installedIndex.byNpmName.values()) {
      for (const dep of entry.descriptor.dependencies ?? []) {
        const dependencyNpmName = await this.names.resolveNpmPackageName(dep.name);
        if (dependencyNpmName === npmName && !versionSatisfies(candidateDescriptorVersion, dep.version)) {
          violations.push(`${entry.npmName} requires ${dep.name} ${dep.version}`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(`Cannot install ${npmName}; existing dependencies would be violated:\n${violations.join('\n')}`);
    }
  }

  /**
   * Enqueue the transitive dependencies declared in a freshly-installed descriptor.
   *
   * Performs cycle detection by checking whether the dependency npm name already
   * appears in the current resolution path.
   * @param queue - Active BFS queue to push entries into.
   * @param parent - Queue entry for the package that declared these dependencies.
   * @param installedDescriptor - Descriptor from the installed package.
   */
  private async enqueueDependencies(
    queue: QueueEntry[],
    parent: QueueEntry,
    installedDescriptor: ExtensionDescriptor,
  ): Promise<void> {
    for (const dep of installedDescriptor.dependencies ?? []) {
      const npmName = await this.names.resolveNpmPackageName(dep.name);
      if (parent.path.includes(npmName)) {
        throw new Error(`Circular dependency detected: ${[...parent.path, npmName].join(' -> ')}`);
      }
      queue.push({
        npmName,
        expectedDescriptorName: dep.name,
        requiredRange: dep.version,
        optional: dep.optional === true,
        path: [...parent.path, npmName],
        root: false,
      });
    }
  }
}

/**
 * Return the descriptor identity implied by a root package input, when the
 * root itself is a descriptor/convention name rather than a scoped npm name.
 * @param npmName - Parsed root npm package name.
 * @returns Expected descriptor name or `undefined` when the npm name is scoped.
 */
function expectedRootDescriptorName(npmName: string): string | undefined {
  return npmName.startsWith('@') ? undefined : npmName;
}

/**
 * Parse a root package specifier into npm name plus optional requested range.
 *
 * Yarn accepts root inputs such as `@scope/pkg@2.0.0`; descriptor reads and
 * installed indexes must use only `@scope/pkg`.
 * @param packageSpec - User-provided package name or package specifier.
 * @returns Parsed package name and optional range.
 */
function parseRootPackageSpec(packageSpec: string): ParsedRoot {
  if (packageSpec.startsWith('@')) {
    const slashIndex = packageSpec.indexOf('/');
    if (slashIndex === -1) {
      return { npmName: packageSpec };
    }
    const rangeMarker = packageSpec.indexOf('@', slashIndex + 1);
    if (rangeMarker === -1) {
      return { npmName: packageSpec };
    }
    const requiredRange = packageSpec.slice(rangeMarker + 1);
    return {
      npmName: packageSpec.slice(0, rangeMarker),
      ...(requiredRange === 'latest' ? {} : { requiredRange }),
    };
  }

  const rangeMarker = packageSpec.indexOf('@');
  if (rangeMarker === -1) {
    return { npmName: packageSpec };
  }
  const requiredRange = packageSpec.slice(rangeMarker + 1);
  return {
    npmName: packageSpec.slice(0, rangeMarker),
    ...(requiredRange === 'latest' ? {} : { requiredRange }),
  };
}

/**
 * Format an unknown thrown value for diagnostics.
 * @param error - Value caught from a failed operation.
 * @returns Human-readable error message.
 */
function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
