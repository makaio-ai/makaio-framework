/**
 * `extension enable` / `extension disable` command implementation.
 *
 * Extracted from `extension-commands.ts` to keep that file within its line
 * budget while preserving the toggle path's own extensive rationale.
 * @packageDocumentation
 */
import { resolveMakaioHome, loadExtensionEnablementStore } from '@makaio/runtime-node';
import {
  probeHealth,
  connectBusClient,
  resolveClientAuth,
  resolveBusUrl,
  isRemoteBusUrl,
  type ServerHealth,
} from './bus-client.js';
import { ExtensionSubjects, type SetEnabledReason, type TransitionOutcome } from '@makaio/kernel';
import {
  findCollidingInstalledEntry,
  listInstalledExtensions,
  type InstalledExtensionListingOptions,
  type InstalledExtensionRecord,
} from './extension-installed-listing.js';

/**
 * Message printed when a disable request targets a critical extension.
 * @param name - Extension package name.
 * @returns Refusal text explaining why nothing was written.
 */
function criticalRefusalMessage(name: string): string {
  return (
    `Cannot disable "${name}": it is a critical extension. ` +
    'The runtime starts critical extensions even when the enablement file disables them, ' +
    'so nothing was written.'
  );
}

/**
 * Message printed when a disable request targets a name whose criticality
 * could not be determined.
 *
 * Distinct from {@link criticalRefusalMessage}: this is not a known-critical
 * refusal, but a fail-closed refusal for a name nothing can vouch for either
 * way. Treating it as "not critical" would let the disable persist for an
 * extension that the next boot — which may well be able to read the export —
 * force-starts as critical anyway, leaving a permanently ignored entry.
 * @param name - Extension package name.
 * @returns Refusal text explaining why nothing was written.
 */
function unknownCriticalityRefusalMessage(name: string): string {
  return (
    `Cannot disable "${name}": its server entry could not be read, so whether it is critical is unknown. ` +
    'Refusing to disable rather than risk silently persisting a disable for a critical extension — ' +
    'repair the extension and try again.'
  );
}

/**
 * Report a `MAKAIO_BUS_URL`-configured remote server that did not answer the
 * health probe.
 *
 * Shared by {@link runSetEnabled}'s offline fallback and `extension list`'s
 * live-listing fallback (`extension-commands.ts`): both have an offline path
 * that is only correct for a *local* bus — it reads or writes the same file
 * a local server would use, so falling back to it is a safe stand-in for "no
 * server to consult." An unreachable *remote* bus has no such relationship
 * to this machine's enablement file — falling back would silently report
 * this machine's own state (or persist a preference) as if it belonged to
 * the configured server. Whether the remote host is merely slow to answer or
 * genuinely down cannot be told apart from here, so both refuse rather than
 * guessing.
 * @param action - Description of the attempted action, used as
 *   `Failed to ${action}: ...` — e.g. `enable extension "foo"` or
 *   `list extensions`.
 * @param busUrl - Resolved, unreachable remote bus URL.
 * @returns Refusal text explaining why nothing was written or read.
 */
export function remoteUnreachableRefusalMessage(action: string, busUrl: string): string {
  return (
    `Failed to ${action}: the configured server at ${busUrl} is unreachable; ` +
    'retry when it is up, or run this command on that host.'
  );
}

/**
 * Refuse a toggle request for a name more than one installed copy claims.
 *
 * An enablement preference is keyed by extension name, so there is nothing to
 * write it *for* while two installed copies claim that name: the runtime
 * refuses to resolve the identity and the next start aborts before any
 * preference is read (see {@link InstalledExtensionRecord.collidesWith}).
 * Persisting anyway would report success for a change that cannot take effect
 * and would silently apply to whichever copy survives the operator's cleanup.
 * @param installed - Installed-package listing to check the name against.
 * @param name - Extension package name being toggled.
 * @param verb - Verb used in output ("enable" or "disable").
 * @returns `true` when the request was refused and nothing should be written.
 */
function refuseCollidingExtensionName(
  installed: readonly InstalledExtensionRecord[],
  name: string,
  verb: string,
): boolean {
  const colliding = findCollidingInstalledEntry(installed, name);
  if (colliding === undefined) return false;
  console.error(
    `Failed to ${verb} extension "${name}": more than one installed copy claims this name ` +
      `(${colliding.origin} and ${colliding.collidesWith}), so it does not resolve to a single extension and ` +
      'the next server start refuses to boot. Uninstall or rename one of them first; nothing was written. ' +
      'Run "makaio extension list" to see both copies.',
  );
  process.exitCode = 1;
  return true;
}

