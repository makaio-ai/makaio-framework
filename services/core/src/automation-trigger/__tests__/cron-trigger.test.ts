import { describe, expect, it, vi } from 'vitest';
import type { IMakaioBus } from '@makaio/bus-core';
import { createBusInstance } from '@makaio/bus-core';
import type {
  AutomationTriggerCleanup,
  AutomationTriggerListener,
  ExtensionServiceLifecycle,
  MakaioNodeExtension,
} from '@makaio/contracts';
import { AutomationTriggerSubjects, CRON_AUTOMATION_TRIGGER_KIND, DEFAULT_CRON_TIMEZONE } from '@makaio/contracts';
import { ExtensionCoordinator } from '@makaio/kernel';
import type { KernelExtensionContext } from '@makaio/kernel';
import { AutomationTriggerBindingRuntime } from '../automation-trigger-binding-runtime.js';
import type { AutomationTriggerResolver } from '../automation-trigger-binding-runtime.js';
import { createAutomationTriggerContributionProcessor } from '../automation-trigger-contribution-processor.js';
import {
  AutomationTriggerBindingRuntimeToken,
  automationTriggerBindingRuntimePackage,
  automationTriggerRegistryPackage,
} from '../packages.js';
import { createCanonicalBindingKey } from '../canonical-binding-key.js';
import type { AutomationCronScheduleInput, AutomationCronScheduler } from '../cron-scheduler.js';
import { AutomationCronSchedulerToken } from '../cron-scheduler.js';
import { selectAutomationCronSchedulerPackage } from '../cron-scheduler-selection.js';
import { localAutomationCronSchedulerPackage } from '../local-cron-scheduler.js';
import { createCronAutomationTrigger } from '../builtins/cron-trigger.js';
import { AUTOMATION_TRIGGER_BUILTINS_OWNER, automationTriggerBuiltinsPackage } from '../builtins/package.js';

/** No-op listener used when firings do not need to be observed. */
const noopListener: AutomationTriggerListener = async () => {};

/**
 * Minimal {@link KernelExtensionContext} fields the coordinator does not own,
 * for the boot-ordering suite.
 */
const CRON_TEST_PKG_CTX_BASE: Omit<
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

/**
 * Builds a binding runtime whose only registered kind is `makaio.cron`.
 * @param resolveScheduler - Scheduler resolver handed to the trigger.
 * @returns The runtime, ready to subscribe.
 */
function createRuntime(resolveScheduler: () => AutomationCronScheduler | undefined): AutomationTriggerBindingRuntime {
  const type = createCronAutomationTrigger(resolveScheduler);
  const resolver: AutomationTriggerResolver = {
    resolveRegistration: (kind) =>
      kind === CRON_AUTOMATION_TRIGGER_KIND ? { owner: AUTOMATION_TRIGGER_BUILTINS_OWNER, type } : undefined,
  };
  return new AutomationTriggerBindingRuntime(resolver);
}

/** Records every schedule request and reports the firings it accepted. */
function createRecordingScheduler(): {
  /** Provider service, including the teardown the coordinator calls on disable. */
  readonly scheduler: AutomationCronScheduler & ExtensionServiceLifecycle;
  readonly requests: AutomationCronScheduleInput[];
  readonly cleanups: ReturnType<typeof vi.fn>;
} {
  const requests: AutomationCronScheduleInput[] = [];
  const cleanups = vi.fn<AutomationTriggerCleanup>(() => {});
  let destroyed = false;

  return {
    requests,
    cleanups,
    scheduler: {
      schedule: async (input) => {
        // Mirrors a real provider: a destroyed one owns no jobs and can accept no
        // new ones, so an activation that reaches a dead provider fails loudly here
        // instead of registering a schedule that will never fire.
        if (destroyed) throw new Error('recording cron scheduler was destroyed');
        requests.push(input);
        return cleanups;
      },
      destroy: () => {
        destroyed = true;
      },
    },
  };
}

