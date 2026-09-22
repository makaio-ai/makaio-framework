/**
 * Dependency Resolver
 *
 * Resolves and installs a root set of extension packages together with their
 * transitive descriptor-declared dependencies. Resolution is breadth-first with
 * cycle detection, and everything the descriptor graph has to satisfy — which
 * npm package claims which extension name, and whether every declared
 * dependency still resolves — is judged once at the end, against the resolved
 * target state rather than against the transient state between installs. On any
 * required-dependency failure the pre-install manifest snapshot is restored;
 * optional dependency failures are collected and skipped without triggering a
 * rollback. Skipping is a statement about the *declared dependency*, not about
 * the disk: a package that installed and only then failed an assertion stays
 * installed, joins the resolved set, and is judged with it — which is how an
 * extension-name claim conflict ({@link ExtensionNameClaimedError}) stays fatal
 * however the dependency was declared.
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
 * An optional dependency that was not accepted as satisfied.
 *
 * Says nothing about whether the package reached disk: most skips are installs
 * that never succeeded, but a package can also install cleanly and then fail an
 * assertion about its descriptor. Such a package stays installed — the resolver
 * has no per-package undo — and is judged with the rest of the resolved set.
 */
export interface SkippedPackage {
  /** npm package name. */
  readonly npmName: string;
  /** Human-readable reason the dependency was not accepted. */
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
   * When `true`, the resolved dependency graph is not validated: existing
   * installed packages that depend on an upgraded package may be left with a
   * version outside their declared range, or with a required dependency name
   * the upgrade released (see
   * {@link DependencyResolver.assertResolvedGraphConsistent}).
   *
   * Does not extend to extension-name claims. A dependent left on an
   * unsatisfiable range still boots with its dependency skipped, which is a
   * degraded state an operator can knowingly accept; two packages claiming one
   * extension name leave discovery with no bootable state at all, so
   * {@link DependencyResolver.claimDescriptorNames} refuses it either way.
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
 * Mutable in-memory index of installed extension packages, keyed by the npm
 * name each one is installed under.
 *
 * This is the only installed state the resolution loop maintains, and it always
 * describes the target set: entries start as what is on disk and are replaced
 * as packages are installed or upgraded. Everything keyed on the *extension*
 * name a package declares is derived from it once the queue has drained — see
 * {@link DescriptorNameClaims} — because an extension name can move between npm
 * packages within a single resolution and only the final set says where it
 * ended up.
 */
type InstalledIndex = Map<string, InstalledExtensionDescriptor>;

/**
 * Extension-name facts derived from the descriptor set a resolution resolved to.
 *
 * npm identity and extension identity are independent: any npm package may ship
 * a `descriptor.json` declaring any name, and an upgrade may declare a
 * different name than the version it replaced. Both maps therefore only become
 * knowable once every install in the batch has been read back.
 */
interface DescriptorNameClaims {
  /** Extension name to the single installed package declaring it afterwards. */
  readonly byDescriptorName: ReadonlyMap<string, InstalledExtensionDescriptor>;
  /**
   * Extension names that were declared before this resolution and are declared
   * by nothing afterwards, keyed to the npm package that gave each one up.
   */
  readonly released: ReadonlyMap<string, string>;
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
 * See {@link DependencyResolver.claimDescriptorNames} for why the contest can
 * only be judged once every install in the batch has been read back.
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
 * 6. On an optional-dependency failure, collect the skip reason and continue,
 *    keeping anything that did reach disk in the resolved set.
 * 7. Once the queue has drained, derive the extension-name claims of the
 *    resolved set and validate the dependency graph against it.
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
    const initialInstalled = await this.packages.listInstalledExtensionDescriptors();
    const installedIndex: InstalledIndex = new Map(initialInstalled.map((entry) => [entry.npmName, entry]));
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

    while (queue.length > 0) {
      const entry = queue.shift()!;
      const alreadyProcessed = processedNpmNames.has(entry.npmName);
      const current = installedIndex.get(entry.npmName);

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
        // The package is on disk under this descriptor from here on, whatever
        // the assertions below decide about it, and the resolver has no way to
        // take that back: its only undo is the whole-transaction manifest
        // snapshot, which an optional failure deliberately does not trigger,
        // and for an upgrade there is nothing to uninstall back to anyway.
        // Recording it before the assertions can divert control is what keeps
        // the resolved set equal to what an operator would actually boot — a
        // package skipped for its own declared range still claims the
        // extension name its descriptor declares.
        installedIndex.set(entry.npmName, { npmName: entry.npmName, version, descriptor });
        changedNpmNames.add(entry.npmName);

        this.assertDescriptorMatches(entry, descriptor);
        this.assertDescriptorVersionSatisfies(entry, descriptor);
        installedDescriptor = descriptor;
      } catch (error) {
        // Optionality lets a *declared dependency* go unsatisfied; it does not
        // erase an install that already happened. Both consequences of one that
        // did are therefore judged against the resolved set after the queue
        // drains — a contested extension name by claimDescriptorNames, a
        // version no dependent's range accepts by assertResolvedGraphConsistent
        // — where optionality no longer suppresses them.
        if (entry.optional) {
          skipped.push({ npmName: entry.npmName, reason: error instanceof Error ? error.message : String(error) });
          continue;
        }
        throw error;
      }

