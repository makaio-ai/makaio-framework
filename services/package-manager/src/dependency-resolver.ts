/**
 * Dependency Resolver
 *
 * Resolves and installs a root set of extension packages together with their
 * transitive descriptor-declared dependencies. Resolution is breadth-first with
 * cycle detection, and the descriptor graph it leaves behind is validated once
 * at the end, against the resolved target state rather than against the
 * transient state between installs. On any required-dependency failure the
 * pre-install manifest snapshot is restored; optional dependency failures are collected and skipped
 * without triggering a rollback — except an extension-name claim conflict
 * ({@link ExtensionNameClaimedError}), which is an identity violation rather
 * than a failed install and is fatal for optional dependencies too.
 * @packageDocumentation
 */
import { versionSatisfies } from '@makaio/contracts';
import type { ExtensionDescriptor } from '@makaio/contracts';
import type { IDescriptorNameResolver } from './descriptor-name-resolver.js';
import { extractNpmName, packageSpecWithRange, type InstalledExtensionDescriptor } from './yarn-integration.js';

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
   * When `true`, the resolved graph is not validated: existing installed
   * packages that depend on an upgraded package may be left with a version
   * outside their declared range, or with a required dependency name the
   * upgrade released (see {@link DependencyResolver.assertResolvedGraphConsistent}).
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

/**
 * Mutable in-memory index of currently-installed extension packages, keyed by
 * both identities a package carries: the npm name it is installed under, and
 * the extension name its descriptor declares.
 *
 * The two are independent — an npm package may ship a descriptor declaring any
 * name — and only the descriptor name is the runtime identity. Indexing both
 * is what lets {@link DependencyResolver} tell "this npm package is already
 * installed" (a no-op or upgrade) apart from "a *different* npm package
 * already claims this extension name" (an identity collision).
 */
interface InstalledIndex {
  byNpmName: Map<string, InstalledExtensionDescriptor>;
  byDescriptorName: Map<string, InstalledExtensionDescriptor>;
}

/**
 * A package's descriptor declares an extension name another installed npm
 * package already claims.
 *
 * Carried as its own type because it is the one install failure that is not
 * transient: the package is on disk with a descriptor that duplicates an
 * existing runtime identity, so a caller that would otherwise tolerate the
 * failure (an optional dependency) must not, or the resolution reports success
 * while leaving discovery with two packages claiming one name at the next boot.
 * See {@link DependencyResolver.assertDescriptorNameUnclaimed} for why the
 * check can only run after the install.
 */
export class ExtensionNameClaimedError extends Error {
  /**
   * @param npmName - npm package being installed or upgraded.
   * @param descriptorName - Extension name its descriptor declares.
   * @param claimant - Installed package that already declares that name.
   */
  public constructor(
    public readonly npmName: string,
    public readonly descriptorName: string,
    public readonly claimant: InstalledExtensionDescriptor,
  ) {
    super(
      `Package ${npmName} declares extension name "${descriptorName}", which is already installed from ` +
        `${claimant.npmName}@${claimant.version}. Extension names are identities and cannot be shared — ` +
        `uninstall ${claimant.npmName} first, or install a build of ${npmName} that declares a different name.`,
    );
    this.name = 'ExtensionNameClaimedError';
  }
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
 * 6. On an optional-dependency failure, collect the skip reason and continue —
 *    unless it is an {@link ExtensionNameClaimedError}, which is fatal for
 *    optional dependencies too.
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
    /** npm packages whose installed version changed during this resolution. */
    const changedNpmNames = new Set<string>();
    /** Extension names released by a rename, keyed to the package that gave each up. */
    const releasedDescriptorNames = new Map<string, string>();

    while (queue.length > 0) {
      const entry = queue.shift()!;
      const alreadyProcessed = processedNpmNames.has(entry.npmName);
      const current = installedIndex.byNpmName.get(entry.npmName);

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
        this.assertDescriptorNameUnclaimed(entry.npmName, descriptor, installedIndex);
        this.assertDescriptorVersionSatisfies(entry, descriptor);
        installedDescriptor = descriptor;
      } catch (error) {
        // Optionality covers a dependency that could not be installed, not one
        // that must not stay installed. An extension-name claim conflict is the
        // latter: the package is already on disk, so skipping it would leave a
        // duplicate identity behind, report the resolution as successful, and
        // fail at the next boot's discovery instead — where the rollback that
        // removes it again is no longer available. It is fatal regardless of
        // optionality, which is what makes the caller's manifest restore run.
        if (entry.optional && !(error instanceof ExtensionNameClaimedError)) {
          skipped.push({ npmName: entry.npmName, reason: error instanceof Error ? error.message : String(error) });
          continue;
        }
        throw error;
      }

