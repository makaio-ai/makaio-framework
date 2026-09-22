import type {
  ExtensionContributionProcessor,
  ExtensionOperatorConfigSource,
  ExtensionWarning,
  MakaioExtension,
  ExtensionIdentity,
  ExtensionService,
  NodeExtensionContext,
  StorageDialect,
  VersionLiteral,
} from '@makaio/contracts';
import type { IMakaioBus } from '@makaio/bus-core';
import type { ComponentState } from '../observability/index.js';

/** Concrete Node runtime context supplied by the kernel coordinator. */
export type KernelExtensionContext = NodeExtensionContext<IMakaioBus>;

/** Concrete executable extension shape loaded by the kernel coordinator. */
export type KernelMakaioExtension = MakaioExtension<KernelExtensionContext>;

/** Awaited contribution processor registered with the {@link ExtensionCoordinator}. */
export type ContributionProcessor = ExtensionContributionProcessor<KernelExtensionContext>;

/**
 * Hosted runtime surface category used for extension/package gating.
 *
 * Represents the concrete surface a runtime IS -- `'any'` is intentionally
 * absent because a runtime cannot BE `'any'`; it is always interactive or
 * headless. Package manifests may declare `'any'` as their surface affinity,
 * which the coordinator interprets as "load on all surfaces".
 */
export type ExtensionRuntimeSurface = 'interactive' | 'headless';

/**
 * Host-advertised runtime capability fact.
 */
export interface RuntimeCapability {
  /** Stable capability token. */
  readonly id: string;
  /** Concrete capability contract version when the host exposes one. */
  readonly version?: VersionLiteral;
}

/**
 * Snapshot of the runtime environment provided by the host.
 *
 * The coordinator uses this to evaluate {@link RuntimeRequirement} gates on
 * each extension before deciding whether to load it.
 */
export interface RuntimeEnvironment {
  /**
   * Identifiers of the active host runtimes (e.g. `'node'`, `'electron'`).
   *
   * Extensions that declare `{ type: 'host', id: '...' }` requirements check
   * against this set.
   */
  readonly hosts: ReadonlySet<string>;
  /**
   * Capability tokens advertised by the host (e.g. `'storage.drizzle'`).
   *
   * Extensions that declare `{ type: 'capability', id: '...' }` requirements
   * check against this set. Versioned requirements additionally consult
   * {@link RuntimeEnvironment.capabilityVersions}.
   */
  readonly capabilities: ReadonlySet<string>;
  /**
   * Concrete versions for host capabilities that expose a versioned contract.
   *
   * A capability requirement with a `version` range is satisfied only when the
   * capability ID is present and this map contains a satisfying concrete version.
   */
  readonly capabilityVersions?: ReadonlyMap<string, VersionLiteral>;
}

/**
 * Options for constructing an {@link ExtensionCoordinator}.
 */
