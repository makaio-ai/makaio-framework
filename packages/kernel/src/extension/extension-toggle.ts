import { getErrorString } from '@makaio/utils';
import {
  ExtensionSubjects,
  type SetEnabledReason,
  type TransitionOutcome,
} from '../observability/extension-namespace.js';
import type { InstalledExtensionRecord } from '../observability/installed-extension-catalog-schemas.js';
import { ServiceSkipError } from '../service-skip-error.js';
import {
  buildExtensionContext,
  checkExtensionNameAddressable,
  type ExtensionContextHost,
  resolveExtensionEntryConfig,
} from './extension-context-builder.js';
import { transitionPackageEntry } from './state-transition.js';
import { runContributionProcessors } from './contribution-processor-runner.js';
import { registerPackageTrayMenuEntry, unregisterPackageTrayMenuEntry } from './tray-menu-entry-bridge.js';
import type { ContributionProcessor, ExtensionEntry } from './types.js';

/**
 * Minimal coordinator surface consumed by the toggle helpers.
 *
 * Keeps the extraction loosely coupled — the coordinator satisfies this
 * interface without exposing its full internal API.
 */
export interface ToggleHost extends ExtensionContextHost {
  readonly db: unknown;
  readonly entries: ReadonlyMap<string, ExtensionEntry>;
  /**
   * Durably persist the operator's enablement preference for a name.
   *
   * {@link handleSetEnabled} calls this unconditionally on every request — it
   * is the seam's only write path, and it must never be skipped based on a
   * cached or previously observed value. Bus-connected hosts wire this to
   * `ExtensionEnablementStore.persistEnabled` (`@makaio/runtime-node`), which
   * re-reads the enablement file from disk before writing, so a concurrent
   * hand-edit is never silently overwritten by a stale in-memory guess.
   * Absent in coordinators built without a durable enablement store — for
   * example an isolated, headless runtime that never wires the enablement
   * file at all. {@link handleSetEnabled} refuses the request outright in
   * that case rather than silently reporting success for a preference it
   * cannot actually persist.
   */
  readonly persistEnabled: ((name: string, enabled: boolean) => Promise<void>) | undefined;
  /**
   * Registered {@link ContributionProcessor} instances.
   *
   * Passed through from the coordinator so the toggle helpers can invoke
   * processors after a successful enable (activated) or before a disable
   * (stopped) without coupling to coordinator internals.
   */
  readonly contributionProcessors: ReadonlyArray<ContributionProcessor>;
  /**
   * Run the health-check hook for the named extension and store the result.
   *
   * Called after an extension transitions to `active` state during `enableExtension`.
   * The coordinator owns the implementation.
   * @param name - Extension name to run the health check for.
   */
  runHealthCheck(name: string): Promise<void>;
  /**
   * Emit console warnings and toast notifications for a single extension entry's
   * active warnings.
   *
   * Called after `runHealthCheck` completes in the enable flow so the newly
   * enabled extension's degraded warnings are surfaced immediately.
   * @param name - Extension name used for log prefixes and toast IDs.
   * @param entry - Extension entry whose warnings should be emitted.
   */
  emitWarningsForEntry(name: string, entry: ExtensionEntry): Promise<void>;
}

/**
 * {@link TransitionOutcome} (re-exported here for call sites that already
 * import from this module) reports how one enablement request relates to the
 * process's actual runtime state.
 *
 * The type is defined in `../observability/extension-namespace.js` as
 * `z.infer<typeof TransitionOutcomeSchema>` because
 * `kernel:extension.setEnabled` returns it verbatim on the bus — the schema
 * is the source of truth so the wire contract and this in-process type cannot
 * drift apart.
 *
 * {@link applyExtensionTransition} (the internal restart primitive) and
 * {@link handleSetEnabled} (the operator-preference seam, persist-only) both
 * report through this union, but they answer different questions with it:
 * for {@link applyExtensionTransition} it is the result of a state-machine
 * transition it actually attempted; for {@link handleSetEnabled} it is a
 * comparison between the runtime's current state and the requested
 * preference, since that seam never attempts a transition itself.
 * - `'applied'` — the requested state already matches the process's actual
 *   runtime state, or — for an entry `handleSetEnabled` finds still at
 *   `'discovered'`, before `startAll()` has consulted it — the direction
 *   that entry is already headed without any restart; no restart is needed
 *   for it to take effect.
 * - `'rejected'` — the request itself was refused: an unknown extension name,
 *   a disable of a `critical` extension, or (for
 *   {@link applyExtensionTransition}) a state machine refusal such as active
 *   dependents, inactive dependencies, or a failed re-initialization.
 * - `'restart-required'` — the requested state and the process's actual (or,
 *   for `'discovered'`, pending) runtime state diverge. The preference is
 *   durable and correct; only a process restart makes the runtime match it.
 */