      installed.push({ npmName: entry.npmName, version, source: current ? 'upgraded' : 'new' });
      await this.enqueueDependencies(queue, entry, installedDescriptor);
      processedNpmNames.add(entry.npmName);
    }

    const claims = this.claimDescriptorNames(initialInstalled, installedIndex, changedNpmNames);
    this.assertResolvedGraphConsistent(installedIndex, claims, changedNpmNames, force);

    return { installed, skipped, warnings };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

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
   * Derive which npm package claims each extension name in the set this
   * resolution resolved to, refusing any name two packages still claim.
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
   * Judged over the resolved set rather than per install, for the same reason
   * {@link assertResolvedGraphConsistent} is: a name can legitimately move
   * between npm packages inside one batch, when the package holding it is
   * upgraded to a descriptor that declares a different name and another package
   * takes the released one over. Both packages are installed under one
   * rollback, so the order the roots were submitted in says nothing about the
   * intended target graph — checking each install against the transient set
   * would accept the handover for one order and refuse it for the other.
   *
   * A contest is only this resolution's to refuse when it changed one of the
   * contenders. Two packages that already shared a name before the batch are
   * left to discovery, which refuses to boot on them regardless; failing every
   * unrelated install until they are sorted out would not make that any more
   * visible. The package this resolution changed is reported as the offender so
   * the message names the install an operator can still undo, and the resolved
   * set is walked in npm-name order so a batch that changed both contenders
   * still reports the same pair either way round.
   * @param before - Installed records as they were when the resolution started.
   * @param after - Installed records this resolution resolved to.
   * @param changedNpmNames - npm packages whose installed version this resolution changed.
   * @returns Name claims and releases of the resolved set.
   * @throws ExtensionNameClaimedError when two packages in the resolved set declare one extension name.
   */
  private claimDescriptorNames(
    before: readonly InstalledExtensionDescriptor[],
    after: InstalledIndex,
    changedNpmNames: ReadonlySet<string>,
  ): DescriptorNameClaims {
    const byDescriptorName = new Map<string, InstalledExtensionDescriptor>();
    for (const record of [...after.values()].sort(compareByNpmName)) {
      const contender = byDescriptorName.get(record.descriptor.name);
      if (contender === undefined) {
        byDescriptorName.set(record.descriptor.name, record);
        continue;
      }

      const offender = changedNpmNames.has(record.npmName) ? record : contender;
      if (!changedNpmNames.has(offender.npmName)) continue;
      throw new ExtensionNameClaimedError(
        offender.npmName,
        record.descriptor.name,
        offender === record ? contender : record,
      );
    }

    // A name nothing declares any more was given up by whichever package
    // declared it before: packages are only ever added or upgraded here, so a
    // rename is the only way a name can leave the set.
    const released = new Map<string, string>();
    for (const record of before) {
      if (!byDescriptorName.has(record.descriptor.name)) {
        released.set(record.descriptor.name, record.npmName);
      }
    }

    return { byDescriptorName, released };
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
   * Dependency names are matched through the resolved name claims, not through
   * {@link IDescriptorNameResolver}: the claims record which npm package
   * actually declares each extension name, while the name resolver only
   * predicts where one would be published.
   * @param installedIndex - Installed records this resolution resolved to.
   * @param claims - Extension-name claims and releases of that resolved set.
   * @param changedNpmNames - npm packages whose installed version this resolution changed.
   * @param force - When `true`, violations are ignored.
   */
  private assertResolvedGraphConsistent(
    installedIndex: InstalledIndex,
    claims: DescriptorNameClaims,
    changedNpmNames: ReadonlySet<string>,
    force: boolean,
  ): void {
    if (force) return;

    const violations: string[] = [];
    const offenders = new Set<string>();
    for (const entry of installedIndex.values()) {
      for (const dep of entry.descriptor.dependencies ?? []) {
        const claimant = claims.byDescriptorName.get(dep.name);
        const requirement = `${entry.npmName} requires ${dep.name} ${dep.version}`;
        const releasedBy = claims.released.get(dep.name);
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
 * Order two installed records by npm name.
 *
 * Gives {@link DependencyResolver.claimDescriptorNames} a submission-independent
 * walk over the resolved set, so a contested extension name always reports the
 * same pair of packages.
 * @param a - First installed record.
 * @param b - Second installed record.
 * @returns Negative, zero, or positive per the `Array.prototype.sort` contract.
 */
function compareByNpmName(a: InstalledExtensionDescriptor, b: InstalledExtensionDescriptor): number {
  if (a.npmName === b.npmName) return 0;
  return a.npmName < b.npmName ? -1 : 1;
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
