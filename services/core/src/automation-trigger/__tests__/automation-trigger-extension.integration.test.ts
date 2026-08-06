import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { IMakaioBus } from '@makaio/bus-core';
import { createBusInstance } from '@makaio/bus-core';
import {
  AutomationTriggerSubjects,
  defineAutomationTrigger,
  JsonValueSchema,
  toAutomationTriggerType,
  type AutomationTriggerListener,
} from '@makaio/contracts';
import { ExtensionCoordinator } from '@makaio/kernel';
import type { KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel';
import {
  AutomationTriggerBindingRuntimeToken,
  AutomationTriggerRegistryToken,
  automationTriggerBindingRuntimePackage,
  automationTriggerRegistryPackage,
} from '../packages.js';
import type { AutomationTriggerBindingRuntime } from '../automation-trigger-binding-runtime.js';
import { createAutomationTriggerContributionProcessor } from '../automation-trigger-contribution-processor.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

/**
 * Minimal {@link KernelExtensionContext} fields (excluding coordinator-owned
 * and bus-owned fields) for test coordinators.
 */
const TEST_PKG_CTX_BASE: Omit<
  KernelExtensionContext,
  'bus' | 'identity' | 'getService' | 'dataDir' | 'config' | 'signal' | 'hasExtension'
> = {
  platform: 'linux',
  homedir: '/home/test',
  makaioHome: '/home/test/.makaio',
  username: 'test',
  machineId: 'machine-1',
  tryImport: async (_specifier) => null,
};

/** Canonical kind contributed by the fictional extension. */
const KIND = 'demo.tick';

/** No-op listener used when trigger events do not need to be observed. */
const noopListener: AutomationTriggerListener = async () => {};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Booted acceptance harness: coordinator, resolved runtime, and spy handles. */
interface Harness {
  /** The real coordinator that loaded and started all extensions. */
  readonly coordinator: ExtensionCoordinator;
  /** Bus the coordinator was booted on. */
  readonly bus: IMakaioBus;
  /** The runtime resolved after boot, the way a host would obtain it. */
  readonly runtime: AutomationTriggerBindingRuntime;
  /** Spy on the activate function contributed by the fictional extension. */
  readonly activate: ReturnType<typeof vi.fn>;
  /** Spy on the cleanup returned by activate. */
  readonly cleanup: ReturnType<typeof vi.fn>;
  /** Number of times the extension's factory has been called. */
  readonly triggerFactoryCalls: () => number;
}

/**
 * Boots a real coordinator with the automation trigger registry and runtime
 * packages, the real contribution processor, and a fictional `demo` extension
 * whose contribution imports only framework contracts.
 * @returns The started harness with spy handles.
 */
async function bootHarness(): Promise<Harness> {
  const cleanup = vi.fn(async () => {});
  const activate = vi.fn(async () => cleanup);
  let triggerFactoryCalls = 0;

  const trigger = toAutomationTriggerType(
    defineAutomationTrigger({
      kind: KIND,
      label: 'Demo Tick',
      description: 'Fires a tick event for testing.',
      categories: ['Testing'],
      paramsSchema: z.object({}),
      eventSchema: JsonValueSchema,
      activate,
    }),
  );

  const demoExtension: KernelMakaioExtension = {
    name: 'demo',
    displayName: 'Demo',
    version: '0.1.0',
    automationTriggers: {
      createAutomationTriggers: () => {
        triggerFactoryCalls += 1;
        return [trigger];
      },
    },
  };

  const bus = createBusInstance();
  const coordinator = new ExtensionCoordinator(bus, {
    extensionContextBase: TEST_PKG_CTX_BASE,
  });
  coordinator.registerContributionProcessor(
    createAutomationTriggerContributionProcessor({
      forEachActiveExtension: (callback) => coordinator.forEachActiveExtension(callback),
    }),
  );
  coordinator.load([automationTriggerRegistryPackage, automationTriggerBindingRuntimePackage, demoExtension]);
  await coordinator.startAll();

  const runtime = coordinator.getExtensionService(AutomationTriggerBindingRuntimeToken);
  if (!runtime) {
    throw new Error('AutomationTriggerBindingRuntime service did not start');
  }

  return {
    coordinator,
    bus,
    runtime,
    activate,
    cleanup,
    triggerFactoryCalls: () => triggerFactoryCalls,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AutomationTrigger extension acceptance (real coordinator lifecycle)', () => {
  it('activates the trigger on the first subscribe and deactivates when the extension is disabled', async () => {
    const harness = await bootHarness();
    const subscription = await harness.runtime.subscribe({ kind: KIND, params: {} }, noopListener);
    expect(harness.activate).toHaveBeenCalledTimes(1);

    await harness.coordinator.handleSetEnabled('demo', false);
    expect(harness.cleanup).toHaveBeenCalledTimes(1);
    await expect(harness.runtime.subscribe({ kind: KIND, params: {} }, noopListener)).rejects.toThrow(/not registered/);
    await subscription.detach();

    await harness.coordinator.shutdown();
  });

  it('stops live trigger sources when the registry itself is disabled', async () => {
    const harness = await bootHarness();
    const subscription = await harness.runtime.subscribe({ kind: KIND, params: {} }, noopListener);
    expect(harness.activate).toHaveBeenCalledTimes(1);

    // Disabling the registry does not cascade a stop to the binding runtime, so
    // the processor must stop the sources it owns before dropping the cleanup
    // closures that are the only handles able to reach `stopOwner`.
    await harness.coordinator.handleSetEnabled(AutomationTriggerRegistryToken.name, false);
    expect(harness.cleanup).toHaveBeenCalledTimes(1);

    // Disabling the contributor afterwards must neither resurrect nor re-run an
    // executable last-good closure.
    await expect(harness.coordinator.handleSetEnabled('demo', false)).resolves.toBe(true);
    expect(harness.cleanup).toHaveBeenCalledTimes(1);

    await subscription.detach();
    await harness.coordinator.shutdown();
  });

  it('deregisters a contributor disabled while the binding runtime is stopped', async () => {
    const harness = await bootHarness();
    await harness.runtime.subscribe({ kind: KIND, params: {} }, noopListener);

    // The runtime's own teardown disposes the activation.
    await harness.coordinator.handleSetEnabled(AutomationTriggerBindingRuntimeToken.name, false);
    expect(harness.cleanup).toHaveBeenCalledTimes(1);

    // With the runtime reference nulled, the cleanup closure still deregisters.
    await expect(harness.coordinator.handleSetEnabled('demo', false)).resolves.toBe(true);
    expect(harness.coordinator.getExtensionService(AutomationTriggerRegistryToken)?.list()).toEqual([]);

    await harness.coordinator.shutdown();
  });

  it('rolls back a contributor whose batch fails registration, leaving nothing registered', async () => {
    const cleanup = vi.fn(async () => {});
    const activate = vi.fn(async () => cleanup);

    // A trigger whose kind is not prefixed by the extension name will be
    // rejected by the registry: the full batch must be rolled back.
    const invalidTrigger = toAutomationTriggerType(
      defineAutomationTrigger({
        kind: 'other.not-demo',
        label: 'Other',
        description: 'Wrong namespace.',
        categories: [],
        paramsSchema: z.object({}),
        eventSchema: JsonValueSchema,
        activate,
      }),
    );

    const failingExtension: KernelMakaioExtension = {
      name: 'demo',
      displayName: 'Demo',
      version: '0.1.0',
      automationTriggers: {
        createAutomationTriggers: () => [invalidTrigger],
      },
    };

    const coordinator = new ExtensionCoordinator(createBusInstance(), {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.registerContributionProcessor(
      createAutomationTriggerContributionProcessor({
        forEachActiveExtension: (callback) => coordinator.forEachActiveExtension(callback),
      }),
    );
    coordinator.load([automationTriggerRegistryPackage, automationTriggerBindingRuntimePackage, failingExtension]);
    await coordinator.startAll();

    // The extension should have failed to activate.
    const extEntry = coordinator.list().find((e) => e.name === 'demo');
    expect(extEntry?.state).toBe('failed');

    // The registry must be empty — no partial registration.
    const registry = coordinator.getExtensionService(AutomationTriggerRegistryToken);
    expect(registry?.list()).toEqual([]);

    await coordinator.shutdown();
  });

  it('re-registers active contributors when the registry-owning extension restarts', async () => {
    const harness = await bootHarness();

    await harness.coordinator.handleSetEnabled(AutomationTriggerRegistryToken.name, false);
    await harness.coordinator.handleSetEnabled(AutomationTriggerRegistryToken.name, true);

    const restoredRuntime = harness.coordinator.getExtensionService(AutomationTriggerBindingRuntimeToken);
    if (!restoredRuntime) {
      throw new Error('AutomationTriggerBindingRuntime did not restart');
    }
    // Factory should have been called a second time for the replay.
    expect(harness.triggerFactoryCalls()).toBe(2);

    const restoredRegistry = harness.coordinator.getExtensionService(AutomationTriggerRegistryToken);
    expect(restoredRegistry?.list().map((d) => d.kind)).toEqual([KIND]);

    // A new subscription against the replayed runtime must work.
    const subscription = await restoredRuntime.subscribe({ kind: KIND, params: {} }, noopListener);
    await subscription.detach();

    await harness.coordinator.shutdown();
  });

  it('re-registers active contributors when the binding runtime restarts, signalling subscribers', async () => {
    const harness = await bootHarness();
    const registry = harness.coordinator.getExtensionService(AutomationTriggerRegistryToken);
    if (!registry) throw new Error('AutomationTriggerRegistry service did not start');

    // Subscribers hold handles issued by the runtime instance that stops here, and
    // no contributor raises an activation event of its own across this restart.
    // Replaying them re-registers the batch, whose `automation-triggers.changed`
    // event is the only signal a subscriber can reconcile on — without it a
    // restarted runtime would come back with no live source at all.
    const changed: number[] = [];
    const stopListening = harness.bus.on(AutomationTriggerSubjects.changed, (ctx) => {
      changed.push(ctx.payload.revision);
    });

    try {
      await harness.coordinator.handleSetEnabled(AutomationTriggerBindingRuntimeToken.name, false);
      await harness.coordinator.handleSetEnabled(AutomationTriggerBindingRuntimeToken.name, true);

      expect(harness.triggerFactoryCalls()).toBe(2);
      await vi.waitFor(() => expect(changed).toHaveLength(1));
      expect(registry.list().map((descriptor) => descriptor.kind)).toEqual([KIND]);

      const restartedRuntime = harness.coordinator.getExtensionService(AutomationTriggerBindingRuntimeToken);
      if (!restartedRuntime) throw new Error('AutomationTriggerBindingRuntime did not restart');
      const subscription = await restartedRuntime.subscribe({ kind: KIND, params: {} }, noopListener);
      await subscription.detach();
    } finally {
      stopListening();
      await harness.coordinator.shutdown();
    }
  });

  it('deregisters the contributors it cleared when a binding-runtime replay fails', async () => {
    // A replay failure drops the cleanup closures that are the only handles able
    // to deregister. The registry survives this failure — only the binding runtime
    // is destroyed — so dropping them without deregistering would strand the
    // batches: the contributor could then be disabled with its kinds still
    // registered and still resolvable, ready to reactivate while it is stopped.
    const validTrigger = toAutomationTriggerType(
      defineAutomationTrigger({
        kind: KIND,
        label: 'Demo Tick',
        description: 'Fires a tick event for testing.',
        categories: ['Testing'],
        paramsSchema: z.object({}),
        eventSchema: JsonValueSchema,
        activate: async () => async () => {},
      }),
    );
    // Not namespaced by the owner, so the registry rejects the whole batch.
    const rejectedTrigger = toAutomationTriggerType(
      defineAutomationTrigger({
        kind: 'other.not-demo',
        label: 'Other',
        description: 'Wrong namespace.',
        categories: [],
        paramsSchema: z.object({}),
        eventSchema: JsonValueSchema,
        activate: async () => async () => {},
      }),
    );

    let contributeRejectedBatch = false;
    const demoExtension: KernelMakaioExtension = {
      name: 'demo',
      displayName: 'Demo',
      version: '0.1.0',
      automationTriggers: {
        createAutomationTriggers: () => [contributeRejectedBatch ? rejectedTrigger : validTrigger],
      },
    };

    const coordinator = new ExtensionCoordinator(createBusInstance(), {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.registerContributionProcessor(
      createAutomationTriggerContributionProcessor({
        forEachActiveExtension: (callback) => coordinator.forEachActiveExtension(callback),
      }),
    );
    coordinator.load([automationTriggerRegistryPackage, automationTriggerBindingRuntimePackage, demoExtension]);
    await coordinator.startAll();

    const registry = coordinator.getExtensionService(AutomationTriggerRegistryToken);
    if (!registry) throw new Error('AutomationTriggerRegistry service did not start');
    expect(registry.list().map((descriptor) => descriptor.kind)).toEqual([KIND]);

    // Restart the binding runtime with a batch the registry will reject, so the
    // replay fails partway through.
    await expect(coordinator.handleSetEnabled(AutomationTriggerBindingRuntimeToken.name, false)).resolves.toBe(true);
    contributeRejectedBatch = true;
    await expect(coordinator.handleSetEnabled(AutomationTriggerBindingRuntimeToken.name, true)).resolves.toBe(false);

    // The registry is alive and must no longer hold the cleared contributor.
    expect(coordinator.getExtensionService(AutomationTriggerRegistryToken)).toBe(registry);
    expect(registry.list()).toEqual([]);

    // Disabling the contributor afterwards is clean and still leaves nothing behind.
    await expect(coordinator.handleSetEnabled('demo', false)).resolves.toBe(true);
    expect(registry.list()).toEqual([]);

    await coordinator.shutdown();
  });

  it('does not register a contributor whose async factory resolves after the extension was disabled', async () => {
    const factoryEntered = Promise.withResolvers<void>();
    const releaseFactory = Promise.withResolvers<void>();
    let factoryCalls = 0;

    const trigger = toAutomationTriggerType(
      defineAutomationTrigger({
        kind: KIND,
        label: 'Demo Tick',
        description: 'Test trigger.',
        categories: [],
        paramsSchema: z.object({}),
        eventSchema: JsonValueSchema,
        activate: async () => async () => {},
      }),
    );

    const slowExtension: KernelMakaioExtension = {
      name: 'demo',
      displayName: 'Demo',
      version: '0.1.0',
      automationTriggers: {
        createAutomationTriggers: async () => {
          factoryCalls += 1;
          if (factoryCalls === 2) {
            factoryEntered.resolve();
            await releaseFactory.promise;
          }
          return [trigger];
        },
      },
    };

    const coordinator = new ExtensionCoordinator(createBusInstance(), {
      extensionContextBase: TEST_PKG_CTX_BASE,
    });
    coordinator.registerContributionProcessor(
      createAutomationTriggerContributionProcessor({
        forEachActiveExtension: (callback) => coordinator.forEachActiveExtension(callback),
      }),
    );
    coordinator.load([automationTriggerRegistryPackage, automationTriggerBindingRuntimePackage, slowExtension]);
    await coordinator.startAll();

    // Trigger a registry restart so the factory is called a second time
    // (async) while we queue a disable of the contributor.
    await coordinator.handleSetEnabled(AutomationTriggerRegistryToken.name, false);
    const reenabling = coordinator.handleSetEnabled(AutomationTriggerRegistryToken.name, true);
    await factoryEntered.promise;

    let disableSettled = false;
    const disabling = coordinator.handleSetEnabled('demo', false).finally(() => {
      disableSettled = true;
    });
    await Promise.resolve();
    // Disable is queued but not yet settled — the FIFO lane is blocked.
    expect(disableSettled).toBe(false);

    releaseFactory.resolve();
    await expect(reenabling).resolves.toBe(true);
    await expect(disabling).resolves.toBe(true);

    // After the factory resolved and the disable ran, the trigger must not
    // be registered and a subscribe must fail.
    const runtime = coordinator.getExtensionService(AutomationTriggerBindingRuntimeToken);
    if (!runtime) {
      throw new Error('AutomationTriggerBindingRuntime did not restart');
    }
    await expect(runtime.subscribe({ kind: KIND, params: {} }, noopListener)).rejects.toThrow(/not registered/);

    await coordinator.shutdown();
  });
});