/**
 * Refuse a toggle request for a name nothing has installed.
 *
 * Shared by the offline path and {@link reportToggleResult}, so a typo reads
 * the same whether this process or the reachable server was the one that
 * could not find the name.
 * @param name - Extension package name that was not found.
 * @param verb - Verb used in output ("enable" or "disable").
 */
function reportUnknownExtensionName(name: string, verb: string): void {
  console.error(
    `Failed to ${verb} extension "${name}": no installed extension with this name. ` +
      'Run "makaio extension list" to see installed extensions.',
  );
  process.exitCode = 1;
}

/**
 * Enable or disable an extension by name.
 *
 * Who decides is the whole design here: whenever a server is reachable, *it*
 * owns the answer, because its enablement file, its installed packages, and
 * its project-local discovery root are the ones that matter — none of which
 * this process can see for a remote host, or even for a local server started
 * from another directory. So a reachable server validates and persists every
 * request through `kernel:extension.setEnabled`, including for names it never
 * loaded, and this command only renders the outcome it reports. The offline
 * path below is the fallback for "no server to ask", where this process is
 * the only view there is.
 *
 * `kernel:extension.setEnabled` is persist-only — enabling or disabling an
 * extension never takes effect in an already-running process, because
 * several package contributions are composed exactly once at boot.
 * @param name - Extension package name to toggle.
 * @param enabled - Desired enabled state.
 * @param listingOptions - Host capabilities forwarded to the offline
 *   installed-extension listing — its criticality check reads an extension's
 *   exported package by importing its server entry, which needs the host's
 *   framework module resolver to succeed for an extension installed from a
 *   local path. Unused when a server is reachable, which resolves the same
 *   fact against its own host.
 */
