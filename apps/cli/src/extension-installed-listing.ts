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
} from '@makaio/runtime-node';
import { importPackageManager } from './extension-install-transaction.js';

/**
 * One installed extension as seen without loading any extension code.
 *
 * `critical` comes from the package's `descriptor.json`, which is the only
 * declaration available before the runtime imports the extension's server
 * entrypoint. It is what lets offline CLI paths honour the same critical rule
 * the runtime applies.
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
  /** Whether this package declares itself critical. */
  readonly critical?: boolean;
  /**
   * npm dependency identifier this entry was installed under, when it
   * differs from `name` (an npm install whose descriptor declares a
   * different name than the package it ships in, e.g.
   * `@makaio/extension-opencode` installing a descriptor named `opencode`).
   * Display-only — every enablement-relevant lookup must use `name`, not this
   * field.
   */
  readonly npmName?: string;
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
  /** Whether the descriptor declares the extension as critical. */
  readonly critical?: boolean;
  /** Absolute import path for the resolved server entrypoint, when present. */
  readonly serverImportPath?: string;
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
 * across tiers keeps only the higher-priority tier's descriptor and its child
 * packages, exactly as the runtime would only ever load one of the two.
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
 * @returns Project-local extensions first (when `tiers` is `'all'`), then
 *   `$MAKAIO_HOME/extensions` symlinks, then npm installs; each descriptor's
 *   own entry is immediately followed by its child package entries, when it
 *   declares any.
 */
export async function listInstalledExtensions(
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
  const serverImportPath =
    serverEntrypoint === undefined ? undefined : resolveConventionEntrypoint('server', serverEntrypoint, extensionPath);
  const installerEntry: InstallerListingEntry = {
    name: descriptor.name,
    version: descriptor.version,
    ...(descriptor.critical !== undefined && { critical: descriptor.critical }),
    ...(serverImportPath !== undefined && { serverImportPath }),
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
 * @param ext - Installer entry to expand.
 * @param origin - Tier the entry came from.
 * @returns The descriptor's own entry followed by its child package entries.
 */
async function expandInstallerEntry(
  ext: InstallerListingEntry,
  origin: InstalledExtensionEntry['origin'],
): Promise<InstalledExtensionEntry[]> {
  return [toInstalledEntry(ext, origin), ...(await listChildPackages(ext, origin))];
}

/**
 * Merge extension groups from every discovery tier, resolving name
 * collisions per emitted package name rather than per descriptor group.
 *
 * Mirrors the `local` \> `installed` \> `global-npm` tier precedence
 * {@link FilesystemDescriptorDiscovery} applies at boot, at the same
 * granularity as the runtime's own tier merge
 * (`mergePackagesByDescriptorSourcePriority` in `load-extensions.ts`): a
 * descriptor whose own name collides with a higher-priority tier's
 * descriptor name is dropped whole, but a descriptor that only collides on
 * one of its *child* package names — because a higher-priority tier's
 * descriptor or child already claimed that exact name — loses only that one
 * colliding entry, keeping its own non-colliding entries. Tracking
 * collisions solely by `group[0].name` (the descriptor) would miss a
 * collision between a higher-priority tier's child package (e.g. `foo.bar`
 * exported by descriptor `foo`) and a lower-priority tier's *descriptor*
 * literally named `foo.bar`: both would end up in the merged list even
 * though the runtime's own coalescing only ever keeps one, and the offline
 * disable-validation path that scans this list for the first matching row
 * could pick the wrong one's `critical` flag.
 * @param tiers - Extension groups from each tier, ordered from highest to
 *   lowest priority. Each group is one descriptor entry followed by its own
 *   child package entries.
 * @returns Flattened, deduplicated entry list with at most one entry per
 *   package name.
 */
function mergeExtensionTiers(
  ...tiers: ReadonlyArray<ReadonlyArray<InstalledExtensionEntry[]>>
): InstalledExtensionEntry[] {
  const seenDescriptorNames = new Set<string>();
  const seenPackageNames = new Set<string>();
  const merged: InstalledExtensionEntry[] = [];
  for (const tier of tiers) {
    for (const group of tier) {
      const descriptorEntry = group[0];
      if (descriptorEntry === undefined || seenDescriptorNames.has(descriptorEntry.name)) continue;
      seenDescriptorNames.add(descriptorEntry.name);

      for (const entry of group) {
        if (seenPackageNames.has(entry.name)) continue;
        seenPackageNames.add(entry.name);
        merged.push(entry);
      }
    }
  }
  return merged;
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
 * @returns Normalized entry carrying the descriptor's critical flag.
 */
function toInstalledEntry(
  ext: InstallerListingEntry,
  origin: InstalledExtensionEntry['origin'],
): InstalledExtensionEntry {
  const descriptorName = ext.descriptorName ?? ext.name;
  return {
    name: descriptorName,
    version: ext.version,
    origin,
    ...(ext.critical !== undefined && { critical: ext.critical }),
    ...(descriptorName !== ext.name && { npmName: ext.name }),
  };
}

/**
 * Discover the executable child packages an installed extension's server
 * entrypoint exports, without invoking any package's `create()`.
 *
 * Dynamically imports the already-resolved server entry and normalizes its
 * default export with {@link normalizePackageExport} — the same identity
 * contract the runtime applies at boot. The import executes the module's
 * top-level code; the extension server-module contract (see
 * `docs/architecture/extensions/index.md`) requires that top level to
 * contain only declarations, with side effects deferred to `create()`/
 * `init()`. `create()` itself is called exclusively by the coordinator
 * during activation, never by this offline path. A descriptor
 * with no server entrypoint (`serverImportPath` undefined) — including every
 * detached extension, whose descriptor never declares `entrypoints` — has no
 * child packages to discover and is skipped.
 *
 * A single-package export or an import failure both yield no child packages:
 * the caller already has a row for the descriptor name itself, and a broken
 * extension must not block the rest of the listing.
 * @param ext - Installer entry whose child packages should be discovered.
 * @param origin - Installer the entry came from.
 * @returns Entries for every dot-prefixed child package the descriptor exports.
 */
async function listChildPackages(
  ext: InstallerListingEntry,
  origin: InstalledExtensionEntry['origin'],
): Promise<InstalledExtensionEntry[]> {
  if (ext.serverImportPath === undefined) {
    return [];
  }

  const descriptorName = ext.descriptorName ?? ext.name;
  const label = `[extension list] ${descriptorName}`;
  try {
    const mod = (await import(pathToFileURL(ext.serverImportPath).href)) as { readonly default: unknown };
    // The descriptor identity, not the npm dependency identifier, is the
    // expected package identity `normalizePackageExport` anchors the export
    // against — the same identity contract `loadExtensions` applies at boot.
    const packages = normalizePackageExport(mod.default, descriptorName, label);
    if (!packages) {
      return [];
    }

    return packages
      .filter((pkg) => pkg.name !== descriptorName)
      .map((pkg) => ({
        name: pkg.name,
        version: pkg.version,
        origin,
        ...(pkg.critical !== undefined && { critical: pkg.critical }),
      }));
  } catch (error) {
    console.warn(
      `${label}: failed to import server entry while listing child packages:`,
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}