export type { TransitionOutcome };

/**
 * Result of {@link handleSetEnabled}.
 *
 * Carries both the collapsed `success` boolean (for callers that only need
 * to know whether the request needs attention) and the full `outcome` (for
 * callers — the `kernel:extension.setEnabled` RPC response and the CLI/UI
 * surfaces that read it — that must tell a durable-but-deferred preference
 * apart from an outright rejection instead of guessing from `success` alone).
 */
export interface SetEnabledResult {
  /** `true` when the preference already matches the runtime state; `false` otherwise. */
  readonly success: boolean;
  /** The transition outcome computed for this request. */
  readonly outcome: TransitionOutcome;
  /**
   * Machine-readable detail for this outcome, when there is one to report —
   * which refusal it was, or why a persisted preference is not in effect. See
   * {@link SetEnabledReason}. Absent only for the plain `'applied'` case,
   * where the loaded extension already matches the request and there is
   * nothing further to explain.
   */
  readonly reason?: SetEnabledReason;
}

/**
 * The installed-extension catalog's answer for one `setEnabled` request,
 * resolved before the request enters the coordinator's lifecycle queue.
 *
 * Reading the catalog scans install tiers and imports extension code, so it
 * happens outside the queue — holding the lifecycle lock across it would
 * stall shutdown and every other transition behind an interactive request.
 *
 * Consulted for *every* request, including one that resolves to a loaded,
 * operator-managed entry: a second copy installed while this process runs is
 * invisible to the coordinator — which holds the single copy it loaded at boot
 * — yet contests the name at the next start. Only the catalog sees that copy,
 * so skipping the read for a loaded name would persist a preference no boot
 * will ever act on.
 *
 * The two variants are deliberately distinct:
 * - `'unavailable'` — this runtime exposes no installed-extension catalog at
 *   all, so it cannot vouch for any name it did not load.
 * - `'resolved'` — the catalog was read; an absent `record` means this name is
 *   genuinely not installed here, which is a typo, not an unanswerable
 *   question.
 */
export type SetEnabledCatalogLookup =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'resolved'; readonly record: InstalledExtensionRecord | undefined };

/**
 * Coordinator-owned runtime lifecycle primitive: enable or disable an extension
 * without touching operator preference.
 *
 * This is the seam for coordinator-internal (or product-internal) callers that
 * need to stop and restart an extension as part of their own mechanics — for
 * example stopping live trigger sources when a dependency registry restarts,
 * or replacing a disabled cron provider — as distinct from
 * {@link handleSetEnabled}, which is the seam for an operator-originated
 * request (CLI, UI) that must persist a preference and refuse to disable a
 * `critical` extension.
 *
 * Deliberately does **not** call `host.persistEnabled` and does **not** refuse
 * a `critical` extension: a coordinator-internal restart is not an operator
 * preference change, and refusing it here would remove the restart capability
 * `critical` extensions rely on (see the `automation-trigger` binding runtime
 * package for the canonical example of a `critical` extension designed around
 * its dependency restarting underneath it).
 *
 * Still performs everything that makes the transition observable and correct
 * at runtime: the enable/disable state machine (including the boot-skip
 * activation refusal in `enableExtension`'s skipped-state guard), health
 * checks and warning emission on enable, teardown-error handling on disable,
 * and the `enabledChanged` bus announcement.
 *
 * A teardown failure on disable does not change the outcome: the extension
 * really did reach `stopped`, so this still reports `'applied'` and still
 * announces `enabledChanged`; the failure itself is recorded on `entry.error`
 * instead of being folded into the outcome, so a caller that needs to know
 * about it reads the entry, not the return value.
 *
 * The invariant: the `enabledChanged` announcement fires exactly when the
 * state machine accepted the transition (`'applied'`), regardless of whether
 * `entry.enabled` happened to change — a failed/skipped → active recovery can
 * leave an already-enabled flag unchanged and must still announce, because
 * every other observer needs to learn the extension's effective runtime
 * state. It never fires for `'rejected'` (the runtime state did not move).
 *
 * `'restart-required'` is not a reachable outcome of this primitive: it only
 * ever attempts a transition on an entry this process already started (see
 * the boot-skip guard above), so there is never a boot-only surface left
 * unapplied for it to defer on.
 * @param host - Coordinator surface providing shared state.
 * @param name - Name of the extension to toggle.
 * @param enabled - `true` to enable, `false` to disable.
 * @returns `'applied'` when the extension reached the requested state
 *   (cleanly, or with a recorded teardown failure on `entry.error`), or
 *   `'rejected'` when the state machine refused the request outright.
 */
