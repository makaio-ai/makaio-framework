/**
 * Installed-extension listing shared by the `extension list`, `extension enable`, and
 * `extension disable` commands.
 *
 * Extracted from `extension-commands.ts` so both the offline listing path and
 * the toggle commands' "is this name actually installed" checks read from one
 * place.
 * @packageDocumentation
 */
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  normalizePackageExport,
  resolveConventionEntrypoint,
  FilesystemDescriptorDiscovery,
  type DiscoveredExtension,
  type FrameworkModuleResolver,
} from '@makaio/runtime-node';
import { importPackageManager } from './extension-install-transaction.js';

/**
 * One installed extension as seen without starting any extension service.
 *
 * `critical` is read from the same declaration the runtime honours: the
 * executable `MakaioExtension` the descriptor's server entrypoint exports,
 * enumerated here without calling any package's `create()`. A descriptor
 * without a server entrypoint (detached, CLI-only, browser-only) has no
 * exported package — the runtime synthesizes its package from descriptor
 * metadata, so the descriptor's own `critical` is that package's flag and is
 * used instead. Reading the flag from anywhere else would let offline CLI
 * paths refuse or permit a disable the runtime would decide the other way.
 *
 * A single descriptor can export more than one executable package from its
 * server entrypoint — e.g. `makaio-dev` also exports `makaio-dev.relay-connection`
 * — so one descriptor can produce several entries here: one for the descriptor
 * name itself, and one for each dot-prefixed child package it exports. The
 * enablement file is keyed by these executable package names, not by
 * descriptor name, so every entry needs its own row for the toggle commands
 * and the offline listing to address the same identities the live server does.
 */
export interface InstalledExtensionEntry {
  /**
   * Extension identity — the descriptor name, or one of its dot-prefixed
   * child packages. This is the key the enablement file, the runtime loader,
   * and `normalizePackageExport` all use; it is never the npm dependency
   * identifier.
   */
  readonly name: string;
  /** Installed version. */
  readonly version: string;
  /**
   * Where the extension was installed from.
   *
   * `'project-local'` is the runtime's highest-priority discovery tier
   * (`{cwd}/node_modules`, see {@link FilesystemDescriptorDiscovery}) — a
   * dependency of the project the CLI is invoked from, distinct from both a
   * `'local'` symlink under `$MAKAIO_HOME/extensions` and a `'npm'` install
   * under `$MAKAIO_HOME/node_modules`. This is the one origin
   * {@link listInstalledExtensions}'s `'shared-home'` tier mode deliberately
   * omits — see that function's TSDoc for why.
   */
  readonly origin: 'local' | 'npm' | 'project-local';
  /**
   * Whether the executable package under this name declares itself critical.
   *
   * `undefined` is ambiguous by itself — it means either "nothing declares a
   * `critical` flag for this name" (a descriptor with no server entrypoint,
   * legitimately non-critical) or "the declaration could not be read" (a
   * server-backed descriptor whose entrypoint failed to import, or whose
   * export {@link normalizePackageExport} rejected). {@link criticalityUnknown}
   * disambiguates the two: only when it is `true` does `undefined` here mean
   * "unknown", not "not critical". A caller that gates a disable on
   * criticality must check {@link criticalityUnknown} first and refuse rather
   * than treat this as `false` — see `resolveDisableCriticality` in
   * `extension-toggle-commands.ts`.
   */
  readonly critical?: boolean;
  /**
   * `true` when `critical` could not be resolved because this entry's
   * descriptor declares a server entrypoint but this process could not read
   * it — the candidate path was not resolvable (missing/unreadable file),
   * the import failed, or its export was rejected by
   * {@link normalizePackageExport} or was shaped with a non-boolean
   * `critical` field (see the warnings logged by {@link listExportedPackages}).
   * Never `true` for a descriptor with no server entrypoint at all, whose
   * absent `critical` is a legitimate "not critical" rather than an
   * unresolved one. Omitted (not `false`) when criticality is resolved,
   * known, or legitimately absent.
   */
  readonly criticalityUnknown?: boolean;
  /**
   * npm dependency identifier this entry was installed under, when it
   * differs from `name` (an npm install whose descriptor declares a
   * different name than the package it ships in, e.g.
   * `@makaio/extension-opencode` installing a descriptor named `opencode`).
   * Display-only — every enablement-relevant lookup must use `name`, not this
   * field.
   */
  readonly npmName?: string;
  /**
   * Set when a higher-priority discovery tier already installed an extension
   * under this {@link name}, naming that winner's {@link origin}.
   *
   * The runtime loads exactly one extension per name and resolves a
   * cross-tier collision by tier precedence (`project-local` \> `local` \>
   * `npm`, mirroring `FilesystemDescriptorDiscovery`). The losing copy is
   * still installed, and an operator who just installed it would otherwise see
   * it vanish from the listing with no explanation, so it is reported here
   * rather than dropped — marked with the tier that actually wins the name.
   *
   * Never set on an entry the runtime would load. A shadowed entry always
   * follows its winner in the listing order, so every lookup by name keeps
   * resolving to the winner.
   *
   * Only a *descriptor* name is resolvable this way, because the descriptor is
   * what discovery sees. A name claimed by an executable child package is not —
   * see {@link collidesWith}.
   */
  readonly shadowedBy?: InstalledExtensionEntry['origin'];
  /**
   * Runtime surface this package is restricted to, when it declares exactly
   * one ({@link MakaioExtension.surface}).
   *
   * Absent means "loads on every surface": the package declared `'any'`,
   * declared nothing, or its declaration could not be read here. Two copies
   * claiming one name only contest it where both can be loaded at once, which
   * is what this field decides — see {@link collidesWith}.
   */
  readonly surface?: 'interactive' | 'headless';
  /**
   * Set when this {@link name} is claimed by two installed copies the runtime
   * refuses to choose between, naming the other claimant's {@link origin}.
   *
   * Unlike {@link shadowedBy} this is not a resolved contest — it is a boot
   * failure. Both claimants carry it, because neither loads: the next start
   * aborts instead of picking one. Two cases produce it:
   *
   * - Two packages in *one* tier claiming one name. There is no precedence
   *   within a tier, so discovery throws `ExtensionNameCollisionError`.
   * - A name claimed across tiers by at least one executable *child* package
   *   (`foo.bar` exported by descriptor `foo`) rather than by two descriptors.
   *   Discovery resolves tiers by descriptor name only — both descriptors are
   *   admitted, both then register the contested package name, and
   *   `coalesceExtensionOverrides` aborts the load. Tier precedence cannot
   *   settle it: a child package has no descriptor of its own to demote, and
   *   dropping it would silently remove part of a descriptor that did win its
   *   own name.
   *
   * Reporting these as {@link shadowedBy} would present one copy as the one
   * the runtime loads, when in fact nothing loads at all.
   *
   * The second case is judged per surface. The coordinator filters by
   * {@link MakaioExtension.surface} *before* it resolves names, so two copies
   * restricted to different surfaces are never offered to that resolution
   * together and neither blocks the other — reporting them as a collision
   * would refuse a toggle for a name that boots fine. See {@link surface} and
   * `claimsContest`. The first case does not depend on it at all: discovery
   * throws on a same-tier duplicate descriptor name before any package is
   * loaded, so no surface declaration exists yet to exempt it.
   */
  readonly collidesWith?: InstalledExtensionEntry['origin'];
}