export interface ExtensionCoordinatorOptions {
  /** Hosted surface category used to apply package gating. Defaults to `'headless'`. */
  surface?: ExtensionRuntimeSurface;
  /**
   * Host launcher command embedded into client wiring installed from warning actions.
   *
   * Defaults to `'makaio'` for framework-only hosts. Hosts pass their
   * own launcher policy through this seam so the runtime does not infer it
   * from process entrypoints.
   */
  launcherCommand?: string;
  /** Optional database instance for storage handler registration (opaque — cast to MakaioDatabase at call site). */
  db?: unknown;
  /**
   * Node host fields for the context supplied to extension factories.
   *
   * Required when any loaded extension declares a `create` factory. When absent,
   * extensions with `create` will fail to start.
   *
   * Omit `config`, `signal`, and `hasExtension` — those are coordinator-owned
   * and assembled per extension at context-build time.
   */
  extensionContextBase?: Omit<
    KernelExtensionContext,
    'bus' | 'identity' | 'getService' | 'dataDir' | 'config' | 'signal' | 'hasExtension'
  >;
  /**
   * Host-provided runtime environment snapshot used to evaluate extension
   * {@link RuntimeRequirement} gates during {@link ExtensionCoordinator.load}.
   *
   * Extensions whose {@link MakaioExtension.requires} entries are not all
   * satisfied by the supplied environment are excluded. Omit only in tests that
   * intentionally bypass environment gating.
   */
  runtimeEnvironment?: RuntimeEnvironment;
  /**
   * Names of packages whose enablement is operator-managed.
   *
   * Scopes the coordinator's enablement machinery to the packages a
   * descriptor actually declares: {@link ExtensionCoordinatorOptions.loadEnabled}
   * is only consulted for a name in this set, `handleSetEnabled`
   * (`kernel:extension.setEnabled`) refuses outright for any other name, and
   * `ExtensionInfo.persistedEnabled` is `undefined` for it. Every name absent
   * from this set boots unconditionally enabled — a framework package is not
   * subject to operator enablement at all, so the enablement store's
   * category defaults (and a hand-edited disable) can never skip it, and
   * dependents cannot be excluded by a framework name looking "disabled".
   *
   * Omitted entirely: every loaded package is treated as managed, which
   * preserves prior behavior for coordinators built without this option
   * (including every existing test that constructs one without it).
   */
  extensionManagedNames?: ReadonlySet<string>;
  /**
   * Names of packages this host loads unconditionally as framework packages.
   *
   * These are the only names an extension package may legitimately register a
   * second time: the host always loads the framework package, and a single
   * extension registration under one of those names is the supported core
   * override, which {@link ExtensionCoordinator.load} lets win the name. A
   * collision under any other name is an extension identity collision with no
   * legitimate winner and aborts `load()` — see `coalesceExtensionOverrides`.
   *
   * Omitted entirely: every name in the loaded set is treated as an extension
   * identity, so any name collision aborts. A composition root that mixes
   * framework packages into the same `load()` call must supply this set, or a
   * legitimate core override is reported as a collision.
   */
  frameworkPackageNames?: ReadonlySet<string>;
  /**
   * Optional callback to durably persist an enablement preference.
   *
   * Called by `handleSetEnabled` (the `kernel:extension.setEnabled` RPC
   * handler) on every request it does not refuse outright — unconditionally,
   * regardless of whether the preference appears unchanged, and regardless of
   * this same coordinator's own {@link ExtensionCoordinatorOptions.loadEnabled}
   * value. The composition root supplies this to bridge into a durable store
   * (for example `ExtensionEnablementStore` from `@makaio/runtime-node`),
   * which re-reads its backing file before writing so a concurrent hand-edit
   * is never silently overwritten by a stale in-memory guess.
   */
  persistEnabled?: (name: string, enabled: boolean) => Promise<void>;
  /**
   * Optional callback to retrieve the persisted enablement preference.
   *
   * Called once per package during {@link ExtensionCoordinator.load}, to seed
   * `entry.enabled` for this boot: returns `false` to skip the package at
   * boot, `true` or `undefined` to start it normally. That boot-time read is
   * a snapshot — nothing later re-derives `entry.enabled` from it, and
   * `handleSetEnabled` must never use it (or `entry.enabled`) to decide
   * whether a write is necessary — see {@link persistEnabled}. A hand-edit to
   * the backing store between boots is exactly what this snapshot is meant to
   * pick up on the *next* restart, not something a live `setEnabled` call
   * reconciles against.
   *
   * `list()` and the singular `get` lookup (`kernel:extension.list` /
   * `kernel:extension.get`) also call this — once per extension, per call —
   * to populate `ExtensionInfo.persistedEnabled`. Unlike the boot-time read
   * above, that call is live: a caller backed by `ExtensionEnablementStore`
   * (`@makaio/runtime-node`) reflects every `persistEnabled` write this
   * process has committed in-process since boot, because that store updates
   * its in-memory set only after its own write lands (see that module). It
   * does not reflect a concurrent hand-edit made by another process; the
   * next boot's `load()` call is what picks that up.
   */
  loadEnabled?: (name: string) => boolean | undefined;
  /**
   * Optional callback to retrieve stored configuration for a package during
   * startAll and enablePackage. Returns `undefined` when no stored config exists.
   */
  loadConfig?: (name: string) => Record<string, unknown> | undefined;
  /**
   * Optional operator-owned configuration layer, consulted at every config
   * resolution point.
   *
   * Sits above both descriptor/host defaults and {@link ExtensionCoordinatorOptions.loadConfig},
   * so an explicit operator decision is never silently overwritten by a write
   * from the storage tier. An entry the source reports as unusable fails the
   * affected extension when it activates, under the coordinator's existing
   * criticality rules; extensions the source says nothing about are unaffected.
   *
   * When absent, config resolution behaves exactly as it does without an
   * operator layer.
   */
  operatorConfig?: ExtensionOperatorConfigSource;
  /**
   * Optional callback invoked by {@link ExtensionCoordinator.startAll} to run
   * database migrations declared by loaded packages before any services start.
   *
   * The coordinator collects all packages whose `StorageManifest.migrations`
   * field is set and passes them as an array of
   * `{ name, migrationsPath, migrationSourceId, migrationsPathByDialect? }`
   * objects to this callback in topological (dependency) order. The callback is
   * responsible for applying pending migrations — typically via Drizzle
   * `migrate()` or the bundled `applyMigrations()` helper — using a tracking
   * table keyed to the migration bundle identity so packages that share one
   * folder share one ledger.
   *
   * When absent, declared migrations are silently skipped and storage tables
   * that depend on them will not be created at runtime.
   *
   * The `migrationsPath` values are absolute discovery paths resolved by the
   * coordinator from each package's `StorageManifest.migrations` field
   * plus executable `storage.packageRoot` metadata when needed.
   * `migrationSourceId` is the stable runtime identity used for bundled hosts;
   * when a package does not declare one, it falls back to `migrationsPath`.
   *
   * When a package declares the object form of `StorageManifest.migrations`,
   * the coordinator additionally passes `migrationsPathByDialect` — an
   * absolute, containment-checked map of every declared per-dialect chain. The
   * coordinator stays dialect-agnostic; the host runtime selects the active
   * dialect's chain from this map and falls back to `migrationsPath` when the
   * map has no entry for that dialect.
   * @param sources - Migration sources in dependency order, each carrying the
   *   package name, absolute migration folder path, stable source id, and an
   *   optional per-dialect chain map.
   * @returns A promise that resolves when all migrations have been applied.
   */
  runMigrations?: (
    sources: ReadonlyArray<{
      name: string;
      migrationsPath: string;
      migrationSourceId: string;
      migrationsPathByDialect?: Partial<Record<StorageDialect, string>>;
    }>,
  ) => Promise<void>;
}