export async function applyExtensionTransition(
  host: ToggleHost,
  name: string,
  enabled: boolean,
): Promise<Exclude<TransitionOutcome, 'restart-required'>> {
  const entry = host.entries.get(name);
  if (!entry) return 'rejected';

  const outcome = enabled ? await enableExtension(host, name, entry) : await disableExtension(host, name, entry);

  if (outcome === 'rejected') return outcome;

  // Every observer of the toggle learns the extension's effective runtime
  // state. This also refreshes consumers after a failed/skipped → active
  // recovery whose flag was already enabled. Teardown cleanliness travels the
  // two channels that already carry it — this function's result and
  // `entry.error` — rather than being expressed by withholding this event and
  // leaving a second window showing a stopped extension as enabled.
  void host.bus.emit(ExtensionSubjects.enabledChanged, { name, enabled }).catch((err: unknown) => {
    console.error(`[ExtensionCoordinator] enabledChanged emit failed for "${name}":`, err);
  });

  return outcome;
}

/**
 * Handle the `kernel:extension.setEnabled` RPC by durably recording the
 * operator's enablement preference for an extension.
 *
 * This is the operator-preference seam, and it is **persist-only**: live
 * extension toggling is not a contract this runtime can honor, because
 * several package contributions — client definitions, the
 * `runtimeOwnership` single-owner selection, `runtimeBoot.configure()`,
 * `storage.migrations`, and host-level policies wired in at boot outside the
 * coordinator's own visibility (for example a host's cron-scheduler policy)
 * — are composed exactly once, before {@link ExtensionCoordinator.startAll},
 * and have no seam to replay for one package in isolation afterwards. A
 * request that appears to "apply" live here would silently lie about having
 * fully activated or deactivated the extension.
 *
 * Two kinds of name reach this seam, and the split below is exactly that
 * distinction:
 *
 * - A name this coordinator loaded as an operator-managed extension
 *   ({@link persistForLoadedEntry}) — the preference is compared against the
 *   direction that entry's runtime state is already headed.
 * - Every other name ({@link persistForUnloadedName}) — never loaded at all
 *   (surface affinity, unmet requirements, boot-time suppression), or loaded
 *   under a framework package that holds the same name. The coordinator has
 *   nothing of its own to validate such a name against, so it validates
 *   against the host's installed-extension catalog instead. Without a catalog
 *   it refuses rather than writing a preference for a name that may be a typo.
 *
 * Both paths refuse before writing when this coordinator has no
 * {@link ToggleHost.persistEnabled} writer — a runtime with no durable
 * enablement store cannot honour *any* preference request, and reporting
 * `'applied'`/`'restart-required'` for a write that never happened would lie
 * about persistence that does not exist. Both also refuse a disable of a
 * `critical` package: the coordinator force-starts one on the next boot
 * regardless of the store, so persisting the disable would only produce a
 * permanent, ignored entry. The catalog path additionally refuses a disable
 * whose criticality could not be resolved at all — a loaded entry never has
 * that problem, because the coordinator imported the package to load it. There is no rollback path — persistence always succeeds or
 * throws, and there is no transition attempt whose failure could leave
 * runtime state ahead of durable state.
 * @param host - Coordinator surface providing shared state.
 * @param name - Name of the extension to toggle.
 * @param enabled - `true` to enable, `false` to disable.
 * @param catalog - The installed-extension catalog's answer for this name,
 *   resolved by the caller outside the lifecycle queue. Decides the
 *   name-collision refusal for every request, and additionally validates the
 *   name itself on the {@link persistForUnloadedName} path.
 * @returns A {@link SetEnabledResult} whose `success` is `true` when the
 *   preference already matches the runtime state and `false` when it was
 *   rejected or can only take effect on the next process restart; `outcome`
 *   always carries the underlying {@link TransitionOutcome}, and `reason` the
 *   machine-readable detail behind it.
 * @throws Error when {@link ToggleHost.persistEnabled} is absent, or when a
 *   framework package holds the requested name and this runtime exposes no
 *   installed-extension catalog to discover a shadowed install through.
 */