      installed.push({ npmName: entry.npmName, version, source: current ? 'upgraded' : 'new' });
      changedNpmNames.add(entry.npmName);
      const record: InstalledExtensionDescriptor = { npmName: entry.npmName, version, descriptor: installedDescriptor };
      installedIndex.byNpmName.set(entry.npmName, record);
      // Claim the extension name for the rest of this resolution too, so two
      // packages in one root set colliding on it is refused exactly like a
      // collision against a package installed by an earlier run.
      this.transferDescriptorNameClaim(installedIndex, current, record, releasedDescriptorNames);
      await this.enqueueDependencies(queue, entry, installedDescriptor);
      processedNpmNames.add(entry.npmName);
    }

    this.assertResolvedGraphConsistent(installedIndex, changedNpmNames, releasedDescriptorNames, force);

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
      byDescriptorName: new Map(entries.map((entry) => [entry.descriptor.name, entry])),
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
   * Assert that no *other* installed npm package already claims this
   * descriptor's extension name.
   *
   * npm identity and extension identity are independent: any npm package may
   * ship a `descriptor.json` declaring any name. The runtime keys everything
   * that matters — enablement preferences, dependency resolution, bus and
   * storage namespaces, the coordinator's entry map — on the *extension* name,
   * so two installed npm packages declaring one extension name leave the
   * runtime with two candidates and no way to choose between them. Both sit in
   * the same discovery tier (`{makaioHome}/node_modules`), where there is no
   * precedence rule to appeal to, so discovery refuses to boot at all rather
   * than picking one. Refusing the install is how an operator finds out at the
   * moment they can still act on it, instead of at the next start.
   *
   * The check necessarily runs after the package is on disk — its descriptor
   * is not readable before that — so the refusal propagates as a required
   * dependency failure and the caller's manifest rollback removes it again.
   *
   * Scope is this installer's own tier. A name claimed by a symlinked install
   * under `{makaioHome}/extensions`, or by a package in the invoking project's
   * own `node_modules`, is a *cross*-tier collision, which discovery resolves
   * by tier precedence rather than refusing — so it is deliberately not an
   * install error here.
   * @param npmName - npm package being installed or upgraded.
   * @param descriptor - Descriptor read from that package after install.
   * @param installedIndex - Index of packages already installed in this tier.
   * @throws ExtensionNameClaimedError when a different npm package already declares this extension name.
   */
  private assertDescriptorNameUnclaimed(
    npmName: string,
    descriptor: ExtensionDescriptor,
    installedIndex: InstalledIndex,
  ): void {
    const claimant = installedIndex.byDescriptorName.get(descriptor.name);
    if (claimant === undefined || claimant.npmName === npmName) {
      return;
    }

    throw new ExtensionNameClaimedError(npmName, descriptor.name, claimant);
  }

  /**
   * Move the extension-name claim of a just-installed package onto its new
   * record, releasing the name its previous version declared.
   *
   * An upgrade may ship a descriptor declaring a *different* extension name
   * than the version it replaced. The old name is then no longer declared by
   * anything on disk, so leaving it in the index would keep an identity
   * reserved by a package that gave it up and refuse a later install in the
   * same resolution that legitimately takes it over. The release is guarded on
   * the previous claim still pointing at this npm package: when another package
   * holds that name, the index entry is not this package's to remove.
   *
   * A released name is recorded rather than just dropped: an installed package
   * may declare a required dependency on it, which nothing satisfies once the
   * name is gone. {@link assertResolvedGraphConsistent} judges that against the
   * resolution's final state, so a batch that also upgrades the dependent onto
   * the new name stays legal while one that strands it is refused.
   * @param installedIndex - Index being updated for this resolution.
   * @param previous - Record this package had before the install, when it was already present.
   * @param record - Record for the version just installed.
   * @param releasedDescriptorNames - Accumulator of names given up during this
   *   resolution, keyed to the npm package that gave each one up.
   */
  private transferDescriptorNameClaim(
    installedIndex: InstalledIndex,
    previous: InstalledExtensionDescriptor | undefined,
    record: InstalledExtensionDescriptor,
    releasedDescriptorNames: Map<string, string>,
  ): void {
    const previousName = previous?.descriptor.name;
    if (
      previousName !== undefined &&
      previousName !== record.descriptor.name &&
      installedIndex.byDescriptorName.get(previousName)?.npmName === record.npmName
    ) {
      installedIndex.byDescriptorName.delete(previousName);
      releasedDescriptorNames.set(previousName, record.npmName);
    }
    releasedDescriptorNames.delete(record.descriptor.name);
    installedIndex.byDescriptorName.set(record.descriptor.name, record);
  }

  /**
   * Assert that the descriptor version satisfies the queue entry's requested range.
   *
   * Names the package that asked for the range when the entry is a transitive
   * dependency: two roots in one batch can declare incompatible ranges for a
   * shared dependency, and the range alone does not say which of them the
   * unsatisfiable one came from.
   * @param entry - Queue entry currently being resolved.
   * @param descriptor - Installed extension descriptor.
   */
  private assertDescriptorVersionSatisfies(entry: QueueEntry, descriptor: ExtensionDescriptor): void {
    if (this.descriptorRangeSatisfied(descriptor, entry.requiredRange)) {
      return;
    }

    const requiredBy = entry.root ? '' : ` (required by ${entry.path[entry.path.length - 2]})`;
    throw new Error(
      `Installed package ${entry.npmName} descriptor version ${descriptor.version} does not satisfy ${descriptor.name} ${entry.requiredRange}${requiredBy}`,
    );
  }

  /**
   * Assert that the descriptor graph this resolution leaves behind still holds
   * for every dependency the resolution touched.
   *
   * Judged once against the final installed set rather than per install against
   * the transient one. The order roots are submitted in is not a statement
   * about the intended target graph: a batch that upgrades both `A` and its
   * dependent `B` is legal exactly when `B`'s *new* range accepts `A`'s *new*
   * version, and a per-install check comparing the freshly installed `A@2`
   * against the not-yet-upgraded `B@1` refuses that batch for one submission
   * order and accepts it for the other. Every install in a resolution shares
   * one rollback, so deferring the judgement to the end only costs installs
   * that rollback undoes anyway.
   *
   * A touched dependency breaks a dependent in two ways:
   *
   * - **The extension name is gone.** An upgrade can ship a descriptor
   *   declaring a different name than the version it replaced, releasing the
   *   old one (see {@link transferDescriptorNameClaim}). A required dependency
   *   on a released name can never resolve again — the dependent is skipped at
   *   every following boot — so the rename is refused unless the same batch
   *   also moved that dependent onto the new name. An *optional* dependent
   *   survives a missing dependency by design, so it does not block it.
   * - **The name is declared at a version outside the range.** Checked for
   *   optional dependents too: the dependency is installed and will be offered
   *   to the coordinator at a version the dependent declared it cannot use.
   *
   * Dependency names are matched through the installed index's descriptor-name
   * key, not through {@link IDescriptorNameResolver}: the index records which
   * npm package actually declares each extension name, while the name resolver
   * only predicts where one would be published.
   * @param installedIndex - Final installed index for this resolution.
   * @param changedNpmNames - npm packages whose installed version this resolution changed.
   * @param releasedDescriptorNames - Extension names no installed package declares any
   *   more, keyed to the npm package that gave each one up.
   * @param force - When `true`, violations are ignored.
   */
  private assertResolvedGraphConsistent(
    installedIndex: InstalledIndex,
    changedNpmNames: ReadonlySet<string>,
    releasedDescriptorNames: ReadonlyMap<string, string>,
    force: boolean,
  ): void {
    if (force) return;

    const violations: string[] = [];
    const offenders = new Set<string>();
    for (const entry of installedIndex.byNpmName.values()) {
      for (const dep of entry.descriptor.dependencies ?? []) {
        const claimant = installedIndex.byDescriptorName.get(dep.name);
        const requirement = `${entry.npmName} requires ${dep.name} ${dep.version}`;
        const releasedBy = releasedDescriptorNames.get(dep.name);
        if (claimant === undefined) {
          if (dep.optional === true || releasedBy === undefined) continue;
          violations.push(`${requirement}, which ${releasedBy} no longer declares`);
          offenders.add(releasedBy);
        } else if (
          changedNpmNames.has(claimant.npmName) &&
          !versionSatisfies(claimant.descriptor.version, dep.version)
        ) {
          violations.push(requirement);
          offenders.add(claimant.npmName);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Cannot install ${[...offenders].join(', ')}; existing dependencies would be violated:\n${violations.join('\n')}`,
      );
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
  const npmName = extractNpmName(packageSpec);
  if (npmName.length === packageSpec.length) {
    return { npmName };
  }
  const requiredRange = packageSpec.slice(npmName.length + 1);
  return requiredRange === 'latest' ? { npmName } : { npmName, requiredRange };
}

/**
 * Format an unknown thrown value for diagnostics.
 * @param error - Value caught from a failed operation.
 * @returns Human-readable error message.
 */
function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
