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
import { ExtensionSubjects, type ExtensionInfo, type TransitionOutcome } from '@makaio/kernel';
import { listInstalledExtensions, type InstalledExtensionEntry } from './extension-installed-listing.js';

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
 * Decide whether a disable request targets a critical extension.
 *
 * Prefers the running server's view, which reflects the executable package the
 * runtime actually loaded. Falls back to the installed descriptor when no
 * server is running or the server does not know the extension.
 * @param makaioHome - Resolved Makaio data home.
 * @param name - Extension package name.
 * @param liveEntry - Extension entry reported by `kernel:extension.get`, when a server was queried.
 * @param tiers - Discovery-tier mode to fall back to when `installedListing` is not supplied — see
 *   {@link listInstalledExtensions}. Ignored when `installedListing` is supplied, since the caller
 *   already made that choice fetching it.
 * @param installedListing - Installed-package listing already fetched by the caller, when
 *   available. Passing it avoids a second installer round trip when the caller also needs the
 *   listing for another check (e.g. {@link applyUnmanagedNameToggle}); omit it to have this
 *   function fetch the listing itself.
 * @returns `true` when the extension must not be disabled.
 */
async function isCriticalExtension(
  makaioHome: string,
  name: string,
  liveEntry: { readonly critical: boolean } | null | undefined,
  tiers: 'all' | 'shared-home',
  installedListing?: readonly InstalledExtensionEntry[],
): Promise<boolean> {
  if (liveEntry) return liveEntry.critical;
  const installed = installedListing ?? (await listInstalledExtensions(makaioHome, tiers));
  return installed.find((ext) => ext.name === name)?.critical ?? false;
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
 * Refuse a toggle request for a name absent from the installed listing.
 *
 * Shared by the offline path below and {@link applyUnmanagedNameToggle} so a
 * typo is reported identically whether or not a server happens to be
 * reachable — both call sites already hold the listing they need this
 * against, so neither re-fetches it here.
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
 * A disable that targets a critical extension is refused before anything is
 * written: the runtime force-starts a critical extension on every boot
 * regardless of the enablement file, so persisting the disable would only
 * produce a permanent warning.
 *
 * `kernel:extension.setEnabled` is persist-only — enabling or disabling an
 * extension never takes effect in an already-running process, because
 * several package contributions are composed exactly once at boot. Every
 * other request persists the enablement file and reports one of:
 * - "already matches this state" — the process's current runtime state already matches the request
 * - "persisted; no running server — takes effect on next boot" — no server was reachable
 * - "persisted; ... takes effect on next boot" — a server persisted it, but the process's runtime state diverges
 * - "persisted; a framework package currently holds this name" — the reachable server loaded a framework
 *   package under this name instead of the operator-managed extension being toggled; the CLI writes the
 *   preference directly, the same unmanaged-name path used when the coordinator never loaded any entry
 * - "the request was rejected" — an unknown name or a race with the coordinator; nothing was written
 * - "the configured server ... is unreachable" — `MAKAIO_BUS_URL` names a remote host that did not
 *   answer the health probe; nothing was written, since this machine's enablement file is not the
 *   one that host reads
 * @param name - Extension package name to toggle.
 * @param enabled - Desired enabled state.
 */
export async function runSetEnabled(name: string, enabled: boolean): Promise<void> {
  const verb = enabled ? 'enable' : 'disable';
  try {
    const makaioHome = resolveMakaioHome();
    const busUrl = resolveBusUrl();
    const health = await probeHealth(busUrl);

    if (!health) {
      if (isRemoteBusUrl(busUrl)) {
        console.error(remoteUnreachableRefusalMessage(`${verb} extension "${name}"`, busUrl));
        process.exitCode = 1;
        return;
      }

      // No local server is reachable, so the CLI is the sole writer of the
      // enablement file for this action — see {@link applyLiveToggle} for the
      // case where a server is reachable, which owns the file instead for
      // every name it manages. Fetched once and reused for both checks below.
      // This process is the only relevant view with nothing running, so
      // every tier — including its own project-local `{cwd}/node_modules` —
      // is in scope (`'all'`).
      const installedListing = await listInstalledExtensions(makaioHome, 'all');

      if (!enabled && (await isCriticalExtension(makaioHome, name, undefined, 'all', installedListing))) {
        console.error(criticalRefusalMessage(name));
        process.exitCode = 1;
        return;
      }
      if (!installedListing.some((ext) => ext.name === name)) {
        reportUnknownExtensionName(name, verb);
        return;
      }

      const enablementStore = await loadExtensionEnablementStore(makaioHome);
      await enablementStore.persistEnabled(name, enabled);
      console.info(`Extension "${name}" ${verb}d. Persisted; no running server — takes effect on next boot.`);
      return;
    }

    await applyLiveToggle({ makaioHome, name, enabled, verb, health, busUrl });
  } catch (error) {
    console.error(`Failed to ${verb} extension "${name}": ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

/** Inputs for one live enable/disable attempt against a running server. */
interface LiveToggleOptions {
  /** Resolved Makaio data home. */
  readonly makaioHome: string;
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
 * Apply a toggle to a running server, which owns the enablement file for the
 * duration of this call, for every name the server actually manages.
 *
 * `kernel:extension.setEnabled` is persist-only: it never applies a change to
 * the running process, only records the preference and reports whether the
 * process's current runtime state already matches it. The CLI does not write
 * the enablement file itself for a name the server manages — a per-name
 * single-writer rule decides *who* owns that name's preference (the reachable
 * server's own `persistEnabled` callback, wired to the same file at boot,
 * rather than the CLI), not what makes the shared file safe against
 * concurrent writers: {@link loadExtensionEnablementStore}'s cross-process
 * lock is what actually closes the read-modify-write race, because the name
 * this call does write for unmanaged names below (`applyUnmanagedNameToggle`)
 * can legitimately run while that same server process is writing a different
 * name at the same time.
 *
 * A name that is installed but was never loaded into the server's coordinator
 * — interactive-only on a headless server, unmet `requires`, or suppressed via
 * `MAKAIO_SKIP_EXTENSIONS` — is the one case the reachable server cannot
 * persist for: `kernel:extension.get` reports it as `null`, so there is no
 * entry for `setEnabled` to compare against. The same is true when `get`
 * *does* report an entry but {@link ExtensionInfo.extensionManaged} is
 * `false`: a framework package retains that entry under the requested name
 * (the coordinator loads framework packages unconditionally, so a disabled
 * operator-managed package never displaces one that shares its name), and
 * `setEnabled` throws outright for a non-operator-managed entry — there is
 * still no preference for it to compare against, just a different reason
 * than a `null` `get` response. Both cases route to the same unmanaged-name
 * fallback below. The per-name single-writer rule does not apply to that name
 * either way, because the server never touches it for `setEnabled`'s purposes;
 * the CLI writes the enablement file directly for it instead — while the
 * server may be concurrently writing for a name it does manage, which the
 * store's cross-process lock, not process exclusivity, keeps safe — after
 * confirming against the installed-package listing (the same "does this name
 * exist at all" check the offline path already uses) that the name is not
 * simply a typo. See {@link runSetEnabled} for the fully offline case, where
 * the CLI is the sole writer for every name because no server is reachable at
 * all.
 * @param options - Live toggle inputs.
 */
async function applyLiveToggle(options: LiveToggleOptions): Promise<void> {
  const { makaioHome, name, enabled, verb, health, busUrl } = options;
  const auth = resolveClientAuth(health);
  const bus = await connectBusClient(busUrl, { auth, autoReconnect: false });
  try {
    const { extension } = await bus.request(ExtensionSubjects.get, { name });

    // An entry the coordinator reports but does not operator-manage is a
    // framework package retaining this name, not the requested extension —
    // `setEnabled` has nothing to compare against for it (see this
    // function's own TSDoc), so it is treated identically to a `null` `get`
    // response below, distinguished only for the fallback's own message.
    const managedEntry: ExtensionInfo | null = extension?.extensionManaged ? extension : null;
    const frameworkPackageCollision = extension !== null && !extension.extensionManaged;

    // `managedEntry` is `null` for a name the server never loaded into its
    // coordinator, or one currently held by a same-named framework package —
    // both fall back to {@link applyUnmanagedNameToggle}'s direct file write,
    // which is only legitimate for a local bus (see that function's TSDoc).
    // Refuse a remote target here, before either local-machine call below
    // (the installed-package listing and the critical check that consults
    // it): neither is meaningful for a host whose installed packages this
    // process cannot see, so a remote target must never trigger them just to
    // reach a refusal `applyUnmanagedNameToggle` would have produced anyway.
    // This is the single guard site for both the null-entry and the
    // framework-package-collision cases — `applyUnmanagedNameToggle` itself
    // no longer re-checks it.
    if (!managedEntry && isRemoteBusUrl(busUrl)) {
      console.error(
        `Failed to ${verb} extension "${name}": the reachable server does not manage "${name}"; ` +
          "run this command on the server's host to persist the preference.",
      );
      process.exitCode = 1;
      return;
    }

    // Fetch the installed-package listing once up front for the unmanaged
    // case so both the critical check below and `applyUnmanagedNameToggle`
    // reuse it instead of each issuing their own installer round trip. A
    // server is reachable here, and it may have been started from a
    // different project directory than this CLI invocation, so only the
    // `$MAKAIO_HOME`-shared tiers are trustworthy for it (`'shared-home'`) —
    // see {@link listInstalledExtensions}'s TSDoc.
    const installedListing = managedEntry ? undefined : await listInstalledExtensions(makaioHome, 'shared-home');

    if (!enabled && (await isCriticalExtension(makaioHome, name, managedEntry, 'shared-home', installedListing))) {
      console.error(criticalRefusalMessage(name));
      process.exitCode = 1;
      return;
    }

    if (!managedEntry) {
      await applyUnmanagedNameToggle(makaioHome, name, enabled, verb, installedListing, frameworkPackageCollision);
      return;
    }

    let success: boolean;
    let outcome: TransitionOutcome;
    try {
      ({ success, outcome } = await bus.request(ExtensionSubjects.setEnabled, { name, enabled }));
    } catch (error) {
      // The critical-extension guard throws before the server touches the
      // file, so nothing was written for this attempt; a transport-level
      // failure leaves the true state uncertain from here rather than
      // "reverted" — the CLI never wrote a value of its own to revert.
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        `Failed to ${verb} extension "${name}": request failed: ${reason}. ` +
          'Nothing was written locally; the reachable server owns this preference.',
      );
      process.exitCode = 1;
      return;
    }

    if (success) {
      console.info(`Extension "${name}" ${verb}d. Persisted; the running server's process already matches this state.`);
      return;
    }

    // Reuse the `managedEntry` fetched above rather than issuing a second
    // `get` request: `setEnabled` never mutates the entry (it is
    // persist-only), so the entry's `error` field already carries whatever
    // reason a re-fetch would report for this outcome.
    reportRejectedToggle(name, outcome, managedEntry.error, verb);
  } finally {
    bus.disconnect();
  }
}

/**
 * Persist an enable/disable preference for a name the reachable server does
 * not manage — either never loaded into its coordinator at all, or currently
 * held there by a same-named framework package (see
 * {@link ExtensionInfo.extensionManaged}).
 *
 * This direct write is only legitimate when the enablement file this process
 * writes is the same file the reachable server reads — true only when the
 * bus is local. The caller ({@link applyLiveToggle}) checks
 * {@link isRemoteBusUrl} before calling this function at all — a remote
 * server's installed-package set cannot be discovered from here (there is no
 * RPC for it), so validating "is this name actually installed" against
 * *this* machine's packages, or writing *this* machine's enablement file,
 * would both silently operate on the wrong host. That guard sits in the
 * caller, ahead of the installed-package listing fetch it also owns, so a
 * remote target never triggers a local listing scan just to reach a refusal
 * this function would have produced anyway.
 *
 * No server-owned persist RPC exists for this case by design, not oversight:
 * the coordinator only knows extensions it actually loaded, so it cannot
 * validate an arbitrary installed-but-unloaded name either — a blind
 * server-side "persist this name" RPC would have to trust the caller's word
 * that the name is real, which is a new trust boundary and a new subsystem,
 * not a fix for this call site. That is tracked as a follow-up rather than
 * solved here.
 *
 * When the bus is local, validated against the installed-package listing
 * first so a genuine typo is reported as "not installed" instead of silently
 * writing an enablement entry for a name nothing will ever read. That
 * validation only sees the `$MAKAIO_HOME`-shared tiers ({@link listInstalledExtensions}'s
 * `'shared-home'` mode) — the local server may have been started from a
 * different project directory than this CLI invocation, so this process's
 * own project-local `{cwd}/node_modules` is not necessarily the server's,
 * and a name installed only there is reported as unknown rather than guessed
 * at. Same follow-up as the remote case above: a server-owned catalog RPC
 * for its own project-local tier would close this gap.
 * @param makaioHome - Resolved Makaio data home.
 * @param name - Extension package name to toggle.
 * @param enabled - Desired enabled state.
 * @param verb - Verb used in output ("enable" or "disable").
 * @param installedListing - Installed-package listing already fetched by the caller, when
 *   available; omit it to have this function fetch the listing itself.
 * @param frameworkPackageCollision - `true` when the reason this name is
 *   unmanaged is that a framework package currently holds it (as opposed to
 *   the coordinator never having loaded any entry for it), so the confirmation
 *   message explains the collision instead of the generic not-loaded reasons.
 */
async function applyUnmanagedNameToggle(
  makaioHome: string,
  name: string,
  enabled: boolean,
  verb: string,
  installedListing?: readonly InstalledExtensionEntry[],
  frameworkPackageCollision = false,
): Promise<void> {
  // The caller already refused a remote target before fetching (or
  // requesting this function fetch) the installed-package listing — see this
  // function's own TSDoc. This function only ever runs against a reachable,
  // local server, which may not share this CLI invocation's `cwd` — only
  // `$MAKAIO_HOME` is guaranteed shared, so the fallback fetch uses
  // `'shared-home'`, matching the listing `applyLiveToggle` already fetched
  // with the same mode when it had one to pass.
  const installed = installedListing ?? (await listInstalledExtensions(makaioHome, 'shared-home'));
  if (!installed.some((ext) => ext.name === name)) {
    reportUnknownExtensionName(name, verb);
    return;
  }

  const enablementStore = await loadExtensionEnablementStore(makaioHome);
  await enablementStore.persistEnabled(name, enabled);
  console.info(
    frameworkPackageCollision
      ? `Extension "${name}" ${verb}d. Persisted; a framework package currently holds this name — ` +
          'the installed override takes effect after enabling and restart, once the framework package no ' +
          'longer claims the name.'
      : `Extension "${name}" ${verb}d. Persisted; not loaded in the running server ` +
          '(interactive-only, unmet requirements, or MAKAIO_SKIP_EXTENSIONS) — takes effect on next boot.',
  );
}

/**
 * Report a `kernel:extension.setEnabled` response whose `success` was
 * `false` — either the preference was persisted but diverges from the
 * process's current runtime state, or the request was refused outright.
 * @param name - Extension package name.
 * @param outcome - The {@link TransitionOutcome} the server reported alongside `success: false`.
 * @param reason - The extension entry's recorded error, if any, describing why the process's
 *   runtime state does not match the request.
 * @param verb - Verb used in output ("enable" or "disable").
 */
function reportRejectedToggle(
  name: string,
  outcome: TransitionOutcome,
  reason: string | undefined,
  verb: string,
): void {
  if (outcome === 'restart-required') {
    console.info(
      `Extension "${name}" ${verb}d. Persisted; ${reason ?? 'the running process is not in the requested state'}. ` +
        'The preference will take effect on next boot.',
    );
    return;
  }

  console.error(`Failed to ${verb} extension "${name}": the request was rejected. Nothing was written.`);
  process.exitCode = 1;
}