export async function handleSetEnabled(
  host: ToggleHost,
  name: string,
  enabled: boolean,
  catalog: SetEnabledCatalogLookup,
): Promise<SetEnabledResult> {
  // Checked ahead of every other rule, for loaded and unloaded names alike: the
  // rules below all answer for the single copy the runtime resolves this name
  // to, and a contested name has none. The next start refuses to boot before
  // any preference is read, so persisting one here would report a change
  // nothing can act on.
  if (catalog.kind === 'resolved' && catalog.record?.collidesWith !== undefined) {
    return { success: false, outcome: 'rejected', reason: 'name-collision' };
  }

  const entry = host.entries.get(name);
  if (entry?.extensionManaged) {
    return persistForLoadedEntry(host, name, enabled, entry);
  }
  return persistForUnloadedName(host, name, enabled, entry !== undefined, catalog);
}

/**
 * Persist the preference for a name this coordinator loaded as an
 * operator-managed extension, and report how it relates to that entry's
 * runtime state.
 * @param host - Coordinator surface providing shared state.
 * @param name - Name of the extension to toggle.
 * @param enabled - `true` to enable, `false` to disable.
 * @param entry - The loaded, operator-managed runtime entry for `name`.
 * @returns The persist-only result for this request.
 * @throws Error when {@link ToggleHost.persistEnabled} is absent.
 */
async function persistForLoadedEntry(
  host: ToggleHost,
  name: string,
  enabled: boolean,
  entry: ExtensionEntry,
): Promise<SetEnabledResult> {
  if (!host.persistEnabled) {
    throw new Error(
      `Cannot set enablement preference for "${name}": this runtime has no durable enablement store, so extension enablement is not persistable here.`,
    );
  }

  if (!enabled && entry.pkg.critical) {
    return { success: false, outcome: 'rejected', reason: 'critical' };
  }

  // Persist unconditionally — this is the seam's only write path, and it must
  // never be skipped based on a cached or previously observed preference (see
  // the {@link ToggleHost.persistEnabled} contract). An idempotent write for a
  // preference that already matches what is on disk is intentional: it is the
  // only way a hand-edited file and a `setEnabled` call for the same value are
  // guaranteed to converge on the same durable state.
  await host.persistEnabled(name, enabled);

  // No transition is attempted. The outcome is a pure comparison between the
  // requested preference and the direction this process's own runtime state
  // is already headed, without mutating anything: this seam never touches
  // `entry.enabled` or `entry.state`, so this comparison must read whichever
  // of them already answers "will this process start or keep this extension
  // running, unless a restart intervenes?"
  //
  // `'active'` and `'initializing'` both count as heading enabled:
  // `'initializing'` is transient and resolves through the normal lifecycle
  // to `'active'` (see `disableExtension`'s refusal of that state above, for
  // the same reason), so a disable persisted while it is mid-flight needs a
  // restart to take effect exactly as it would once the extension reached
  // `'active'`.
  //
  // `'discovered'` is the one state where "inactive" would be the wrong
  // default: `load()` has run (this RPC handler exists) but `startAll()` has
  // not yet consulted `entry.enabled` to decide whether to start it — and
  // this function deliberately never mutates that flag, so whatever it holds
  // right now is exactly the direction `startAll()` is about to follow. A
  // request matching it is already correct without a restart, and it is
  // literally `entry.enabled` that gates `startExtensionEntry`'s decision
  // (see `extension-start-runner.ts`), so reading it here for the
  // `'discovered'` case rather than hardcoding "inactive" keeps this
  // comparison honest instead of coincidentally right only when the request
  // happens to disable.
  //
  // Every other state (`'skipped'` — boot-disabled or self-skipped —
  // `'stopped'`, and `'failed'`) satisfies `enabled: false` instead: none of
  // them heads toward `active` on their own without a further transition.
  const headingEnabled =
    entry.state === 'active' || entry.state === 'initializing'
      ? true
      : entry.state === 'discovered'
        ? entry.enabled
        : false;
  return headingEnabled === enabled
    ? { success: true, outcome: 'applied' }
    : { success: false, outcome: 'restart-required', reason: 'runtime-state-diverges' };
}

/**
 * Persist the preference for a name this coordinator did not load as an
 * operator-managed extension, validated against the host's
 * installed-extension catalog.
 *
 * Nothing in this process will start such a name before a restart — it was
 * either never loaded, or the name is currently held by a framework package
 * that shadows the installed one — so a disable already matches the runtime
 * (`'applied'`) while an enable can only take effect on the next boot
 * (`'restart-required'`). The `reason` carries which of the two situations it
 * is, since the outcome alone does not distinguish "not loaded here" from
 * "shadowed by a framework package", and an operator needs to know which.
 * @param host - Coordinator surface providing shared state.
 * @param name - Name of the extension to toggle.
 * @param enabled - `true` to enable, `false` to disable.
 * @param frameworkPackageHoldsName - `true` when the coordinator did load an
 *   entry under this name, but one that is not operator-managed.
 * @param catalog - The installed-extension catalog's answer for this name.
 * @returns The persist-only result for this request.
 * @throws Error when {@link ToggleHost.persistEnabled} is absent, or when a
 *   framework package holds the name and no catalog is available to discover
 *   a shadowed install through.
 */
