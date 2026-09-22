import * as path from 'node:path';
import { Command, InvalidOptionArgumentError } from 'commander';
import { createExtensionScaffold, type ExtensionSurface } from './extension-init.js';
import { verifyExtensionWorkspace } from './extension-verify.js';
import {
  isExtensionEnabled,
  isExtensionDisabledInStore,
  resolveMakaioHome,
  loadExtensionEnablementStore,
  type ExtensionEnablementStore,
} from '@makaio/runtime-node';
import { importPackageManager, installExtensionSources } from './extension-install-transaction.js';
import { runUpdate } from './extension-update-command.js';
import {
  syncProjectManifestAfterInstall,
  syncProjectManifestAfterUninstall,
  warnOnManifestSyncFailure,
} from './project-manifest-sync.js';
import {
  probeHealth,
  connectBusClient,
  resolveClientAuth,
  isAuthConnectionError,
  resolveBusUrl,
  isRemoteBusUrl,
} from './bus-client.js';
import { ExtensionSubjects, type ExtensionInfo, type InstalledExtensionCatalogEntry } from '@makaio/kernel';
import {
  listInstalledExtensions,
  type InstalledExtensionRecord,
  type InstalledExtensionListingOptions,
} from './extension-installed-listing.js';
import { runSetEnabled, remoteUnreachableRefusalMessage } from './extension-toggle-commands.js';

type CommandInstance = InstanceType<typeof Command>;

const SUPPORTED_SURFACES = ['server', 'browser', 'cli'] as const satisfies readonly ExtensionSurface[];

/**
 * Register local extension authoring commands.
 * @param program - Root Commander program.
 * @param listingOptions - Host capabilities forwarded to every offline
 *   installed-extension listing these commands perform. A packaged host
 *   supplies its framework module resolver here so `list`, `enable`, and
 *   `disable` read an extension's exported `critical` declaration through the
 *   same resolution the runtime uses at boot — see
 *   {@link InstalledExtensionListingOptions}.
 */