export async function runSetEnabled(
  name: string,
  enabled: boolean,
  listingOptions: InstalledExtensionListingOptions = {},
): Promise<void> {
  const verb = enabled ? 'enable' : 'disable';
  try {
    const busUrl = resolveBusUrl();
    const health = await probeHealth(busUrl);

    if (health) {
      await applyLiveToggle({ name, enabled, verb, health, busUrl });
      return;
    }

    if (isRemoteBusUrl(busUrl)) {
      console.error(remoteUnreachableRefusalMessage(`${verb} extension "${name}"`, busUrl));
      process.exitCode = 1;
      return;
    }

    await applyOfflineToggle(name, enabled, verb, listingOptions);
  } catch (error) {
    console.error(`Failed to ${verb} extension "${name}": ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

/**
 * Persist an enable/disable preference with no server to consult.
 *
 * This process is the sole writer of the enablement file for this action, so
 * it also performs the two validations a server would have performed against
 * its own host: the name must actually be installed here, and a disable must
 * not target a critical extension — nor one whose criticality could not be
 * resolved, which fails closed for the reason
 * {@link unknownCriticalityRefusalMessage} explains.
 * @param name - Extension package name to toggle.
 * @param enabled - Desired enabled state.
 * @param verb - Verb used in output ("enable" or "disable").
 * @param listingOptions - Host capabilities forwarded to the installed listing.
 */
async function applyOfflineToggle(
  name: string,
  enabled: boolean,
  verb: string,
  listingOptions: InstalledExtensionListingOptions,
): Promise<void> {
  const makaioHome = resolveMakaioHome();
  const installed = await listInstalledExtensions(makaioHome, listingOptions);

  // Checked ahead of "is it installed at all" and of criticality: both of
  // those answer for a single resolved copy, and a contested name has none.
  if (refuseCollidingExtensionName(installed, name, verb)) return;

  const record = installed.find((ext) => ext.name === name);

  if (!record) {
    reportUnknownExtensionName(name, verb);
    return;
  }

  if (!enabled && record.critical) {
    console.error(criticalRefusalMessage(name));
    process.exitCode = 1;
    return;
  }

  if (!enabled && record.criticalityUnknown) {
    console.error(unknownCriticalityRefusalMessage(name));
    process.exitCode = 1;
    return;
  }

  const enablementStore = await loadExtensionEnablementStore(makaioHome);
  await enablementStore.persistEnabled(name, enabled);
  console.info(`Extension "${name}" ${verb}d. Persisted; no running server — takes effect on next boot.`);
}

/** Inputs for one live enable/disable attempt against a running server. */
interface LiveToggleOptions {
  /** Extension package name to toggle. */
  readonly name: string;
  /** Desired enabled state. */
  readonly enabled: boolean;
  /** Verb used in output ("enable" or "disable"). */
  readonly verb: string;
  /** Health payload of the reachable server. */
  readonly health: ServerHealth;
  /** Resolved bus URL the caller connected to, decided once by {@link runSetEnabled}. */
  readonly busUrl: string;
}

/**
 * Forward a toggle to the running server, which owns the preference for every
 * name on its own host.
 *
 * The server is the single writer here: it validates the request against the
 * extensions it loaded and, for a name it did not load, against its own
 * installed-extension catalog — which covers install tiers this process may
 * have no access to at all. This command deliberately writes nothing itself,
 * even for a local bus: a local server can have been started from a different
 * project directory, so "this process's installed packages" is not a reliable
 * stand-in for the server's, and a preference written here for a name only the
 * server can resolve would be validated against the wrong host.
 * @param options - Live toggle inputs.
 */
async function applyLiveToggle(options: LiveToggleOptions): Promise<void> {
  const { name, enabled, verb, health, busUrl } = options;
  const auth = resolveClientAuth(health);
  const bus = await connectBusClient(busUrl, { auth, autoReconnect: false });
  try {
    let result: { readonly outcome: TransitionOutcome; readonly reason?: SetEnabledReason };
    try {
      result = await bus.request(ExtensionSubjects.setEnabled, { name, enabled });
    } catch (error) {
      // Every refusal the server can reason about arrives as a response, so a
      // thrown request is a transport- or runtime-level failure instead: it
      // leaves the true state uncertain from here rather than "reverted" —
      // this command never wrote a value of its own to revert.
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        `Failed to ${verb} extension "${name}": request failed: ${reason}. ` +
          'Nothing was written locally; the reachable server owns this preference.',
      );
      process.exitCode = 1;
      return;
    }

    reportToggleResult(name, verb, result.outcome, result.reason);
  } finally {
    bus.disconnect();
  }
}

/**
 * Render one `kernel:extension.setEnabled` response.
 *
 * The outcome says whether the preference was written and whether it is
 * already in effect; the reason says which situation produced it. Both are
 * needed: "persisted, and the process already matches" reads very differently
 * depending on whether the extension is running or was never loaded at all,
 * and an operator can only act on a refusal once they know which one it was.
 * @param name - Extension package name.
 * @param verb - Verb used in output ("enable" or "disable").
 * @param outcome - Outcome the server reported.
 * @param reason - Machine-readable detail the server reported alongside it.
 */
function reportToggleResult(
  name: string,
  verb: string,
  outcome: TransitionOutcome,
  reason: SetEnabledReason | undefined,
): void {
  if (outcome === 'rejected') {
    reportRejectedToggle(name, verb, reason);
    return;
  }

  const takesEffect = outcome === 'restart-required' ? ' Takes effect on next boot.' : '';
  console.info(`Extension "${name}" ${verb}d. Persisted; ${persistedStateNote(reason)}.${takesEffect}`);
}

/**
 * Describe what the server's runtime state means for a persisted preference.
 * @param reason - Machine-readable detail the server reported.
 * @returns Sentence fragment appended after `Persisted; `.
 */
function persistedStateNote(reason: SetEnabledReason | undefined): string {
  switch (reason) {
    case 'not-loaded':
      return 'not loaded in the running server (interactive-only, unmet requirements, or MAKAIO_SKIP_EXTENSIONS)';
    case 'framework-package-shadowed':
      return (
        'a framework package currently holds this name — the installed override applies once that package ' +
        'no longer claims it'
      );
    case 'runtime-state-diverges':
      return "the running server's process is not in the requested state";
    default:
      return "the running server's process already matches this state";
  }
}

/**
 * Report a refused toggle, naming the specific refusal so the operator can
 * act on it.
 * @param name - Extension package name.
 * @param verb - Verb used in output ("enable" or "disable").
 * @param reason - Machine-readable detail the server reported.
 */
function reportRejectedToggle(name: string, verb: string, reason: SetEnabledReason | undefined): void {
  process.exitCode = 1;
  switch (reason) {
    case 'critical':
      console.error(criticalRefusalMessage(name));
      return;
    case 'criticality-unknown':
      console.error(unknownCriticalityRefusalMessage(name));
      return;
    case 'not-installed':
      reportUnknownExtensionName(name, verb);
      return;
    case 'no-catalog':
      console.error(
        `Failed to ${verb} extension "${name}": the running server has not loaded this extension and cannot ` +
          'enumerate its installed packages, so it refused to persist a preference it cannot validate. ' +
          'Nothing was written.',
      );
      return;
    case 'name-collision':
      console.error(
        `Failed to ${verb} extension "${name}": more than one installed copy claims this name, so it does not ` +
          'resolve to a single extension and the next server start refuses to boot. Uninstall or rename one of ' +
          'them first; nothing was written. Run "makaio extension list" to see every copy.',
      );
      return;
    case 'shutting-down':
      console.error(`Failed to ${verb} extension "${name}": the running server is shutting down. Nothing was written.`);
      return;
    default:
      console.error(`Failed to ${verb} extension "${name}": the request was rejected. Nothing was written.`);
  }
}