async function persistForUnloadedName(
  host: ToggleHost,
  name: string,
  enabled: boolean,
  frameworkPackageHoldsName: boolean,
  catalog: SetEnabledCatalogLookup,
): Promise<SetEnabledResult> {
  if (!host.persistEnabled) {
    throw new Error(
      `Cannot set enablement preference for "${name}": this runtime has no durable enablement store, so extension enablement is not persistable here.`,
    );
  }

  if (catalog.kind !== 'resolved') {
    // A framework package under this name with no catalog to check is the one
    // case that is a caller error rather than a refusable request: the name
    // resolves to a package that is never subject to operator enablement, and
    // without a catalog there is no way to learn that an installed package is
    // shadowed behind it. See `extensionManaged`'s own TSDoc on
    // `ExtensionEntry`.
    if (frameworkPackageHoldsName) {
      throw new Error(
        `Cannot set enablement preference for "${name}": framework packages are always loaded and have no operator enablement preference.`,
      );
    }
    return { success: false, outcome: 'rejected', reason: 'no-catalog' };
  }

  const record = catalog.record;
  if (!record) {
    return { success: false, outcome: 'rejected', reason: 'not-installed' };
  }

  if (!enabled && record.critical) {
    return { success: false, outcome: 'rejected', reason: 'critical' };
  }

  // Fail closed: an unresolved `critical` is not "not critical". The next boot
  // that can read the export might force-start this package anyway, which
  // would leave the persisted disable permanently ignored.
  if (!enabled && record.criticalityUnknown) {
    return { success: false, outcome: 'rejected', reason: 'criticality-unknown' };
  }

  await host.persistEnabled(name, enabled);

  const reason: SetEnabledReason = frameworkPackageHoldsName ? 'framework-package-shadowed' : 'not-loaded';
  return enabled
    ? { success: false, outcome: 'restart-required', reason }
    : { success: true, outcome: 'applied', reason };
}

/**
 * Marks a re-enable attempt as failed: records the reason on the entry, logs
 * it, and transitions the entry to `'failed'`.
 * @param host - Coordinator surface providing the bus for the transition.
 * @param entry - Mutable runtime entry for the extension.
 * @param name - Extension name (used for log messages).
 * @param message - Human-readable failure reason stored on the entry.
 * @returns Always `'rejected'`, so callers can return the result directly.
 */
function failReEnable(host: ToggleHost, entry: ExtensionEntry, name: string, message: string): 'rejected' {
  entry.error = message;
  console.error(`[ExtensionCoordinator] Cannot re-enable "${name}":`, message);
  transitionPackageEntry(host.bus, entry, 'failed');
  return 'rejected';
}

/**
 * Re-initialize an extension from `stopped`, `failed`, or `skipped` state.
 *
 * Verifies dependencies are active, re-registers storage handlers, and runs
 * the `create` + `init` lifecycle.
 *
 * When the extension is already `active`, there is nothing to (re)initialize,
 * but a restart request that asks for the state it is already in is still a
 * valid request: it settles as `'applied'` with no other side effect. This is
 * the mirror image of {@link disableExtension}'s already-inactive no-op —
 * that settles a disable of an already-inactive extension as `'applied'`
 * because the runtime has nothing to do but the request is valid, and this
 * does the same for an enable of an already-active one. `'initializing'` is
 * the one non-active state that is refused instead, exactly as it is on the
 * disable side, because interrupting an in-flight `create`/`init` is a
 * genuine runtime conflict, not a no-op.
 * @param host - Coordinator surface providing shared state.
 * @param name - Extension name (used for log messages).
 * @param entry - Mutable runtime entry for the extension.
 * @returns `'applied'` when the extension reaches `active` (or already was),
 *   `'rejected'` for every other failure, including the boot-skip guard
 *   below.
 */