/**
 * Minimal shape both installers report for an installed extension, sufficient
 * to enumerate its executable package surface offline.
 */
interface InstallerListingEntry {
  /**
   * Identifier the installer lists packages under. For
   * {@link LocalPathInstaller} this already is the descriptor name; for
   * {@link YarnPackageManager} this is the npm dependency identifier, which
   * can differ from the descriptor's own `name` — see `descriptorName` below.
   */
  readonly name: string;
  /**
   * Extension identity declared in the package's `descriptor.json`, when the
   * installer can distinguish it from `name`. Falls back to `name` when
   * absent (true for every local install, and for an npm install whose
   * descriptor name happens to match its npm identifier).
   */
  readonly descriptorName?: string;
  /** Installed version. */
  readonly version: string;
  /**
   * `critical` as declared in the package's `descriptor.json`.
   *
   * Authoritative only for a descriptor with no server entrypoint, whose
   * package the runtime synthesizes from this metadata; the schema forbids the
   * field on any descriptor that does declare one. See
   * {@link InstalledExtensionEntry.critical}.
   */
  readonly critical?: boolean;
  /**
   * `surface` as declared in the package's `descriptor.json`.
   *
   * Authoritative only for a descriptor with no server entrypoint, whose
   * package the runtime synthesizes from this metadata; a server-backed
   * descriptor's exported package carries its own declaration, which wins.
   * Installers that do not report it leave this `undefined`, which the
   * collision check reads as "loads on every surface" — the conservative
   * answer, since assuming a restriction that was never declared would hide a
   * real contest.
   */
  readonly surface?: 'interactive' | 'headless' | 'any';
  /** Absolute import path for the resolved server entrypoint, when present. */
  readonly serverImportPath?: string;
  /**
   * Whether the descriptor declares `entrypoints.server` at all, independent
   * of whether `serverImportPath` could be resolved.
   *
   * `serverImportPath` alone cannot distinguish "no server entrypoint
   * declared" (legitimately no exported package, so `critical` — absent or
   * not — is authoritative) from "a server entrypoint is declared but its
   * convention-resolved candidate file is missing or unreadable"
   * (criticality is genuinely unknown) — both leave `serverImportPath`
   * `undefined`. {@link expandInstallerEntry} uses this field, not
   * `serverImportPath`, to compute {@link InstalledExtensionEntry.criticalityUnknown}.
   */
  readonly declaresServerEntrypoint?: boolean;
}

/**
 * The subset of an exported `MakaioExtension` this listing reads.
 *
 * Structural on purpose: the offline listing only needs each exported
 * package's identity, version, and criticality, never its executable surface.
 */