describe('makaio.cron built-in automation trigger', () => {
  it('delegates to the scheduler with the canonical binding key and default timezone', async () => {
    const { scheduler, requests } = createRecordingScheduler();
    const runtime = createRuntime(() => scheduler);

    const subscription = await runtime.subscribe(
      { kind: CRON_AUTOMATION_TRIGGER_KIND, params: { schedule: '0 9 * * 1' } },
      noopListener,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.schedule).toBe('0 9 * * 1');
    expect(requests[0]?.timezone).toBe(DEFAULT_CRON_TIMEZONE);
    // The key the trigger computed must be the key the runtime derived, so a
    // provider can attribute the schedule to the binding that owns it.
    expect(requests[0]?.bindingKey).toBe(subscription.bindingKey);
    expect(subscription.bindingKey).toBe(
      createCanonicalBindingKey(CRON_AUTOMATION_TRIGGER_KIND, {
        schedule: '0 9 * * 1',
        timezone: DEFAULT_CRON_TIMEZONE,
      }),
    );

    await runtime.close();
  });

  it('shares one schedule between a binding that names the default timezone and one that omits it', async () => {
    const { scheduler, requests } = createRecordingScheduler();
    const runtime = createRuntime(() => scheduler);

    await runtime.subscribe({ kind: CRON_AUTOMATION_TRIGGER_KIND, params: { schedule: '* * * * *' } }, noopListener);
    await runtime.subscribe(
      { kind: CRON_AUTOMATION_TRIGGER_KIND, params: { timezone: DEFAULT_CRON_TIMEZONE, schedule: '* * * * *' } },
      noopListener,
    );

    expect(requests).toHaveLength(1);

    await runtime.close();
  });

  it('delivers a firing reported by the scheduler to the subscriber', async () => {
    const { scheduler, requests } = createRecordingScheduler();
    const runtime = createRuntime(() => scheduler);
    const listener = vi.fn<AutomationTriggerListener>(async () => {});

    await runtime.subscribe({ kind: CRON_AUTOMATION_TRIGGER_KIND, params: { schedule: '* * * * *' } }, listener);
    await requests[0]?.emit({ scheduledFor: 1_700_000_000_000 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      kind: CRON_AUTOMATION_TRIGGER_KIND,
      payload: { scheduledFor: 1_700_000_000_000 },
    });

    await runtime.close();
  });

  it('cancels the schedule when the last subscriber detaches', async () => {
    const { scheduler, cleanups } = createRecordingScheduler();
    const runtime = createRuntime(() => scheduler);

    const subscription = await runtime.subscribe(
      { kind: CRON_AUTOMATION_TRIGGER_KIND, params: { schedule: '* * * * *' } },
      noopListener,
    );
    await subscription.detach();

    expect(cleanups).toHaveBeenCalledTimes(1);

    await runtime.close();
  });

  it('fails activation when no cron scheduler provider is registered', async () => {
    const runtime = createRuntime(() => undefined);

    await expect(
      runtime.subscribe({ kind: CRON_AUTOMATION_TRIGGER_KIND, params: { schedule: '* * * * *' } }, noopListener),
    ).rejects.toThrow(new RegExp(AutomationCronSchedulerToken.name));

    await runtime.close();
  });
});