async function enableExtension(
  host: ToggleHost,
  name: string,
  entry: ExtensionEntry,
): Promise<Exclude<TransitionOutcome, 'restart-required'>> {
  if (entry.state === 'active') {
    entry.enabled = true;
    return 'applied';
  }

  if (entry.state !== 'stopped' && entry.state !== 'failed' && entry.state !== 'skipped') return 'rejected';

  // Invariant: this primitive must never activate an entry boot never
  // started. `'skipped'` is reached two ways — a self-skip during this
  // process's own `create`/`init` (a package that did start boot, then threw
  // `ServiceSkipError`), or a boot-time disable that short-circuited before
  // any `create`/`init` attempt (`startExtensionEntry` transitions straight
  // to `'skipped'` when `!entry.enabled`). Only the first is safe to restart
  // here: it already ran every boot-only contribution surface (bus namespace
  // registration, client definitions, the `runtimeOwnership` single-owner
  // selection, `runtimeBoot.configure()`, `storage.migrations`) exactly once,
  // before this process's `startAll()`, and there is no seam to replay any of
  // them for one package in isolation afterwards. `entry.surfacesCollected` is the
  // coordinator's own record of which case this is: it is set only for
  // entries that were enabled at `load()` time (and therefore started boot),
  // so a `'skipped'` entry that never collected surfaces is, by construction,
  // one boot never started. Reject instead of silently under-activating it —
  // only a process restart can bring it up correctly.
  if (entry.state === 'skipped' && !entry.surfacesCollected) {
    entry.error = `Extension "${name}" was disabled at boot and never started this process; a restart is required to activate it.`;
    return 'rejected';
  }

  const { pkg } = entry;
  let storageCleanup: (() => void) | undefined;
  const inactiveDeps = (pkg.dependencies ?? []).filter((dep) => {
    if (dep.optional) return false;
    const depEntry = host.entries.get(dep.name);
    return !depEntry || depEntry.state !== 'active';
  });
  if (inactiveDeps.length > 0) {
    return failReEnable(
      host,
      entry,
      name,
      `Required dependencies not active: ${inactiveDeps.map((d) => d.name).join(', ')}`,
    );
  }

  // Re-validate name addressability eagerly, mirroring `startExtensionEntry`'s
  // boot-time check via the same `checkExtensionNameAddressable` predicate. A
  // "bare" extension (no `create`, no `storage.registerHandlers`, and no
  // matching contribution processor) never calls `buildExtensionContext` below,
  // so without this check it would reach `active` with an unencodable name.
  // A later `forEachActiveExtension`/`forExtension` call would then throw
  // outside per-extension isolation.
  const addressabilityError = checkExtensionNameAddressable(entry.identity.extensionName);
  if (addressabilityError !== undefined) {
    return failReEnable(host, entry, name, addressabilityError);
  }

  entry.enabled = true;
  entry.error = undefined;
  transitionPackageEntry(host.bus, entry, 'initializing');

  // Config resolution fails only when an operator-supplied layer cannot be
  // honoured; loadConfig and stored-config parse failures stay non-throwing and
  // are represented as absent config. Re-enable resolves against the same
  // operator source as startup, so an extension that started cannot fail here
  // for a reason that did not already exist at boot.
  let config: unknown;
  try {
    config = resolveExtensionEntryConfig(host, name, entry, 'activate');
  } catch (err) {
    return failReEnable(host, entry, name, `Config resolution failed: ${getErrorString(err)}`);
  }

  if (pkg.storage?.registerHandlers && host.db !== undefined) {
    try {
      const pkgCtx = buildExtensionContext(host, entry, config);
      const cleanup = pkg.storage.registerHandlers(host.bus, host.db, pkgCtx);
      if (typeof cleanup === 'function') {
        storageCleanup = cleanup;
        entry.storageCleanup = cleanup;
      }
    } catch (err) {
      entry.error = getErrorString(err);
      console.error(`[ExtensionCoordinator] Extension "${name}" storage re-registration failed:`, err);
      transitionPackageEntry(host.bus, entry, 'failed');
      return 'rejected';
    }
  }

  if (!(await reinitializeService(host, name, entry, config, storageCleanup))) return 'rejected';

  // Run contribution processors BEFORE transitioning to active so a hard
  // failure never leaves the extension in the `active` state.
  try {
    await runContributionProcessors(host.contributionProcessors, host, name, entry, 'activated');
  } catch (err) {
    // Q2: Contribution activation is part of extension activation.
    // Hard failures transition the extension to `failed`. The runner already
    // rolled back previously-invoked processors before re-throwing.
    await cleanupFailedEnable(name, entry.service, storageCleanup, entry);
    entry.service = undefined;
    entry.error = getErrorString(err);
    console.error(`[ExtensionCoordinator] Extension "${name}" contribution processing failed:`, err);
    transitionPackageEntry(host.bus, entry, 'failed');
    return 'rejected';
  }

  transitionPackageEntry(host.bus, entry, 'active');

  // Bridge a tray manifest into the live tray menu service on every
  // activation, exactly like the normal startup path does right after its own
  // 'active' transition (see `registerEntryTray` in extension-start-runner.ts).
  // Without this, a tray-owning extension reaches 'active' via this
  // coordinator-internal restart but stays absent from the running tray until
  // the next process restart.
  try {
    await registerPackageTrayMenuEntry(host.bus, entry.pkg);
  } catch (err) {
    console.warn(`[ExtensionCoordinator] Failed to register tray entry for ${name}:`, err);
  }

  await host.runHealthCheck(name);
  await host.emitWarningsForEntry(name, entry);
  return 'applied';
}

