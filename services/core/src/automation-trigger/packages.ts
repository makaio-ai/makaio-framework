import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioNodeExtension } from '@makaio/contracts';
import { extensionToken } from '@makaio/contracts';
import { AutomationTriggerRegistry } from './automation-trigger-registry.js';
import { AutomationTriggerBindingRuntime } from './automation-trigger-binding-runtime.js';
import type { AutomationTriggerResolver } from './automation-trigger-binding-runtime.js';

/** Token for the automation trigger registry service. */
export const AutomationTriggerRegistryToken = extensionToken<AutomationTriggerRegistry>('automation-trigger-registry');

/** Token for the automation trigger binding runtime service. */
export const AutomationTriggerBindingRuntimeToken =
  extensionToken<AutomationTriggerBindingRuntime>('automation-trigger-runtime');

/** Package that starts the framework automation trigger registry. */
export const automationTriggerRegistryPackage: MakaioNodeExtension<IMakaioBus> = {
  name: AutomationTriggerRegistryToken.name,
  displayName: 'Automation Trigger Registry',
  version: '0.1.0',
  critical: true,
  create: (ctx) => new AutomationTriggerRegistry(ctx.bus),
};

/**
 * Package that starts the automation trigger binding runtime.
 *
 * The runtime resolves its registry lazily via a closure around
 * `ctx.getService(AutomationTriggerRegistryToken)` rather than capturing a
 * fixed reference at construction time. This allows the registry to restart
 * (disable → re-enable) without forcing the runtime to restart in lock-step:
 * the runtime service and every handle issued by it survive the gap, and
 * contributor replay installs fresh registrations in the new registry instance
 * before any new subscription resolves. New subscriptions therefore always
 * resolve against the current live registry.
 *
 * Contributor-owned activations do not survive the gap: the contribution
 * processor stops the sources it owns when the registry stops, because the
 * cleanup closures that could stop them are dropped at that point. Their handles
 * stay safely detachable — detaching a stopped activation is a no-op.
 *
 * Deliberately does NOT declare `dependencies: [dep(registry)]`. A non-optional
 * dependency edge does not cascade a stop — the coordinator refuses to disable a
 * package while active non-optional dependents remain. Declaring it would make
 * the registry permanently undisableable whenever this runtime is active, which
 * would remove the registry restart/replay capability the lazy resolver above
 * exists to support. Start ordering is instead given by the position of the two
 * packages in `frameworkCorePackages`, and the runtime needs no registry
 * reference at construction time.
 */
export const automationTriggerBindingRuntimePackage: MakaioNodeExtension<IMakaioBus> = {
  name: AutomationTriggerBindingRuntimeToken.name,
  displayName: 'Automation Trigger Binding Runtime',
  version: '0.1.0',
  critical: true,
  create: (ctx) => {
    /**
     * Lazy resolver: delegates to the currently live registry instance rather
     * than capturing a fixed reference at construction time. Returns `undefined`
     * when the registry is stopped, causing subscribe to reject with a
     * `not registered` error (the same error the caller sees for an unknown kind).
     */
    const lazyResolver: AutomationTriggerResolver = {
      resolveRegistration: (kind) => ctx.getService(AutomationTriggerRegistryToken)?.resolveRegistration(kind),
    };
    return new AutomationTriggerBindingRuntime(lazyResolver);
  },
};