interface ExportedPackage {
  /** Executable package identity — the descriptor name or a dot-prefixed child. */
  readonly name: string;
  /** Version the exported package declares. */
  readonly version: string;
  /**
   * Runtime surface affinity the exported package declares, when it declares a
   * readable one. `'any'`, an absent declaration, and an unrecognized value all
   * arrive here as `undefined` — all three mean the same thing to the
   * coordinator's surface gate: do not restrict this package.
   */
  readonly surface?: 'interactive' | 'headless';
  /**
   * Whether the exported package declares itself critical.
   *
   * Typed as `boolean` for callers, but {@link listExportedPackages} still
   * validates it is actually a `boolean` at runtime before trusting it — see
   * {@link isValidExportedCriticalFlag}. A package whose raw `critical` value
   * failed that check is reported here with `critical` omitted, and its name
   * is carried in {@link ExportedPackagesResolution.invalidCriticalNames} so
   * callers can tell "not declared" apart from "declared but unresolvable".
   */
  readonly critical?: boolean;
}

/** Result of {@link listExportedPackages}: every exported package, plus which of them had an unresolvable `critical`. */
interface ExportedPackagesResolution {
  /** Every package the server entry exports, with any invalid `critical` value stripped. */
  readonly packages: readonly ExportedPackage[];
  /**
   * Names of exported packages whose raw `critical` field was present but
   * not a `boolean`. Criticality is unresolved for these, not legitimately
   * absent — {@link expandInstallerEntry} marks the corresponding entry
   * {@link InstalledExtensionEntry.criticalityUnknown} instead of reporting
   * them as non-critical.
   */
  readonly invalidCriticalNames: ReadonlySet<string>;
}

/**
 * Validate that an exported package's `critical` field is either absent or a
 * genuine `boolean`.
 *
 * `normalizePackageExport`'s structural check (`isMakaioExtensionLike`) only
 * requires `name`, `displayName`, and `version` to be strings — it never
 * inspects `critical`, so a malformed export (e.g. `critical: 'yes'`) still
 * passes it. Left unchecked, that value would flow into
 * {@link InstalledExtensionEntry.critical}, which every caller downstream —
 * `resolveDisableCriticality` in particular — treats as a trustworthy
 * `boolean`.
 *
 * Mirrors `isValidExportedCriticalFlag` in
 * `@makaio/services-package-manager`'s `exported-package-critical.ts`, which
 * applies the identical rule for the bus-facing `packages.list` listing;
 * duplicated here rather than imported to keep this offline listing free of
 * a dependency on that package's internal (non-exported) helper.
 * @param value - Candidate `critical` value read off an exported package.
 * @returns Whether `value` is safe to report as `critical`.
 */
