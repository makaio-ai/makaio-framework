import { CRON_AUTOMATION_TRIGGER_KIND } from '@makaio/contracts';
import type { ContributionProcessor, KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel';
import type { AutomationTriggerBindingRuntime } from './automation-trigger-binding-runtime.js';
import { AUTOMATION_TRIGGER_BUILTINS_OWNER } from './builtins/package.js';
import { AutomationCronSchedulerToken } from './cron-scheduler.js';
import { AutomationTriggerBindingRuntimeToken, AutomationTriggerRegistryToken } from './packages.js';

// ---------------------------------------------------------------------------
// Options seam
// ---------------------------------------------------------------------------

/** Runtime hooks used to replay contributions after registry/runtime activation. */
export interface AutomationTriggerContributionProcessorOptions {
  /**
   * Enumerate active extensions in dependency order.
   *
   * The registry and the binding runtime can both be enabled after an extension
   * contributing automation triggers is already active, so those active
   * contributors are replayed after either one starts.
   * @param callback - Called for each active extension and its context.
   */
  readonly forEachActiveExtension: (
    callback: (name: string, pkg: KernelMakaioExtension, ctx: KernelExtensionContext) => void,
  ) => void;
}

/** Log prefix for processor diagnostics. */
const LOG_PREFIX = '[AutomationTriggerContributionProcessor]';

/**
 * What dropping ownership must do about the registrations behind it.
 *
 * - `stop-only` — the registry those cleanups would deregister from is gone or
 *   about to be destroyed, so deregistration is impossible (or pointless) and
 *   only the live sources are torn down.
 * - `stop-and-deregister` — the registry outlives this release, so the batches
 *   must be removed from it as well. Dropping the closures without deregistering
 *   would leave a stopped contributor's kinds registered with no handle left to
 *   remove them, and a later reconciliation could reactivate them while the
 *   contributing extension is stopped.
 */
type OwnershipReleaseMode = 'stop-only' | 'stop-and-deregister';

// ---------------------------------------------------------------------------
// Ownership state
// ---------------------------------------------------------------------------

/**
 * Ownership of contributed automation triggers across lifecycle transitions.
 *
 * Holds one cleanup closure per contributing extension, plus the live binding
 * runtime. Those cleanup closures are the only handles that reach
 * {@link AutomationTriggerBindingRuntime.stopOwner}, so every path that drops
 * them must stop the sources they own first — see {@link releaseAllOwnership}.
 *
 * The runtime reference is resolved lazily rather than captured per closure, so
 * cleanups stay correct across registry/runtime restart cycles: after a registry
 * restart the runtime activates again and every existing cleanup closure calls
 * whichever runtime is live at deactivation time.
 */
class AutomationTriggerContributionOwnership {
  /** Cleanup closures keyed by contributing extension name. */
  private readonly cleanups = new Map<string, () => Promise<void>>();
  /** The currently running binding runtime, or `undefined` while it is stopped. */
  private currentRuntime: AutomationTriggerBindingRuntime | undefined;

  /**
   * @param options - Runtime hooks used for late registry-owner activation.
   */
  public constructor(private readonly options: AutomationTriggerContributionProcessorOptions) {}

  /**
   * Records the binding runtime that (re-)activated, or forgets the stopped one.
   *
   * Passing `undefined` is how a runtime stop is recorded: pending cleanups resolve
   * the runtime lazily through this field, so clearing it keeps them from calling a
   * closed runtime.
   * @param runtime - The live runtime, or `undefined` when there is none.
   */
  public setRuntime(runtime: AutomationTriggerBindingRuntime | undefined): void {
    this.currentRuntime = runtime;
  }

  /**
   * Registers one extension's automation trigger batch and takes ownership of it.
   *
   * A no-op for extensions that contribute no automation triggers.
   * @param name - Contributing extension name, used as the registry owner.
   * @param pkg - The extension whose contribution is being processed.
   * @param ctx - Extension context used to resolve the registry and build triggers.
   * @returns Resolves once the batch is registered.
   * @throws When the registry is unavailable, the factory fails, or the registry
   *   rejects the batch.
   */
  public async registerContribution(
    name: string,
    pkg: KernelMakaioExtension,
    ctx: KernelExtensionContext,
  ): Promise<void> {
    const contribution = pkg.automationTriggers;
    if (!contribution) return;

    const registry = ctx.getService(AutomationTriggerRegistryToken);
    if (!registry) {
      throw new Error(
        'AutomationTriggerRegistry is not available — ensure automation-trigger-registry is started before extensions with automationTriggers.',
      );
    }

    // Factory may be async. Coordinator lifecycle transitions share one FIFO
    // lane so a disable admitted while this factory is pending cannot run
    // between its settlement and registration: it follows this complete
    // activation and deregisters the just-installed batch.
    const triggers = await contribution.createAutomationTriggers(ctx);

    await registry.register(name, triggers);

    // Capture registry by reference now; resolve the runtime lazily through
    // `this` so cleanup always uses the live runtime instance.
    this.cleanups.set(name, async () => {
      await this.currentRuntime?.stopOwner(name);
      await registry.deregister(name);
    });
  }

  /**
   * Re-registers every active contributor into a freshly activated registry or
   * binding runtime.
   *
   * Both restarts need it, for the same reason: a contributor that is already
   * active raises no activation event of its own, so the fresh instance would
   * otherwise never learn about it. Re-registering also raises
   * `automation-triggers.changed`, which is the signal binding subscribers
   * reconcile on.
   *
   * On failure the partially installed ownership is released, in the mode the
   * caller's lifecycle dictates: a registry that is itself being destroyed cannot
   * be deregistered from, while a registry that outlives the failure must be.
   * Releasing everything is right here and only here — a fresh collaborator holds
   * either the whole set of contributions or none of them, and a partial replay is
   * the state that must not survive.
   * @param failureReleaseMode - How to release ownership if the replay fails.
   * @returns Resolves once every active contributor has been registered.
   * @throws The first replay failure, after releasing ownership.
   */
  public async replayActiveContributors(failureReleaseMode: OwnershipReleaseMode): Promise<void> {
    try {
      await this.replay(this.activeContributors());
    } catch (error) {
      await this.releaseAllOwnership(failureReleaseMode);
      throw error;
    }
  }

  /**
   * Re-registers one active contributor's batch.
   *
   * Used when a service a contributor's triggers are backed by restarts: the
   * contributor itself raises no activation event, so re-registering is what
   * raises `automation-triggers.changed` and lets subscribers reconcile onto
   * freshly activated sources.
   *
   * Deliberately does **not** release ownership on failure, unlike
   * {@link replayActiveContributors}: every other contributor's registration and
   * cleanup are untouched and still valid here, and the failing owner's own prior
   * batch survives because registry replacement is atomic. There is no partial
   * state to undo, so undoing the whole map would only widen the damage.
   *
   * A no-op when the named contributor is not active or contributes no automation
   * triggers.
   * @param owner - Contributing extension name to replay.
   * @returns Resolves once the batch has been re-registered.
   * @throws When the registry is unavailable, the factory fails, or the registry
   *   rejects the batch.
   */
  public async replayContributor(owner: string): Promise<void> {
    await this.replay(this.activeContributors(owner));
  }

  /**
   * Collects the active extensions that contribute automation triggers.
   *
   * Enumeration order is the coordinator's dependency order, which the replay
   * relies on.
   * @param owner - Narrows the result to this contributor when given.
   * @returns The selected contributors with their live contexts.
   */
  private activeContributors(owner?: string): Array<[string, KernelMakaioExtension, KernelExtensionContext]> {
    const contributors: Array<[string, KernelMakaioExtension, KernelExtensionContext]> = [];
    this.options.forEachActiveExtension((activeName, activePkg, activeCtx) => {
      if (!activePkg.automationTriggers) return;
      if (owner !== undefined && activeName !== owner) return;
      contributors.push([activeName, activePkg, activeCtx]);
    });
    return contributors;
  }

  /**
   * Registers a collected set of contributions, sequentially and in order.
   * @param contributors - Contributors to register, in dependency order.
   * @returns Resolves once every contribution has been registered.
   * @throws The first registration failure, leaving the remainder unregistered.
   */
  private async replay(
    contributors: readonly [string, KernelMakaioExtension, KernelExtensionContext][],
  ): Promise<void> {
    for (const [name, pkg, ctx] of contributors) {
      await this.registerContribution(name, pkg, ctx);
    }
  }

  /**
   * Stops the live activations of one trigger kind without touching any
   * registration.
   *
   * The kind stays registered on purpose: it is still contributed and still
   * resolvable, it merely cannot be activated until the service backing it is
   * available again.
   * @param kind - Canonical trigger kind whose activations should stop.
   * @returns Resolves once every matching cleanup has settled.
   */
  public async stopKindSources(kind: string): Promise<void> {
    await this.currentRuntime?.stopKind(kind);
  }

  /**
   * Runs and drops one contributor's cleanup.
   *
   * Idempotent: a contributor that was never registered, or whose ownership was
   * already released, is a no-op.
   * @param name - Contributing extension name.
   * @returns Resolves once the cleanup has settled.
   * @throws Whatever the cleanup throws.
   */
  public async stopContribution(name: string): Promise<void> {
    const cleanup = this.cleanups.get(name);
    if (!cleanup) return;
    this.cleanups.delete(name);
    await cleanup();
  }

  /**
   * Tears down every owned trigger source and drops all cleanup ownership.
   *
   * Always sweeps the sources: the binding runtime is deliberately not a
   * dependent of the registry, so the coordinator does not cascade a stop to it
   * and its activations are still live here. Dropping the closures without this
   * sweep would leave those activations running with no handle left to stop them.
   *
   * Whether the batches are also deregistered is the caller's lifecycle
   * knowledge, not something inferable here — see {@link OwnershipReleaseMode}.
   *
   * Failures are logged per owner so one bad source or one rejected
   * deregistration cannot abandon the rest.
   * @param mode - Whether the surviving registry must also be deregistered from.
   * @returns Resolves once every owner has been swept.
   */
  public async releaseAllOwnership(mode: OwnershipReleaseMode): Promise<void> {
    // Snapshot: `stopContribution` mutates the map it iterates.
    for (const owner of Array.from(this.cleanups.keys())) {
      try {
        // The cleanup closure is the only handle that both stops the sources and
        // deregisters the batch, so running it is exactly `stop-and-deregister`.
        if (mode === 'stop-and-deregister') await this.stopContribution(owner);
        else await this.currentRuntime?.stopOwner(owner);
      } catch (error) {
        console.error(`${LOG_PREFIX} ownership release error for "${owner}":`, error);
      }
    }
    this.cleanups.clear();
  }
}

// ---------------------------------------------------------------------------
// Processor factory
// ---------------------------------------------------------------------------

/**
 * Processes AutomationTrigger contributions from extensions.
 *
 * Calls each extension's `automationTriggers.createAutomationTriggers(ctx)`
 * factory during activation and registers the returned definitions with the
 * `AutomationTriggerRegistry` under the extension name; deregisters them and
 * tears down their active bindings via
 * {@link AutomationTriggerBindingRuntime.stopOwner} when the extension stops.
 *
 * Contributor activation is atomic: if `createAutomationTriggers` or the
 * registry replacement throws, the existing registration and its cleanup remain
 * intact. Ownership bookkeeping across restarts lives in
 * {@link AutomationTriggerContributionOwnership}.
 * @param options - Runtime hooks used for late registry-owner activation.
 * @returns Contribution processor that manages AutomationTrigger registration.
 */
export function createAutomationTriggerContributionProcessor(
  options: AutomationTriggerContributionProcessorOptions,
): ContributionProcessor {
  const ownership = new AutomationTriggerContributionOwnership(options);

  return {
    // Service-dependent source recovery is deliberately explicit: today only
    // `makaio.cron` depends on a restartable service token. Another such source
    // needs declared kind-to-service metadata so stop/replay remains scoped.
    filter: (pkg) =>
      pkg.name === AutomationTriggerRegistryToken.name ||
      pkg.name === AutomationTriggerBindingRuntimeToken.name ||
      pkg.name === AutomationCronSchedulerToken.name ||
      !!pkg.automationTriggers,

    async processActivated(name, pkg, ctx) {
      if (name === AutomationTriggerRegistryToken.name) {
        // Registry (re-)activated: replay all currently active contributors so
        // their triggers are registered with the fresh registry instance.
        //
        // A failure destroys this very registry instance, so its batches cannot
        // be deregistered from it — only the live sources are swept.
        await ownership.replayActiveContributors('stop-only');
        return;
      }

      if (name === AutomationCronSchedulerToken.name) {
        // A cron scheduler provider (re-)activated. The built-ins' `makaio.cron`
        // trigger resolves this service at activation time, so a *fresh* activation
        // captures the live provider — but nothing would create one on its own: the
        // built-ins raise no activation event, and the previous activations were
        // retired when the former provider stopped. Re-registering the built-ins
        // batch raises `automation-triggers.changed`, the signal subscribers
        // reconcile on, and the subscriptions that follow activate against this
        // provider. This is the recovery half of the `processStopped` branch below.
        //
        // Skipped while the registry is stopped: the built-ins hold no
        // registration at all in that state, and the registry's own activation
        // replays them. A no-op during boot, where a provider starts before the
        // built-ins are registered.
        if (ctx.getService(AutomationTriggerRegistryToken)) {
          await ownership.replayContributor(AUTOMATION_TRIGGER_BUILTINS_OWNER);
        }
        return;
      }

      if (name === AutomationTriggerBindingRuntimeToken.name) {
        ownership.setRuntime(ctx.getService(AutomationTriggerBindingRuntimeToken));
        // Runtime (re-)activated: every activation the previous instance held died
        // with it, and the handles subscribers still hold are dead too. Replaying
        // the active contributors re-registers their batches, which raises
        // `automation-triggers.changed` — the signal subscribers reconcile on — so
        // a restart restores live sources instead of leaving them silently gone.
        // A no-op during boot, where the runtime starts before any contributor.
        //
        // Skipped while the registry is stopped: contributions hold no
        // registration at all in that state, and the registry's own activation
        // replays them.
        //
        // The registry survives a failure here, so a partial replay must also
        // deregister what it cleared — otherwise a contributor disabled afterwards
        // would have no cleanup handle left and its kinds would stay registered.
        if (ctx.getService(AutomationTriggerRegistryToken)) {
          await ownership.replayActiveContributors('stop-and-deregister');
        }
        return;
      }

      await ownership.registerContribution(name, pkg, ctx);
    },

    async processStopped(name) {
      if (name === AutomationTriggerBindingRuntimeToken.name) {
        ownership.setRuntime(undefined);
        return;
      }

      if (name === AutomationTriggerRegistryToken.name) {
        // Registry stopped: its contributors' cleanups can no longer deregister,
        // but their live activations must still be torn down.
        await ownership.releaseAllOwnership('stop-only');
        return;
      }

      if (name === AutomationCronSchedulerToken.name) {
        // The cron scheduler provider stopped, taking its jobs with it. Every
        // `makaio.cron` activation is now permanently inert, yet the runtime still
        // indexes it — so the next reconciliation would join that dead activation
        // instead of building a live one, and the binding would never fire again.
        // Retiring them unindexes them, which is what makes the provider's next
        // activation recoverable.
        //
        // Deliberately kind-scoped rather than owner-scoped: `makaio.bus-event`
        // shares this owner and is backed by the bus, not by this provider, so
        // stopping it here would silence bindings this restart never touched.
        //
        // No re-registration here, and no `changed` signal: this runs *before* the
        // coordinator destroys the service and clears `entry.service`, so a
        // subscriber reconciling now would still resolve the dying provider and
        // schedule against it. Recovery belongs on the activation side, where the
        // live provider is the only one resolvable.
        try {
          await ownership.stopKindSources(CRON_AUTOMATION_TRIGGER_KIND);
        } catch (error) {
          // Logged, not propagated: a provider's own disable must not be reported
          // as failed because retiring a dependent activation misbehaved.
          console.error(`${LOG_PREFIX} stopping '${CRON_AUTOMATION_TRIGGER_KIND}' activations failed:`, error);
        }
        return;
      }

      try {
        await ownership.stopContribution(name);
      } catch (error) {
        console.error(`${LOG_PREFIX} Deregister error for "${name}":`, error);
      }
    },
  };
}