export function registerExtensionCommands(
  program: CommandInstance,
  listingOptions: InstalledExtensionListingOptions = {},
): void {
  const extension = program.command('extension').description('Local extension authoring commands');

  extension
    .command('init <name>')
    .description('Create a local extension scaffold')
    .option('--display-name <displayName>', 'Display name shown in Makaio surfaces')
    .option('--surface <surfaceList>', 'Comma-separated surfaces: server,browser,cli', parseSurfaceOption, ['server'])
    .option('--scope <scope>', 'Optional npm scope for package.json (for example @acme)')
    .option('--out-dir <outDir>', 'Target directory for the new extension workspace')
    .action(
      async (
        name: string,
        options: {
          readonly displayName?: string;
          readonly surface: readonly ExtensionSurface[];
          readonly scope?: string;
          readonly outDir?: string;
        },
      ) => {
        try {
          const result = await createExtensionScaffold({
            name,
            displayName: options.displayName,
            surfaces: options.surface,
            scope: options.scope,
            outDir: options.outDir,
          });
          console.info(`Created extension scaffold at ${result.rootDir}`);
        } catch (error) {
          console.error(`Extension init failed: ${error instanceof Error ? error.message : String(error)}`);
          process.exitCode = 1;
        }
      },
    );

  extension
    .command('verify')
    .description('Verify the local extension workspace against the built entrypoint contract')
    .option('--cwd <cwd>', 'Extension root to verify')
    .action(async (options: { readonly cwd?: string }) => {
      try {
        const result = await verifyExtensionWorkspace({ cwd: options.cwd });
        console.info(`Extension verified at ${result.rootDir}`);
      } catch (error) {
        console.error(`Extension verify failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    });

  extension
    .command('install <sources...>')
    .description('Install extensions from npm or local paths')
    .option('--force', 'Skip compatibility checks for dependency upgrades')
    .action(async (sources: string[], options: { readonly force?: boolean }) => runInstall(sources, options));

  extension
    .command('uninstall <name>')
    .description('Uninstall an extension')
    .action(async (name: string) => runUninstall(name));

  extension
    .command('list')
    .description('List installed extensions with runtime state when a server is reachable')
    .action(async () => runList(listingOptions));

  extension
    .command('enable <name>')
    .description('Enable an extension (persists the preference; takes effect on the next server start)')
    .action(async (name: string) => runSetEnabled(name, true, listingOptions));

  extension
    .command('disable <name>')
    .description('Disable an extension (persists the preference; takes effect on the next server start)')
    .action(async (name: string) => runSetEnabled(name, false, listingOptions));

  extension
    .command('update [name]')
    .description('Update one or all installed extensions')
    .action(async (name?: string) => runUpdate(name));
}

// ---------------------------------------------------------------------------
// Action handlers — extracted to keep registerExtensionCommands within the
// max-lines-per-function budget while preserving readable action bodies.
// ---------------------------------------------------------------------------

/**
 * Install one or more extensions from local paths or the npm registry.
 *
 * Delegates the transaction to {@link installExtensionSources} and prints a
 * restart reminder when any install modified state.
 * @param sources - Raw CLI source strings (local paths or npm package names).
 * @param options - Install options.
 */
async function runInstall(sources: readonly string[], options: { readonly force?: boolean } = {}): Promise<void> {
  try {
    const result = await installExtensionSources(sources, options);
    await warnOnManifestSyncFailure(() => syncProjectManifestAfterInstall(process.cwd(), result.directNpm));
    if (result.changed) {
      console.info('Restart makaio to activate.');
    }
  } catch (error) {
    console.error(`Install failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

/**
 * Uninstall an extension by name, checking local symlinks before npm.
 * @param name - Extension name as declared in its descriptor.
 */
async function runUninstall(name: string): Promise<void> {
  try {
    const { YarnPackageManager, LocalPathInstaller } = await importPackageManager();
    const makaioHome = resolveMakaioHome();
    const localInstaller = new LocalPathInstaller(path.join(makaioHome, 'extensions'));
    const localExts = await localInstaller.list();

    if (localExts.some((e) => e.name === name)) {
      await localInstaller.uninstall(name);
      console.info(`Uninstalled ${name} (local)`);
      return;
    }

    const yarn = new YarnPackageManager(makaioHome);
    await yarn.initialize();
    await yarn.uninstallPackage(name);
    console.info(`Uninstalled ${name}`);
    await warnOnManifestSyncFailure(() => syncProjectManifestAfterUninstall(process.cwd(), name));
  } catch (error) {
    console.error(`Uninstall failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

/**
 * Warn when the enablement store's initial read failed.
 *
 * A corrupt, oversized, or unreadable enablement file degrades to an empty
 * disabled set (see {@link loadExtensionEnablementStore}), so the offline
 * listing would otherwise silently report every extension as enabled with no
 * indication that the persisted preferences were never actually read. The
 * listing still runs afterwards — the file's *contents* couldn't be used, but
 * discovering what is installed does not depend on it — but the command
 * exits non-zero so the operator notices before trusting the output. Only the
 * offline path reads this file at all: a reachable server reports its own
 * preferences, from its own store.
 * @param store - Enablement store returned by {@link loadExtensionEnablementStore}.
 */
function warnOnEnablementReadFailure(store: ExtensionEnablementStore): void {
  if (!store.readFailure) return;
  console.warn(
    'Warning: extension enablement preferences could not be read, so any extension not currently loaded by a ' +
      `running server is reported as enabled regardless of its persisted preference: ${store.readFailure.diagnostic}`,
  );
  process.exitCode = 1;
}

/**
 * Format an installed extension's origin for display, including the npm
 * dependency identifier when it differs from the executable package name.
 * @param ext - Installed package record to format.
 * @returns Origin label, e.g. `npm` or `npm, npm package: @makaio/extension-opencode`.
 */
function formatInstalledOrigin(ext: InstalledExtensionRecord): string {
  return ext.npmName === undefined ? ext.origin : `${ext.origin}, npm package: ${ext.npmName}`;
}

/**
 * Compute the enabled/disabled label for a package that is installed but not
 * running, from its persisted preference.
 *
 * Answers through {@link isExtensionEnabled} so this label honours the same
 * critical override the coordinator applies at boot: a hand-disabled critical
 * extension is reported as enabled, because that is what the next boot does
 * with it.
 *
 * The one case that override cannot resolve is a package whose criticality is
 * unknown — its server entry could not be read. {@link isExtensionEnabled}
 * treats a missing `critical` flag as `false`, which would print `disabled`
 * for a name the next boot might force-start anyway. That ambiguity only
 * becomes visible when the preference actually disables the name; without a
 * recorded disable the package is enabled either way.
 * @param store - Source of the persisted preference for `name`.
 * @param name - Executable package name to label.
 * @param record - Package view carrying the criticality flags.
 * @returns `enabled` or `disabled` when the preference resolves the effective
 *   state unambiguously; otherwise a label naming the stored preference and
 *   flagging the effective state as unresolved.
 */
function enablementLabel(
  store: { readonly loadEnabled?: (name: string) => boolean | undefined },
  name: string,
  record: { readonly critical?: boolean; readonly criticalityUnknown?: boolean },
): string {
  if (record.criticalityUnknown && isExtensionDisabledInStore(store, name)) {
    return 'preference: disabled, effective state unknown (criticality unresolved)';
  }
  return isExtensionEnabled(store, name, record) ? 'enabled' : 'disabled';
}

/**
 * Label one installed package record, reporting an unresolvable name claim
 * instead of an enablement state that will never be acted on.
 *
 * A colliding record has no effective state at all: the contested name aborts
 * the next start. A shadowed record has one, but it belongs to the copy that
 * won the name — reporting it here would show the *other* package's state
 * under this row's version and origin. Only a record the runtime would
 * actually load reaches {@link enablementLabel}.
 * @param store - Source of the persisted preference for the record's name.
 * @param record - Installed package record to label.
 * @returns The collision or shadowing label, or the record's enablement label.
 */
function installedRecordLabel(
  store: { readonly loadEnabled?: (name: string) => boolean | undefined },
  record: InstalledExtensionRecord,
): string {
  if (record.collidesWith !== undefined) {
    return `name collision with ${record.collidesWith}, nothing loads under this name until it is resolved`;
  }
  if (record.shadowedBy !== undefined) {
    return `shadowed by ${record.shadowedBy}, not loaded`;
  }
  return enablementLabel(store, record.name, record);
}

/**
 * Report every name an installed-package listing found unresolvably claimed.
 *
 * The listing itself was produced successfully, so this is not a command
 * failure — but the state it describes stops the next server start, so the
 * command exits non-zero rather than leaving the rows to be scrolled past.
 * Mirrors {@link warnOnEnablementReadFailure}, which treats an unusable
 * enablement file the same way.
 * @param installed - Installed-package records that were printed, from this
 *   machine's own scan or from the reachable server's catalog.
 */
function reportInstalledNameCollisions(installed: readonly InstalledExtensionRecord[]): void {
  const names = [...new Set(installed.filter((ext) => ext.collidesWith !== undefined).map((ext) => ext.name))];
  if (names.length === 0) return;
  console.error(
    `Extension name collision: ${names.join(', ')} — claimed by more than one installed copy. ` +
      'Extension names are identities and cannot be shared, and the copies above have no precedence over ' +
      'each other — the next server start refuses to boot until one of them is uninstalled or renamed.',
  );
  process.exitCode = 1;
}

/**
 * Print the packages the reachable server has installed but never loaded into
 * its coordinator.
 *
 * A name can be installed without appearing in the live snapshot —
 * interactive-only on a headless server, unmet `requires`, or
 * `MAKAIO_SKIP_EXTENSIONS` — and `extension enable`/`disable` still address
 * it. Omitting these would hide exactly the names that path serves. Their
 * preference comes from the server's own catalog entry, not from this
 * machine's enablement file, so the listing describes the host that actually
 * owns the state.
 * @param catalog - Installed-package catalog reported by the server.
 * @param liveNames - Names already reported by the live snapshot.
 */
function printNotLoadedCatalogEntries(
  catalog: readonly InstalledExtensionCatalogEntry[],
  liveNames: ReadonlySet<string>,
): void {
  for (const entry of catalog) {
    // A shadowed or colliding row is never the copy the server loaded under
    // this name, so the live snapshot containing the name says nothing about
    // it — skipping it here is exactly the silent disappearance `shadowedBy`
    // and `collidesWith` exist to end.
    if (entry.shadowedBy === undefined && entry.collidesWith === undefined && liveNames.has(entry.name)) continue;
    const label = installedRecordLabel({ loadEnabled: () => entry.persistedEnabled }, entry);
    console.info(`${entry.name} (${entry.version}, ${formatInstalledOrigin(entry)}) [not loaded, ${label}]`);
  }
}

/**
 * Format the trailing note appended to a framework package's listing row
 * when an installed package shares its name.
 *
 * The coordinator loads the framework package unconditionally under the
 * shared name, so the installed package never gets its own coordinator entry
 * — it would otherwise be silently invisible, since the name is already in
 * the live snapshot and the not-loaded merge skips it as if nothing were
 * installed under it at all. This surfaces the shadowed install on the
 * framework package's own row instead, without a second row for one name.
 * @param ext - Live extension entry to check for a name collision.
 * @param installedNames - Names the server reports as installed.
 * @returns The trailing note, or an empty string when `ext` is
 *   operator-managed or no installed package shares its name.
 */
function frameworkPackageOverrideNote(ext: ExtensionInfo, installedNames: ReadonlySet<string>): string {
  if (ext.extensionManaged || !installedNames.has(ext.name)) return '';
  return ' (installed override present, shadowed by a framework package of the same name until it no longer claims it)';
}

/**
 * Print a running server's extension listing: its live snapshot, merged with
 * the packages it has installed but never loaded.
 *
 * Both halves come from the server, so the listing describes one host rather
 * than splicing this machine's installs into another's snapshot — which is
 * what makes it equally correct for a local and a remote bus, and what lets
 * it cover the server's own project-local install tier.
 * @param extensions - Live extension snapshot from `kernel:extension.list`.
 * @param catalog - Installed-package catalog from `kernel:extension.catalog`,
 *   or `null` when that server cannot enumerate its installed packages.
 */
function printLiveListing(
  extensions: readonly ExtensionInfo[],
  catalog: readonly InstalledExtensionCatalogEntry[] | null,
): void {
  const liveNames = new Set(extensions.map((ext) => ext.name));
  const installedNames = new Set((catalog ?? []).map((entry) => entry.name));
  const hasNotLoaded = (catalog ?? []).some((entry) => !liveNames.has(entry.name));

  if (extensions.length === 0 && !hasNotLoaded) {
    console.info('No extensions registered in the running server.');
  }
  for (const ext of extensions) {
    const stateLabel = extensionStateLabel(ext.state, ext.enabled, ext.persistedEnabled, ext.critical);
    console.info(
      `${ext.displayName} (${ext.name}) [${stateLabel}]${frameworkPackageOverrideNote(ext, installedNames)}`,
    );
  }
  if (catalog === null) {
    console.info(
      'Note: this server does not expose an installed-extension catalog, so packages it has installed but ' +
        'never loaded cannot be listed.',
    );
    return;
  }
  printNotLoadedCatalogEntries(catalog, liveNames);
  reportInstalledNameCollisions(catalog);
}

/**
 * Query the running server's extension state and print it.
 *
 * Both requests go to the same server, so a failure of either is reported
 * rather than silently degraded: falling back to this machine's own view
 * would describe a different host.
 * @param health - Health payload of the reachable server.
 * @param busUrl - Resolved bus URL the caller connected to, decided once by
 *   {@link runList}.
 * @returns `true` when the live listing was printed (including the empty-list
 *   case); `false` when the caller should fall through to the offline listing.
 */
async function tryPrintLiveListing(
  health: NonNullable<Awaited<ReturnType<typeof probeHealth>>>,
  busUrl: string,
): Promise<boolean> {
  // `resolveClientAuth` throwing is unconditional and deterministic — it
  // means auth is required and no secret is configured, which is a fact
  // about this client's credentials, not about the server's reachability.
  // The health probe just proved the server IS running, so reporting this
  // rather than falling through to the offline listing is the only
  // reading that doesn't hide a real, actionable configuration problem.
  let auth: Awaited<ReturnType<typeof resolveClientAuth>>;
  try {
    auth = resolveClientAuth(health);
  } catch (error) {
    console.error(`Failed to query running server: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return true;
  }

  let bus: Awaited<ReturnType<typeof connectBusClient>> | undefined;
  try {
    bus = await connectBusClient(busUrl, { auth, autoReconnect: false });
    const [{ extensions }, { entries }] = await Promise.all([
      bus.request(ExtensionSubjects.list, {}),
      bus.request(ExtensionSubjects.catalog, {}),
    ]);
    printLiveListing(extensions, entries);
    return true;
  } catch (error) {
    // `bus` is only set once `connectBusClient` resolves, so a defined
    // `bus` here means the failure came from a request itself, not from
    // establishing the connection — the server is unambiguously running,
    // and hiding that behind the offline listing would report stale/wrong
    // state as if no server existed. The server actively rejecting our
    // credentials (as opposed to this client having none, handled above)
    // is the same: reachable, just not to this client, so it must be
    // reported rather than silently swallowed. Only a genuine
    // connection-establishment failure for a non-auth reason (the health
    // probe raced with the server going down) falls through to the
    // offline listing below, matching what the probe would have reported
    // had it run a moment later.
    if (bus || isAuthConnectionError(error)) {
      console.error(`Failed to query running server: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
      return true;
    }
    // Fall through to offline listing.
    return false;
  } finally {
    bus?.disconnect();
  }
}

/**
 * List all installed extensions with runtime state.
 *
 * When a server is reachable, the listing is entirely the server's: its live
 * runtime states plus its own installed-but-not-loaded packages. When none
 * is, this process lists what it can see itself — its installed packages and
 * the persisted preferences from the enablement file.
 *
 * That offline fallback is only correct for a *local* bus: it reads this
 * machine's installs and enablement file, which is a faithful stand-in for
 * "no server to query" only because a local server would read the exact same
 * state. `MAKAIO_BUS_URL` naming a remote host that did not answer the health
 * probe — or one that answered it but then failed to connect for a non-auth
 * reason, the same probe/connect race {@link tryPrintLiveListing} falls
 * through for — has no such relationship to this machine, so the offline
 * branch is entered through a single guard that refuses a remote target
 * regardless of which of those two paths led here.
 * @param listingOptions - Host capabilities forwarded to the offline
 *   installed-extension listing.
 */
async function runList(listingOptions: InstalledExtensionListingOptions): Promise<void> {
  try {
    const busUrl = resolveBusUrl();
    const health = await probeHealth(busUrl);
    if (health && (await tryPrintLiveListing(health, busUrl))) {
      return;
    }

    if (isRemoteBusUrl(busUrl)) {
      console.error(remoteUnreachableRefusalMessage('list extensions', busUrl));
      process.exitCode = 1;
      return;
    }

    // Offline: this machine's installed packages plus its persisted
    // preferences. Only reached for a local bus, so the enablement file read
    // here is the same one a local server would have read.
    const makaioHome = resolveMakaioHome();
    const enablementStore = await loadExtensionEnablementStore(makaioHome);
    warnOnEnablementReadFailure(enablementStore);

    const installed = await listInstalledExtensions(makaioHome, listingOptions);

    if (installed.length === 0) {
      console.info('No extensions installed.');
      return;
    }

    for (const ext of installed) {
      console.info(
        `${ext.name} (${ext.version}, ${formatInstalledOrigin(ext)}) [${installedRecordLabel(enablementStore, ext)}]`,
      );
    }
    reportInstalledNameCollisions(installed);
  } catch (error) {
    console.error(`List failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

/**
 * Produce the runtime-state portion of a live extension's label, ignoring
 * the durable preference.
 * @param state - Runtime lifecycle state.
 * @returns Short label for the runtime lifecycle state.
 */
function runtimeStateLabel(state: string): string {
  switch (state) {
    case 'active':
      return 'active';
    case 'skipped':
      return 'skipped';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'stopped';
    case 'initializing':
      return 'starting';
    case 'discovered':
      return 'pending';
    default:
      return state;
  }
}

/**
 * Produce a concise human-readable state label for a live extension.
 *
 * `enabled` is the *runtime* flag `setEnabled` cannot change without a
 * restart (see {@link ExtensionInfo.enabled}'s TSDoc), so it can diverge from
 * `persistedEnabled` — the durable preference read live at snapshot time —
 * right after a `setEnabled` call whose outcome was `restart-required`.
 * Reporting only `enabled` would then hide a durable toggle that has not
 * taken effect yet. When the two disagree, the label surfaces both: the
 * current runtime state plus what takes effect after the next restart. When
 * they agree, or `persistedEnabled` is unavailable (no `loadEnabled` reader
 * configured on the coordinator), the label stays as compact as before.
 *
 * A `critical` extension is the one case where "after restart" would be a
 * false promise: the coordinator force-starts it on every boot regardless of
 * the enablement file (see {@link ExtensionInfo.persistedEnabled}'s TSDoc),
 * so a hand-disabled `persistedEnabled: false` never actually takes effect —
 * the divergence is permanent, not pending. That combination gets its own
 * label instead of the restart promise; the reverse divergence (critical
 * with `persistedEnabled: true` or `undefined`) cannot occur from a
 * hand-edit that matters here and stays on the compact/restart paths above.
 * @param state - Runtime lifecycle state.
 * @param enabled - Whether the extension's runtime entry is currently enabled.
 * @param persistedEnabled - Durable enablement preference read live from the
 *   snapshot, or `undefined` when the coordinator has no `loadEnabled` reader.
 * @param critical - Whether the runtime force-starts this extension on every
 *   boot regardless of the enablement file.
 * @returns Label combining runtime state with the durable preference when
 *   they diverge.
 */
function extensionStateLabel(
  state: string,
  enabled: boolean,
  persistedEnabled: boolean | undefined,
  critical: boolean,
): string {
  const baseLabel = enabled ? runtimeStateLabel(state) : 'disabled';
  if (persistedEnabled === undefined || persistedEnabled === enabled) return baseLabel;
  if (critical && !persistedEnabled) {
    return `${baseLabel}, durable disable ignored (critical)`;
  }
  const restartLabel = persistedEnabled ? 'enabled after restart' : 'disabled after restart';
  return `${baseLabel}, ${restartLabel}`;
}

/**
 * Parse the `--surface` option into a canonical surface list.
 * @param value - Raw comma-separated surface list.
 * @returns Canonically ordered, deduplicated surface list.
 */
function parseSurfaceOption(value: string): readonly ExtensionSurface[] {
  const requested = value
    .split(',')
    .map((surface) => surface.trim())
    .filter((surface) => surface.length > 0);

  if (requested.length === 0) {
    throw new InvalidOptionArgumentError('Surface list must not be empty.');
  }

  const requestedSet = new Set<ExtensionSurface>();
  for (const surface of requested) {
    if (!SUPPORTED_SURFACES.includes(surface as ExtensionSurface)) {
      throw new InvalidOptionArgumentError(
        `Unsupported surface "${surface}". Expected one of: ${SUPPORTED_SURFACES.join(', ')}.`,
      );
    }
    requestedSet.add(surface as ExtensionSurface);
  }

  return SUPPORTED_SURFACES.filter((surface) => requestedSet.has(surface));
}