describe('cron scheduler start ordering', () => {
  it('starts the scheduler provider before the built-ins that need it, whatever the load order', async () => {
    // A stored `makaio.cron` binding is activated by the reconciliation that the
    // built-ins' registration signals. A scheduler that started after that
    // registration would leave the binding dropped-unavailable with nothing left
    // to wake it, so the provider must be ordered first even when a host lists it
    // last. Booted through the real coordinator: the ordering is Kahn's, not a
    // property of the manifest field alone.
    const activationOrder: string[] = [];
    const createScheduler = localAutomationCronSchedulerPackage.create;
    if (!createScheduler) throw new Error('local cron scheduler package registers no service');
    const schedulerPackage: MakaioNodeExtension<IMakaioBus> = {
      ...localAutomationCronSchedulerPackage,
      create: (ctx) => {
        activationOrder.push('scheduler');
        return createScheduler(ctx);
      },
    };
    const builtinsContribution = automationTriggerBuiltinsPackage.automationTriggers;
    if (!builtinsContribution) throw new Error('built-ins package contributes no automation triggers');
    const builtinsPackage: MakaioNodeExtension<IMakaioBus> = {
      ...automationTriggerBuiltinsPackage,
      automationTriggers: {
        createAutomationTriggers: (ctx) => {
          activationOrder.push('builtins');
          return builtinsContribution.createAutomationTriggers(ctx);
        },
      },
    };

    const bus = createBusInstance();
    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: CRON_TEST_PKG_CTX_BASE });
    coordinator.registerContributionProcessor(
      createAutomationTriggerContributionProcessor({
        forEachActiveExtension: (callback) => coordinator.forEachActiveExtension(callback),
      }),
    );
    // Hostile order on purpose: the provider is listed last.
    coordinator.load([
      automationTriggerRegistryPackage,
      automationTriggerBindingRuntimePackage,
      builtinsPackage,
      schedulerPackage,
    ]);

    try {
      await coordinator.startAll();

      expect(activationOrder).toEqual(['scheduler', 'builtins']);

      // End to end: the binding activates against the live provider.
      const runtime = coordinator.getExtensionService(AutomationTriggerBindingRuntimeToken);
      if (!runtime) throw new Error('AutomationTriggerBindingRuntime service did not start');
      const subscription = await runtime.subscribe(
        { kind: CRON_AUTOMATION_TRIGGER_KIND, params: { schedule: '* * * * *' } },
        noopListener,
      );
      await subscription.detach();
    } finally {
      await coordinator.shutdown();
    }
  });
});

describe('cron scheduler restart', () => {
  /** Binding a host would have persisted and keep re-acquiring. */
  const STORED_BINDING = { kind: CRON_AUTOMATION_TRIGGER_KIND, params: { schedule: '0 9 * * 1' } };

  /**
   * A provider package that hands out a fresh recording scheduler per activation.
   *
   * Modelling one instance per activation is the point: it makes "which provider
   * did this binding actually schedule against" observable, which is exactly what
   * a restart must get right.
   * @param instances - Collects every scheduler this package creates, in order.
   * @returns The provider package.
   */
  function createRecordingSchedulerPackage(
    instances: Array<ReturnType<typeof createRecordingScheduler>>,
  ): MakaioNodeExtension<IMakaioBus> {
    return {
      name: AutomationCronSchedulerToken.name,
      displayName: 'Recording Cron Scheduler',
      version: '0.1.0',
      critical: true,
      create: () => {
        const instance = createRecordingScheduler();
        instances.push(instance);
        return instance.scheduler;
      },
    };
  }

  it('re-activates a stored cron binding against the provider that replaced a disabled one', async () => {
    const instances: Array<ReturnType<typeof createRecordingScheduler>> = [];
    const bus = createBusInstance();
    const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: CRON_TEST_PKG_CTX_BASE });
    coordinator.registerContributionProcessor(
      createAutomationTriggerContributionProcessor({
        forEachActiveExtension: (callback) => coordinator.forEachActiveExtension(callback),
      }),
    );
    coordinator.load([
      automationTriggerRegistryPackage,
      automationTriggerBindingRuntimePackage,
      automationTriggerBuiltinsPackage,
      createRecordingSchedulerPackage(instances),
    ]);

    const changed: number[] = [];
    const stopListening = bus.on(AutomationTriggerSubjects.changed, (ctx) => {
      changed.push(ctx.payload.revision);
    });

    try {
      await coordinator.startAll();
      const runtime = coordinator.getExtensionService(AutomationTriggerBindingRuntimeToken);
      if (!runtime) throw new Error('AutomationTriggerBindingRuntime service did not start');

      const fired: number[] = [];
      const listener: AutomationTriggerListener = async (event) => {
        fired.push((event.payload as { scheduledFor: number }).scheduledFor);
      };

      // The binding is live on the first provider and firings reach the listener.
      const initial = await runtime.subscribe(STORED_BINDING, listener);
      expect(instances).toHaveLength(1);
      expect(instances[0]?.requests).toHaveLength(1);
      await instances[0]?.requests[0]?.emit({ scheduledFor: 111 });
      expect(fired).toEqual([111]);

      // Disabling the provider destroys its jobs. The activation that captured it
      // must be retired here — while it stays indexed, it is permanently inert and
      // any later acquisition would join it instead of building a live one.
      await expect(coordinator.handleSetEnabled(AutomationCronSchedulerToken.name, false)).resolves.toBe(true);
      expect(instances[0]?.cleanups).toHaveBeenCalledTimes(1);

      // Re-enabling installs a new provider and re-registers the built-ins, whose
      // `automation-triggers.changed` event is the only signal a subscriber can
      // reconcile on.
      const changedBeforeReenable = changed.length;
      await expect(coordinator.handleSetEnabled(AutomationCronSchedulerToken.name, true)).resolves.toBe(true);
      expect(instances).toHaveLength(2);
      await vi.waitFor(() => expect(changed.length).toBeGreaterThan(changedBeforeReenable));

      // The reconciliation that signal drives: re-acquire the stored binding. It
      // must schedule against the *live* provider.
      const restored = await runtime.subscribe(STORED_BINDING, listener);
      await initial.detach();

      expect(instances[1]?.requests).toHaveLength(1);
      await instances[1]?.requests[0]?.emit({ scheduledFor: 222 });
      expect(fired).toEqual([111, 222]);

      await restored.detach();
    } finally {
      stopListening();
      await coordinator.shutdown();
    }
  });
});

