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
import { ExtensionSubjects, type ExtensionInfo } from '@makaio/kernel';
import {
  listInstalledExtensions,
  type InstalledExtensionEntry,
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
 * disabled set (see {@link loadExtensionEnablementStore}), so every listing
 * below would otherwise silently report every extension as enabled with no
 * indication that the persisted preferences were never actually read. The
 * listing still runs afterwards — the file's *contents* couldn't be used, but
 * discovering what is installed does not depend on it — but the command
 * exits non-zero so the operator notices before trusting the output.
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
 * Format an installed extension's origin for display, including its npm
 * dependency identifier when it differs from the descriptor identity used as
 * the entry's `name` (see {@link InstalledExtensionEntry.npmName}).
 * @param ext - Installed extension entry to format.
 * @returns Origin label, e.g. `npm` or `npm, npm package: @makaio/extension-opencode`.
 */
function formatInstalledOrigin(ext: InstalledExtensionEntry): string {
  return ext.npmName === undefined ? ext.origin : `${ext.origin}, npm package: ${ext.npmName}`;
}

/**
 * Compute the offline enabled/disabled label for an installed extension,
 * accounting for {@link InstalledExtensionEntry.criticalityUnknown}.
 *
 * {@link isExtensionEnabled} treats a missing `critical` flag the same as
 * `critical: false`. Feeding it an entry whose criticality could not be
 * determined (its server entry failed to import — see
 * {@link InstalledExtensionEntry.criticalityUnknown}) would therefore
 * silently print `disabled` for a name that might in fact be critical and
 * force-started on the next boot regardless of the enablement file. The
 * ambiguity only has a visible effect when the store actually disables the
 * name (see {@link isExtensionDisabledInStore}): a name with no persisted
 * disable is enabled either way, critical or not, so the compact `enabled`
 * label still applies unchanged in that case.
 *
 * A colliding entry (see {@link InstalledExtensionEntry.collidesWith}) has no
 * effective state at all: the contested name aborts the next start, so the
 * label reports the collision rather than an enablement preference that will
 * never be acted on.
 * @param enablementStore - Enablement store backing the persisted preference.
 * @param ext - Installed extension entry to label.
 * @returns `enabled` or `disabled` when the persisted preference resolves
 *   the effective state unambiguously; otherwise an indeterminate label
 *   naming the stored preference and flagging the effective state as
 *   unresolved.
 */
function offlineEnabledLabel(enablementStore: ExtensionEnablementStore, ext: InstalledExtensionEntry): string {
  if (ext.collidesWith !== undefined) {
    // Neither claimant loads, so there is no enablement state to report for
    // this row — the next start aborts on the contested name instead.
    return `name collision with ${ext.collidesWith}, nothing loads under this name until it is resolved`;
  }
  if (ext.shadowedBy !== undefined) {
    // The enablement preference is keyed by name, and the name belongs to the
    // winning copy — reporting this row's enabled/disabled state would report
    // the *other* extension's state under this row's version and origin.
    return `shadowed by ${ext.shadowedBy}, not loaded`;
  }
  if (ext.criticalityUnknown && isExtensionDisabledInStore(enablementStore, ext.name)) {
    return 'preference: disabled, effective state unknown (criticality unresolved)';
  }
  return isExtensionEnabled(enablementStore, ext.name, ext) ? 'enabled' : 'disabled';
}

/**
 * Report every name an installed listing found unresolvably claimed.
 *
 * The listing itself succeeded, so this is not a command failure — but the
 * state it describes stops the next server start, so the command exits
 * non-zero rather than leaving the rows to be scrolled past. Mirrors
 * {@link warnOnEnablementReadFailure}, which treats an unusable enablement file
 * the same way.
 * @param installed - Installed-package listing that was printed.
 */
function reportInstalledNameCollisions(installed: readonly InstalledExtensionEntry[]): void {
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
 * Print installed extensions the reachable server's coordinator never loaded.
 *
 * A name can be installed without being in the coordinator's live snapshot —
 * interactive-only on a headless server, unmet `requires`, or
 * `MAKAIO_SKIP_EXTENSIONS` — yet {@link runSetEnabled}'s unmanaged-name
 * fallback still lets an operator configure it directly. Omitting these
 * entries from `extension list` would hide exactly the names that fallback
 * addresses, so they are merged in here under a distinct `not loaded` status
 * carrying their persisted preference from the enablement file, deduplicated
 * against the live snapshot by name.
 * @param installed - Installed-package listing from {@link listInstalledExtensions}.
 * @param liveNames - Names already reported by the live `kernel:extension.list` snapshot.
 * @param enablementStore - Enablement store backing the persisted preference shown for each entry.
 */
function printNotLoadedInstalledExtensions(
  installed: readonly InstalledExtensionEntry[],
  liveNames: ReadonlySet<string>,
  enablementStore: ExtensionEnablementStore,
): void {
  for (const ext of installed) {
    // A shadowed or colliding row is never the copy the server loaded under
    // this name, so the live snapshot containing the name says nothing about
    // it — skipping it here is exactly the silent disappearance `shadowedBy`
    // and `collidesWith` exist to end.
    if (ext.shadowedBy === undefined && ext.collidesWith === undefined && liveNames.has(ext.name)) continue;
    // `ext` carries the executable package's `critical` flag, so a
    // hand-disabled critical extension is reported as enabled here exactly as
    // boot starts it — see {@link offlineEnabledLabel} for the
    // `criticalityUnknown` case this cannot resolve either way.
    const enabledLabel = offlineEnabledLabel(enablementStore, ext);
    console.info(`${ext.name} (${ext.version}, ${formatInstalledOrigin(ext)}) [not loaded, ${enabledLabel}]`);
  }
}

/**
 * Format the trailing note appended to a framework package's listing row
 * when an operator-managed installed package shares its name.
 *
 * The coordinator loads the framework package unconditionally under the
 * shared name, so the installed override never gets its own coordinator
 * entry — it would otherwise be silently invisible: `liveNames` (built from
 * the live snapshot) already contains the name, so
 * {@link printNotLoadedInstalledExtensions}'s dedup skips it as if nothing
 * were installed under that name at all. This surfaces the override's
 * presence directly on the framework package's own row instead, without a
 * second listing entry for the same name.
 * @param ext - Live extension entry to check for a name collision.
 * @param installedNames - Names of packages installed under this
 *   `$MAKAIO_HOME` (see {@link listInstalledExtensions}'s `'shared-home'` tier).
 * @returns The trailing note, or an empty string when `ext` is
 *   operator-managed or no installed package shares its name.
 */
function frameworkPackageOverrideNote(ext: ExtensionInfo, installedNames: ReadonlySet<string>): string {
  if (ext.extensionManaged || !installedNames.has(ext.name)) return '';
  return ' (installed override present, shadowed by a framework package of the same name until it no longer claims it)';
}

/**
 * Print a local server's live extension snapshot, merged with any
 * installed-but-not-loaded names discovered on this same `$MAKAIO_HOME`.
 *
 * Uses {@link listInstalledExtensions}'s `'shared-home'` tier mode, not
 * `'all'`: a local server is reachable over the loopback bus, but it can
 * have been started from a different project directory than this CLI
 * invocation, so this process's own project-local `{cwd}/node_modules` is
 * not necessarily the server's — only `$MAKAIO_HOME` is guaranteed shared.
 * See {@link listInstalledExtensions}'s TSDoc for the full rationale and the
 * follow-up this leaves open.
 * @param makaioHome - Resolved Makaio data home.
 * @param enablementStore - Enablement store used to label not-loaded entries.
 * @param extensions - Live extension snapshot from `kernel:extension.list`.
 * @param listingOptions - Host capabilities forwarded to
 *   {@link listInstalledExtensions}.
 */
async function printLocalLiveListing(
  makaioHome: string,
  enablementStore: ExtensionEnablementStore,
  extensions: readonly ExtensionInfo[],
  listingOptions: InstalledExtensionListingOptions,
): Promise<void> {
  const liveNames = new Set(extensions.map((ext) => ext.name));
  const installed = await listInstalledExtensions(makaioHome, 'shared-home', listingOptions);
  const installedNames = new Set(installed.map((ext) => ext.name));
  const hasNotLoaded = installed.some((ext) => !liveNames.has(ext.name));

  if (extensions.length === 0 && !hasNotLoaded) {
    console.info('No extensions registered in the running server.');
    return;
  }
  for (const ext of extensions) {
    const stateLabel = extensionStateLabel(ext.state, ext.enabled, ext.persistedEnabled, ext.critical);
    console.info(
      `${ext.displayName} (${ext.name}) [${stateLabel}]${frameworkPackageOverrideNote(ext, installedNames)}`,
    );
  }
  printNotLoadedInstalledExtensions(installed, liveNames, enablementStore);
  reportInstalledNameCollisions(installed);
  console.info(
    'Note: this listing only covers extensions shared through $MAKAIO_HOME — a project-local extension ' +
      "installed under the server's own {cwd}/node_modules (if its working directory differs from this CLI " +
      'invocation) cannot be listed or unmanaged-toggled from here.',
  );
}

/**
 * Print a remote server's live extension snapshot, without merging any
 * name installed on this machine.
 *
 * Merging local installed-but-not-loaded names into a remote host's listing
 * would misreport this machine's own installs as the remote host's, and a
 * local listing failure could suppress an otherwise valid remote result.
 * There is no RPC that reports a remote server's own installed-but-not-
 * loaded names — the same design gap `applyUnmanagedNameToggle` in
 * `extension-toggle-commands.ts` documents for persisting an unmanaged name
 * against a remote server — so this is a follow-up, not solved here.
 * @param extensions - Live extension snapshot from `kernel:extension.list`.
 */
function printRemoteLiveListing(extensions: readonly ExtensionInfo[]): void {
  if (extensions.length === 0) {
    console.info('No extensions registered in the running server.');
    return;
  }
  for (const ext of extensions) {
    const stateLabel = extensionStateLabel(ext.state, ext.enabled, ext.persistedEnabled, ext.critical);
    console.info(`${ext.displayName} (${ext.name}) [${stateLabel}]`);
  }
  console.info(
    'Note: this is a remote server (MAKAIO_BUS_URL) — extensions installed but not loaded on that host ' +
      'cannot be listed from here.',
  );
}

/**
 * Query the running server's live extension snapshot and print it.
 *
 * Merged with installed-but-not-loaded names only when the bus is local —
 * see {@link printLocalLiveListing} and {@link printRemoteLiveListing}. The
 * local enablement store is loaded only once that local/remote decision is
 * made, and only on the local branch: a reachable *remote* server's listing
 * never reads or reports on this machine's own `extensions.json` — that file
 * belongs to a different host and {@link printRemoteLiveListing} never
 * consults it, so eagerly loading it here would surface a read failure (and
 * the exit-1 it causes) for a file this call never actually uses.
 * @param makaioHome - Resolved Makaio data home.
 * @param health - Health payload of the reachable server.
 * @param busUrl - Resolved bus URL the caller connected to, decided once by
 *   {@link runList}.
 * @param listingOptions - Host capabilities forwarded to
 *   {@link printLocalLiveListing}'s installed-extension listing.
 * @returns `true` when the live listing was printed (including the empty-list
 *   case); `false` when the caller should fall through to the offline listing.
 */
async function tryPrintLiveListing(
  makaioHome: string,
  health: NonNullable<Awaited<ReturnType<typeof probeHealth>>>,
  busUrl: string,
  listingOptions: InstalledExtensionListingOptions,
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
    const { extensions } = await bus.request(ExtensionSubjects.list, {});

    if (isRemoteBusUrl(busUrl)) {
      printRemoteLiveListing(extensions);
    } else {
      const enablementStore = await loadExtensionEnablementStore(makaioHome);
      warnOnEnablementReadFailure(enablementStore);
      await printLocalLiveListing(makaioHome, enablementStore, extensions, listingOptions);
    }
    return true;
  } catch (error) {
    // `bus` is only set once `connectBusClient` resolves, so a defined
    // `bus` here means the failure came from the RPC request itself, not
    // from establishing the connection — the server is unambiguously
    // running, and hiding that behind the offline listing would report
    // stale/wrong state as if no server existed. The server actively
    // rejecting our credentials (as opposed to this client having none,
    // handled above) is the same: reachable, just not to this client, so
    // it must be reported rather than silently swallowed. Only a genuine
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
 * When a server is reachable, queries `kernel:extension.list` and reports
 * each extension's live state (enabled, disabled, skipped, failed, etc),
 * merged with any installed-but-not-loaded names. When offline, lists
 * installed packages from the package manager alongside the persisted
 * disabled set from the enablement file.
 *
 * The offline fallback below is only correct for a *local* bus: it lists
 * this machine's own installed packages and enablement file, which is a
 * faithful stand-in for "no server to query" only because a local server
 * would read the exact same state. `MAKAIO_BUS_URL` naming a remote host
 * that did not answer the health probe — or one that answered the probe but
 * then failed to connect for a non-auth reason, the same probe/connect race
 * {@link tryPrintLiveListing} falls through for — has no such relationship to
 * this machine — falling back would present this machine's installs as if
 * they were the configured server's, exactly the failure mode
 * {@link runSetEnabled} already refuses for the same reason (see
 * {@link remoteUnreachableRefusalMessage}), so the offline branch below is
 * entered through a single guard that refuses a remote target regardless of
 * which of those two paths led here, instead of only the outright-unreachable
 * one.
 * @param listingOptions - Host capabilities forwarded to every
 *   {@link listInstalledExtensions} call this listing makes.
 */
async function runList(listingOptions: InstalledExtensionListingOptions): Promise<void> {
  try {
    const makaioHome = resolveMakaioHome();

    // Try to get live state from a running server.
    const busUrl = resolveBusUrl();
    const health = await probeHealth(busUrl);
    if (health && (await tryPrintLiveListing(makaioHome, health, busUrl, listingOptions))) {
      return;
    }

    // Single guard for every path that falls through to the offline branch
    // below — an outright-failed health probe, or a health probe that
    // succeeded followed by a non-auth connection failure (see
    // `tryPrintLiveListing`'s TSDoc) — so a remote target refuses identically
    // in both cases rather than only the more obvious one.
    if (isRemoteBusUrl(busUrl)) {
      console.error(remoteUnreachableRefusalMessage('list extensions', busUrl));
      process.exitCode = 1;
      return;
    }

    // Offline: installed packages + persisted disabled set. No server is
    // reachable, so this CLI process is the sole relevant view — every tier,
    // including its own project-local `{cwd}/node_modules`, is in scope. Only
    // reached for a local bus, so the local enablement file this process
    // reads below is the same one a local server would have read.
    const enablementStore = await loadExtensionEnablementStore(makaioHome);
    warnOnEnablementReadFailure(enablementStore);

    const installed = await listInstalledExtensions(makaioHome, 'all', listingOptions);

    if (installed.length === 0) {
      console.info('No extensions installed.');
      return;
    }

    for (const ext of installed) {
      // `ext` carries the executable package's `critical` flag, so a
      // hand-disabled critical extension is reported as enabled here exactly
      // as boot starts it — see {@link offlineEnabledLabel} for the
      // `criticalityUnknown` case this cannot resolve either way.
      const enabledLabel = offlineEnabledLabel(enablementStore, ext);
      console.info(`${ext.name} (${ext.version}, ${formatInstalledOrigin(ext)}) [${enabledLabel}]`);
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