/**
 * Re-run the `create` + `init` lifecycle for an extension being re-enabled.
 *
 * Mirrors the startup path: a {@link ServiceSkipError} from a non-critical
 * extension settles as `skipped`, every other failure — including a skip
 * attempted by a `critical: true` extension — settles as `failed`. Both
 * outcomes tear down the service and storage handlers first.
 * @param host - Coordinator surface providing shared state.
 * @param name - Extension name (used for log messages).
 * @param entry - Mutable runtime entry for the extension.
 * @param config - Configuration resolved for this enable.
 * @param storageCleanup - Cleanup registered by this enable, if any.
 * @returns `true` when the service is ready or the extension declares no
 *   factory, `false` when the entry was transitioned away from `initializing`.
 */
async function reinitializeService(
  host: ToggleHost,
  name: string,
  entry: ExtensionEntry,
  config: unknown,
  storageCleanup: (() => void) | undefined,
): Promise<boolean> {
  const { create } = entry.pkg;
  if (!create) return true;

  let service: Awaited<ReturnType<typeof create>> | undefined;
  try {
    const pkgCtx = buildExtensionContext(host, entry, config);
    service = await create(pkgCtx);
    await service.init?.();
    entry.service = service;
    return true;
  } catch (err) {
    await cleanupFailedEnable(name, service, storageCleanup, entry);
    if (err instanceof ServiceSkipError) {
      if (!entry.pkg.critical) {
        entry.error = err.reason;
        transitionPackageEntry(host.bus, entry, 'skipped');
        return false;
      }
      entry.error = `Critical extension cannot skip startup: ${err.reason}`;
      console.error(`[ExtensionCoordinator] Extension "${name}" failed to re-initialize:`, entry.error);
      transitionPackageEntry(host.bus, entry, 'failed');
      return false;
    }
    entry.error = getErrorString(err);
    console.error(`[ExtensionCoordinator] Extension "${name}" failed to re-initialize:`, err);
    transitionPackageEntry(host.bus, entry, 'failed');
    return false;
  }
}

/**
 * Tear down an active extension.
 *
 * Stops contribution processors, destroys the service, unregisters storage
 * handlers, unregisters the tray menu entry, and transitions to `stopped`.
 *
 * Teardown is completed even when a step fails — the service fails to
 * destroy, storage cleanup throws, or the tray menu service rejects the
 * unregister request — the extension really is stopped and must not be left
 * claiming otherwise, nor left with a stale, clickable tray entry pointing at
 * a destroyed service. Every one of those failures is recorded on
 * `entry.error` rather than changing the outcome: the runtime really did
 * reach `stopped`, so this still reports `'applied'`.
 *
 * When the extension is already inactive — `stopped`, `failed`, `skipped`, or
 * never started this boot (`discovered`) — there is nothing to tear down, but
 * a disable request that asks for the state it is already in is still a
 * valid request: it settles as `'applied'` with `entry.enabled` flipped to
 * `false` and no other side effect. `'initializing'` is the one inactive
 * state that is refused instead, because interrupting an in-flight
 * `create`/`init` is a genuine runtime conflict, not a no-op.
 * @param host - Coordinator surface providing shared state.
 * @param name - Extension name (used for log messages).
 * @param entry - Mutable runtime entry for the extension.
 * @returns `'applied'` when the extension reaches `stopped` (cleanly, or with
 *   a teardown failure recorded on `entry.error`), or was already inactive
 *   and the disable request was simply recorded; `'rejected'` when the
 *   extension is mid-`init` or active dependents still require it.
 */