describe('selectAutomationCronSchedulerPackage', () => {
  it('defaults a framework-only boot to the local provider', () => {
    expect(selectAutomationCronSchedulerPackage({ loadedPackages: [] })).toBe(localAutomationCronSchedulerPackage);
  });

  it('adds nothing when a loaded package already provides the scheduler', () => {
    expect(
      selectAutomationCronSchedulerPackage({
        loadedPackages: [{ name: AutomationCronSchedulerToken.name, displayName: 'Relay Cron Scheduler' }],
      }),
    ).toBeUndefined();
  });

  it('uses the host-selected provider package', () => {
    const hostPackage = { ...localAutomationCronSchedulerPackage, displayName: 'Host Cron Scheduler' };
    expect(selectAutomationCronSchedulerPackage({ hostPackages: [hostPackage], loadedPackages: [] })).toBe(hostPackage);
  });

  it('fails when a host-selected package does not register the scheduler service', () => {
    expect(() =>
      selectAutomationCronSchedulerPackage({
        hostPackages: [{ ...localAutomationCronSchedulerPackage, name: 'not-the-scheduler' }],
        loadedPackages: [],
      }),
    ).toThrow(/must be named/);
  });

  it('fails deterministically when two host seams contribute providers', () => {
    expect(() =>
      selectAutomationCronSchedulerPackage({
        hostPackages: [
          { ...localAutomationCronSchedulerPackage, displayName: 'Direct Host Cron Scheduler' },
          { ...localAutomationCronSchedulerPackage, displayName: 'Descriptor Cron Scheduler' },
        ],
        loadedPackages: [],
      }),
    ).toThrow(
      "Multiple automation cron scheduler providers: host packages 'Direct Host Cron Scheduler', 'Descriptor Cron Scheduler'",
    );
  });

  it('fails when two loaded packages provide the scheduler', () => {
    expect(() =>
      selectAutomationCronSchedulerPackage({
        loadedPackages: [
          { name: AutomationCronSchedulerToken.name, displayName: 'Relay Cron Scheduler' },
          { name: AutomationCronSchedulerToken.name, displayName: 'Other Cron Scheduler' },
        ],
      }),
    ).toThrow(/Multiple automation cron scheduler providers/);
  });

  it('fails when a host-selected package collides with a loaded provider', () => {
    expect(() =>
      selectAutomationCronSchedulerPackage({
        hostPackages: [localAutomationCronSchedulerPackage],
        loadedPackages: [{ name: AutomationCronSchedulerToken.name, displayName: 'Relay Cron Scheduler' }],
      }),
    ).toThrow(/Multiple automation cron scheduler providers/);
  });
});