/**
 * Per-extension runtime entry tracked by the coordinator.
 */
export interface ExtensionEntry {
  /** The extension manifest and executable code. */
  pkg: KernelMakaioExtension;
  /** Opaque identity minted for this extension by the coordinator. */
  identity: ExtensionIdentity;
  /** Current lifecycle state. */
  state: ComponentState;
  /** Whether this extension is currently enabled. Defaults to `true` on load. */
  enabled: boolean;
  /**
   * Whether this entry's enablement is operator-managed.
   *
   * Set once in {@link ExtensionCoordinator.load} from
   * {@link ExtensionCoordinatorOptions.extensionManagedNames}: `true` when the
   * name is present in that set, or when the coordinator was built without
   * one at all (test compatibility — every entry is then treated as
   * managed). `false` marks a framework package, which the coordinator loads
   * unconditionally: `handleSetEnabled` refuses to toggle it, and
   * {@link ExtensionCoordinatorOptions.loadEnabled} is never consulted for it
   * (neither to seed `enabled` above nor to populate
   * `ExtensionInfo.persistedEnabled`) — a non-managed entry's `enabled` is
   * therefore always `true`.
   */
  extensionManaged: boolean;
  /** Instantiated service, present after successful `create + init`. */
  service?: ExtensionService;
  /** Cleanup returned by `storage.registerHandlers`, if any. */
  storageCleanup?: () => void;
  /**
   * Error message captured when state is `'failed'` or `'skipped'`.
   *
   * {@link ExtensionCoordinator.load} also pre-populates this field for a
   * boot-disabled entry whose own declared dependency graph would otherwise
   * have failed the coordinator's fatal graph validation (missing
   * dependency, incompatible version, or a cycle running only through
   * disabled entries) — see `topoSort`'s `onSoftValidationWarning` seam. That
   * write happens while the entry still sits at `'discovered'`, ahead of the
   * `'skipped'` transition `startExtensionEntry` applies for it moments later
   * at `startAll()`, so the reason is already visible to a re-enable attempt
   * (`kernel:extension.setEnabled`) made before this process ever reaches
   * `startAll()`.
   */
  error?: string;
  /**
   * Weakest configuration layer for this extension: the descriptor's own
   * defaults combined with any host-supplied defaults by the composition root.
   *
   * Both stored configuration and the operator layer override these values.
   */
  configDefaults?: Readonly<Record<string, unknown>>;
  /**
   * Active health warnings reported by the package's `checkHealth` hook.
   *
   * Populated after the package reaches `active` state. Cleared when the
   * package is disabled or stopped. An empty array signals no active warnings.
   */
  warnings: ExtensionWarning[];
  /**
   * Whether static surfaces (windows, tray, CLI) and the package's bus
   * namespace have been collected/registered for this entry.
   *
   * Set to `true` during {@link ExtensionCoordinator.load} for extensions
   * whose preference-enabled state survives the dependency closure computed
   * by `closeEnabledExtensionEntries` (`extension-entry-closure.ts`). An
   * entry disabled at boot, or one that is preference-enabled but excluded
   * from that closure because a required, non-optional dependency is
   * disabled, never sets this: neither can reach `active` this process — the
   * first because `startExtensionEntry` skips it outright, the second
   * because its own dependency check refuses it — so nothing was collected
   * or registered for either. Withholding namespace registration this way
   * also keeps a disabled entry's routing metadata from colliding with, and
   * aborting boot for, an active entry's or framework namespace of the same
   * name — disabling the offending entry remains a working recovery path.
   * Both can only be corrected by a fresh process restart, whose own
   * {@link ExtensionCoordinator.load} call collects surfaces and registers
   * namespaces normally once the blocking condition is gone. This flag also
   * distinguishes the two ways an entry reaches `'skipped'` — set for a
   * self-skip during this process's own `create`/`init`, unset for a
   * boot-time disable that short-circuited before any start attempt — which
   * `applyExtensionTransition`'s boot-skip guard relies on to refuse
   * activating an entry boot never started. A closure-excluded entry never
   * reaches `'skipped'` itself (its own dependency check fails it into
   * `'failed'` instead), so this flag is unset but does not need to gate
   * that guard for it: the same dependency check re-runs on every re-enable
   * attempt and keeps failing while the dependency stays disabled, so the
   * entry whose namespace was never registered can never reach the
   * `create`/`init` call that would need it in this process.
   */
  surfacesCollected?: boolean;
}
