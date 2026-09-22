import * as path from 'node:path';
import { Command, InvalidOptionArgumentError } from 'commander';
import { createExtensionScaffold, type ExtensionSurface } from './extension-init.js';
import { verifyExtensionWorkspace } from './extension-verify.js';
import {
  isExtensionEnabled,
  resolveMakaioHome,
  loadExtensionEnablementStore,
  type ExtensionEnablementStore,
} from '@makaio/runtime-node';
import { importPackageManager, installExtensionSources } from './extension-install-transaction.js';
import {
  syncExistingProjectManifestPinsAfterUpdate,
  syncProjectManifestAfterInstall,
  syncProjectManifestAfterUninstall,
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
import { listInstalledExtensions, type InstalledExtensionEntry } from './extension-installed-listing.js';
import { runSetEnabled, remoteUnreachableRefusalMessage } from './extension-toggle-commands.js';

type CommandInstance = InstanceType<typeof Command>;

const SUPPORTED_SURFACES = ['server', 'browser', 'cli'] as const satisfies readonly ExtensionSurface[];

/**
 * Register local extension authoring commands.
 * @param program - Root Commander program.
 */
export function registerExtensionCommands(program: CommandInstance): void {
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
    .action(async () => runList());

  extension
    .command('enable <name>')
    .description('Enable an extension (persists the preference; takes effect on the next server start)')
    .action(async (name: string) => runSetEnabled(name, true));

  extension
    .command('disable <name>')
    .description('Disable an extension (persists the preference; takes effect on the next server start)')
    .action(async (name: string) => runSetEnabled(name, false));

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
 * Run a manifest sync operation, printing a warning instead of throwing on
 * failure. Manifest sync is best-effort: a stale or missing manifest must
 * never block the install or uninstall command itself.
 * @param operation - Async manifest sync callback to execute.
 */
async function warnOnManifestSyncFailure(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    console.warn(`Project manifest sync failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

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
    if (liveNames.has(ext.name)) continue;
    // `ext` carries the descriptor's `critical` flag, so a hand-disabled
    // critical extension is reported as enabled here exactly as boot starts it.
    const enabledLabel = isExtensionEnabled(enablementStore, ext.name, ext) ? 'enabled' : 'disabled';
    console.info(`${ext.name} (${ext.version}, ${formatInstalledOrigin(ext)}) [not loaded, ${enabledLabel}]`);
  }
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
 */
async function printLocalLiveListing(
  makaioHome: string,
  enablementStore: ExtensionEnablementStore,
  extensions: readonly ExtensionInfo[],
): Promise<void> {
  const liveNames = new Set(extensions.map((ext) => ext.name));
  const installed = await listInstalledExtensions(makaioHome, 'shared-home');
  const hasNotLoaded = installed.some((ext) => !liveNames.has(ext.name));

  if (extensions.length === 0 && !hasNotLoaded) {
    console.info('No extensions registered in the running server.');
    return;
  }
  for (const ext of extensions) {
    const stateLabel = extensionStateLabel(ext.state, ext.enabled, ext.persistedEnabled, ext.critical);
    console.info(`${ext.displayName} (${ext.name}) [${stateLabel}]`);
  }
  printNotLoadedInstalledExtensions(installed, liveNames, enablementStore);
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
 * see {@link printLocalLiveListing} and {@link printRemoteLiveListing}.
 * @param makaioHome - Resolved Makaio data home.
 * @param enablementStore - Enablement store used to label not-loaded entries.
 * @param health - Health payload of the reachable server.
 * @param busUrl - Resolved bus URL the caller connected to, decided once by
 *   {@link runList}.
 * @returns `true` when the live listing was printed (including the empty-list
 *   case); `false` when the caller should fall through to the offline listing.
 */
async function tryPrintLiveListing(
  makaioHome: string,
  enablementStore: ExtensionEnablementStore,
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
    const { extensions } = await bus.request(ExtensionSubjects.list, {});

    if (isRemoteBusUrl(busUrl)) {
      printRemoteLiveListing(extensions);
    } else {
      await printLocalLiveListing(makaioHome, enablementStore, extensions);
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
 * that did not answer the health probe has no such relationship to this
 * machine — falling back would present this machine's installs as if they
 * were the configured server's, exactly the failure mode
 * {@link runSetEnabled} already refuses for the same reason (see
 * {@link remoteUnreachableRefusalMessage}), so this refuses identically
 * instead of falling through.
 */
async function runList(): Promise<void> {
  try {
    const makaioHome = resolveMakaioHome();
    const enablementStore = await loadExtensionEnablementStore(makaioHome);
    warnOnEnablementReadFailure(enablementStore);

    // Try to get live state from a running server.
    const busUrl = resolveBusUrl();
    const health = await probeHealth(busUrl);
    if (health) {
      if (await tryPrintLiveListing(makaioHome, enablementStore, health, busUrl)) {
        return;
      }
    } else if (isRemoteBusUrl(busUrl)) {
      console.error(remoteUnreachableRefusalMessage('list extensions', busUrl));
      process.exitCode = 1;
      return;
    }

    // Offline: installed packages + persisted disabled set. No server is
    // reachable, so this CLI process is the sole relevant view — every tier,
    // including its own project-local `{cwd}/node_modules`, is in scope.
    const installed = await listInstalledExtensions(makaioHome, 'all');

    if (installed.length === 0) {
      console.info('No extensions installed.');
      return;
    }

    for (const ext of installed) {
      // `ext` carries the descriptor's `critical` flag, so a hand-disabled
      // critical extension is reported as enabled here exactly as boot starts it.
      const enabledLabel = isExtensionEnabled(enablementStore, ext.name, ext) ? 'enabled' : 'disabled';
      console.info(`${ext.name} (${ext.version}, ${formatInstalledOrigin(ext)}) [${enabledLabel}]`);
    }
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
 * Update one or all npm-installed extensions to their latest published version.
 * @param name - Optional extension name. When omitted, all npm extensions are updated.
 */
async function runUpdate(name?: string): Promise<void> {
  try {
    const { YarnPackageManager } = await importPackageManager();
    const makaioHome = resolveMakaioHome();
    const yarn = new YarnPackageManager(makaioHome);
    await yarn.initialize();

    const packages = await yarn.listPackages();
    const targets = name ? packages.filter((p) => p.name === name) : packages;

    if (targets.length === 0) {
      console.info(name ? `Extension ${name} not found.` : 'No npm extensions installed.');
      return;
    }

    const updatedPins: Array<{ packageName: string; version: string; spec: string }> = [];
    for (const pkg of targets) {
      const latest = await yarn.getLatestVersion(pkg.name);
      if (latest === 'unknown') {
        console.warn(`Could not determine latest version for ${pkg.name}; skipping.`);
        continue;
      }
      if (latest !== pkg.version) {
        const version = await yarn.installPackage(pkg.name);
        updatedPins.push({ packageName: pkg.name, version, spec: `${pkg.name}@${version}` });
        console.info(`Updated ${pkg.name}: ${pkg.version} → ${latest}`);
      } else {
        console.info(`${pkg.name}@${pkg.version} is up to date.`);
      }
    }
    await warnOnManifestSyncFailure(() => syncExistingProjectManifestPinsAfterUpdate(process.cwd(), updatedPins));
  } catch (error) {
    console.error(`Update failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
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
