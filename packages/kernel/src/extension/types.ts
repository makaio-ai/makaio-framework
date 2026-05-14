import type {
  ExtensionContributionProcessor,
  ExtensionWarning,
  MakaioExtension,
  ExtensionIdentity,
  ExtensionService,
  NodeExtensionContext,
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
   * Optional callback to persist enabled/disabled state after a setEnabled call.
   * The composition root supplies this to bridge into PreferencesSubjects or another durable store.
   */
  persistEnabled?: (name: string, enabled: boolean) => Promise<void>;
  /**
   * Optional callback to retrieve persisted enabled state during startAll.
   * Returns `false` to skip a package at boot, `true` or `undefined` to start normally.
   */
  loadEnabled?: (name: string) => boolean | undefined;
  /**
   * Optional callback to retrieve stored configuration for a package during
   * startAll and enablePackage. Returns `undefined` when no stored config exists.
   */
  loadConfig?: (name: string) => Record<string, unknown> | undefined;
  /**
   * Optional callback invoked by {@link ExtensionCoordinator.startAll} to run
   * database migrations declared by loaded packages before any services start.
   *
   * The coordinator collects all packages whose `StorageManifest.migrations`
   * field is set and passes them as an array of
   * `{ name, migrationsPath, migrationSourceId }` objects to this callback in topological
   * (dependency) order. The callback is responsible for applying pending
   * migrations — typically via Drizzle `migrate()` or the bundled
   * `applyMigrations()` helper — using a tracking table keyed to the migration
   * bundle identity so packages that share one folder share one ledger.
   *
   * When absent, declared migrations are silently skipped and storage tables
   * that depend on them will not be created at runtime.
   *
   * The `migrationsPath` values are absolute discovery paths resolved by the
   * coordinator from each package's `StorageManifest.migrations` field
   * plus executable `storage.packageRoot` metadata when needed.
   * `migrationSourceId` is the stable runtime identity used for bundled hosts;
   * when a package does not declare one, it falls back to `migrationsPath`.
   * @param sources - Migration sources in dependency order, each carrying the
   *   package name, absolute migration folder path, and stable source id.
   * @returns A promise that resolves when all migrations have been applied.
   */
  runMigrations?: (
    sources: ReadonlyArray<{ name: string; migrationsPath: string; migrationSourceId: string }>,
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
  /** Instantiated service, present after successful `create + init`. */
  service?: ExtensionService;
  /** Cleanup returned by `storage.registerHandlers`, if any. */
  storageCleanup?: () => void;
  /** Error message captured when state is `'failed'` or `'skipped'`. */
  error?: string;
  /** Default config values from descriptor.json, merged under stored config. */
  configDefaults?: Readonly<Record<string, unknown>>;
  /**
   * Active health warnings reported by the package's `checkHealth` hook.
   *
   * Populated after the package reaches `active` state. Cleared when the
   * package is disabled or stopped. An empty array signals no active warnings.
   */
  warnings: ExtensionWarning[];
}