async function disableExtension(
  host: ToggleHost,
  name: string,
  entry: ExtensionEntry,
): Promise<Exclude<TransitionOutcome, 'restart-required'>> {
  // Mid create/init is a genuine runtime conflict: interrupting it now is
  // unsafe, so the request is refused outright rather than accepted as a
  // no-op.
  if (entry.state === 'initializing') return 'rejected';

  if (entry.state !== 'active') {
    // Already inactive and there is nothing to tear down, but the durable
    // "stay off" wish is perfectly valid — record it so the seam's caller
    // persists it instead of rolling it back as a refusal.
    entry.enabled = false;
    return 'applied';
  }

  const activeDependents = Array.from(host.entries.entries())
    .filter(([dependentName, dependentEntry]) => {
      if (dependentName === name) return false;
      if (dependentEntry.state !== 'active') return false;
      return dependentEntry.pkg.dependencies?.some((dep) => !dep.optional && dep.name === name) ?? false;
    })
    .map(([dependentName]) => dependentName);

  if (activeDependents.length > 0) {
    entry.error = `Cannot disable "${name}" while active dependents remain: ${activeDependents.join(', ')}`;
    console.error(`[ExtensionCoordinator] ${entry.error}`);
    return 'rejected';
  }

  entry.enabled = false;
  entry.error = undefined;

  const teardownFailures: unknown[] = [];
  try {
    teardownFailures.push(
      ...(await runContributionProcessors(host.contributionProcessors, host, name, entry, 'stopped')),
    );
  } catch (err) {
    teardownFailures.push(err);
    console.error(`[ExtensionCoordinator] Contribution processor error during disable of "${name}":`, err);
  }

  if (entry.service) {
    try {
      await entry.service.destroy?.();
    } catch (err) {
      teardownFailures.push(err);
      console.error(`[ExtensionCoordinator] Error during disable destroy of "${name}":`, err);
    } finally {
      entry.service = undefined;
    }
  }

  if (entry.storageCleanup) {
    try {
      entry.storageCleanup();
    } catch (err) {
      teardownFailures.push(err);
      console.error(`[ExtensionCoordinator] Storage cleanup error during disable of "${name}":`, err);
    } finally {
      entry.storageCleanup = undefined;
    }
  }

  // Mirror the tray registration `enableExtension` performs after the
  // 'active' transition: without this, a tray-owning extension's entry stays
  // live in the running tray menu after this coordinator-internal restart's
  // disable, clickable into a service that no longer exists. Folded into the
  // same teardown-failure contract as the processor/service/storage steps
  // above — recorded on `entry.error` before the `'stopped'` transition and
  // its `stateChanged` announcement fire, exactly like the others, rather
  // than being merely logged after the extension already reports itself
  // stopped.
  try {
    await unregisterPackageTrayMenuEntry(host.bus, entry.pkg);
  } catch (err) {
    teardownFailures.push(err);
    console.error(`[ExtensionCoordinator] Failed to unregister tray entry for ${name}:`, err);
  }

  if (teardownFailures.length > 0) {
    const detail = teardownFailures.map((failure) => getErrorString(failure)).join('; ');
    const teardownError = new AggregateError(
      teardownFailures,
      `Extension "${name}" disabled with ${teardownFailures.length} teardown failure(s): ${detail}`,
    );
    entry.error = getErrorString(teardownError);
  }

  transitionPackageEntry(host.bus, entry, 'stopped');

  entry.warnings = [];

  // Awaited so a rapid disable→enable cycle cannot reorder this empty
  // snapshot after the re-enable health check's fresh warnings.
  try {
    await host.bus.emit(ExtensionSubjects.warnings.changed, { extensionName: name, warnings: [] });
  } catch (err) {
    console.error(`[ExtensionCoordinator] warnings.changed emit failed for "${name}":`, err);
  }

  return 'applied';
}

/**
 * Destroy a partially created service and clean up storage after a failed enable.
 * @param name - Extension name for log messages.
 * @param service - Service instance returned by `pkg.create`, if any.
 * @param storageCleanup - Storage cleanup callback, if any.
 * @param entry - Extension entry whose storageCleanup field is cleared.
 */
async function cleanupFailedEnable(
  name: string,
  service: { destroy?(): Promise<void> | void } | undefined,
  storageCleanup: (() => void) | undefined,
  entry: ExtensionEntry,
): Promise<void> {
  try {
    await service?.destroy?.();
  } catch (destroyErr) {
    console.error(`[ExtensionCoordinator] Service cleanup error after failed enable of "${name}":`, destroyErr);
  }
  try {
    storageCleanup?.();
  } catch (cleanupErr) {
    console.error(`[ExtensionCoordinator] Storage cleanup error after failed enable of "${name}":`, cleanupErr);
  } finally {
    entry.storageCleanup = undefined;
  }
}