function isValidExportedCriticalFlag(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

/**
 * Narrow an exported package's `surface` declaration to a single concrete
 * runtime surface.
 *
 * Mirrors the coordinator's own gate (`matchesSurface` in
 * `@makaio/kernel`'s `extension-selection.ts`): a package loads everywhere
 * unless it names exactly one surface. `'any'`, an absent value, and anything
 * the schema would have rejected therefore collapse to `undefined` — "not
 * restricted" — rather than being treated as a restriction this process
 * invented.
 * @param value - Candidate `surface` value read off an exported package.
 * @returns The single surface the package is restricted to, or `undefined`.
 */
function toRestrictedSurface(value: unknown): 'interactive' | 'headless' | undefined {
  return value === 'interactive' || value === 'headless' ? value : undefined;
}

/**
 * Host capabilities the offline listing needs to read the same declarations a
 * booted runtime would.
 */
export interface InstalledExtensionListingOptions {
  /**
   * Module resolver for `@makaio/framework/*` subpath imports, as selected by
   * the host that owns this CLI invocation.
   *
   * {@link listExportedPackages} imports each descriptor's server entrypoint
   * on this process's own module registry. An extension installed from a local
   * path lives outside this process's module tree, so its `@makaio/framework/*`
   * imports only resolve when the host's resolver hook is installed — the same
   * hook a packaged host installs before loading extensions at boot, and the
   * same capability `@makaio/services-package-manager` forwards into its import
   * worker as `frameworkDistPath`. Without it, such an extension's export is
   * unreadable here and its criticality is reported unknown, which refuses an
   * `extension disable` the runtime itself would have allowed.
   *
   * Installed for the duration of one listing and uninstalled afterwards: the
   * hook is process-wide loader state, so the listing owns it only while it is
   * importing extension code. Omitted by hosts that resolve
   * `@makaio/framework/*` natively (a development workspace, Bun).
   */
  readonly frameworkModuleResolver?: FrameworkModuleResolver;
}

/**
 * List installed extensions, expanded with every executable child package
 * each descriptor's server entrypoint exports.
 *
 * Tiers are merged with the same `local > installed > global-npm` precedence
 * {@link FilesystemDescriptorDiscovery} applies at boot (`'project-local'` is
 * this function's name for that discovery class's `'local'` tier — see
 * {@link InstalledExtensionEntry.origin} — kept distinct from the
 * `LocalPathInstaller`-managed `'local'` origin below): a name that collides
 * across tiers is loaded only from the higher-priority tier, exactly as the
 * runtime would only ever load one of the two. The lower-priority copy is
 * still reported, marked {@link InstalledExtensionEntry.shadowedBy}, so an
 * installed-but-unloadable extension is visible instead of absent. A claim the
 * runtime cannot resolve at all — two copies inside one tier, or a contested
 * executable child package name — is reported on every claimant as
 * {@link InstalledExtensionEntry.collidesWith} instead; see
 * {@link mergeExtensionTiers} for why those two are not the same contest.
 *
 * `tiers` decides whether the project-local tier (`{cwd}/node_modules` of
 * *this CLI process*) is scanned at all:
 *
 * - `'all'` — every tier, including project-local. Correct only when this
 *   process's own `cwd` is the one relevant view — the fully offline paths,
 *   where the CLI is the sole process with an opinion about what is
 *   installed.
 * - `'shared-home'` — only the tiers CLI and a *reachable* server both read
 *   from the same `$MAKAIO_HOME` (`extensions/` symlinks, then
 *   `node_modules/` npm installs). A loopback server can have been started
 *   from a different project directory than the one this CLI invocation
 *   runs in, so this process's own `{cwd}/node_modules` says nothing about
 *   what that server has installed — including it would misreport this
 *   CLI's own project-local extensions as "installed but not loaded" on a
 *   server that never had them to load, and would let an unmanaged-name
 *   toggle persist a preference under the false pretense that it affects
 *   that server's next boot. Live callers (the local live listing's
 *   not-loaded merge, and the unmanaged-name validation/critical-check
 *   toggle commands run against a reachable server) must use this mode.
 *   The unavoidable consequence — a server's own project-local extensions
 *   are simply not addressable from a live CLI invocation whose `cwd`
 *   differs from the server's — is surfaced to the operator as a listing
 *   note (see `printLocalLiveListing` in `extension-commands.ts`) rather
 *   than silently guessed at; resolving it for real needs a server-owned
 *   catalog RPC for its own project-local tier, which is a deliberate
 *   follow-up, not solved here (the same reasoning
 *   `applyUnmanagedNameToggle` already documents for a *remote* bus).
 * @param makaioHome - Resolved Makaio data home.
 * @param tiers - Which discovery tiers to scan; see above.
 * @param options - Host capabilities for this listing; see
 *   {@link InstalledExtensionListingOptions}.
 * @returns Project-local extensions first (when `tiers` is `'all'`), then
 *   `$MAKAIO_HOME/extensions` symlinks, then npm installs; each descriptor's
 *   own entry is immediately followed by its child package entries, when it
 *   declares any.
 */
export async function listInstalledExtensions(
  makaioHome: string,
  tiers: 'all' | 'shared-home',
  options: InstalledExtensionListingOptions = {},
): Promise<readonly InstalledExtensionEntry[]> {
  const resolver = options.frameworkModuleResolver;
  try {
    await resolver?.install();
    return await scanInstalledExtensions(makaioHome, tiers);
  } finally {
    // Also runs when `install()` itself threw part-way — the same cleanup the
    // runtime performs for a failed install at boot, so a partially installed
    // hook never outlives this listing.
    await resolver?.uninstall();
  }
}

/**
 * Scan every requested discovery tier and merge the results.
 *
 * Split from {@link listInstalledExtensions} so the framework module
 * resolver's install/uninstall window wraps every server-entry import this
 * scan performs, with no early return escaping it.
 * @param makaioHome - Resolved Makaio data home.
 * @param tiers - Which discovery tiers to scan; see {@link listInstalledExtensions}.
 * @returns Merged entries in tier priority order.
 */
async function scanInstalledExtensions(
  makaioHome: string,
  tiers: 'all' | 'shared-home',
): Promise<readonly InstalledExtensionEntry[]> {
  const { YarnPackageManager, LocalPathInstaller } = await importPackageManager();
  const localInstaller = new LocalPathInstaller(path.join(makaioHome, 'extensions'));
  const yarn = new YarnPackageManager(makaioHome);

  const [projectLocalGroups, localExts, npmExts] = await Promise.all([
    tiers === 'all' ? listProjectLocalExtensionGroups() : Promise.resolve([]),
    localInstaller.list(),
    yarn.initialize().then(() => yarn.listPackages()),
  ]);

  const [localGroups, npmGroups] = await Promise.all([
    expandWithChildPackagesGrouped(localExts, 'local'),
    expandWithChildPackagesGrouped(npmExts, 'npm'),
  ]);

  return mergeExtensionTiers(projectLocalGroups, localGroups, npmGroups);
}

/**
 * Discover extensions in the current project's own dependency tree
 * (`{cwd}/node_modules`) — the tier the runtime's boot-time discovery
 * prioritizes above every `$MAKAIO_HOME`-managed install (see
 * {@link FilesystemDescriptorDiscovery}'s tier order). Reuses that same
 * discovery class with no directory overrides, which scans only this project-
 * local tier, and {@link resolveConventionEntrypoint} for the server-entry
 * resolution the runtime itself applies — so this reads exactly the
 * descriptors, and their child packages, a server booted from this directory
 * would load.
 * @returns One descriptor-plus-children group per project-local extension.
 *   Grouped (not flattened) so a name collision against a higher-priority
 *   caller-supplied tier can drop the whole losing group in
 *   {@link mergeExtensionTiers}.
 */
async function listProjectLocalExtensionGroups(): Promise<InstalledExtensionEntry[][]> {
  const discovery = new FilesystemDescriptorDiscovery(process.cwd());
  const discovered = await discovery.discover();
  return Promise.all(discovered.map((ext) => expandDiscoveredExtension(ext)));
}

/**
 * Convert one runtime-discovered project-local extension into an
 * {@link InstallerListingEntry} and expand it with its child packages.
 * @param ext - Extension discovered by {@link FilesystemDescriptorDiscovery}.
 * @returns The descriptor's own entry followed by its child package entries.
 */
async function expandDiscoveredExtension(ext: DiscoveredExtension): Promise<InstalledExtensionEntry[]> {
  const { descriptor, extensionPath } = ext;
  const serverEntrypoint = descriptor.entrypoints?.server;
  const declaresServerEntrypoint = serverEntrypoint !== undefined;
  const serverImportPath = declaresServerEntrypoint
    ? resolveConventionEntrypoint('server', serverEntrypoint, extensionPath)
    : undefined;
  const installerEntry: InstallerListingEntry = {
    name: descriptor.name,
    version: descriptor.version,
    ...(descriptor.critical !== undefined && { critical: descriptor.critical }),
    ...(descriptor.surface !== undefined && { surface: descriptor.surface }),
    ...(serverImportPath !== undefined && { serverImportPath }),
    ...(declaresServerEntrypoint && { declaresServerEntrypoint }),
  };
  return expandInstallerEntry(installerEntry, 'project-local');
}

/**
 * Expand a batch of installer entries with every executable child package
 * their server entrypoint exports, keeping each descriptor's entry grouped
 * with its own children.
 * @param exts - Entries reported by one installer.
 * @param origin - Installer the entries came from.
 * @returns One group per descriptor: its own entry, plus one entry per child
 *   package it exports.
 */
async function expandWithChildPackagesGrouped(
  exts: ReadonlyArray<InstallerListingEntry>,
  origin: 'local' | 'npm',
): Promise<InstalledExtensionEntry[][]> {
  return Promise.all(exts.map((ext) => expandInstallerEntry(ext, origin)));
}

/**
 * Expand one installer entry into its descriptor entry followed by its
 * executable child package entries.
 *
 * The descriptor's own row takes its `critical` flag from the exported package
 * carrying the descriptor name — the same object the coordinator loads — and
 * falls back to the descriptor's metadata only when there is no export to read
 * (see {@link listExportedPackages}). When the entry declares a server
 * entrypoint but that entrypoint could not be read, the descriptor's own row
 * is marked {@link InstalledExtensionEntry.criticalityUnknown} rather than
 * silently reported as non-critical — the schema forbids the descriptor from
 * declaring `critical` itself in that case, so there is no metadata to fall
 * back to either. The exported packages are reordered so the descriptor's own
 * entry always leads the group, which {@link mergeExtensionTiers} relies on to
 * identify it.
 * @param ext - Installer entry to expand.
 * @param origin - Tier the entry came from.
 * @returns The descriptor's own entry followed by its child package entries.
 */
async function expandInstallerEntry(
  ext: InstallerListingEntry,
  origin: InstalledExtensionEntry['origin'],
): Promise<InstalledExtensionEntry[]> {
  const resolution = await listExportedPackages(ext);
  if (resolution === undefined) {
    // A declared server entrypoint that could not be read — whether because
    // its candidate path never resolved or the import itself failed — leaves
    // criticality genuinely unresolved (the schema forbids `ext.critical` in
    // this case anyway). Checking `declaresServerEntrypoint` rather than
    // `ext.serverImportPath` is what makes that distinction: an unresolvable
    // path also leaves `serverImportPath` `undefined`, which would otherwise
    // be indistinguishable from "no entrypoint declared" (a legitimate,
    // known "not critical").
    const criticalityUnknown = ext.declaresServerEntrypoint === true;
    return [toInstalledEntry(ext, origin, ext.critical, toRestrictedSurface(ext.surface), criticalityUnknown)];
  }

  const { packages: exported, invalidCriticalNames } = resolution;
  const descriptorName = ext.descriptorName ?? ext.name;
  const ownPackage = exported.find((pkg) => pkg.name === descriptorName);
  return [
    // A package present in the export but whose raw `critical` value failed
    // validation (see `isValidExportedCriticalFlag`) is not "legitimately
    // non-critical" — it is unresolved for the same reason an unreadable
    // entrypoint is, so it carries the same `criticalityUnknown` marker.
    // The exported package's own `surface` wins over the descriptor's: the
    // coordinator gates on the object it loads, and the descriptor's metadata
    // only reaches a package the runtime synthesizes from it.
    toInstalledEntry(
      ext,
      origin,
      ownPackage?.critical,
      ownPackage ? ownPackage.surface : toRestrictedSurface(ext.surface),
      invalidCriticalNames.has(descriptorName),
    ),
    ...exported
      .filter((pkg) => pkg.name !== descriptorName)
      .map((pkg) => ({
        name: pkg.name,
        version: pkg.version,
        origin,
        ...(pkg.critical !== undefined && { critical: pkg.critical }),
        ...(pkg.surface !== undefined && { surface: pkg.surface }),
        ...(invalidCriticalNames.has(pkg.name) && { criticalityUnknown: true }),
      })),
  ];
}

/** One live claim on a package name, recorded while merging tiers. */
interface NameClaim {
  /** Position of the claiming entry in the merged output. */
  readonly mergedIndex: number;
  /** Origin of the claiming entry, reported to the entries it collides with. */
  readonly origin: InstalledExtensionEntry['origin'];
  /**
   * Single runtime surface the claiming package is restricted to, or
   * `undefined` when it loads on every surface — see
   * {@link InstalledExtensionEntry.surface}.
   */
  readonly surface: InstalledExtensionEntry['surface'];
  /**
   * Whether this claim originates from a descriptor name repeated inside one
   * tier, which contests the name regardless of any surface declaration — see
   * {@link claimsContest}.
   */
  readonly sameTierDescriptorContest: boolean;
}

/**
 * Merge extension groups from every discovery tier, reproducing what the
 * runtime does with each claimed package name: resolve it, or refuse to boot.
 *
 * Two different contests exist, and conflating them is what made this listing
 * disagree with the runtime:
 *
 * - **A descriptor name claimed by a higher-priority tier.** This is the one
 *   contest discovery itself resolves (`local` \> `installed` \> `global-npm`,
 *   see {@link FilesystemDescriptorDiscovery}). The losing descriptor is
 *   dropped whole — its child packages cannot load without it — and is marked
 *   {@link InstalledExtensionEntry.shadowedBy} here rather than omitted: it is
 *   installed, an operator can act on it, and silently dropping it made a
 *   just-installed extension look like it had never been installed. Keeping it
 *   is safe for every lookup because it is always emitted *after* the winner,
 *   so scanning for the first row matching a name still finds the loaded copy.
 * - **Any other repeated claim on one name.** Two packages inside a single tier,
 *   or a cross-tier claim in which at least one side is an executable child
 *   package, have no resolution: discovery's dedup is by descriptor name, so
 *   both copies survive it and the coordinator's own name check then aborts the
 *   boot. Every claimant is marked {@link InstalledExtensionEntry.collidesWith}
 *   — none of them loads. A cross-tier claim is judged per surface, because
 *   the coordinator's name check only ever sees the packages one surface
 *   loaded — see {@link claimsContest}.
 * @param tiers - Extension groups from each tier, ordered from highest to
 *   lowest priority. Each group is one descriptor entry followed by its own
 *   child package entries.
 * @returns Flattened entry list: unshadowed entries followed by the entries
 *   they shadow, with every unresolvable claim marked as a collision.
 */
function mergeExtensionTiers(
  ...tiers: ReadonlyArray<ReadonlyArray<InstalledExtensionEntry[]>>
): InstalledExtensionEntry[] {
  const descriptorClaims = new Map<string, { tierIndex: number; origin: InstalledExtensionEntry['origin'] }>();
  const claimsByName = new Map<string, NameClaim[]>();
  const merged: InstalledExtensionEntry[] = [];

  tiers.forEach((tier, tierIndex) => {
    for (const group of tier) {
      const descriptorEntry = group[0];
      if (descriptorEntry === undefined) continue;
      // Only a *higher* tier shadows a whole group. A descriptor name repeated
      // inside one tier has no precedence to appeal to, so both copies stay
      // live here and are surfaced as a collision below, matching the
      // `ExtensionNameCollisionError` discovery throws for them.
      const descriptorClaim = descriptorClaims.get(descriptorEntry.name);
      const groupShadowOrigin =
        descriptorClaim !== undefined && descriptorClaim.tierIndex < tierIndex ? descriptorClaim.origin : undefined;
      if (descriptorClaim === undefined) {
        descriptorClaims.set(descriptorEntry.name, { tierIndex, origin: descriptorEntry.origin });
      }

      // A descriptor name repeated inside one tier is refused by discovery
      // itself, before any package exists to carry a surface declaration — so
      // that contest is recorded as surface-independent.
      const sameTierDescriptorContest = descriptorClaim?.tierIndex === tierIndex;

      for (const entry of group) {
        // A shadowed group's entries claim nothing: its descriptor never loads,
        // so the names its children would have registered stay free for a
        // lower tier to take without that being a collision.
        if (groupShadowOrigin !== undefined) {
          merged.push({ ...entry, shadowedBy: groupShadowOrigin });
          continue;
        }
        const claims = claimsByName.get(entry.name) ?? [];
        claims.push({
          mergedIndex: merged.length,
          origin: entry.origin,
          surface: entry.surface,
          sameTierDescriptorContest: sameTierDescriptorContest && entry.name === descriptorEntry.name,
        });
        claimsByName.set(entry.name, claims);
        merged.push(entry);
      }
    }
  });

  return markNameCollisions(merged, claimsByName);
}

/**
 * Decide whether two claims on one name actually contest it.
 *
 * The coordinator resolves names *after* it filters packages by surface
 * (`filterEligibleExtensions` then `coalesceExtensionOverrides` in
 * `@makaio/kernel`), so two packages restricted to different surfaces are
 * never handed to that resolution together: each boots on its own surface and
 * neither displaces the other. Reporting them as a collision would exit
 * non-zero and refuse a toggle for a name that resolves fine on every surface
 * a host can actually be.
 *
 * A same-tier descriptor-name contest ignores this: discovery throws before
 * any package is loaded, so no surface declaration exists yet to exempt it.
 *
 * `requires` (host and capability gates) is deliberately *not* evaluated the
 * same way. It is answered by the host environment of the process that boots,
 * which an offline listing cannot know — two packages with disjoint `requires`
 * may still both be eligible on some host, and treating them as safe here
 * would reinstate exactly the silent override this reporting exists to end.
 * They stay reported as a collision.
 * @param claim - One claim on the name.
 * @param other - Another claim on the same name.
 * @returns Whether both claims can be loaded at once, making the name contested.
 */
function claimsContest(claim: NameClaim, other: NameClaim): boolean {
  if (claim.sameTierDescriptorContest || other.sameTierDescriptorContest) return true;
  return claim.surface === undefined || other.surface === undefined || claim.surface === other.surface;
}

/**
 * Mark every entry whose name survived tier resolution with a claimant it
 * actually contests the name with.
 *
 * Both sides are marked, not just the later one: the runtime loads neither, so
 * presenting either as the winner would be the same misreport
 * {@link InstalledExtensionEntry.collidesWith} exists to end.
 * @param merged - Entries in listing order, as produced by {@link mergeExtensionTiers}.
 * @param claimsByName - Live claims per package name, keyed by name.
 * @returns The entry list with each colliding entry marked.
 */
function markNameCollisions(
  merged: readonly InstalledExtensionEntry[],
  claimsByName: ReadonlyMap<string, readonly NameClaim[]>,
): InstalledExtensionEntry[] {
  const result = [...merged];
  for (const claims of claimsByName.values()) {
    if (claims.length < 2) continue;
    for (const claim of claims) {
      const entry = result[claim.mergedIndex];
      const other = claims.find((candidate) => candidate !== claim && claimsContest(claim, candidate));
      if (entry === undefined || other === undefined) continue;
      result[claim.mergedIndex] = { ...entry, collidesWith: other.origin };
    }
  }
  return result;
}

/**
 * Find the installed entry that reports a name as unresolvably claimed.
 *
 * Shared by the toggle commands so an enablement preference is never persisted
 * for a name no boot will resolve — see
 * {@link InstalledExtensionEntry.collidesWith}. Scanning for any colliding row
 * rather than the first row matching the name matters because every claimant
 * carries the marker, and the first one is not a winner.
 * @param installed - Installed-package listing from {@link listInstalledExtensions}.
 * @param name - Extension package name being addressed.
 * @returns The first colliding entry claiming `name`, or `undefined` when the
 *   name is unambiguous.
 */
export function findCollidingInstalledEntry(
  installed: readonly InstalledExtensionEntry[],
  name: string,
): InstalledExtensionEntry | undefined {
  return installed.find((ext) => ext.name === name && ext.collidesWith !== undefined);
}

/**
 * Normalize an installer listing entry into an {@link InstalledExtensionEntry}.
 *
 * Keyed by the descriptor identity (`ext.descriptorName`, falling back to
 * `ext.name` when the installer cannot distinguish it), which is what the
 * enablement file and the runtime loader both use. The npm dependency
 * identifier is retained under `npmName` only when it differs, for display.
 * @param ext - Entry reported by one of the installers.
 * @param origin - Installer the entry came from.
 * @param critical - Criticality resolved by the caller from the authoritative
 *   declaration for this descriptor; `undefined` when nothing declares it.
 * @param surface - Single runtime surface this descriptor's package is
 *   restricted to, resolved by the caller from the authoritative declaration;
 *   `undefined` when it loads on every surface — see
 *   {@link InstalledExtensionEntry.surface}.
 * @param criticalityUnknown - `true` when `critical` is `undefined` because
 *   the declaration could not be read, not because nothing declares it — see
 *   {@link InstalledExtensionEntry.criticalityUnknown}. Defaults to `false`.
 * @returns Normalized entry for the descriptor's own package name.
 */
function toInstalledEntry(
  ext: InstallerListingEntry,
  origin: InstalledExtensionEntry['origin'],
  critical: boolean | undefined,
  surface: InstalledExtensionEntry['surface'],
  criticalityUnknown = false,
): InstalledExtensionEntry {
  const descriptorName = ext.descriptorName ?? ext.name;
  return {
    name: descriptorName,
    version: ext.version,
    origin,
    ...(critical !== undefined && { critical }),
    ...(surface !== undefined && { surface }),
    ...(criticalityUnknown && { criticalityUnknown }),
    ...(descriptorName !== ext.name && { npmName: ext.name }),
  };
}

/**
 * Enumerate the executable packages an installed extension's server entrypoint
 * exports, without invoking any package's `create()`.
 *
 * Dynamically imports the already-resolved server entry and normalizes its
 * default export with {@link normalizePackageExport} — the same identity
 * contract the runtime applies at boot, which guarantees one exported package
 * carries the descriptor name and every other is dot-prefixed under it. The
 * import executes the module's top-level code; the extension server-module
 * contract (see `docs/architecture/extensions/index.md`) requires that top
 * level to contain only declarations, with side effects deferred to
 * `create()`/`init()`. `create()` itself is called exclusively by the
 * coordinator during activation, never by this offline path.
 *
 * Returning `undefined` rather than an empty list distinguishes "this
 * descriptor has no exported package to read" — no server entrypoint
 * (`serverImportPath` undefined, including every detached extension, whose
 * descriptor never declares `entrypoints`), or an export this process could
 * not import or validate — from "it exports exactly one package". Only the
 * former lets the caller fall back to descriptor metadata; a broken extension
 * must not block the rest of the listing either way.
 *
 * The import runs directly on this process's own module registry, unlike
 * `resolveExportedPackageCritical` in `@makaio/services-package-manager`'s
 * `exported-package-critical.ts`, which imports inside an isolated
 * `worker_threads.Worker`: that function runs inside a long-lived server
 * process where a stale Node ESM module cache could report a pre-update
 * `critical` value across repeated `packages.list` calls, so it needs a
 * fresh module registry per call. Each `makaio extension list` / `enable` /
 * `disable` invocation is a fresh, short-lived CLI process, so there is no
 * cross-call cache to go stale within — the first import in the process is
 * always current, and the worker's isolation overhead is unnecessary here.
 *
 * Running on this process's registry also means this import only resolves an
 * extension's own `@makaio/framework/*` imports when the host's module
 * resolver hook is installed — {@link listInstalledExtensions} installs it
 * around this scan when the host supplied one (see
 * {@link InstalledExtensionListingOptions.frameworkModuleResolver}).
 * @param ext - Installer entry whose exported packages should be enumerated.
 * @returns Every package the server entry exports plus their invalid-`critical`
 *   names, or `undefined` when there is no readable export.
 */
async function listExportedPackages(ext: InstallerListingEntry): Promise<ExportedPackagesResolution | undefined> {
  if (ext.serverImportPath === undefined) {
    return undefined;
  }

  const descriptorName = ext.descriptorName ?? ext.name;
  const label = `[extension list] ${descriptorName}`;
  // Typed as the raw export, not as {@link ExportedPackage}: the sanitization
  // pass below is what narrows `critical` and `surface` to the values this
  // listing is willing to trust.
  let packages:
    | ReadonlyArray<
        Omit<ExportedPackage, 'critical' | 'surface'> & { readonly critical?: unknown; readonly surface?: unknown }
      >
    | undefined;
  try {
    const mod = (await import(pathToFileURL(ext.serverImportPath).href)) as { readonly default: unknown };
    // The descriptor identity, not the npm dependency identifier, is the
    // expected package identity `normalizePackageExport` anchors the export
    // against — the same identity contract `loadExtensions` applies at boot.
    packages = normalizePackageExport(mod.default, descriptorName, label);
  } catch (error) {
    console.warn(
      `${label}: failed to import server entry while listing exported packages:`,
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }

  if (packages === undefined) {
    return undefined;
  }

  // `normalizePackageExport`'s structural check never inspects `critical` —
  // strip a non-boolean value rather than let it masquerade as a resolved
  // flag downstream, and record its name so the caller marks that specific
  // entry unresolved instead of legitimately non-critical.
  const invalidCriticalNames = new Set<string>();
  const sanitized = packages.map((pkg): ExportedPackage => {
    const surface = toRestrictedSurface(pkg.surface);
    const base: ExportedPackage = { name: pkg.name, version: pkg.version, ...(surface !== undefined && { surface }) };
    if (isValidExportedCriticalFlag(pkg.critical)) {
      return { ...base, ...(pkg.critical !== undefined && { critical: pkg.critical }) };
    }
    invalidCriticalNames.add(pkg.name);
    console.warn(
      `${label}: exported package '${pkg.name}' declares 'critical' as ${typeof pkg.critical}, not a boolean; ` +
        'treating criticality as unresolved',
    );
    return base;
  });
  return { packages: sanitized, invalidCriticalNames };
}
